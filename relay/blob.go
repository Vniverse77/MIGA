package main

// Encrypted attachments. The relay stores opaque ciphertext bytes under a random 128-bit id
// and never learns what they are. Nothing here logs ids together with addresses or IPs.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	// 25 MiB of content plus the per-chunk authentication tags (16 bytes per 64 KiB, about 6.4 KB).
	defaultMaxBlob   = 25<<20 + 64<<10
	defaultBlobQuota = 2 << 30
	blobTTL          = 30 * 24 * time.Hour
	blobRateWindow   = 10 * time.Minute
	blobRateLimit    = 30
	maxActiveUploads = 4
	tempMaxAge       = time.Hour
)

var blobIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

var (
	errQuota = errors.New("quota")
	errBusy  = errors.New("busy")
)

type blobStore struct {
	db       *sql.DB
	dir      string
	maxSize  int64
	quota    int64
	ttl      time.Duration
	origins  []string
	trustXFF bool

	mu       sync.Mutex
	reserved int64 // bytes promised to uploads still in flight
	active   int
	rate     map[string]*ipWindow
}

type ipWindow struct {
	start time.Time
	n     int
}

func newBlobStore(db *sql.DB, dir string, quota int64, origins []string) (*blobStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS blobs (
		id      TEXT PRIMARY KEY,
		size    INTEGER NOT NULL,
		created INTEGER NOT NULL,
		expires INTEGER NOT NULL,
		del     TEXT NOT NULL
	)`); err != nil {
		return nil, err
	}
	return &blobStore{
		db: db, dir: dir, maxSize: defaultMaxBlob, quota: quota, ttl: blobTTL, origins: origins,
		trustXFF: os.Getenv("MIGA_TRUST_PROXY") == "1",
		rate:     map[string]*ipWindow{},
	}, nil
}

func (b *blobStore) register(mux *http.ServeMux) {
	mux.HandleFunc("/blob", b.cors(b.upload))
	mux.HandleFunc("/blob/{id}", b.cors(b.item))
}

// cors allows the page's own origin and the origins listed in MIGA_ORIGINS (same patterns as
// the WebSocket); any other browser origin is refused.
func (b *blobStore) cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !b.originAllowed(u.Host, r.Host) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type, X-Delete-Token")
			h.Set("Access-Control-Max-Age", "600")
			h.Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (b *blobStore) originAllowed(originHost, requestHost string) bool {
	if strings.EqualFold(originHost, requestHost) {
		return true
	}
	for _, p := range b.origins {
		if ok, _ := path.Match(strings.ToLower(p), strings.ToLower(originHost)); ok {
			return true
		}
	}
	return false
}

func (b *blobStore) clientIP(r *http.Request) string {
	if b.trustXFF {
		if v := r.Header.Get("CF-Connecting-IP"); v != "" {
			return v
		}
		if v := r.Header.Get("X-Forwarded-For"); v != "" {
			return strings.TrimSpace(strings.Split(v, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (b *blobStore) allow(ip string) bool {
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	w := b.rate[ip]
	if w == nil || now.Sub(w.start) > blobRateWindow {
		w = &ipWindow{start: now}
		b.rate[ip] = w
	}
	w.n++
	return w.n <= blobRateLimit
}

// reserve promises `n` bytes of disk to an upload, or says why that is not possible.
func (b *blobStore) reserve(n int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active >= maxActiveUploads {
		return errBusy
	}
	var used int64
	if err := b.db.QueryRow(`SELECT COALESCE(SUM(size),0) FROM blobs`).Scan(&used); err != nil {
		return err
	}
	if used+b.reserved+n > b.quota {
		return errQuota
	}
	b.reserved += n
	b.active++
	return nil
}

func (b *blobStore) release(n int64) {
	b.mu.Lock()
	b.reserved -= n
	b.active--
	b.mu.Unlock()
}

func randHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// upload: PUT /blob, body = ciphertext. Answers {"id":"<32 hex>","del":"<32 hex>"}.
func (b *blobStore) upload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !b.allow(b.clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if r.ContentLength > b.maxSize {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		return
	}
	want := r.ContentLength
	if want <= 0 {
		want = b.maxSize // unknown length: promise the maximum
	}
	if err := b.reserve(want); err != nil {
		switch err {
		case errQuota:
			http.Error(w, "storage full", http.StatusInsufficientStorage)
		case errBusy:
			http.Error(w, "busy", http.StatusServiceUnavailable)
		default:
			http.Error(w, "error", http.StatusInternalServerError)
		}
		return
	}
	defer b.release(want)

	tmp, err := os.CreateTemp(b.dir, "up-*")
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	tmpName := tmp.Name()
	keep := false
	defer func() {
		tmp.Close()
		if !keep {
			os.Remove(tmpName)
		}
	}()

	// Streams to disk; MaxBytesReader stops reading at the limit, so memory use stays tiny.
	body := http.MaxBytesReader(w, r.Body, b.maxSize)
	size, err := io.Copy(tmp, body)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "upload failed", http.StatusBadRequest)
		}
		return
	}
	if size == 0 {
		http.Error(w, "empty", http.StatusBadRequest)
		return
	}
	if err := tmp.Close(); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	id, del := randHex(16), randHex(16)
	if err := os.Rename(tmpName, filepath.Join(b.dir, id)); err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	keep = true
	now := time.Now()
	if _, err := b.db.Exec(`INSERT INTO blobs (id, size, created, expires, del) VALUES (?,?,?,?,?)`,
		id, size, now.UnixMilli(), now.Add(b.ttl).UnixMilli(), hashToken(del)); err != nil {
		os.Remove(filepath.Join(b.dir, id))
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id, "del": del, "size": size, "expires": now.Add(b.ttl).UnixMilli()})
}

// item handles GET and DELETE of /blob/{id}.
func (b *blobStore) item(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !blobIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	var size, expires int64
	var del string
	err := b.db.QueryRow(`SELECT size, expires, del FROM blobs WHERE id=?`, id).Scan(&size, &expires, &del)
	if err != nil || expires < time.Now().UnixMilli() {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		f, err := os.Open(filepath.Join(b.dir, id))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r, "", time.Time{}, f)
	case http.MethodDelete:
		token := r.Header.Get("X-Delete-Token")
		if subtle.ConstantTimeCompare([]byte(hashToken(token)), []byte(del)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		b.remove(id)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (b *blobStore) remove(id string) {
	if _, err := b.db.Exec(`DELETE FROM blobs WHERE id=?`, id); err != nil {
		log.Printf("blob delete row: %v", err)
	}
	os.Remove(filepath.Join(b.dir, id))
}

// cleanup removes expired blobs, stray temporary files and stale rate-limit entries.
func (b *blobStore) cleanup(now time.Time) {
	rows, err := b.db.Query(`SELECT id FROM blobs WHERE expires < ?`, now.UnixMilli())
	if err != nil {
		log.Printf("blob cleanup: %v", err)
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		b.remove(id)
	}
	if entries, err := os.ReadDir(b.dir); err == nil {
		for _, e := range entries {
			if !strings.HasPrefix(e.Name(), "up-") {
				continue
			}
			if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > tempMaxAge {
				os.Remove(filepath.Join(b.dir, e.Name()))
			}
		}
	}
	b.mu.Lock()
	for ip, w := range b.rate {
		if now.Sub(w.start) > blobRateWindow {
			delete(b.rate, ip)
		}
	}
	b.mu.Unlock()
}

func (b *blobStore) cleanupLoop() {
	for {
		b.cleanup(time.Now())
		time.Sleep(time.Hour)
	}
}

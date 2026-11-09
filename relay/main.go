// MIGA relay: forwards and briefly stores end-to-end encrypted messages.
// It never sees plaintext. See docs/PROTOCOL.md.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	_ "modernc.org/sqlite"
)

const (
	authPrefix    = "miga-auth-v0:"
	maxBody       = 24000
	maxFrameBytes = 32 << 10
	maxQueue      = 1000
	messageTTL    = 30 * 24 * time.Hour
	idleTimeout   = 90 * time.Second
	writeTimeout  = 5 * time.Second
	rateWindow    = 10 * time.Second
	rateLimit     = 30
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type frame struct {
	T     string `json:"t"`
	Nonce string `json:"nonce,omitempty"`
	Pub   string `json:"pub,omitempty"`
	Sig   string `json:"sig,omitempty"`
	To    string `json:"to,omitempty"`
	From  string `json:"from,omitempty"`
	ID    string `json:"id,omitempty"`
	Body  string `json:"body,omitempty"`
	TS    int64  `json:"ts,omitempty"`
	Err   string `json:"err,omitempty"`
}

type server struct {
	db      *sql.DB
	origins []string

	mu      sync.RWMutex
	clients map[string]map[*websocket.Conn]struct{}
}

func main() {
	addr := env("MIGA_ADDR", "127.0.0.1:8787")
	dbPath := env("MIGA_DB", "miga.db")
	static := os.Getenv("MIGA_STATIC")

	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS messages (
		rcpt   TEXT NOT NULL,
		sender TEXT NOT NULL,
		id     TEXT NOT NULL,
		body   TEXT NOT NULL,
		ts     INTEGER NOT NULL,
		PRIMARY KEY (rcpt, sender, id)
	)`); err != nil {
		log.Fatalf("create table: %v", err)
	}

	s := &server{db: db, clients: map[string]map[*websocket.Conn]struct{}{}}
	if o := os.Getenv("MIGA_ORIGINS"); o != "" {
		s.origins = strings.Split(o, ",")
	}
	go s.purgeLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	if static != "" {
		mux.Handle("/", securityHeaders(http.FileServer(http.Dir(static))))
	}

	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("miga relay listening on %s (db=%s static=%q)", addr, dbPath, static)
	log.Fatal(srv.ListenAndServe())
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func isAddr(s string) bool {
	if len(s) != 64 || s != strings.ToLower(s) {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.origins})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(maxFrameBytes)
	ctx := r.Context()

	// Challenge-response: the client proves it owns the secret key of its address.
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return
	}
	nonceHex := hex.EncodeToString(nonce)
	if send(c, frame{T: "challenge", Nonce: nonceHex}) != nil {
		return
	}
	var a frame
	if read(ctx, c, &a, 15*time.Second) != nil || a.T != "auth" || !isAddr(a.Pub) {
		c.Close(websocket.StatusPolicyViolation, "auth expected")
		return
	}
	pub, _ := hex.DecodeString(a.Pub)
	sig, err := hex.DecodeString(a.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize ||
		!ed25519.Verify(ed25519.PublicKey(pub), []byte(authPrefix+nonceHex), sig) {
		c.Close(websocket.StatusPolicyViolation, "bad signature")
		return
	}
	me := a.Pub

	s.register(me, c)
	defer s.unregister(me, c)
	if send(c, frame{T: "ready"}) != nil {
		return
	}
	for _, m := range s.pending(me) {
		if send(c, m) != nil {
			return
		}
	}

	windowStart, sent := time.Now(), 0
	for {
		var f frame
		if read(ctx, c, &f, idleTimeout) != nil {
			return
		}
		switch f.T {
		case "ping":
			send(c, frame{T: "pong"})
		case "ack":
			if isAddr(f.From) && idPattern.MatchString(f.ID) {
				s.db.Exec(`DELETE FROM messages WHERE rcpt=? AND sender=? AND id=?`, me, f.From, f.ID)
			}
		case "send":
			if now := time.Now(); now.Sub(windowStart) > rateWindow {
				windowStart, sent = now, 0
			}
			sent++
			switch {
			case sent > rateLimit:
				send(c, frame{T: "error", Err: "rate_limited", ID: f.ID})
			case !isAddr(f.To) || !idPattern.MatchString(f.ID) || f.Body == "":
				send(c, frame{T: "error", Err: "bad_frame", ID: f.ID})
			case len(f.Body) > maxBody:
				send(c, frame{T: "error", Err: "too_large", ID: f.ID})
			default:
				s.accept(c, me, f)
			}
		default:
			send(c, frame{T: "error", Err: "bad_frame"})
		}
	}
}

// accept stores a message and pushes it to the recipient if online.
func (s *server) accept(c *websocket.Conn, from string, f frame) {
	var queued int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE rcpt=?`, f.To).Scan(&queued); err != nil {
		log.Printf("count queue: %v", err)
		return
	}
	if queued >= maxQueue {
		send(c, frame{T: "error", Err: "queue_full", ID: f.ID})
		return
	}
	ts := time.Now().UnixMilli()
	res, err := s.db.Exec(`INSERT OR IGNORE INTO messages (rcpt, sender, id, body, ts) VALUES (?,?,?,?,?)`,
		f.To, from, f.ID, f.Body, ts)
	if err != nil {
		log.Printf("store message: %v", err)
		return
	}
	send(c, frame{T: "sent", ID: f.ID})
	if n, _ := res.RowsAffected(); n == 0 {
		return // duplicate id from a client retry; already stored and pushed
	}

	out := frame{T: "msg", From: from, ID: f.ID, Body: f.Body, TS: ts}
	s.mu.RLock()
	for rc := range s.clients[f.To] {
		go send(rc, out)
	}
	s.mu.RUnlock()
}

func (s *server) pending(rcpt string) []frame {
	rows, err := s.db.Query(`SELECT sender, id, body, ts FROM messages WHERE rcpt=? ORDER BY ts`, rcpt)
	if err != nil {
		log.Printf("load queue: %v", err)
		return nil
	}
	defer rows.Close()
	var out []frame
	for rows.Next() {
		f := frame{T: "msg"}
		if rows.Scan(&f.From, &f.ID, &f.Body, &f.TS) == nil {
			out = append(out, f)
		}
	}
	return out
}

func (s *server) register(addr string, c *websocket.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clients[addr] == nil {
		s.clients[addr] = map[*websocket.Conn]struct{}{}
	}
	s.clients[addr][c] = struct{}{}
}

func (s *server) unregister(addr string, c *websocket.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clients[addr], c)
	if len(s.clients[addr]) == 0 {
		delete(s.clients, addr)
	}
}

func (s *server) purgeLoop() {
	for {
		cutoff := time.Now().Add(-messageTTL).UnixMilli()
		if _, err := s.db.Exec(`DELETE FROM messages WHERE ts < ?`, cutoff); err != nil {
			log.Printf("purge: %v", err)
		}
		time.Sleep(time.Hour)
	}
}

func send(c *websocket.Conn, f frame) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return wsjson.Write(ctx, c, f)
}

func read(ctx context.Context, c *websocket.Conn, f *frame, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return wsjson.Read(ctx, c, f)
}

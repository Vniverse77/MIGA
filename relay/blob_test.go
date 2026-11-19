package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testStore(t *testing.T, quota int64) (*blobStore, *http.ServeMux) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	b, err := newBlobStore(db, filepath.Join(t.TempDir(), "blobs"), quota, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	b.register(mux)
	return b, mux
}

func do(mux *http.ServeMux, method, target string, body []byte, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func upload(t *testing.T, mux *http.ServeMux, data []byte) (id, del string) {
	t.Helper()
	rec := do(mux, "PUT", "/blob", data, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	var m map[string]any
	json.Unmarshal(rec.Body.Bytes(), &m)
	return m["id"].(string), m["del"].(string)
}

func TestRoundTripAndDelete(t *testing.T) {
	_, mux := testStore(t, 1<<30)
	data := []byte("opaque ciphertext")
	id, del := upload(t, mux, data)
	if len(id) != 32 || len(del) != 32 {
		t.Fatalf("bad id/token: %q %q", id, del)
	}
	rec := do(mux, "GET", "/blob/"+id, nil, nil)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), data) {
		t.Fatalf("get: %d", rec.Code)
	}
	if rec := do(mux, "DELETE", "/blob/"+id, nil, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("delete without token: %d", rec.Code)
	}
	if rec := do(mux, "DELETE", "/blob/"+id, nil, map[string]string{"X-Delete-Token": "00"}); rec.Code != http.StatusForbidden {
		t.Fatalf("delete with wrong token: %d", rec.Code)
	}
	if rec := do(mux, "DELETE", "/blob/"+id, nil, map[string]string{"X-Delete-Token": del}); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := do(mux, "GET", "/blob/"+id, nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("get after delete: %d", rec.Code)
	}
}

func TestUnknownIDIs404(t *testing.T) {
	_, mux := testStore(t, 1<<30)
	for _, id := range []string{"00000000000000000000000000000000", "nothex", "../../etc/passwd"} {
		// 307 is the mux cleaning "../" out of the path; either way no content is served.
		if rec := do(mux, "GET", "/blob/"+id, nil, nil); rec.Code != http.StatusNotFound && rec.Code != http.StatusTemporaryRedirect {
			t.Errorf("%s: %d", id, rec.Code)
		}
	}
}

func TestSizeLimit(t *testing.T) {
	b, mux := testStore(t, 1<<30)
	b.maxSize = 1000
	if rec := do(mux, "PUT", "/blob", make([]byte, 1000), nil); rec.Code != http.StatusCreated {
		t.Fatalf("at limit: %d", rec.Code)
	}
	if rec := do(mux, "PUT", "/blob", make([]byte, 1001), nil); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over limit (known length): %d", rec.Code)
	}
	// Unknown length (chunked): must still be cut off while streaming.
	req := httptest.NewRequest("PUT", "/blob", bytes.NewReader(make([]byte, 5000)))
	req.ContentLength = -1
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over limit (streamed): %d", rec.Code)
	}
	entries, _ := os.ReadDir(b.dir)
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %d entries", len(entries))
	}
	if rec := do(mux, "PUT", "/blob", nil, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty: %d", rec.Code)
	}
}

func TestQuota(t *testing.T) {
	_, mux := testStore(t, 2500)
	upload(t, mux, make([]byte, 1000))
	upload(t, mux, make([]byte, 1000))
	if rec := do(mux, "PUT", "/blob", make([]byte, 1000), nil); rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("over quota: %d", rec.Code)
	}
	if rec := do(mux, "PUT", "/blob", make([]byte, 400), nil); rec.Code != http.StatusCreated {
		t.Fatalf("under quota: %d", rec.Code)
	}
}

func TestTTLCleanup(t *testing.T) {
	b, mux := testStore(t, 1<<30)
	id, _ := upload(t, mux, []byte("old"))
	keep, _ := upload(t, mux, []byte("new"))
	b.db.Exec(`UPDATE blobs SET expires=? WHERE id=?`, time.Now().Add(-time.Minute).UnixMilli(), id)
	// Expired means gone even before the cleanup runs.
	if rec := do(mux, "GET", "/blob/"+id, nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("expired get: %d", rec.Code)
	}
	stray := filepath.Join(b.dir, "up-stray")
	os.WriteFile(stray, []byte("x"), 0o600)
	os.Chtimes(stray, time.Now().Add(-2*time.Hour), time.Now().Add(-2*time.Hour))
	b.cleanup(time.Now())
	if _, err := os.Stat(filepath.Join(b.dir, id)); !os.IsNotExist(err) {
		t.Fatal("expired file still on disk")
	}
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Fatal("stray temp file still on disk")
	}
	if rec := do(mux, "GET", "/blob/"+keep, nil, nil); rec.Code != 200 {
		t.Fatalf("live blob lost: %d", rec.Code)
	}
}

func TestRateLimitPerIP(t *testing.T) {
	_, mux := testStore(t, 1<<30)
	for i := 0; i < blobRateLimit; i++ {
		if rec := do(mux, "PUT", "/blob", []byte("x"), nil); rec.Code != http.StatusCreated {
			t.Fatalf("upload %d: %d", i, rec.Code)
		}
	}
	if rec := do(mux, "PUT", "/blob", []byte("x"), nil); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rec.Code)
	}
}

func TestOrigins(t *testing.T) {
	b, mux := testStore(t, 1<<30)
	b.origins = []string{"app.example.org"}
	if rec := do(mux, "GET", "/blob/00000000000000000000000000000000", nil, map[string]string{"Origin": "https://evil.example"}); rec.Code != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", rec.Code)
	}
	rec := do(mux, "OPTIONS", "/blob", nil, map[string]string{"Origin": "https://app.example.org"})
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example.org" {
		t.Fatalf("allowed origin preflight: %d %v", rec.Code, rec.Header())
	}
}

func TestOriginsWithScheme(t *testing.T) {
	b, mux := testStore(t, 1<<30)
	b.origins = []string{"tauri://localhost", "http://tauri.localhost"}
	for _, o := range []string{"tauri://localhost", "http://tauri.localhost"} {
		rec := do(mux, "OPTIONS", "/blob", nil, map[string]string{"Origin": o})
		if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != o {
			t.Fatalf("preflight %s: %d %v", o, rec.Code, rec.Header())
		}
		rec = do(mux, "PUT", "/blob", []byte("x"), map[string]string{"Origin": o})
		if rec.Code != http.StatusCreated || rec.Header().Get("Access-Control-Allow-Origin") != o {
			t.Fatalf("upload %s: %d", o, rec.Code)
		}
	}
	for _, o := range []string{"https://tauri.localhost", "http://localhost", "tauri://evil", "https://evil.example", "null"} {
		if rec := do(mux, "OPTIONS", "/blob", nil, map[string]string{"Origin": o}); rec.Code != http.StatusForbidden {
			t.Fatalf("origin %s should be refused: %d", o, rec.Code)
		}
	}
}

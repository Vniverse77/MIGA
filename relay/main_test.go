package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type tc struct {
	c    *websocket.Conn
	addr string
}

func testServer(t *testing.T) (*server, string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`CREATE TABLE messages (rcpt TEXT NOT NULL, sender TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (rcpt, sender, id))`); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db, clients: map[string]map[*websocket.Conn]struct{}{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return s, "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
}

func dial(t *testing.T, url string) *tc {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	var ch frame
	if err := wsjson.Read(ctx, c, &ch); err != nil {
		t.Fatal(err)
	}
	addr := hex.EncodeToString(pub)
	sig := ed25519.Sign(priv, []byte(authPrefix+ch.Nonce))
	wsjson.Write(ctx, c, frame{T: "auth", Pub: addr, Sig: hex.EncodeToString(sig)})
	var r frame
	if err := wsjson.Read(ctx, c, &r); err != nil || r.T != "ready" {
		t.Fatalf("ready: %v %v", err, r)
	}
	return &tc{c, addr}
}

func (x *tc) write(t *testing.T, f frame) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, x.c, f); err != nil {
		t.Fatal(err)
	}
}

func (x *tc) readFor(d time.Duration) (frame, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var f frame
	if wsjson.Read(ctx, x.c, &f) != nil {
		return f, false
	}
	return f, true
}

func queued(t *testing.T, s *server) int {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestEphemeralNotQueuedWhenOffline(t *testing.T) {
	s, url := testServer(t)
	a := dial(t, url)
	offline := strings.Repeat("ab", 32)
	a.write(t, frame{T: "send", To: offline, Body: "x", Eph: true})
	if f, ok := a.readFor(300 * time.Millisecond); ok {
		t.Fatalf("unexpected reply %+v", f)
	}
	if n := queued(t, s); n != 0 {
		t.Fatalf("queued %d ephemeral frames", n)
	}
	// B connects later and receives nothing.
	b := dial(t, url)
	_ = b
	c := dial(t, url)
	c.write(t, frame{T: "send", To: b.addr, Body: "y", Eph: true})
	if _, ok := a.readFor(200 * time.Millisecond); ok {
		t.Fatal("a got a frame")
	}
	// Late joiner with the offline address gets no backlog.
	if n := queued(t, s); n != 0 {
		t.Fatalf("queued %d", n)
	}
}

func TestEphemeralDeliveredWhenOnline(t *testing.T) {
	s, url := testServer(t)
	a, b := dial(t, url), dial(t, url)
	a.write(t, frame{T: "send", To: b.addr, Body: "aGk=", Eph: true})
	f, ok := b.readFor(2 * time.Second)
	if !ok || f.T != "msg" || !f.Eph || f.From != a.addr || f.Body != "aGk=" {
		t.Fatalf("got %+v ok=%v", f, ok)
	}
	if n := queued(t, s); n != 0 {
		t.Fatalf("queued %d", n)
	}
	// A normal message is still queued and carries no eph flag.
	a.write(t, frame{T: "send", To: b.addr, ID: "m1", Body: "zz"})
	if f, ok := a.readFor(2 * time.Second); !ok || f.T != "sent" {
		t.Fatalf("no sent: %+v", f)
	}
	if n := queued(t, s); n != 1 {
		t.Fatalf("normal message not queued: %d", n)
	}
}

func TestEphemeralSeparateRateLimit(t *testing.T) {
	s, url := testServer(t)
	a, b := dial(t, url), dial(t, url)
	for i := 0; i < 40; i++ {
		a.write(t, frame{T: "send", To: b.addr, Body: "x", Eph: true})
	}
	got := 0
	for {
		if _, ok := b.readFor(400 * time.Millisecond); !ok {
			break
		}
		got++
	}
	if got < 1 || got > ephLimit {
		t.Fatalf("delivered %d, want 1..%d", got, ephLimit)
	}
	// The normal message budget is untouched.
	a.write(t, frame{T: "send", To: b.addr, ID: "n1", Body: "hi"})
	var sawSent bool
	for i := 0; i < 3; i++ {
		f, ok := a.readFor(time.Second)
		if ok && f.T == "sent" {
			sawSent = true
			break
		}
		if ok && f.Err == "rate_limited" {
			t.Fatal("normal send was rate limited")
		}
	}
	if !sawSent {
		t.Fatal("no sent ack")
	}
	if n := queued(t, s); n != 1 {
		t.Fatalf("queued %d", n)
	}
}

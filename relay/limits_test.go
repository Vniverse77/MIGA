package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func guardedServer(t *testing.T, mod func(*limits)) (*server, string) {
	t.Helper()
	s, url := testServer(t)
	l := defaultLimits()
	if mod != nil {
		mod(&l)
	}
	s.g = newGuard(l, false)
	return s, url
}

func recvErr(t *testing.T, x *tc) string {
	t.Helper()
	for i := 0; i < 4; i++ {
		f, ok := x.readFor(time.Second)
		if !ok {
			return ""
		}
		if f.T == "error" {
			return f.Err
		}
		if f.T == "sent" {
			return "sent"
		}
	}
	return ""
}

func TestBucket(t *testing.T) {
	b := newBucketSet(3, time.Minute)
	now := time.Now()
	for i := 0; i < 3; i++ {
		if !b.allow("k", now) {
			t.Fatalf("burst %d denied", i)
		}
	}
	if b.allow("k", now) {
		t.Fatal("over burst allowed")
	}
	if !b.allow("k", now.Add(21*time.Second)) { // 3/min = one token per 20 s
		t.Fatal("no refill")
	}
	b.prune(now.Add(time.Hour))
	if len(b.m) != 0 {
		t.Fatal("not pruned")
	}
}

func TestCounters(t *testing.T) {
	var c counters
	if !c.acquire("a", 1) || c.acquire("a", 1) || !c.acquire("b", 1) {
		t.Fatal("acquire")
	}
	c.release("a")
	if !c.acquire("a", 1) {
		t.Fatal("release")
	}
	c.release("a")
	c.release("b")
	if len(c.m) != 0 {
		t.Fatal("not cleaned")
	}
}

func TestConnectionCapPerIP(t *testing.T) {
	_, url := guardedServer(t, func(l *limits) { l.MaxConnsPerIP = 2 })
	a, b := dial(t, url), dial(t, url)
	_, _ = a, b
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, url, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("third connection: err=%v resp=%v", err, resp)
	}
	b.c.CloseNow()
	time.Sleep(300 * time.Millisecond)
	dial(t, url) // a slot is free again
}

func TestConnectionRatePerIP(t *testing.T) {
	_, url := guardedServer(t, func(l *limits) { l.ConnPerMin = 2 })
	dial(t, url)
	dial(t, url)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, url, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("err=%v resp=%v", err, resp)
	}
}

func TestMessageRatePerIPAcrossConnections(t *testing.T) {
	_, url := guardedServer(t, func(l *limits) { l.MsgPerMin = 4 })
	a, b := dial(t, url), dial(t, url)
	got := map[string]int{}
	for i := 0; i < 6; i++ {
		x := a
		if i%2 == 1 {
			x = b
		}
		x.write(t, frame{T: "send", To: strings.Repeat("ee", 32), ID: "m" + string(rune('a'+i)), Body: "x"})
		got[recvErr(t, x)]++
	}
	if got["sent"] != 4 || got["rate_limited"] != 2 {
		t.Fatalf("got %v", got)
	}
}

func TestPerRecipientQueueMessageCap(t *testing.T) {
	s, url := guardedServer(t, func(l *limits) { l.QueueMsgs = 3 })
	a := dial(t, url)
	rcpt := strings.Repeat("cd", 32)
	var errs []string
	for i := 0; i < 5; i++ {
		a.write(t, frame{T: "send", To: rcpt, ID: "q" + string(rune('a'+i)), Body: "x"})
		errs = append(errs, recvErr(t, a))
	}
	want := "sent,sent,sent,queue_full,queue_full"
	if strings.Join(errs, ",") != want {
		t.Fatalf("got %v", errs)
	}
	if n := queued(t, s); n != 3 {
		t.Fatalf("queued %d (old messages must stay)", n)
	}
}

func TestPerRecipientQueueByteCap(t *testing.T) {
	_, url := guardedServer(t, func(l *limits) { l.QueueBytes = 100 })
	a := dial(t, url)
	rcpt := strings.Repeat("cd", 32)
	a.write(t, frame{T: "send", To: rcpt, ID: "b1", Body: strings.Repeat("x", 60)})
	if e := recvErr(t, a); e != "sent" {
		t.Fatal(e)
	}
	a.write(t, frame{T: "send", To: rcpt, ID: "b2", Body: strings.Repeat("x", 60)})
	if e := recvErr(t, a); e != "queue_full" {
		t.Fatal(e)
	}
}

func TestGlobalQueueCap(t *testing.T) {
	s, url := guardedServer(t, func(l *limits) { l.QueueTotalBytes = 100 })
	a := dial(t, url)
	a.write(t, frame{T: "send", To: strings.Repeat("c1", 32), ID: "g1", Body: strings.Repeat("x", 80)})
	if e := recvErr(t, a); e != "sent" {
		t.Fatal(e)
	}
	a.write(t, frame{T: "send", To: strings.Repeat("c2", 32), ID: "g2", Body: strings.Repeat("x", 80)})
	if e := recvErr(t, a); e != "queue_full" {
		t.Fatal(e)
	}
	// Space comes back after the database is re-measured (acks/purge).
	s.db.Exec(`DELETE FROM messages`)
	s.refreshQueueTotal()
	a.write(t, frame{T: "send", To: strings.Repeat("c2", 32), ID: "g3", Body: strings.Repeat("x", 80)})
	if e := recvErr(t, a); e != "sent" {
		t.Fatal(e)
	}
}

func TestNewRecipientBudget(t *testing.T) {
	s, url := guardedServer(t, func(l *limits) { l.NewRcptPerHour = 2 })
	a, friend := dial(t, url), dial(t, url)
	var errs []string
	for i := 0; i < 4; i++ { // four brand-new offline recipients
		a.write(t, frame{T: "send", To: strings.Repeat(string(rune('a'+i))+"1", 32), ID: "n" + string(rune('a'+i)), Body: "x"})
		errs = append(errs, recvErr(t, a))
	}
	if strings.Join(errs, ",") != "sent,sent,rate_limited,rate_limited" {
		t.Fatalf("got %v", errs)
	}
	// Online recipients and recipients that already have a queue are not charged.
	for i := 0; i < 3; i++ {
		a.write(t, frame{T: "send", To: friend.addr, ID: "f" + string(rune('a'+i)), Body: "x"})
		if e := recvErr(t, a); e != "sent" {
			t.Fatalf("online recipient: %s", e)
		}
	}
	a.write(t, frame{T: "send", To: strings.Repeat("a1", 32), ID: "again", Body: "x"})
	if e := recvErr(t, a); e != "sent" {
		t.Fatalf("existing queue: %s", e)
	}
	_ = s
}

func TestProxyHeaderOnlyWhenTrusted(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("CF-Connecting-IP", "203.0.113.9")
	if clientIP(r, false) != "10.0.0.1" || clientIP(r, true) != "203.0.113.9" {
		t.Fatal("ip selection")
	}
}

func TestBlobUploadConcurrencyPerIP(t *testing.T) {
	b, mux := testStore(t, 1<<30)
	b.g = newGuard(defaultLimits(), false)
	b.g.l.BlobPerIPUploads = 1
	pr, pw := io.Pipe()
	done := make(chan int)
	go func() {
		req := httptest.NewRequest("PUT", "/blob", pr)
		req.RemoteAddr = "192.0.2.1:1"
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		done <- rec.Code
	}()
	time.Sleep(200 * time.Millisecond) // first upload is in flight
	req := httptest.NewRequest("PUT", "/blob", bytes.NewReader([]byte("abc")))
	req.RemoteAddr = "192.0.2.1:2"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second concurrent upload: %d", rec.Code)
	}
	req = httptest.NewRequest("PUT", "/blob", bytes.NewReader([]byte("abc")))
	req.RemoteAddr = "192.0.2.77:2" // other IP unaffected
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("other ip: %d", rec.Code)
	}
	pw.Write([]byte("data"))
	pw.Close()
	if c := <-done; c != http.StatusCreated {
		t.Fatalf("first upload: %d", c)
	}
}

func TestBlobDownloadConcurrencyPerIP(t *testing.T) {
	b, mux := testStore(t, 1<<30)
	b.g = newGuard(defaultLimits(), false)
	b.g.l.BlobPerIPReads = 1
	if !b.g.reads.acquire("192.0.2.5", 1) { // simulate a download in progress
		t.Fatal()
	}
	req := httptest.NewRequest("PUT", "/blob", bytes.NewReader([]byte("hello")))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var up struct{ ID string }
	json.Unmarshal(rec.Body.Bytes(), &up)
	id := up.ID
	req = httptest.NewRequest("GET", "/blob/"+id, nil)
	req.RemoteAddr = "192.0.2.5:9"
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("download over cap: %d", rec.Code)
	}
	b.g.reads.release("192.0.2.5")
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/blob/"+id, nil)
	req.RemoteAddr = "192.0.2.5:9"
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("download: %d", rec.Code)
	}
}

func TestBlobStorageCapAnswers507(t *testing.T) {
	_, mux := testStore(t, 10)
	req := httptest.NewRequest("PUT", "/blob", bytes.NewReader(bytes.Repeat([]byte("x"), 11)))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestLimitsFromEnvDefaults(t *testing.T) {
	t.Setenv("MIGA_QUEUE_MSGS", "7")
	t.Setenv("MIGA_BLOB_QUOTA", "12345")
	l := limitsFromEnv()
	if l.QueueMsgs != 7 || l.BlobQuota != 12345 || l.MaxConnsPerIP != 20 || l.QueueTotalBytes != 512<<20 {
		t.Fatalf("%+v", l)
	}
}

func TestBackupDB(t *testing.T) {
	s, _ := testServer(t)
	s.db.Exec(`INSERT INTO messages VALUES ('r','s','i','body',1)`)
	var path string
	s.db.QueryRow(`PRAGMA database_list`).Scan(new(int), new(string), &path)
	dest := filepath.Join(t.TempDir(), "b.db")
	if err := backupDB(path, dest); err != nil {
		t.Fatal(err)
	}
	if err := backupDB(path, dest); err == nil {
		t.Fatal("must not overwrite")
	}
	db, _ := sql.Open("sqlite", "file:"+dest)
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}

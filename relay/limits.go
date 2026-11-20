package main

// Resource limits. Everything here lives in memory only: counters are keyed by the client IP
// for as long as they are needed (seconds to minutes), pruned regularly, never written to disk
// and never logged.

import (
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// limits holds every tunable. Zero or negative values are rejected at startup.
type limits struct {
	MaxConnsPerIP    int   // MIGA_MAX_CONNS_PER_IP: simultaneous WebSocket connections per IP
	ConnPerMin       int   // MIGA_CONNS_PER_MIN: new WebSocket connections per minute per IP (burst = same)
	MsgPerMin        int   // MIGA_MSGS_PER_MIN: stored messages (send/unsend) per minute per IP, summed over its connections
	NewRcptPerHour   int   // MIGA_NEW_RCPT_PER_HOUR: messages to recipients with an empty queue who are not online, per hour per IP
	QueueMsgs        int   // MIGA_QUEUE_MSGS: queued messages per recipient
	QueueBytes       int64 // MIGA_QUEUE_BYTES: queued bytes per recipient
	QueueTotalBytes  int64 // MIGA_QUEUE_TOTAL_BYTES: queued bytes over all recipients
	BlobQuota        int64 // MIGA_BLOB_QUOTA: total blob bytes on disk
	BlobPerIPUploads int   // MIGA_BLOB_UPLOADS_PER_IP: concurrent uploads per IP
	BlobPerIPReads   int   // MIGA_BLOB_DOWNLOADS_PER_IP: concurrent downloads per IP
	BlobPerWindow    int   // MIGA_BLOB_UPLOADS_PER_10MIN: uploads per 10 minutes per IP
}

func defaultLimits() limits {
	return limits{
		MaxConnsPerIP: 20, ConnPerMin: 60, MsgPerMin: 240, NewRcptPerHour: 30,
		QueueMsgs: maxQueue, QueueBytes: 8 << 20, QueueTotalBytes: 512 << 20,
		BlobQuota: 1 << 30, BlobPerIPUploads: 2, BlobPerIPReads: 8, BlobPerWindow: blobRateLimit,
	}
}

func envInt(key string, dst *int64) {
	v := os.Getenv(key)
	if v == "" {
		return
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		log.Fatalf("%s must be a positive number: %q", key, v)
	}
	*dst = n
}

func limitsFromEnv() limits {
	l := defaultLimits()
	for _, e := range []struct {
		key string
		dst *int
	}{
		{"MIGA_MAX_CONNS_PER_IP", &l.MaxConnsPerIP}, {"MIGA_CONNS_PER_MIN", &l.ConnPerMin},
		{"MIGA_MSGS_PER_MIN", &l.MsgPerMin}, {"MIGA_NEW_RCPT_PER_HOUR", &l.NewRcptPerHour},
		{"MIGA_QUEUE_MSGS", &l.QueueMsgs}, {"MIGA_BLOB_UPLOADS_PER_IP", &l.BlobPerIPUploads},
		{"MIGA_BLOB_DOWNLOADS_PER_IP", &l.BlobPerIPReads}, {"MIGA_BLOB_UPLOADS_PER_10MIN", &l.BlobPerWindow},
	} {
		n := int64(*e.dst)
		envInt(e.key, &n)
		*e.dst = int(n)
	}
	envInt("MIGA_QUEUE_BYTES", &l.QueueBytes)
	envInt("MIGA_QUEUE_TOTAL_BYTES", &l.QueueTotalBytes)
	envInt("MIGA_BLOB_QUOTA", &l.BlobQuota)
	return l
}

// bucket is a token bucket: `burst` tokens, refilled at `rate` per second.
type bucket struct {
	tokens float64
	last   time.Time
}

type bucketSet struct {
	mu    sync.Mutex
	m     map[string]*bucket
	rate  float64
	burst float64
}

func newBucketSet(perPeriod int, period time.Duration) *bucketSet {
	return &bucketSet{m: map[string]*bucket{}, rate: float64(perPeriod) / period.Seconds(), burst: float64(perPeriod)}
}

func (s *bucketSet) allow(key string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.m[key]
	if b == nil {
		b = &bucket{tokens: s.burst, last: now}
		s.m[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * s.rate
	if b.tokens > s.burst {
		b.tokens = s.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// prune drops buckets that have refilled completely (they carry no information any more).
func (s *bucketSet) prune(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, b := range s.m {
		if b.tokens+now.Sub(b.last).Seconds()*s.rate >= s.burst {
			delete(s.m, k)
		}
	}
}

// counters counts things in progress per key (connections, transfers).
type counters struct {
	mu sync.Mutex
	m  map[string]int
}

func (c *counters) acquire(key string, max int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]int{}
	}
	if c.m[key] >= max {
		return false
	}
	c.m[key]++
	return true
}

func (c *counters) release(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m[key] <= 1 {
		delete(c.m, key)
	} else {
		c.m[key]--
	}
}

// guard bundles all per-IP state. A nil guard allows everything (used by older tests).
type guard struct {
	l          limits
	trustProxy bool

	conns, uploads, reads counters
	connRate, msgRate     *bucketSet
	newRcpt               *bucketSet

	queueTotal atomic.Int64 // approximate queued bytes, refreshed from the database
}

func newGuard(l limits, trustProxy bool) *guard {
	return &guard{
		l: l, trustProxy: trustProxy,
		connRate: newBucketSet(l.ConnPerMin, time.Minute),
		msgRate:  newBucketSet(l.MsgPerMin, time.Minute),
		newRcpt:  newBucketSet(l.NewRcptPerHour, time.Hour),
	}
}

func (g *guard) pruneLoop() {
	for {
		time.Sleep(time.Minute)
		now := time.Now()
		g.connRate.prune(now)
		g.msgRate.prune(now)
		g.newRcpt.prune(now)
	}
}

// ip returns the address used as a counter key. Behind Cloudflare/a proxy set MIGA_TRUST_PROXY=1.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
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

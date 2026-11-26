package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func sampleAt(ts time.Time, cpu float64) telemetry {
	return telemetry{
		Type:           "telemetry",
		Timestamp:      ts.UTC().Format(time.RFC3339),
		CPUPercent:     cpu,
		MemoryPercent:  40,
		DiskPercent:    50,
		NetworkRxBytes: uint64(cpu * 1000),
		NetworkTxBytes: uint64(cpu * 100),
		UptimeSeconds:  uint64(cpu),
		ConfigHashes:   map[string]string{},
	}
}

func TestQueueFIFOOrderAndPersistenceAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "queue.jsonl")
	q, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for i := range 5 {
		if err := q.push(sampleAt(base.Add(time.Duration(i)*15*time.Second), float64(i+1))); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate a restart: reopen from disk only.
	reopened, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.len() != 5 {
		t.Fatalf("expected 5 persisted entries, got %d", reopened.len())
	}
	for i := range 5 {
		got, ok := reopened.peek()
		if !ok {
			t.Fatalf("queue drained early at %d", i)
		}
		if got.CPUPercent != float64(i+1) {
			t.Fatalf("order broken at %d: cpu=%v", i, got.CPUPercent)
		}
		if err := reopened.popN(1); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := reopened.peek(); ok {
		t.Fatal("queue should be empty")
	}
	// The file must be empty after the last pop.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) != 0 {
		t.Fatalf("queue file not truncated after drain: %q", data)
	}
	stat, err := os.Stat(path)
	if err != nil || stat.Mode().Perm() != 0o600 {
		t.Fatalf("queue file permissions: %v %v", stat, err)
	}
}

func TestQueueBoundedCapacityDropsOldest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.jsonl")
	q, err := openQueue(path, 3, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for i := range 6 {
		if err := q.push(sampleAt(base.Add(time.Duration(i)*time.Second), float64(i+1))); err != nil {
			t.Fatal(err)
		}
	}
	if q.len() != 3 {
		t.Fatalf("expected capacity 3, got %d", q.len())
	}
	first, _ := q.peek()
	if first.CPUPercent != 4 {
		t.Fatalf("oldest entries were not dropped first: first cpu=%v", first.CPUPercent)
	}
}

func TestQueueAgeCapDropsStaleEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.jsonl")
	q, err := openQueue(path, 100, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := q.push(sampleAt(now.Add(-10*time.Minute), 1)); err != nil {
		t.Fatal(err)
	}
	if err := q.push(sampleAt(now, 2)); err != nil {
		t.Fatal(err)
	}
	if q.len() != 1 {
		t.Fatalf("expected age cap to drop the stale entry, got %d", q.len())
	}
	first, _ := q.peek()
	if first.CPUPercent != 2 {
		t.Fatalf("kept the wrong entry: cpu=%v", first.CPUPercent)
	}
}

func TestQueueSkipsCorruptLinesOnLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.jsonl")
	good, _ := json.Marshal(sampleAt(time.Now().UTC(), 7))
	content := "not json\n" + string(good) + "\n" + `{"type":"other"}` + "\n\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	q, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if q.len() != 1 {
		t.Fatalf("expected only the valid line, got %d", q.len())
	}
	got, _ := q.peek()
	if got.CPUPercent != 7 {
		t.Fatalf("wrong surviving entry: %+v", got)
	}
}

// wsRecorder is a test Hub that records telemetry frames and can drop live connections.
type wsRecorder struct {
	server   *httptest.Server
	received chan telemetry
	mu       sync.Mutex
	conns    []*websocket.Conn
}

func newWSRecorder(t *testing.T) *wsRecorder {
	t.Helper()
	r := &wsRecorder{received: make(chan telemetry, 64)}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		ws, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			return
		}
		r.mu.Lock()
		r.conns = append(r.conns, ws)
		r.mu.Unlock()
		defer ws.Close()
		for {
			var msg telemetry
			if err := ws.ReadJSON(&msg); err != nil {
				return
			}
			r.received <- msg
		}
	}))
	t.Cleanup(r.server.Close)
	return r
}

// dropAll simulates a Hub disconnect by closing every live connection.
func (r *wsRecorder) dropAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ws := range r.conns {
		ws.Close()
	}
	r.conns = nil
}

func dial(t *testing.T, server *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + server.URL[4:] + "/"
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	return ws
}

func expectSample(t *testing.T, r *wsRecorder, cpu float64, label string) {
	t.Helper()
	select {
	case got := <-r.received:
		if got.CPUPercent != cpu {
			t.Fatalf("%s: expected cpu=%v, got %v", label, cpu, got.CPUPercent)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: timed out waiting for cpu=%v", label, cpu)
	}
}

func TestFlushQueueDrainsInOrderAcrossReconnect(t *testing.T) {
	recorder := newWSRecorder(t)
	path := filepath.Join(t.TempDir(), "queue.jsonl")
	queue, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// Hub unreachable: samples accumulate durably instead of being sent.
	base := time.Now().UTC().Truncate(time.Second)
	for i := range 3 {
		if err := queue.push(sampleAt(base.Add(time.Duration(i)*time.Second), float64(i+1))); err != nil {
			t.Fatal(err)
		}
	}

	// Reconnect: the queued samples flush in FIFO order.
	conn := &safeConn{ws: dial(t, recorder.server)}
	if !flushQueue(conn, queue) {
		t.Fatal("flush did not drain the queue")
	}
	if queue.len() != 0 {
		t.Fatalf("queue not empty after flush: %d", queue.len())
	}
	for i := range 3 {
		expectSample(t, recorder, float64(i+1), "initial flush")
	}

	// New samples after reconnect are pushed and flushed immediately.
	if err := queue.push(sampleAt(base.Add(3*time.Second), 4)); err != nil {
		t.Fatal(err)
	}
	if !flushQueue(conn, queue) {
		t.Fatal("queue should drain with a live connection")
	}
	expectSample(t, recorder, 4, "post-reconnect sample")

	// Disconnect: later samples stay queued, then flush in order on the next reconnect.
	recorder.dropAll()
	for i := 4; i < 6; i++ {
		if err := queue.push(sampleAt(base.Add(time.Duration(i)*time.Second), float64(i+1))); err != nil {
			t.Fatal(err)
		}
	}
	conn2 := &safeConn{ws: dial(t, recorder.server)}
	if !flushQueue(conn2, queue) {
		t.Fatal("second reconnect should drain the remaining queue")
	}
	for i := 4; i < 6; i++ {
		expectSample(t, recorder, float64(i+1), "reconnect flush")
	}

	// Persistence across restart with a partially drained queue.
	if err := queue.push(sampleAt(base.Add(10*time.Second), 11)); err != nil {
		t.Fatal(err)
	}
	if err := queue.push(sampleAt(base.Add(11*time.Second), 12)); err != nil {
		t.Fatal(err)
	}
	reopened, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.len() != 2 {
		t.Fatalf("expected 2 entries after restart, got %d", reopened.len())
	}
	first, _ := reopened.peek()
	if first.CPUPercent != 11 {
		t.Fatalf("restart lost order: first cpu=%v", first.CPUPercent)
	}
}

func TestCapabilityNegotiationIntersection(t *testing.T) {
	caps := newCapabilitySet()
	if !caps.has("telemetry") || !caps.has("systemd_status") || !caps.has("diagnostics") {
		t.Fatal("defaults should enable all advertised capabilities")
	}
	caps.applyAck(helloAck{Type: "hello_ack", ProtocolVersion: protocolVersion, Capabilities: []string{"telemetry"}})
	if !caps.has("telemetry") {
		t.Fatal("telemetry should remain negotiated")
	}
	if caps.has("systemd_status") || caps.has("diagnostics") {
		t.Fatal("non-negotiated capabilities must be disabled")
	}
	// Unknown names in an ack must not enable anything.
	caps.applyAck(helloAck{Type: "hello_ack", ProtocolVersion: protocolVersion, Capabilities: []string{"shell", "telemetry"}})
	if caps.has("shell") {
		t.Fatal("unknown capability must never be enabled")
	}
	if !caps.has("telemetry") {
		t.Fatal("telemetry should stay enabled")
	}
}

func TestFlushQueueRestampsDelayedSamplesAndPrunesExpired(t *testing.T) {
	recorder := newWSRecorder(t)
	path := filepath.Join(t.TempDir(), "queue.jsonl")
	queue, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	// Older than MaxQueueAge (1h): must be pruned, not re-stamped.
	if err := queue.push(sampleAt(now.Add(-2*time.Hour), 1)); err != nil {
		t.Fatal(err)
	}
	// Delayed >120s (Hub MAX_TELEMETRY_AGE_MS) but within MaxQueueAge: must be re-stamped on flush.
	if err := queue.push(sampleAt(now.Add(-10*time.Minute), 42)); err != nil {
		t.Fatal(err)
	}

	conn := &safeConn{ws: dial(t, recorder.server)}
	beforeFlush := time.Now().UTC().Add(-2 * time.Second)
	if !flushQueue(conn, queue) {
		t.Fatal("flush did not drain the queue")
	}
	select {
	case got := <-recorder.received:
		if got.CPUPercent != 42 {
			t.Fatalf("expected surviving delayed sample cpu=42, got %v", got.CPUPercent)
		}
		ts, err := time.Parse(time.RFC3339, got.Timestamp)
		if err != nil {
			t.Fatalf("invalid flushed timestamp %q: %v", got.Timestamp, err)
		}
		if ts.Before(beforeFlush) || ts.After(time.Now().UTC().Add(2*time.Second)) {
			t.Fatalf("flushed timestamp was not re-stamped at send time: %s", got.Timestamp)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for re-stamped sample")
	}
}

func TestTelemetrySamplerQueuesSamplesWhileOffline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.jsonl")
	queue, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{
		ProcRoot: dir,
		DiskPath: dir,
		Interval: 20 * time.Millisecond,
	}
	notify := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startTelemetrySampler(ctx, cfg, newCPUSampler(dir), queue, notify)

	deadline := time.Now().Add(2 * time.Second)
	for queue.len() < 2 && time.Now().Before(deadline) {
		time.Sleep(15 * time.Millisecond)
	}
	cancel()
	if queue.len() < 2 {
		t.Fatalf("expected offline sampler to queue >=2 samples, got %d", queue.len())
	}
	reopened, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.len() < 2 {
		t.Fatalf("expected >=2 durable samples on disk, got %d", reopened.len())
	}
}

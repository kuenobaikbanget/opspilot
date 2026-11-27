package agent

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestQueueChaosBackpressureUnderOutage pushes far more samples than the bounded
// capacity while the hub is unreachable: the queue must never exceed its cap,
// must drop the oldest entries first, and must retain a strict FIFO tail.
func TestQueueChaosBackpressureUnderOutage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.jsonl")
	const capacity = 128
	q, err := openQueue(path, capacity, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	const pushed = 10_000
	for i := range pushed {
		if err := q.push(sampleAt(base.Add(time.Duration(i)*time.Second), float64(i))); err != nil {
			t.Fatalf("push %d failed: %v", i, err)
		}
		if q.len() > capacity {
			t.Fatalf("queue exceeded capacity: len=%d cap=%d", q.len(), capacity)
		}
	}
	if q.len() != capacity {
		t.Fatalf("expected queue pinned at capacity %d, got %d", capacity, q.len())
	}
	snap := q.snapshot()
	// Oldest retained sample is pushed-capacity (oldest dropped first).
	if snap[0].CPUPercent != float64(pushed-capacity) {
		t.Fatalf("expected oldest retained cpu=%d, got %v", pushed-capacity, snap[0].CPUPercent)
	}
	if snap[len(snap)-1].CPUPercent != float64(pushed-1) {
		t.Fatalf("expected newest retained cpu=%d, got %v", pushed-1, snap[len(snap)-1].CPUPercent)
	}
	// FIFO order is strictly increasing.
	for i := 1; i < len(snap); i++ {
		if snap[i].CPUPercent <= snap[i-1].CPUPercent {
			t.Fatalf("FIFO order broken at %d", i)
		}
	}
	// Durability: everything retained survives a restart during the outage.
	reopened, err := openQueue(path, capacity, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.len() != capacity {
		t.Fatalf("expected %d entries after restart, got %d", capacity, reopened.len())
	}
	if got, _ := reopened.peek(); got.CPUPercent != float64(pushed-capacity) {
		t.Fatalf("after restart oldest retained cpu=%v, want %d", got.CPUPercent, pushed-capacity)
	}
}

// TestQueueChaosConcurrentPushPop hammers the queue from many goroutines
// (agent collector + flush loop racing): the queue must stay within capacity
// and every pop must only remove entries that were actually sent.
func TestQueueChaosConcurrentPushPop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.jsonl")
	const capacity = 64
	q, err := openQueue(path, capacity, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	var wg sync.WaitGroup
	const workers = 8
	const perWorker = 500
	for w := range workers {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := range perWorker {
				_ = q.push(sampleAt(base.Add(time.Duration(w*perWorker+i)*time.Second), float64(w*perWorker+i)))
			}
		}(w)
	}
	// Concurrent consumer pops a bounded number of "sent" entries.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 400; i++ {
			_ = q.popN(1)
		}
	}()
	wg.Wait()
	if q.len() > capacity {
		t.Fatalf("queue exceeded capacity under concurrency: len=%d cap=%d", q.len(), capacity)
	}
	// Persisted state matches in-memory state.
	reopened, err := openQueue(path, capacity, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.len() != q.len() {
		t.Fatalf("persisted len=%d != in-memory len=%d", reopened.len(), q.len())
	}
}

// TestQueueChaosAgeExpiry drops samples older than maxAge even below capacity.
func TestQueueChaosAgeExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.jsonl")
	q, err := openQueue(path, 1000, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	for i := range 10 {
		if err := q.push(sampleAt(now.Add(-time.Duration(10-i)*time.Minute), float64(i))); err != nil {
			t.Fatal(err)
		}
	}
	// Only the samples within the 2-minute age window may survive a prune.
	entries, _ := q.pruneAndSnapshot(now)
	for _, e := range entries {
		ts, err := time.Parse(time.RFC3339, e.Timestamp)
		if err != nil {
			t.Fatal(err)
		}
		if now.Sub(ts) > 2*time.Minute {
			t.Fatalf("expired entry survived prune: %s", e.Timestamp)
		}
	}
	if len(entries) > 3 {
		t.Fatalf("expected at most 3 entries inside the age window, got %d", len(entries))
	}
}

// TestQueueChaosCorruptLinesSkipped verifies a partially corrupted queue file
// (crash mid-write) recovers by skipping corrupt lines instead of failing.
func TestQueueChaosCorruptLinesSkipped(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.jsonl")
	q, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for i := range 3 {
		if err := q.push(sampleAt(base.Add(time.Duration(i)*time.Second), float64(i+1))); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate a torn write from a crash: append garbage lines after the valid ones.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("garbage-not-json\n{\"type\":\"other\"}\n"); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	reopened, err := openQueue(path, 100, time.Hour)
	if err != nil {
		t.Fatalf("corrupt queue must not fail open: %v", err)
	}
	// The 3 valid lines survive; the corrupt trailing lines are skipped.
	if reopened.len() != 3 {
		t.Fatalf("expected 3 valid entries after skipping corrupt lines, got %d", reopened.len())
	}
}

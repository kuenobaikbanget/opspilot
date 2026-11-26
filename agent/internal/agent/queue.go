package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// diskQueue is a bounded, durable FIFO of telemetry samples persisted as JSON lines.
// Samples are appended on collection and removed only after the Hub accepted them, so a
// restart or disconnect never silently drops recent samples. Capacity and age caps bound
// the file: once full, the oldest entries are dropped first.
type diskQueue struct {
	path       string
	maxEntries int
	maxAge     time.Duration

	flushMu sync.Mutex
	mu      sync.Mutex
	headSeq uint64
	entries []telemetry
}

// openQueue loads (or creates) the queue file, skipping corrupt lines instead of failing.
func openQueue(path string, maxEntries int, maxAge time.Duration) (*diskQueue, error) {
	if maxEntries < 1 {
		maxEntries = 1
	}
	q := &diskQueue{path: path, maxEntries: maxEntries, maxAge: maxAge}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return q, nil
	}
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var t telemetry
		if err := json.Unmarshal([]byte(line), &t); err != nil || t.Type != "telemetry" {
			log.Printf("telemetry queue: skipping corrupt line")
			continue
		}
		q.entries = append(q.entries, t)
	}
	q.enforceLocked(time.Now())
	return q, nil
}

// enforceLocked drops entries beyond the age cap and then beyond the capacity cap (oldest first).
func (q *diskQueue) enforceLocked(now time.Time) {
	if q.maxAge > 0 {
		cutoff := now.Add(-q.maxAge)
		first := 0
		for first < len(q.entries) {
			ts, err := time.Parse(time.RFC3339, q.entries[first].Timestamp)
			if err != nil || ts.After(cutoff) {
				break
			}
			first++
		}
		if first > 0 {
			q.entries = append([]telemetry(nil), q.entries[first:]...)
			q.headSeq += uint64(first)
		}
	}
	if len(q.entries) > q.maxEntries {
		dropped := len(q.entries) - q.maxEntries
		q.entries = append([]telemetry(nil), q.entries[dropped:]...)
		q.headSeq += uint64(dropped)
	}
}

// persistLocked atomically rewrites the queue file (temp file + fsync + rename + dir fsync).
func (q *diskQueue) persistLocked() error {
	var buf bytes.Buffer
	for _, entry := range q.entries {
		line, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	tmp := q.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, q.path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(q.path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// push durably appends one sample, enforcing the age and capacity caps.
func (q *diskQueue) push(t telemetry) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.entries = append(q.entries, t)
	q.enforceLocked(time.Now())
	return q.persistLocked()
}

// peek returns the oldest queued sample without removing it.
func (q *diskQueue) peek() (telemetry, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.entries) == 0 {
		return telemetry{}, false
	}
	return q.entries[0], true
}

// popN removes the n oldest entries (only after they were sent) and persists the queue.
func (q *diskQueue) popN(n int) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n > len(q.entries) {
		n = len(q.entries)
	}
	if n <= 0 {
		return nil
	}
	q.entries = append([]telemetry(nil), q.entries[n:]...)
	q.headSeq += uint64(n)
	return q.persistLocked()
}

func (q *diskQueue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.entries)
}

// snapshot returns a copy of the queued entries in FIFO order.
func (q *diskQueue) snapshot() []telemetry {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]telemetry(nil), q.entries...)
}

// pruneAndSnapshot drops expired entries before returning a consistent FIFO snapshot and its starting sequence.
func (q *diskQueue) pruneAndSnapshot(now time.Time) ([]telemetry, uint64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	before := len(q.entries)
	q.enforceLocked(now)
	if len(q.entries) != before {
		if err := q.persistLocked(); err != nil {
			log.Printf("telemetry queue persist failed: %v", err)
		}
	}
	return append([]telemetry(nil), q.entries...), q.headSeq
}

// popUpTo removes entries with sequence numbers strictly below endSeq, so concurrent capacity evictions never drop unsent samples.
func (q *diskQueue) popUpTo(endSeq uint64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if endSeq <= q.headSeq {
		return nil
	}
	drop := int(endSeq - q.headSeq)
	if drop > len(q.entries) {
		drop = len(q.entries)
	}
	q.entries = append([]telemetry(nil), q.entries[drop:]...)
	q.headSeq += uint64(drop)
	return q.persistLocked()
}

// flushQueue sends queued samples in FIFO order, re-stamping each frame at send time so
// delayed samples stay within the Hub's timestamp window, and pops them only after a
// successful write. It returns true when the queue is fully drained.
func flushQueue(conn *safeConn, q *diskQueue) bool {
	q.flushMu.Lock()
	defer q.flushMu.Unlock()
	entries, startSeq := q.pruneAndSnapshot(time.Now())
	sent := 0
	for _, t := range entries {
		// Re-stamp at send time: the Hub bounds timestamp age, and queued samples keep order.
		t.Timestamp = time.Now().UTC().Format(time.RFC3339)
		if err := conn.send(t); err != nil {
			log.Printf("queued telemetry send failed: %v", err)
			break
		}
		sent++
	}
	if sent > 0 {
		if err := q.popUpTo(startSeq + uint64(sent)); err != nil {
			log.Printf("telemetry queue persist failed: %v", err)
		}
	}
	return q.len() == 0
}

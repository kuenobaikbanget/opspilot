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

	mu      sync.Mutex
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
		}
	}
	if len(q.entries) > q.maxEntries {
		q.entries = append([]telemetry(nil), q.entries[len(q.entries)-q.maxEntries:]...)
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

// flushQueue sends queued samples in FIFO order and pops them only after a successful
// write. It returns true when the queue is fully drained.
func flushQueue(conn *safeConn, q *diskQueue) bool {
	sent := 0
	for _, t := range q.snapshot() {
		if err := conn.send(t); err != nil {
			log.Printf("queued telemetry send failed: %v", err)
			break
		}
		sent++
	}
	if sent > 0 {
		if err := q.popN(sent); err != nil {
			log.Printf("telemetry queue persist failed: %v", err)
		}
	}
	return q.len() == 0
}

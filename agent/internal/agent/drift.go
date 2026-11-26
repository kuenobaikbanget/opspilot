package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Controlled config diff reading is strictly opt-in (OPSPILOT_CONFIG_DIFFS=true) and limited
// to the local OPSPILOT_CONFIG_FILES allowlist. The agent never reads arbitrary paths, never
// follows symlinks, and redacts secrets locally before anything leaves over WSS.
const (
	// driftInterval is how often tracked allowlisted files are re-hashed for changes.
	driftInterval = 15 * time.Second
	// maxSnapshotFiles bounds how many allowlisted paths are tracked per connection.
	maxSnapshotFiles = 20
	// maxHashBytes mirrors configHashes: hash-only tracking covers files up to 1 MiB.
	maxHashBytes = 1024 * 1024
	// maxSnapshotReadBytes rejects files > 64 KiB for diff reading (hash-only continues).
	maxSnapshotReadBytes = 64 * 1024
	// maxSnapshotContentBytes bounds the redacted snapshot content at 16 KiB.
	maxSnapshotContentBytes = 16 * 1024
)

var dotenvLikeRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*\s*=`)

// configSnapshotBase is the common part of both config_snapshot frame variants. Embedded
// structs flatten in encoding/json, so each variant serializes with exactly its own keys.
type configSnapshotBase struct {
	Type           string `json:"type"`
	Version        int    `json:"version"`
	ObservedAt     string `json:"observedAt"`
	FilePath       string `json:"filePath"`
	ChecksumSha256 string `json:"checksumSha256"`
	Status         string `json:"status"`
}

// configSnapshotRedacted carries agent-redacted, bounded content of one allowlisted file.
type configSnapshotRedacted struct {
	configSnapshotBase
	Format          string `json:"format"`
	ContentRedacted string `json:"contentRedacted"`
	Truncated       bool   `json:"truncated"`
	RedactionCount  int    `json:"redactionCount"`
}

// configSnapshotHashOnly reports a checksum without content (binary/too large/disabled...).
type configSnapshotHashOnly struct {
	configSnapshotBase
	UnavailableReason string `json:"unavailableReason"`
}

func hashOnlyFrame(base configSnapshotBase, reason string) configSnapshotHashOnly {
	base.Status = "hash_only"
	return configSnapshotHashOnly{configSnapshotBase: base, UnavailableReason: reason}
}

// redactWithCount applies the shared secret redaction rules and returns the redacted text
// plus the number of secret matches that were replaced.
func redactWithCount(raw string) (string, int) {
	count := 0
	for _, rule := range redactRules {
		count += len(rule.re.FindAllStringIndex(raw, -1))
		raw = rule.re.ReplaceAllString(raw, rule.replacement)
	}
	return raw, count
}

// truncateSnapshotContent cuts s at max bytes without splitting a UTF-8 rune, preferring a
// line boundary near the cut so the truncated snapshot ends cleanly.
func truncateSnapshotContent(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && cut < len(s) && !utf8.RuneStart(s[cut]) {
		cut--
	}
	if idx := strings.LastIndexByte(s[:cut], '\n'); idx > 0 && cut-idx <= 4096 {
		cut = idx + 1
	}
	return s[:cut]
}

// configFileHash returns the lowercase hex SHA-256 of a regular file up to 1 MiB, mirroring
// configHashes so telemetry and snapshot frames agree on the checksum. Symlinks, directories,
// devices, oversized and unreadable files return "" (never read, never reported).
func configFileHash(path string) string {
	if !filepath.IsAbs(path) {
		return ""
	}
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxHashBytes {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(file, maxHashBytes+1)); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// detectConfigFormat classifies an allowlisted file for the semantic diff engine. The Hub
// re-detects the format itself; this is advisory metadata on the frame.
func detectConfigFormat(path string, content string) string {
	base := strings.ToLower(filepath.Base(path))
	switch {
	case strings.HasSuffix(base, ".json"):
		return "json"
	case strings.HasSuffix(base, ".yaml") || strings.HasSuffix(base, ".yml"):
		return "yaml"
	case base == ".env" || strings.HasPrefix(base, ".env.") || strings.HasSuffix(base, ".env"):
		return "dotenv"
	case strings.HasSuffix(base, ".ini"), strings.HasSuffix(base, ".service"), strings.HasSuffix(base, ".socket"),
		strings.HasSuffix(base, ".timer"), strings.HasSuffix(base, ".mount"), strings.HasSuffix(base, ".path"):
		return "ini"
	case strings.Contains(base, "nginx") || strings.Contains(strings.ToLower(path), "/nginx/"):
		return "nginx"
	}
	sample := content
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	trimmed := strings.TrimSpace(sample)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return "json"
	}
	lines := 0
	dotenvLike := true
	for _, line := range strings.Split(sample, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		lines++
		if !dotenvLikeRE.MatchString(line) {
			dotenvLike = false
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			return "ini"
		}
	}
	if lines > 0 && dotenvLike {
		return "dotenv"
	}
	return "text"
}

// buildConfigSnapshot validates one path against the controlled-reading policy and builds
// the frame to send. It returns (nil, "") when the file cannot be hashed at all (missing,
// symlink, non-regular, > 1 MiB, unreadable) — such files are never read and never sent,
// exactly like configHashes. diffsEnabled=false produces a hash_only "disabled" frame.
func buildConfigSnapshot(path string, diffsEnabled bool) (any, string) {
	base := configSnapshotBase{
		Type:       "config_snapshot",
		Version:    1,
		ObservedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		FilePath:   path,
	}
	if !filepath.IsAbs(path) {
		return nil, ""
	}
	hash := configFileHash(path)
	if hash == "" {
		return nil, ""
	}
	base.ChecksumSha256 = hash
	if !diffsEnabled {
		return hashOnlyFrame(base, "disabled"), hash
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return hashOnlyFrame(base, "unreadable"), hash
	}
	if !fi.Mode().IsRegular() {
		return hashOnlyFrame(base, "not_regular_file"), hash
	}
	if fi.Size() > maxSnapshotReadBytes {
		return hashOnlyFrame(base, "too_large"), hash
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return hashOnlyFrame(base, "unreadable"), hash
	}
	if len(content) > maxSnapshotReadBytes || bytes.Contains(content, []byte{0}) || !utf8.Valid(content) {
		return hashOnlyFrame(base, "binary_or_unreadable"), hash
	}
	redacted, count := redactWithCount(string(content))
	truncated := false
	if len(redacted) > maxSnapshotContentBytes {
		redacted = truncateSnapshotContent(redacted, maxSnapshotContentBytes)
		truncated = true
	}
	base.Status = "redacted_snapshot"
	return configSnapshotRedacted{
		configSnapshotBase: base,
		Format:             detectConfigFormat(path, string(content)),
		ContentRedacted:    redacted,
		Truncated:          truncated,
		RedactionCount:     count,
	}, hash
}

// snapshotSender is the minimal send surface drift tracking needs (safeConn implements it).
type snapshotSender interface {
	send(v any) error
}

// driftTracker remembers the last sent SHA-256 per allowlisted path during one connection.
type driftTracker struct {
	mu       sync.Mutex
	lastSent map[string]string
}

func newDriftTracker() *driftTracker {
	return &driftTracker{lastSent: map[string]string{}}
}

// sync sends a bounded config_snapshot frame for every allowlisted path whose SHA-256
// changed since the last send (all of them on the first sync after connect). It only acts
// when controlled diffs are enabled locally AND the Hub negotiated "config_diffs".
func (d *driftTracker) sync(sender snapshotSender, cfg config, caps *capabilitySet) {
	if !cfg.ConfigDiffs || !caps.has("config_diffs") {
		return
	}
	seen := map[string]bool{}
	for _, p := range cfg.ConfigFiles {
		if len(seen) >= maxSnapshotFiles {
			break
		}
		if !filepath.IsAbs(p) || seen[p] {
			continue
		}
		seen[p] = true
		frame, hash := buildConfigSnapshot(p, cfg.ConfigDiffs)
		if frame == nil {
			continue
		}
		d.mu.Lock()
		changed := d.lastSent[p] != hash
		if changed {
			d.lastSent[p] = hash
		}
		d.mu.Unlock()
		if !changed {
			continue
		}
		if err := sender.send(frame); err != nil {
			log.Printf("config snapshot send failed: %v", err)
			return
		}
	}
}

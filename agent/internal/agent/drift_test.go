package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

type recordingSender struct {
	frames []any
	err    error
}

func (r *recordingSender) send(v any) error {
	r.frames = append(r.frames, v)
	return r.err
}

func TestCapabilitiesForDefaultOff(t *testing.T) {
	caps := capabilitiesFor(config{})
	for _, c := range caps {
		if c == "config_diffs" {
			t.Fatal("config_diffs must not be advertised when OPSPILOT_CONFIG_DIFFS is unset/false")
		}
	}
	if len(caps) != len(advertisedCapabilities) {
		t.Fatalf("default capabilities changed: %v", caps)
	}
	caps = capabilitiesFor(config{ConfigDiffs: true})
	found := false
	for _, c := range caps {
		if c == "config_diffs" {
			found = true
		}
	}
	if !found {
		t.Fatal("config_diffs must be advertised when OPSPILOT_CONFIG_DIFFS=true")
	}
}

func TestBuildConfigSnapshotDefaultOff(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "app.env", "A=1\n")
	frame, hash := buildConfigSnapshot(p, false)
	if hash != sha256Hex("A=1\n") {
		t.Fatalf("hash mismatch: %s", hash)
	}
	ho, ok := frame.(configSnapshotHashOnly)
	if !ok {
		t.Fatalf("expected hash_only frame when disabled, got %T", frame)
	}
	if ho.Status != "hash_only" || ho.UnavailableReason != "disabled" {
		t.Fatalf("bad frame: %+v", ho)
	}
}

func TestBuildConfigSnapshotRejectsSymlinkAndDirectory(t *testing.T) {
	dir := t.TempDir()
	target := writeFile(t, dir, "real.env", "A=1\n")
	link := filepath.Join(dir, "link.env")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if frame, hash := buildConfigSnapshot(link, true); frame != nil || hash != "" {
		t.Fatalf("symlink must never be read or sent: frame=%v hash=%q", frame, hash)
	}
	if frame, hash := buildConfigSnapshot(dir, true); frame != nil || hash != "" {
		t.Fatalf("directory must never be read or sent: frame=%v hash=%q", frame, hash)
	}
	if frame, hash := buildConfigSnapshot(filepath.Join(dir, "missing.env"), true); frame != nil || hash != "" {
		t.Fatalf("missing file must not produce a frame: frame=%v hash=%q", frame, hash)
	}
	if frame, hash := buildConfigSnapshot("relative/path.env", true); frame != nil || hash != "" {
		t.Fatalf("relative path must not produce a frame: frame=%v hash=%q", frame, hash)
	}
}

func TestBuildConfigSnapshotRejectsOversizedFile(t *testing.T) {
	dir := t.TempDir()
	content := strings.Repeat("a", maxSnapshotReadBytes+1)
	p := writeFile(t, dir, "big.conf", content)
	frame, hash := buildConfigSnapshot(p, true)
	if hash != sha256Hex(content) {
		t.Fatal("oversized file must still carry its hash (hash-only tracking continues)")
	}
	ho, ok := frame.(configSnapshotHashOnly)
	if !ok || ho.UnavailableReason != "too_large" {
		t.Fatalf("expected hash_only/too_large, got %#v", frame)
	}
}

func TestBuildConfigSnapshotRejectsBinaryFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(p, []byte{'P', 'K', 0x00, 0x01, 0x02}, 0600); err != nil {
		t.Fatal(err)
	}
	frame, hash := buildConfigSnapshot(p, true)
	if hash == "" {
		t.Fatal("binary file <=1MiB should still be hashable")
	}
	ho, ok := frame.(configSnapshotHashOnly)
	if !ok || ho.UnavailableReason != "binary_or_unreadable" {
		t.Fatalf("expected hash_only/binary_or_unreadable, got %#v", frame)
	}
}

func TestBuildConfigSnapshotRedactsSecretsBeforeSending(t *testing.T) {
	dir := t.TempDir()
	content := strings.Join([]string{
		"DATABASE_URL=postgres://admin:hunter2@db.internal:5432/app",
		"PASSWORD=hunter2",
		"AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
		"GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
		"SLACK=xoxb-123456789012-abcdefghijkl",
		"OPENAI=sk-abcdefghijklmnopqrstuvwxyz123456",
		"JWT=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		"AUTHORIZATION=Bearer abcdef123456",
		"-----BEGIN RSA PRIVATE KEY-----",
		"MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
		"-----END RSA PRIVATE KEY-----",
		"WORKERS=4",
	}, "\n")
	p := writeFile(t, dir, "secrets.env", content)
	frame, hash := buildConfigSnapshot(p, true)
	if hash != sha256Hex(content) {
		t.Fatal("checksum must be of the raw file content")
	}
	rs, ok := frame.(configSnapshotRedacted)
	if !ok {
		t.Fatalf("expected redacted_snapshot, got %T", frame)
	}
	if rs.Status != "redacted_snapshot" || rs.Format != "dotenv" {
		t.Fatalf("bad frame header: %+v", rs.configSnapshotBase)
	}
	out := rs.ContentRedacted
	for _, secret := range []string{"hunter2", "AKIAIOSFODNN7EXAMPLE", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12", "xoxb-123456789012", "sk-abcdefghijklmnopqrstuvwxyz123456", "eyJhbGciOiJIUzI1NiJ9", "abcdef123456", "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu", "admin"} {
		if strings.Contains(out, secret) {
			t.Fatalf("secret %q leaked into redacted content:\n%s", secret, out)
		}
	}
	if !strings.Contains(out, "WORKERS=4") {
		t.Fatalf("non-secret content must survive:\n%s", out)
	}
	if rs.RedactionCount < 9 {
		t.Fatalf("expected >=9 redactions, got %d:\n%s", rs.RedactionCount, out)
	}
	if rs.Truncated {
		t.Fatal("small file must not be truncated")
	}
}

func TestBuildConfigSnapshotTruncatesAt16KiB(t *testing.T) {
	dir := t.TempDir()
	content := strings.Repeat("line of config padding\n", 2000) // > 16 KiB
	p := writeFile(t, dir, "big.env", content)
	frame, _ := buildConfigSnapshot(p, true)
	rs, ok := frame.(configSnapshotRedacted)
	if !ok {
		t.Fatalf("expected redacted_snapshot, got %T", frame)
	}
	if !rs.Truncated {
		t.Fatal("oversized content must set truncated=true")
	}
	if len(rs.ContentRedacted) > maxSnapshotContentBytes {
		t.Fatalf("redacted content exceeds cap: %d bytes", len(rs.ContentRedacted))
	}
	if !strings.HasSuffix(rs.ContentRedacted, "\n") {
		t.Fatal("truncation should end on a clean line boundary")
	}
}

func TestConfigSnapshotFrameSerializationMatchesContract(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "unit.service", "[Service]\nExecStart=/usr/bin/app\n")
	frame, _ := buildConfigSnapshot(p, true)
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	want := []string{"type", "version", "observedAt", "filePath", "checksumSha256", "status", "format", "contentRedacted", "truncated", "redactionCount"}
	if len(generic) != len(want) {
		t.Fatalf("redacted frame keys = %v", keysOf(generic))
	}
	for _, k := range want {
		if _, ok := generic[k]; !ok {
			t.Fatalf("redacted frame missing key %q: %v", k, keysOf(generic))
		}
	}
	if generic["type"] != "config_snapshot" || generic["version"] != float64(1) || generic["status"] != "redacted_snapshot" {
		t.Fatalf("bad frame header: %v", generic)
	}
	if generic["format"] != "ini" {
		t.Fatalf("systemd unit should detect ini, got %v", generic["format"])
	}

	ho, _ := buildConfigSnapshot(p, false)
	raw, _ = json.Marshal(ho)
	generic = map[string]any{}
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	want = []string{"type", "version", "observedAt", "filePath", "checksumSha256", "status", "unavailableReason"}
	if len(generic) != len(want) {
		t.Fatalf("hash_only frame keys = %v", keysOf(generic))
	}
	for _, k := range want {
		if _, ok := generic[k]; !ok {
			t.Fatalf("hash_only frame missing key %q", k)
		}
	}
	if generic["status"] != "hash_only" || generic["unavailableReason"] != "disabled" {
		t.Fatalf("bad hash_only frame: %v", generic)
	}
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestDriftTrackerSendsOnConnectThenOnlyOnChange(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "app.env", "A=1\n")
	cfg := config{ConfigDiffs: true, ConfigFiles: []string{p, "relative.env", p}} // dup + relative must be ignored
	caps := newCapabilitySet("telemetry", "config_diffs")
	sender := &recordingSender{}
	d := newDriftTracker()

	d.sync(sender, cfg, caps)
	if len(sender.frames) != 1 {
		t.Fatalf("first sync should send exactly one frame (deduped), got %d", len(sender.frames))
	}
	d.sync(sender, cfg, caps)
	if len(sender.frames) != 1 {
		t.Fatalf("unchanged file must not resend, got %d frames", len(sender.frames))
	}
	writeFile(t, dir, "app.env", "A=2\n")
	d.sync(sender, cfg, caps)
	if len(sender.frames) != 2 {
		t.Fatalf("changed hash must resend, got %d frames", len(sender.frames))
	}
}

func TestDriftTrackerGatedOnFlagAndCapability(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "app.env", "A=1\n")
	sender := &recordingSender{}
	d := newDriftTracker()

	// Flag off: nothing is sent even with the capability negotiated.
	d.sync(sender, config{ConfigDiffs: false, ConfigFiles: []string{p}}, newCapabilitySet("config_diffs"))
	if len(sender.frames) != 0 {
		t.Fatal("OPSPILOT_CONFIG_DIFFS=false must disable snapshots entirely")
	}
	// Capability not negotiated: nothing is sent even with the flag on.
	d.sync(sender, config{ConfigDiffs: true, ConfigFiles: []string{p}}, newCapabilitySet("telemetry"))
	if len(sender.frames) != 0 {
		t.Fatal("snapshots require the negotiated config_diffs capability")
	}
}

func TestDriftTrackerCapsAt20Files(t *testing.T) {
	dir := t.TempDir()
	var paths []string
	for i := 0; i < 25; i++ {
		paths = append(paths, writeFile(t, dir, fmt.Sprintf("file%02d.env", i), "A=1\n"))
	}
	cfg := config{ConfigDiffs: true, ConfigFiles: paths}
	caps := newCapabilitySet("config_diffs")
	sender := &recordingSender{}
	newDriftTracker().sync(sender, cfg, caps)
	if len(sender.frames) != maxSnapshotFiles {
		t.Fatalf("expected exactly %d snapshots, got %d", maxSnapshotFiles, len(sender.frames))
	}
}

func TestRedactExpandedPatterns(t *testing.T) {
	cases := map[string]string{
		"Authorization: Bearer tok123":                                       "Authorization: Bearer [REDACTED]",
		"Authorization: Basic dXNlcjpwYXNz":                                  "Authorization: Basic [REDACTED]",
		"Authorization: Digest abc":                                          "Authorization: Digest [REDACTED]",
		"passwd: s3cret":                                                     "passwd: [REDACTED]",
		"DB_PASSWORD=hunter2":                                                "DB_PASSWORD=[REDACTED]",
		"api_key: sk-abcdefghijklmnopqrstuv":                                 "api_key: [REDACTED]",
		"aws key AKIAIOSFODNN7EXAMPLE here":                                  "aws key [REDACTED_AWS_KEY] here",
		"token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ99":                             "token [REDACTED_GITHUB_TOKEN]",
		"pat github_pat_ABCDEFGHIJKLMNOPQRSTUVWX99":                          "pat [REDACTED_GITHUB_TOKEN]",
		"slack xoxb-1234567890ab-cdef":                                       "slack [REDACTED_SLACK_TOKEN]",
		"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123456":                 "jwt [REDACTED_JWT]",
		"url postgres://user:pass@host/db":                                   "url postgres://[REDACTED]:[REDACTED]@host/db",
		"-----BEGIN EC PRIVATE KEY-----\nAAAB\n-----END EC PRIVATE KEY-----": "[REDACTED_PRIVATE_KEY]",
	}
	for in, want := range cases {
		if got := redact(in); got != want {
			t.Errorf("redact(%q) = %q, want %q", in, got, want)
		}
	}
	// Non-secret config lines must survive untouched.
	plain := "worker_processes 4;\nlisten 80;"
	if got := redact(plain); got != plain {
		t.Errorf("non-secret text must not change: %q -> %q", plain, got)
	}
}

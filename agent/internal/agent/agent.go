package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type identity struct {
	AgentID     string `json:"agentId"`
	AgentSecret string `json:"agentSecret"`
}
type diagnosticRequest struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Tool      string `json:"tool"`
	Service   string `json:"service"`
}
type diagnosticResult struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Tool      string `json:"tool"`
	Ok        bool   `json:"ok"`
	Content   string `json:"content"`
}
type telemetry struct {
	Type           string            `json:"type"`
	Timestamp      string            `json:"timestamp"`
	CPUPercent     float64           `json:"cpuPercent"`
	MemoryPercent  float64           `json:"memoryPercent"`
	DiskPercent    float64           `json:"diskPercent"`
	NetworkRxBytes uint64            `json:"networkRxBytes"`
	NetworkTxBytes uint64            `json:"networkTxBytes"`
	UptimeSeconds  uint64            `json:"uptimeSeconds"`
	ConfigHashes   map[string]string `json:"configHashes"`
}

// protocolVersion is the agent wire protocol version reported on enrollment and hello.
const protocolVersion = 2

// agentVersion identifies the running binary; overridable at build time via -ldflags.
var agentVersion = "0.1.0"

// advertisedCapabilities lists what this agent can do by default; the Hub negotiates the
// intersection. `config_diffs` is appended only when the operator opted in via
// OPSPILOT_CONFIG_DIFFS=true (see capabilitiesFor).
var advertisedCapabilities = []string{"telemetry", "systemd_status", "diagnostics"}

// capabilitiesFor returns the capabilities this agent advertises for the given config:
// the base set plus "config_diffs" only when controlled config diffs are enabled locally.
func capabilitiesFor(cfg config) []string {
	caps := make([]string, 0, len(advertisedCapabilities)+1)
	caps = append(caps, advertisedCapabilities...)
	if cfg.ConfigDiffs {
		caps = append(caps, "config_diffs")
	}
	return caps
}

type helloMessage struct {
	Type            string   `json:"type"`
	ProtocolVersion int      `json:"protocolVersion"`
	AgentVersion    string   `json:"agentVersion"`
	Capabilities    []string `json:"capabilities"`
}

type helloAck struct {
	Type            string   `json:"type"`
	ProtocolVersion int      `json:"protocolVersion"`
	Capabilities    []string `json:"capabilities"`
}

// capabilitiesRequiringAck lists opt-in capabilities that must be explicitly confirmed in
// hello_ack before the agent emits their frames (older Hubs without hello_ack or without
// the capability never receive them).
var capabilitiesRequiringAck = map[string]bool{
	"config_diffs": true,
}

// capabilitySet tracks the negotiated capabilities; before any ack it defaults to all
// advertised base capabilities while holding back opt-in ack-gated ones like config_diffs.
type capabilitySet struct {
	mu         sync.Mutex
	advertised []string
	set        map[string]bool
}

func newCapabilitySet(capabilities ...string) *capabilitySet {
	if len(capabilities) == 0 {
		capabilities = advertisedCapabilities
	}
	set := map[string]bool{}
	for _, c := range capabilities {
		if !capabilitiesRequiringAck[c] {
			set[c] = true
		}
	}
	return &capabilitySet{advertised: capabilities, set: set}
}

func (c *capabilitySet) has(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.set[name]
}

// applyAck restricts the set to the Hub-negotiated intersection of advertised capabilities.
func (c *capabilitySet) applyAck(ack helloAck) {
	c.mu.Lock()
	defer c.mu.Unlock()
	next := map[string]bool{}
	for _, advertised := range c.advertised {
		for _, negotiated := range ack.Capabilities {
			if negotiated == advertised {
				next[advertised] = true
			}
		}
	}
	c.set = next
}

type enrollRequest struct {
	Token           string   `json:"token"`
	Hostname        string   `json:"hostname"`
	Version         string   `json:"version"`
	ProtocolVersion int      `json:"protocolVersion"`
	Capabilities    []string `json:"capabilities"`
}

type config struct {
	HubURL, StatePath, ProcRoot, DiskPath string
	Interval                              time.Duration
	AllowedServices                       map[string]bool
	ConfigFiles                           []string
	ConfigDiffs                           bool
	Docker                                bool
	WorkloadDocker                        bool
	WorkloadSystemd                       bool
	SystemdUnit                           string
	QueuePath                             string
	MaxQueueEntries                       int
	MaxQueueAge                           time.Duration
}
type safeConn struct {
	mu sync.Mutex
	ws *websocket.Conn
}

func (c *safeConn) send(v interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.ws.WriteJSON(v)
}
func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func splitCSV(v string) []string {
	var out []string
	for _, x := range strings.Split(v, ",") {
		x = strings.TrimSpace(x)
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}
func readConfig() config {
	home, _ := os.UserHomeDir()
	if home == "" {
		home = "/tmp"
	}
	seconds, _ := strconv.Atoi(env("OPSPILOT_INTERVAL_SECONDS", "15"))
	if seconds < 5 {
		seconds = 5
	}
	if seconds > 3600 {
		seconds = 3600
	}
	allowed := map[string]bool{}
	for _, s := range splitCSV(env("OPSPILOT_ALLOWED_SERVICES", "nginx,docker,sshd")) {
		if regexp.MustCompile(`^[a-zA-Z0-9_.@-]{1,80}$`).MatchString(s) {
			allowed[s] = true
		}
	}
	return config{HubURL: strings.TrimRight(env("OPSPILOT_HUB_URL", "http://localhost:3001"), "/"), StatePath: env("OPSPILOT_AGENT_STATE_PATH", filepath.Join(home, ".local", "share", "opspilot-agent", "identity.json")), ProcRoot: env("OPSPILOT_PROC_ROOT", "/proc"), DiskPath: env("OPSPILOT_DISK_PATH", "/"), Interval: time.Duration(seconds) * time.Second, AllowedServices: allowed, ConfigFiles: splitCSV(env("OPSPILOT_CONFIG_FILES", "")), ConfigDiffs: env("OPSPILOT_CONFIG_DIFFS", "false") == "true", Docker: env("OPSPILOT_ENABLE_DOCKER", "false") == "true", WorkloadDocker: env("OPSPILOT_WORKLOADS_DOCKER", "false") == "true", WorkloadSystemd: env("OPSPILOT_WORKLOADS_SYSTEMD", "false") == "true", SystemdUnit: os.Getenv("OPSPILOT_SYSTEMD_UNIT"),
		QueuePath:       env("OPSPILOT_QUEUE_PATH", filepath.Join(home, ".local", "share", "opspilot-agent", "queue.jsonl")),
		MaxQueueEntries: clampInt(env("OPSPILOT_QUEUE_MAX_ENTRIES", "2000"), 1, 100_000, 2000),
		MaxQueueAge:     time.Duration(clampInt(env("OPSPILOT_QUEUE_MAX_AGE_SECONDS", "86400"), 60, 604_800, 86_400)) * time.Second,
	}
}

func clampInt(raw string, min, max, fallback int) int {
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || v < min || v > max {
		return fallback
	}
	return v
}
func readIdentity(path string) (identity, error) {
	var id identity
	b, err := os.ReadFile(path)
	if err != nil {
		return id, err
	}
	err = json.Unmarshal(b, &id)
	if !validIdentity(id) {
		return id, errors.New("invalid agent identity")
	}
	return id, err
}
func saveIdentity(path string, id identity) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(id)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".identity-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

var agentIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func validIdentity(id identity) bool {
	return agentIDPattern.MatchString(id.AgentID) && strings.TrimSpace(id.AgentSecret) != ""
}
func enroll(cfg config) (identity, error) {
	var id identity
	token := os.Getenv("OPSPILOT_ENROLL_TOKEN")
	if token == "" {
		return id, errors.New("set OPSPILOT_ENROLL_TOKEN to a fresh one-time token")
	}
	hostname, _ := os.Hostname()
	payload, _ := json.Marshal(enrollRequest{Token: token, Hostname: hostname, Version: agentVersion, ProtocolVersion: protocolVersion, Capabilities: capabilitiesFor(cfg)})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.HubURL+"/api/agents/enroll", bytes.NewReader(payload))
	if err != nil {
		return id, errors.New("invalid enrollment request")
	}
	req.Header.Set("content-type", "application/json")
	client, err := hubHTTPClient()
	if err != nil {
		return id, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return id, errors.New("enrollment request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return id, fmt.Errorf("enrollment rejected: HTTP %d", resp.StatusCode)
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&id); err != nil || !validIdentity(id) {
		return identity{}, errors.New("invalid enrollment response")
	}
	return id, nil
}
func wsAddress(base string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return "", errors.New("Hub URL must start with http:// or https://")
	}
	parsed.Path = "/api/agents/connect"
	parsed.RawQuery = ""
	return parsed.String(), nil
}
func loadOrEnroll(cfg config) (identity, error) {
	id, err := readIdentity(cfg.StatePath)
	if os.IsNotExist(err) {
		id, err = enroll(cfg)
		if err != nil {
			return id, err
		}
		if err = saveIdentity(cfg.StatePath, id); err != nil {
			return id, err
		}
		log.Printf("Agent enrolled; identity saved at %s", cfg.StatePath)
	}
	return id, err
}

// EnrollOnly persists an identity without starting the reconnect loop.
func EnrollOnly() error {
	raw := os.Getenv("OPSPILOT_HUB_URL")
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery ||
		u.Fragment != "" || strings.ContainsAny(raw, "?#\\\r\n\t ") {
		return errors.New("enroll requires an HTTPS Hub origin without credentials, path, query or fragment")
	}
	_, err = loadOrEnroll(readConfig())
	return err
}

func startTelemetrySampler(ctx context.Context, cfg config, sampler *cpuSampler, queue *diskQueue, notify chan<- struct{}) {
	pushSample := func() {
		t := sample(cfg, sampler)
		if err := queue.push(t); err != nil {
			log.Printf("telemetry queue write failed: %v", err)
			return
		}
		select {
		case notify <- struct{}{}:
		default:
		}
	}
	pushSample()
	go func() {
		tick := time.NewTicker(cfg.Interval)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				pushSample()
			}
		}
	}()
}

func Run() error {
	cfg := readConfig()
	id, err := loadOrEnroll(cfg)
	if err != nil {
		return err
	}
	endpoint, err := wsAddress(cfg.HubURL)
	if err != nil {
		return err
	}
	sampler := newCPUSampler(cfg.ProcRoot)
	// Durable bounded queue: opened once at startup so sampling continues while the Hub is unreachable.
	queue, err := openQueue(cfg.QueuePath, cfg.MaxQueueEntries, cfg.MaxQueueAge)
	if err != nil {
		log.Printf("telemetry queue unavailable (%v); sending without durable buffering", err)
		queue = nil
	}
	var notify chan struct{}
	if queue != nil {
		notify = make(chan struct{}, 1)
		startTelemetrySampler(context.Background(), cfg, sampler, queue, notify)
	}
	dialer, err := websocketDialer()
	if err != nil {
		return err
	}
	log.Printf("OpsPilot agent starting; hub=%s interval=%s", cfg.HubURL, cfg.Interval)
	for {
		header := http.Header{}
		header.Set("Authorization", "Bearer "+id.AgentSecret)
		header.Set("X-OpsPilot-Agent-ID", id.AgentID)
		conn, response, err := dialer.Dial(endpoint, header)
		if err != nil {
			if response != nil {
				log.Printf("websocket denied: HTTP %d", response.StatusCode)
			}
			log.Printf("connection failed: %v; retrying", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Print("Connected to OpsPilot Hub")
		runConnection(conn, cfg, sampler, queue, notify)
		log.Print("Disconnected; retrying")
		time.Sleep(5 * time.Second)
	}
}
func runConnection(ws *websocket.Conn, cfg config, sampler *cpuSampler, queue *diskQueue, notify <-chan struct{}) {
	defer ws.Close()
	conn := &safeConn{ws: ws}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	caps := newCapabilitySet(capabilitiesFor(cfg)...)

	// Report wire protocol version and capabilities first; the Hub answers with hello_ack.
	if err := conn.send(helloMessage{Type: "hello", ProtocolVersion: protocolVersion, AgentVersion: agentVersion, Capabilities: capabilitiesFor(cfg)}); err != nil {
		log.Printf("hello send failed: %v", err)
		return
	}

	// Controlled config snapshots: strictly opt-in (OPSPILOT_CONFIG_DIFFS=true) and gated on
	// the Hub-negotiated "config_diffs" capability. The initial sync runs upon hello_ack;
	// this ticker only polls for subsequent hash changes once negotiated.
	drift := newDriftTracker()
	if cfg.ConfigDiffs {
		go func() {
			tick := time.NewTicker(driftInterval)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					drift.sync(conn, cfg, caps)
				}
			}
		}()
	}

	if queue != nil {
		if caps.has("telemetry") {
			flushQueue(conn, queue)
		}
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case <-notify:
					if caps.has("telemetry") {
						flushQueue(conn, queue)
					}
				}
			}
		}()
	} else {
		sendDirect := func() {
			if !caps.has("telemetry") {
				return
			}
			if err := conn.send(sample(cfg, sampler)); err != nil {
				log.Printf("telemetry send failed: %v", err)
			}
		}
		sendDirect()
		go func() {
			tick := time.NewTicker(cfg.Interval)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					sendDirect()
				}
			}
		}()
	}
	go func() {
		tick := time.NewTicker(systemdInterval)
		defer tick.Stop()
		for {
			report := collectSystemd(ctx, cfg.SystemdUnit, querySystemd)
			if ctx.Err() != nil {
				return
			}
			if caps.has("systemd_status") {
				if err := conn.send(report); err != nil {
					log.Printf("systemd status send failed: %v", err)
					return
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()
	go func() {
		tick := time.NewTicker(workloadInterval)
		defer tick.Stop()
		for {
			report := collectWorkloads(ctx, cfg, systemdManagerBooted(), runBoundedCommand, runBoundedCommand)
			if ctx.Err() != nil {
				return
			}
			if err := conn.send(report); err != nil {
				log.Printf("workload inventory send failed: %v", err)
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()
	ws.SetReadLimit(64 * 1024)
	for {
		var envelope struct {
			Type            string   `json:"type"`
			RequestID       string   `json:"requestId"`
			Tool            string   `json:"tool"`
			Service         string   `json:"service"`
			ProtocolVersion int      `json:"protocolVersion"`
			Capabilities    []string `json:"capabilities"`
		}
		if err := ws.ReadJSON(&envelope); err != nil {
			return
		}
		switch envelope.Type {
		case "hello_ack":
			caps.applyAck(helloAck{Type: envelope.Type, ProtocolVersion: envelope.ProtocolVersion, Capabilities: envelope.Capabilities})
			// Re-sync after negotiation so snapshots are only sent when the Hub actually
			// negotiated "config_diffs" (no-op when nothing changed since connect).
			drift.sync(conn, cfg, caps)
		case "diagnostic_request":
			if len(envelope.RequestID) > 100 || !caps.has("diagnostics") {
				continue
			}
			request := diagnosticRequest{Type: envelope.Type, RequestID: envelope.RequestID, Tool: envelope.Tool, Service: envelope.Service}
			go func(r diagnosticRequest) {
				ok, out := inspect(cfg, r)
				res := diagnosticResult{Type: "diagnostic_result", RequestID: r.RequestID, Tool: r.Tool, Ok: ok, Content: redact(out)}
				if err := conn.send(res); err != nil {
					log.Printf("result send failed: %v", err)
				}
			}(request)
		}
	}
}
func sample(cfg config, cpu *cpuSampler) telemetry {
	rx, tx := networkBytes(cfg.ProcRoot)
	return telemetry{Type: "telemetry", Timestamp: time.Now().UTC().Format(time.RFC3339), CPUPercent: cpu.percent(), MemoryPercent: memoryPercent(cfg.ProcRoot), DiskPercent: diskPercent(cfg.DiskPath), NetworkRxBytes: rx, NetworkTxBytes: tx, UptimeSeconds: uptime(cfg.ProcRoot), ConfigHashes: configHashes(cfg.ConfigFiles)}
}
func inspect(cfg config, r diagnosticRequest) (bool, string) {
	if r.Tool == "disk_usage" {
		return runCommand("df", "-h", cfg.DiskPath)
	}
	if r.Tool == "listening_ports" {
		return runCommand("ss", "-lnt")
	}
	if r.Tool == "docker_status" {
		if !cfg.Docker {
			return false, "Docker inspection disabled by agent configuration"
		}
		return runCommand("docker", "ps", "--format", "{{.Names}} {{.Status}} {{.Ports}}")
	}
	if r.Tool == "service_status" || r.Tool == "recent_logs" {
		if !cfg.AllowedServices[r.Service] {
			return false, "Service not allowlisted"
		}
		if r.Tool == "service_status" {
			return runCommand("systemctl", "is-active", r.Service)
		}
		return runCommand("journalctl", "-u", r.Service, "-n", "50", "--no-pager", "--output", "short-iso")
	}
	return false, "Unknown diagnostic tool"
}
func runCommand(binary string, args ...string) (bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binary, args...).CombinedOutput()
	result := string(out)
	if len(result) > 5500 {
		result = result[:5500] + "\n[TRUNCATED]"
	}
	if err != nil {
		return false, fmt.Sprintf("%v: %s", err, result)
	}
	return true, result
}

// redactRule pairs a secret pattern with its replacement; ${1} refers to capture group 1
// (the key/prefix to preserve). Applied in order by redact and redactWithCount.
type redactRule struct {
	re          *regexp.Regexp
	replacement string
}

// redactRules cover Bearer/Basic/Digest tokens, password/passwd/pwd/api_key/token/secret
// assignments, *_PASSWORD/*_SECRET/*_KEY/*_TOKEN env/INI keys, AWS AKIA/ASIA keys, GitHub
// gh[pousr]_/github_pat_ tokens, PEM private key blocks, Slack xox* tokens, sk- API keys,
// JWTs and URL userinfo credentials (scheme://user:pass@host).
var redactRules = []redactRule{
	{regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer|basic|digest|token)\s+)\S+`), "${1}[REDACTED]"},
	{regexp.MustCompile(`(?i)((?:password|passwd|pwd|api[_-]?key|token|secret)\s*[:=]\s*["']?)[^\s,;"']+`), "${1}[REDACTED]"},
	{regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*(?:password|secret|key|token)\s*[:=]\s*["']?)[^\s,;"']+`), "${1}[REDACTED]"},
	{regexp.MustCompile(`\b((?:AKIA|ASIA)[0-9A-Z]{16})\b`), "[REDACTED_AWS_KEY]"},
	{regexp.MustCompile(`\b(gh[pousr]_[A-Za-z0-9_]{20,})\b`), "[REDACTED_GITHUB_TOKEN]"},
	{regexp.MustCompile(`\b(github_pat_[A-Za-z0-9_]{20,})\b`), "[REDACTED_GITHUB_TOKEN]"},
	{regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`), "[REDACTED_PRIVATE_KEY]"},
	{regexp.MustCompile(`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`), "[REDACTED_SLACK_TOKEN]"},
	{regexp.MustCompile(`\b(sk-[A-Za-z0-9_-]{16,})\b`), "[REDACTED]"},
	{regexp.MustCompile(`\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b`), "[REDACTED_JWT]"},
	{regexp.MustCompile(`([a-z][a-z0-9+.-]*://)([^\s/:@]+):([^\s@]+)@`), "${1}[REDACTED]:[REDACTED]@"},
}

func redact(raw string) string {
	for _, rule := range redactRules {
		raw = rule.re.ReplaceAllString(raw, rule.replacement)
	}
	return raw
}
func configHashes(paths []string) map[string]string {
	hashes := map[string]string{}
	for _, p := range paths {
		if len(hashes) >= 20 {
			break
		}
		if !filepath.IsAbs(p) {
			continue
		}
		fi, err := os.Lstat(p)
		if err != nil || !fi.Mode().IsRegular() || fi.Size() > 1024*1024 {
			continue
		}
		file, err := os.Open(p)
		if err != nil {
			continue
		}
		h := sha256.New()
		_, err = io.Copy(h, io.LimitReader(file, 1024*1024+1))
		file.Close()
		if err == nil {
			hashes[p] = hex.EncodeToString(h.Sum(nil))
		}
	}
	return hashes
}
func diskPercent(path string) float64 {
	var s syscall.Statfs_t
	if syscall.Statfs(path, &s) != nil || s.Blocks == 0 {
		return 0
	}
	return clamp(100 * float64(s.Blocks-s.Bavail) / float64(s.Blocks))
}
func clamp(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
func parseMem(data []byte) map[string]uint64 {
	values := map[string]uint64{}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			n, err := strconv.ParseUint(f[1], 10, 64)
			if err == nil {
				values[strings.TrimSuffix(f[0], ":")] = n
			}
		}
	}
	return values
}
func memoryPercent(root string) float64 {
	data, err := os.ReadFile(filepath.Join(root, "meminfo"))
	if err != nil {
		return 0
	}
	m := parseMem(data)
	if m["MemTotal"] == 0 || m["MemAvailable"] > m["MemTotal"] {
		return 0
	}
	return clamp(100 * float64(m["MemTotal"]-m["MemAvailable"]) / float64(m["MemTotal"]))
}
func uptime(root string) uint64 {
	raw, err := os.ReadFile(filepath.Join(root, "uptime"))
	if err != nil {
		return 0
	}
	f := strings.Fields(string(raw))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return uint64(v)
}
func networkBytes(root string) (uint64, uint64) {
	data, err := os.ReadFile(filepath.Join(root, "net", "dev"))
	if err != nil {
		return 0, 0
	}
	var rx, tx uint64
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "lo" {
			continue
		}
		f := strings.Fields(parts[1])
		if len(f) < 16 {
			continue
		}
		r, _ := strconv.ParseUint(f[0], 10, 64)
		t, _ := strconv.ParseUint(f[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

type cpuSampler struct {
	root                string
	prevTotal, prevIdle uint64
	mu                  sync.Mutex
}

func newCPUSampler(root string) *cpuSampler { return &cpuSampler{root: root} }
func (c *cpuSampler) percent() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	raw, err := os.ReadFile(filepath.Join(c.root, "stat"))
	if err != nil {
		return 0
	}
	first := strings.SplitN(string(raw), "\n", 2)[0]
	fields := strings.Fields(first)
	if len(fields) < 6 || fields[0] != "cpu" {
		return 0
	}
	var total, idle uint64
	for i := 1; i < len(fields) && i <= 8; i++ {
		n, _ := strconv.ParseUint(fields[i], 10, 64)
		total += n
		if i == 4 || i == 5 {
			idle += n
		}
	}
	if c.prevTotal == 0 {
		c.prevTotal = total
		c.prevIdle = idle
		return 0
	}
	dt, di := total-c.prevTotal, idle-c.prevIdle
	c.prevTotal = total
	c.prevIdle = idle
	if dt == 0 {
		return 0
	}
	return clamp(100 * float64(dt-di) / float64(dt))
}

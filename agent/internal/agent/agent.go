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

type config struct {
	HubURL, StatePath, ProcRoot, DiskPath string
	Interval                              time.Duration
	AllowedServices                       map[string]bool
	ConfigFiles                           []string
	Docker                                bool
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
	return config{HubURL: strings.TrimRight(env("OPSPILOT_HUB_URL", "http://localhost:3001"), "/"), StatePath: env("OPSPILOT_AGENT_STATE_PATH", filepath.Join(home, ".local", "share", "opspilot-agent", "identity.json")), ProcRoot: env("OPSPILOT_PROC_ROOT", "/proc"), DiskPath: env("OPSPILOT_DISK_PATH", "/"), Interval: time.Duration(seconds) * time.Second, AllowedServices: allowed, ConfigFiles: splitCSV(env("OPSPILOT_CONFIG_FILES", "")), Docker: env("OPSPILOT_ENABLE_DOCKER", "false") == "true"}
}
func readIdentity(path string) (identity, error) {
	var id identity
	b, err := os.ReadFile(path)
	if err != nil {
		return id, err
	}
	err = json.Unmarshal(b, &id)
	if id.AgentID == "" || id.AgentSecret == "" {
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
	return os.WriteFile(path, b, 0600)
}
func enroll(cfg config) (identity, error) {
	var id identity
	token := os.Getenv("OPSPILOT_ENROLL_TOKEN")
	if token == "" {
		return id, errors.New("set OPSPILOT_ENROLL_TOKEN to a fresh one-time token")
	}
	hostname, _ := os.Hostname()
	payload, _ := json.Marshal(map[string]string{"token": token, "hostname": hostname, "version": "0.1.0"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.HubURL+"/api/agents/enroll", bytes.NewReader(payload))
	if err != nil {
		return id, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return id, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return id, fmt.Errorf("enrollment rejected: HTTP %d", resp.StatusCode)
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&id)
	return id, err
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
func Run() error {
	cfg := readConfig()
	id, err := readIdentity(cfg.StatePath)
	if os.IsNotExist(err) {
		id, err = enroll(cfg)
		if err != nil {
			return err
		}
		if err = saveIdentity(cfg.StatePath, id); err != nil {
			return err
		}
		log.Printf("Agent enrolled; identity saved at %s", cfg.StatePath)
	}
	if err != nil {
		return err
	}
	endpoint, err := wsAddress(cfg.HubURL)
	if err != nil {
		return err
	}
	log.Printf("OpsPilot agent starting; hub=%s interval=%s", cfg.HubURL, cfg.Interval)
	for {
		header := http.Header{}
		header.Set("Authorization", "Bearer "+id.AgentSecret)
		header.Set("X-OpsPilot-Agent-ID", id.AgentID)
		conn, response, err := websocket.DefaultDialer.Dial(endpoint, header)
		if err != nil {
			if response != nil {
				log.Printf("websocket denied: HTTP %d", response.StatusCode)
			}
			log.Printf("connection failed: %v; retrying", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Print("Connected to OpsPilot Hub")
		runConnection(conn, cfg)
		log.Print("Disconnected; retrying")
		time.Sleep(5 * time.Second)
	}
}
func runConnection(ws *websocket.Conn, cfg config) {
	defer ws.Close()
	conn := &safeConn{ws: ws}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sampler := newCPUSampler(cfg.ProcRoot)
	sendTelemetry := func() {
		t := sample(cfg, sampler)
		if err := conn.send(t); err != nil {
			log.Printf("telemetry send failed: %v", err)
		}
	}
	sendTelemetry()
	go func() {
		tick := time.NewTicker(cfg.Interval)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				sendTelemetry()
			}
		}
	}()
	ws.SetReadLimit(64 * 1024)
	for {
		var request diagnosticRequest
		if err := ws.ReadJSON(&request); err != nil {
			return
		}
		if request.Type != "diagnostic_request" || len(request.RequestID) > 100 {
			continue
		}
		go func(r diagnosticRequest) {
			ok, out := inspect(cfg, r)
			res := diagnosticResult{Type: "diagnostic_result", RequestID: r.RequestID, Tool: r.Tool, Ok: ok, Content: redact(out)}
			if err := conn.send(res); err != nil {
				log.Printf("result send failed: %v", err)
			}
		}(request)
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

var patterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization\s*[:=]\s*bearer\s+)\S+`),
	regexp.MustCompile(`(?i)((?:password|api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+`),
}

func redact(raw string) string {
	for _, re := range patterns {
		raw = re.ReplaceAllString(raw, "${1}[REDACTED]")
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

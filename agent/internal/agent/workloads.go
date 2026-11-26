package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	workloadInterval     = 60 * time.Second
	workloadCmdTimeout   = 5 * time.Second
	workloadOutputCap    = 32 * 1024
	workloadStderrCap    = 4 * 1024
	maxWorkloadEntries   = 64
	workloadReportBudget = 16 * 1024
	workloadVersion      = 1
	maxWorkloadCPUPerc   = 25600.0 // 256 cores at 100%
	maxWorkloadMemBytes  = 1 << 50 // 1 PiB cap; untyped constant, compared as float64
)

var dockerContainerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

type workloadEntry struct {
	Name        string   `json:"name"`
	Runtime     string   `json:"runtime"`
	State       string   `json:"state"`
	CPUPerc     *float64 `json:"cpuPercent,omitempty"`
	MemoryBytes *int64   `json:"memoryBytes,omitempty"`
}

// workloadInventory is the v1 opt-in read-only Docker/systemd inventory frame.
type workloadInventory struct {
	Type       string          `json:"type"`
	Version    int             `json:"version"`
	ObservedAt string          `json:"observedAt"`
	Status     string          `json:"status"`
	Reason     string          `json:"reason,omitempty"`
	Skipped    []string        `json:"skipped,omitempty"`
	Workloads  []workloadEntry `json:"workloads,omitempty"`
}

// MarshalJSON always emits the workloads array for an ok report so the Hub can
// distinguish a successful empty scan from a missing/failure status.
func (r workloadInventory) MarshalJSON() ([]byte, error) {
	m := map[string]any{
		"type": r.Type, "version": r.Version, "observedAt": r.ObservedAt, "status": r.Status,
	}
	if r.Reason != "" {
		m["reason"] = r.Reason
	}
	if len(r.Skipped) > 0 {
		m["skipped"] = r.Skipped
	}
	if r.Status == "ok" {
		if r.Workloads == nil {
			m["workloads"] = []workloadEntry{}
		} else {
			m["workloads"] = r.Workloads
		}
	}
	return json.Marshal(m)
}

type collectorResult struct {
	entries     []workloadEntry
	ok          bool
	unsupported bool
	reason      string
}

// commandQuery runs one fixed command and returns capped stdout/stderr. Injected for tests.
type commandQuery func(ctx context.Context, args ...string) (string, string, error)

type boundedOutput struct {
	buf bytes.Buffer
	cap int
}

func (out *boundedOutput) Write(p []byte) (int, error) {
	if out.buf.Len()+len(p) > out.cap {
		if remaining := out.cap - out.buf.Len(); remaining > 0 {
			out.buf.Write(p[:remaining])
		}
		return 0, errors.New("output cap exceeded")
	}
	return out.buf.Write(p)
}

// runBoundedCommand executes a constant executable/argument shape without a shell,
// with a 5s deadline, minimal environment and capped output.
func runBoundedCommand(ctx context.Context, args ...string) (string, string, error) {
	if len(args) == 0 {
		return "", "", errors.New("no command")
	}
	ctx, cancel := context.WithTimeout(ctx, workloadCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Env = []string{"LC_ALL=C"}
	cmd.WaitDelay = 100 * time.Millisecond
	var stdout, stderr boundedOutput
	stdout.cap, stderr.cap = workloadOutputCap, workloadStderrCap
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		err = context.DeadlineExceeded
	}
	return stdout.buf.String(), stderr.buf.String(), err
}

func systemdManagerBooted() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	// sd_booted(3) uses this directory to detect a booted systemd manager.
	_, err := os.Stat("/run/systemd/system")
	return err == nil
}

func classifyDockerError(err error, stderr string) (unsupported bool, reason string) {
	if errors.Is(err, exec.ErrNotFound) {
		return true, "docker_cli_missing"
	}
	if strings.Contains(stderr, "Cannot connect to the Docker daemon") {
		return false, "docker_daemon_unreachable"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return false, "command_timeout"
	}
	if strings.Contains(stderr, "permission denied") {
		return false, "permission_denied"
	}
	return false, "command_failed"
}

func classifySystemdError(err error, stderr string) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "command_timeout"
	}
	if strings.Contains(stderr, "permission denied") {
		return "permission_denied"
	}
	return "command_failed"
}

func dockerState(state string) string {
	switch state {
	case "running", "restarting":
		return "running"
	case "created", "exited", "paused", "removing":
		return "stopped"
	case "dead":
		return "failed"
	default:
		return "unknown"
	}
}

func systemdActiveState(active string) string {
	switch active {
	case "active", "reloading", "refreshing":
		return "running"
	case "inactive":
		return "stopped"
	case "failed":
		return "failed"
	default:
		return "unknown"
	}
}

func parseDockerPs(out string) []workloadEntry {
	var entries []workloadEntry
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(fields) < 3 {
			continue
		}
		name := fields[0]
		if !dockerContainerName.MatchString(name) || seen[name] {
			continue
		}
		seen[name] = true
		entries = append(entries, workloadEntry{Name: name, Runtime: "docker", State: dockerState(fields[1])})
		if len(entries) >= maxWorkloadEntries {
			break
		}
	}
	return entries
}

func parseDockerCPU(s string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > maxWorkloadCPUPerc {
		return 0, false
	}
	return v, true
}

func parseDockerMemory(s string) (int64, bool) {
	// docker reports "<used> / <limit>"; only the used part is kept.
	used := s
	if idx := strings.Index(used, "/"); idx >= 0 {
		used = used[:idx]
	}
	used = strings.TrimSpace(used)
	if used == "" || used == "--" {
		return 0, false
	}
	units := []struct {
		suffix string
		mult   float64
	}{
		{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30}, {"TiB", 1 << 40}, {"PiB", 1 << 50},
		{"kB", 1e3}, {"MB", 1e6}, {"GB", 1e9}, {"TB", 1e12}, {"PB", 1e15}, {"B", 1},
	}
	mult := 1.0
	num := used
	for _, unit := range units {
		if strings.HasSuffix(used, unit.suffix) {
			mult = unit.mult
			num = strings.TrimSpace(strings.TrimSuffix(used, unit.suffix))
			break
		}
	}
	v, err := strconv.ParseFloat(num, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v*mult > maxWorkloadMemBytes {
		return 0, false
	}
	return int64(v * mult), true
}

func applyDockerStats(entries []workloadEntry, out string) {
	byName := make(map[string]*workloadEntry, len(entries))
	for i := range entries {
		byName[entries[i].Name] = &entries[i]
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(fields) < 3 {
			continue
		}
		entry, ok := byName[fields[0]]
		if !ok {
			continue
		}
		if cpu, ok := parseDockerCPU(fields[1]); ok {
			entry.CPUPerc = &cpu
		}
		if mem, ok := parseDockerMemory(fields[2]); ok {
			entry.MemoryBytes = &mem
		}
	}
}

// collectDockerInventory lists containers and their resource usage via fixed docker CLI reads.
func collectDockerInventory(ctx context.Context, query commandQuery) collectorResult {
	out, stderr, err := query(ctx, "docker", "ps", "--all", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}")
	if err != nil {
		unsupported, reason := classifyDockerError(err, stderr)
		return collectorResult{unsupported: unsupported, reason: reason}
	}
	entries := parseDockerPs(out)
	// Resource stats are best-effort; a stats failure never erases the process inventory.
	if statsOut, _, statsErr := query(ctx, "docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"); statsErr == nil {
		applyDockerStats(entries, statsOut)
	}
	return collectorResult{entries: entries, ok: true}
}

func parseSystemdUnits(out string) []workloadEntry {
	var entries []workloadEntry
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		unit, load := fields[0], fields[1]
		if load == "not-found" || !systemdUnitName.MatchString(unit) || seen[unit] {
			continue
		}
		seen[unit] = true
		entries = append(entries, workloadEntry{Name: unit, Runtime: "systemd", State: systemdActiveState(fields[2])})
		if len(entries) >= maxWorkloadEntries {
			break
		}
	}
	return entries
}

// collectSystemdInventory lists service units via one fixed systemctl read.
func collectSystemdInventory(ctx context.Context, booted bool, query commandQuery) collectorResult {
	if !booted {
		return collectorResult{unsupported: true, reason: "systemd_manager_missing"}
	}
	out, stderr, err := query(ctx, "/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password",
		"list-units", "--type=service", "--all", "--no-legend", "--plain")
	if err != nil {
		return collectorResult{reason: classifySystemdError(err, stderr)}
	}
	return collectorResult{entries: parseSystemdUnits(out), ok: true}
}

// fitWorkloadBudget drops trailing entries until the marshaled frame fits the wire budget.
func fitWorkloadBudget(r *workloadInventory) {
	for {
		b, err := json.Marshal(r)
		if err != nil || len(b) <= workloadReportBudget {
			return
		}
		if len(r.Workloads) == 0 {
			return
		}
		r.Workloads = r.Workloads[:len(r.Workloads)-1]
	}
}

// collectWorkloads merges the opt-in collectors into one bounded v1 report.
// Status precedence: disabled (nothing opted in) < ok (at least one collector measured,
// failed collectors listed in skipped) < unavailable (all enabled collectors failed) < unsupported.
func collectWorkloads(ctx context.Context, cfg config, booted bool, dockerQuery, systemdQuery commandQuery) (r workloadInventory) {
	r = workloadInventory{Type: "workload_inventory", Version: workloadVersion, Status: "disabled"}
	defer func() { r.ObservedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }()

	type outcome struct {
		collector string
		res       collectorResult
	}
	var outcomes []outcome
	if cfg.WorkloadDocker {
		outcomes = append(outcomes, outcome{"docker", collectDockerInventory(ctx, dockerQuery)})
	}
	if cfg.WorkloadSystemd {
		outcomes = append(outcomes, outcome{"systemd", collectSystemdInventory(ctx, booted, systemdQuery)})
	}
	if len(outcomes) == 0 {
		return r
	}

	okCount := 0
	failed := false
	var entries []workloadEntry
	var skipped []string
	var unsupportedReason, failReason string
	for _, o := range outcomes {
		if o.res.ok {
			okCount++
			entries = append(entries, o.res.entries...)
			continue
		}
		skipped = append(skipped, o.collector)
		if o.res.unsupported {
			if unsupportedReason == "" {
				unsupportedReason = o.res.reason
			}
		} else {
			failed = true
			if failReason == "" {
				failReason = o.res.reason
			}
		}
	}
	switch {
	case okCount > 0:
		r.Status = "ok"
		r.Skipped = skipped
		if len(entries) > maxWorkloadEntries {
			entries = entries[:maxWorkloadEntries]
		}
		if entries == nil {
			entries = []workloadEntry{}
		}
		r.Workloads = entries
		fitWorkloadBudget(&r)
	case failed:
		r.Status = "unavailable"
		r.Reason = failReason
	default:
		r.Status = "unsupported"
		r.Reason = unsupportedReason
	}
	return r
}

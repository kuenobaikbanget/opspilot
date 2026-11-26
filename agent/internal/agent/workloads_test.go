package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

func staticQuery(stdout, stderr string, err error) commandQuery {
	return func(context.Context, ...string) (string, string, error) {
		return stdout, stderr, err
	}
}

func TestParseDockerPsStatesAndNames(t *testing.T) {
	out := "web\trunning\tUp 2 hours\ndb\texited\tExited (0) 3 days ago\ncache\tdead\tDead\nweird\tpaused\tPaused\n" +
		"--bad-name\trunning\tUp\nweb\trunning\tduplicate\nno-tabs-here\n" + "c" + strings.Repeat("x", 128) + "\trunning\tUp\n"
	entries := parseDockerPs(out)
	states := map[string]string{}
	for _, e := range entries {
		states[e.Name] = e.State
		if e.Runtime != "docker" {
			t.Fatalf("unexpected runtime %q", e.Runtime)
		}
	}
	want := map[string]string{"web": "running", "db": "stopped", "cache": "failed", "weird": "stopped"}
	if len(states) != len(want) {
		t.Fatalf("got %d entries %v; want %d", len(entries), states, len(want))
	}
	for name, state := range want {
		if states[name] != state {
			t.Fatalf("container %s: got %q want %q", name, states[name], state)
		}
	}
}

func TestParseDockerPsCapsItems(t *testing.T) {
	var b strings.Builder
	for i := range 200 {
		b.WriteString("ctr-")
		b.WriteString(strconv.Itoa(i))
		b.WriteString("\trunning\tUp\n")
	}
	if got := len(parseDockerPs(b.String())); got != maxWorkloadEntries {
		t.Fatalf("got %d entries; want cap %d", got, maxWorkloadEntries)
	}
}

func TestParseDockerStatsResources(t *testing.T) {
	entries := parseDockerPs("web\trunning\tUp\ndb\texited\tExited\n")
	applyDockerStats(entries, "web\t0.50%\t1.5MiB / 7.9GiB\ndb\t0.00%\t0B / 0B\nghost\t9%\t9GiB\n")
	var web, db *workloadEntry
	for i := range entries {
		switch entries[i].Name {
		case "web":
			web = &entries[i]
		case "db":
			db = &entries[i]
		}
	}
	if web == nil || web.CPUPerc == nil || *web.CPUPerc != 0.5 {
		t.Fatalf("web cpu: %+v", web)
	}
	if web.MemoryBytes == nil || *web.MemoryBytes != 1572864 {
		t.Fatalf("web mem: %+v want 1572864", web)
	}
	if db == nil || db.CPUPerc == nil || *db.CPUPerc != 0 || db.MemoryBytes == nil || *db.MemoryBytes != 0 {
		t.Fatalf("db stats: %+v", db)
	}
}

func TestParseDockerResourceRejectsGarbage(t *testing.T) {
	for _, cpu := range []string{"--", "abc", "-1%", "99999%", ""} {
		if _, ok := parseDockerCPU(cpu); ok {
			t.Fatalf("accepted cpu %q", cpu)
		}
	}
	for _, mem := range []string{"--", "N/A", "1.5XiB", "-5MiB", "99999PiB", ""} {
		if _, ok := parseDockerMemory(mem); ok {
			t.Fatalf("accepted mem %q", mem)
		}
	}
	if v, ok := parseDockerMemory("2GiB / 8GiB"); !ok || v != 2<<30 {
		t.Fatalf("2GiB: got %d ok=%v", v, ok)
	}
	if v, ok := parseDockerCPU("100.25%"); !ok || v != 100.25 {
		t.Fatalf("100.25%%: got %v ok=%v", v, ok)
	}
}

func TestParseSystemdUnits(t *testing.T) {
	out := "nginx.service loaded active running nginx\n" +
		"backup@daily.service loaded inactive dead backup\n" +
		"broken.service loaded failed failed oops\n" +
		"ghost.service not-found inactive dead ghost\n" +
		"masked.service masked inactive dead masked\n" +
		"activating.service loaded activating auto activating\n" +
		"bad line\n" +
		"evil.service; rm -rf / loaded active running nope\n"
	entries := parseSystemdUnits(out)
	states := map[string]string{}
	for _, e := range entries {
		states[e.Name] = e.State
		if e.Runtime != "systemd" {
			t.Fatalf("unexpected runtime %q", e.Runtime)
		}
	}
	want := map[string]string{
		"nginx.service": "running", "backup@daily.service": "stopped", "broken.service": "failed",
		"masked.service": "stopped", "activating.service": "unknown",
	}
	if len(states) != len(want) {
		t.Fatalf("got %v; want %v", states, want)
	}
	for name, state := range want {
		if states[name] != state {
			t.Fatalf("unit %s: got %q want %q", name, states[name], state)
		}
	}
}

func TestCollectWorkloadsDisabledByDefault(t *testing.T) {
	cfg := config{}
	called := false
	query := func(context.Context, ...string) (string, string, error) {
		called = true
		return "", "", nil
	}
	r := collectWorkloads(context.Background(), cfg, true, query, query)
	if r.Status != "disabled" || r.Reason != "" || r.Workloads != nil || called {
		t.Fatalf("disabled config must not run collectors: %+v called=%v", r, called)
	}
	if r.Type != "workload_inventory" || r.Version != 1 || r.ObservedAt == "" {
		t.Fatalf("bad frame header: %+v", r)
	}
}

func TestCollectWorkloadsUnsupportedAndUnavailable(t *testing.T) {
	notFound := staticQuery("", "", exec.ErrNotFound)
	r := collectWorkloads(context.Background(), config{WorkloadDocker: true}, true, notFound, notFound)
	if r.Status != "unsupported" || r.Reason != "docker_cli_missing" || r.Workloads != nil {
		t.Fatalf("docker cli missing: %+v", r)
	}

	denied := staticQuery("", "permission denied", errors.New("exit status 1"))
	r = collectWorkloads(context.Background(), config{WorkloadDocker: true}, true, denied, denied)
	if r.Status != "unavailable" || r.Reason != "permission_denied" {
		t.Fatalf("denied docker: %+v", r)
	}

	r = collectWorkloads(context.Background(), config{WorkloadSystemd: true}, false, notFound, notFound)
	if r.Status != "unsupported" || r.Reason != "systemd_manager_missing" {
		t.Fatalf("no systemd manager: %+v", r)
	}
}

func TestCollectWorkloadsOkWithPartialSkip(t *testing.T) {
	cfg := config{WorkloadDocker: true, WorkloadSystemd: true}
	dockerQuery := func(_ context.Context, args ...string) (string, string, error) {
		if args[1] == "ps" {
			return "web\trunning\tUp\n", "", nil
		}
		return "web\t1.25%\t64MiB / 1GiB\n", "", nil
	}
	r := collectWorkloads(context.Background(), cfg, false, dockerQuery, staticQuery("", "", exec.ErrNotFound))
	if r.Status != "ok" || len(r.Workloads) != 1 || len(r.Skipped) != 1 || r.Skipped[0] != "systemd" {
		t.Fatalf("partial ok: %+v", r)
	}
	w := r.Workloads[0]
	if w.Name != "web" || w.State != "running" || w.CPUPerc == nil || *w.CPUPerc != 1.25 ||
		w.MemoryBytes == nil || *w.MemoryBytes != 64<<20 {
		t.Fatalf("entry not enriched with stats: %+v", w)
	}
	b, err := json.Marshal(r)
	if err != nil || len(b) > workloadReportBudget {
		t.Fatalf("frame exceeds budget: %d err=%v", len(b), err)
	}
}

func TestCollectWorkloadsEmptyScanIsOk(t *testing.T) {
	r := collectWorkloads(context.Background(), config{WorkloadDocker: true}, true, staticQuery("", "", nil), staticQuery("", "", nil))
	if r.Status != "ok" || len(r.Workloads) != 0 {
		t.Fatalf("successful empty collection must be ok with no entries: %+v", r)
	}
	// workloads must be present (not omitted) so the Hub can distinguish it from failure.
	b, _ := json.Marshal(r)
	if !strings.Contains(string(b), `"workloads":[]`) {
		t.Fatalf("empty scan must serialize an empty array: %s", b)
	}
}

func TestFitWorkloadBudget(t *testing.T) {
	r := workloadInventory{Type: "workload_inventory", Version: 1, Status: "ok"}
	for i := range maxWorkloadEntries {
		cpu := 1.5
		r.Workloads = append(r.Workloads, workloadEntry{
			Name: strings.Repeat("n", 100) + string(rune('a'+i%26)), Runtime: "docker", State: "running",
			CPUPerc: &cpu, MemoryBytes: new(int64),
		})
	}
	*r.Workloads[len(r.Workloads)-1].MemoryBytes = 1 << 40
	fitWorkloadBudget(&r)
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > workloadReportBudget {
		t.Fatalf("frame still %d bytes over budget %d", len(b), workloadReportBudget)
	}
	if len(r.Workloads) == 0 {
		t.Fatal("budget fit dropped every entry")
	}
}

func TestClassifyDockerError(t *testing.T) {
	for _, tc := range []struct {
		err      error
		stderr   string
		unsup    bool
		reason   string
	}{
		{exec.ErrNotFound, "", true, "docker_cli_missing"},
		{errors.New("exit status 1"), "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", false, "docker_daemon_unreachable"},
		{context.DeadlineExceeded, "", false, "command_timeout"},
		{errors.New("exit status 1"), "permission denied while connecting", false, "permission_denied"},
		{errors.New("exit status 1"), "weird", false, "command_failed"},
	} {
		unsup, reason := classifyDockerError(tc.err, tc.stderr)
		if unsup != tc.unsup || reason != tc.reason {
			t.Fatalf("classify(%v,%q) = %v,%q; want %v,%q", tc.err, tc.stderr, unsup, reason, tc.unsup, tc.reason)
		}
	}
}

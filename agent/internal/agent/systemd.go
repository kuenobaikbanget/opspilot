package agent

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const systemdInterval = 15 * time.Second

var systemdUnitName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,71}\.service$`)

var errSystemdUnsupported = errors.New("systemd system manager unavailable")

type systemdReport struct {
	Type       string `json:"type"`
	Version    int    `json:"version"`
	ObservedAt string `json:"observedAt"`
	Status     string `json:"status"`
	Unit       string `json:"unit,omitempty"`
	State      string `json:"state,omitempty"`
}

func collectSystemd(ctx context.Context, unit string, query func(context.Context, string) (string, error)) systemdReport {
	r := systemdReport{Type: "systemd_status", Version: 1, Status: "disabled"}
	switch {
	case unit == "": // Local operator has not opted in.
	case !systemdUnitName.MatchString(unit):
		r.Status = "unavailable"
	default:
		r.Unit = unit
		state, err := query(ctx, unit)
		switch {
		case errors.Is(err, errSystemdUnsupported):
			r.Status = "unsupported"
		case err != nil:
			r.Status = "unavailable"
		default:
			r.Status, r.State = "observed", state
		}
	}
	r.ObservedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	return r
}

func querySystemd(ctx context.Context, unit string) (string, error) {
	if runtime.GOOS != "linux" {
		return "", errSystemdUnsupported
	}
	// sd_booted(3) uses this directory to detect a booted systemd manager.
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", errSystemdUnsupported
		}
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", "show", "--property=LoadState,ActiveState", "--", unit)
	cmd.Env = []string{"LC_ALL=C"}
	cmd.WaitDelay = 100 * time.Millisecond
	var out systemdOutput
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", errSystemdUnsupported
		}
		return "", err
	}
	return parseSystemdState(out.buf.String())
}

type systemdOutput struct{ buf bytes.Buffer }

func (out *systemdOutput) Write(p []byte) (int, error) {
	if len(p) > 1024-out.buf.Len() {
		return 0, errors.New("systemctl output exceeded limit")
	}
	return out.buf.Write(p)
}

func parseSystemdState(output string) (string, error) {
	var load, active string
	// Require exactly one nonempty value for each property. A successful command
	// alone is insufficient: a nonexistent unit can print ActiveState=inactive.
	for _, line := range strings.Split(strings.TrimSuffix(output, "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok && value != "" {
			switch {
			case key == "LoadState" && load == "":
				load = value
				continue
			case key == "ActiveState" && active == "":
				active = value
				continue
			}
		}
		return "", errors.New("invalid systemctl properties")
	}
	if load == "loaded" {
		switch active {
		case "active", "reloading", "refreshing":
			return "running", nil
		case "inactive":
			return "stopped", nil
		case "failed":
			return "failed", nil
		case "activating", "deactivating", "maintenance":
			return "unknown", nil
		}
	}
	return "", errors.New("systemd unit state unavailable")
}

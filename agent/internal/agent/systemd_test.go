package agent

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
)

func TestSystemdState(t *testing.T) {
	for _, tc := range []struct{ name, properties, state string }{
		{"running", "LoadState=loaded\nActiveState=active\n", "running"},
		{"stopped", "ActiveState=inactive\nLoadState=loaded\n", "stopped"},
		{"failed", "LoadState=loaded\nActiveState=failed\n", "failed"},
		{"transition", "LoadState=loaded\nActiveState=activating\n", "unknown"},
		{"missing", "LoadState=not-found\nActiveState=inactive\n", ""},
		{"masked", "LoadState=masked\nActiveState=inactive\n", ""},
		{"truncated", "ActiveState=inactive\n", ""},
		{"duplicate", "LoadState=loaded\nActiveState=inactive\nActiveState=active\n", ""},
		{"unrecognized", "LoadState=loaded\nActiveState=unexpected\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state, err := parseSystemdState(tc.properties)
			if state != tc.state || (err != nil) != (tc.state == "") {
				t.Fatalf("got state=%q err=%v; want state=%q", state, err, tc.state)
			}
		})
	}
}

func TestSystemdCollectorSkipsDisabledAndInvalidConfiguration(t *testing.T) {
	for _, unit := range []string{"", "--all.service", "*.service", "nginx", "a.service,b.service", "a.service\n", "/tmp/a.service", strings.Repeat("a", 73) + ".service"} {
		t.Run(unit, func(t *testing.T) {
			r := collectSystemd(context.Background(), unit, func(context.Context, string) (string, error) {
				t.Fatal("query invoked for disabled or invalid unit")
				return "", nil
			})
			want := "unavailable"
			if unit == "" {
				want = "disabled"
			}
			if r.Status != want || r.State != "" || r.Unit != "" {
				t.Fatalf("collector reported a measurement or echoed unsafe configuration: %+v", r)
			}
		})
	}
}

func TestSystemdCollectorErrorsAreNotStates(t *testing.T) {
	for want, queryError := range map[string]error{
		"unsupported": errSystemdUnsupported,
		"unavailable": os.ErrPermission,
	} {
		t.Run(want, func(t *testing.T) {
			r := collectSystemd(context.Background(), "opspilot-fixture@one.service", func(_ context.Context, unit string) (string, error) {
				if unit != "opspilot-fixture@one.service" {
					t.Fatalf("queried unexpected unit: %s", unit)
				}
				return "stopped", queryError
			})
			if r.Status != want || r.State != "" || r.Unit != "opspilot-fixture@one.service" {
				t.Fatalf("got %+v; want status %s without a measurement", r, want)
			}
		})
	}
}

func TestSystemdOutputLimit(t *testing.T) {
	var out systemdOutput
	if _, err := io.Copy(&out, strings.NewReader(strings.Repeat("x", 1024))); err != nil {
		t.Fatal(err)
	}
	if n, err := io.Copy(&out, strings.NewReader("x")); err == nil || n != 0 {
		t.Fatalf("accepted data above the output cap: n=%d err=%v", n, err)
	}
}

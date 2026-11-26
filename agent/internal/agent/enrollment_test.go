package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var testIdentity = identity{AgentID: "12345678-1234-1234-1234-123456789abc", AgentSecret: "fixture-secret"}

func TestEnrollmentPersistsAndReusesIdentity(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		caps, _ := payload["capabilities"].([]any)
		if r.Method != "POST" || r.URL.Path != "/api/agents/enroll" || len(payload) != 5 || payload["token"] != "fixture-token" || payload["hostname"] == "" || payload["version"] == "" || payload["protocolVersion"] != float64(protocolVersion) || len(caps) != len(advertisedCapabilities) {
			t.Errorf("incompatible enrollment payload: %v", payload)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(testIdentity)
	}))
	defer server.Close()
	t.Setenv("OPSPILOT_ENROLL_TOKEN", "fixture-token")
	cfg := config{HubURL: server.URL, StatePath: filepath.Join(t.TempDir(), "state", "identity.json")}
	for range 2 {
		id, err := loadOrEnroll(cfg)
		if err != nil || id != testIdentity {
			t.Fatalf("enrollment failed: %v", err)
		}
	}
	if calls != 1 {
		t.Fatalf("enrolled %d times", calls)
	}
	stat, err := os.Stat(cfg.StatePath)
	if err != nil || stat.Mode().Perm() != 0600 {
		t.Fatalf("identity permissions: %v %v", stat, err)
	}
	stat, err = os.Stat(filepath.Dir(cfg.StatePath))
	if err != nil || stat.Mode().Perm() != 0700 {
		t.Fatalf("directory permissions: %v %v", stat, err)
	}
}

func TestEnrollmentRejectsResponsesWithoutWriting(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"rejected", 401, "fixture-token"}, {"redirect", 307, ""},
		{"malformed", 201, "{fixture-token"}, {"empty", 201, `{}`},
		{"bad id", 201, `{"agentId":"bad","agentSecret":"secret"}`},
		{"empty secret", 201, `{"agentId":"12345678-1234-1234-1234-123456789abc","agentSecret":""}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			redirected := false
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true }))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			t.Setenv("OPSPILOT_ENROLL_TOKEN", "fixture-token")
			cfg := config{HubURL: server.URL, StatePath: filepath.Join(t.TempDir(), "identity.json")}
			_, err := loadOrEnroll(cfg)
			if err == nil || strings.Contains(err.Error(), "fixture-token") {
				t.Fatalf("unsafe error: %v", err)
			}
			if _, err := os.Stat(cfg.StatePath); !os.IsNotExist(err) {
				t.Fatal("identity was written")
			}
			if redirected {
				t.Fatal("enrollment followed redirect")
			}
		})
	}
}

func TestCorruptIdentityIsPreserved(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	original := []byte(`{"agentId":"broken"}`)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	_, err := loadOrEnroll(config{HubURL: "http://127.0.0.1:1", StatePath: path})
	if err == nil {
		t.Fatal("corrupt identity accepted")
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != string(original) {
		t.Fatal("corrupt identity overwritten")
	}
}

func TestEnrollOnlyRequiresHTTPSOrigin(t *testing.T) {
	for _, hub := range []string{"", "http://hub.example", "https://user:pass@hub.example", "https://hub.example/path", "https://hub.example?x=1", "https://hub.example#fragment", "https://hub.example?", "https://hub.example/#"} {
		t.Run(hub, func(t *testing.T) {
			t.Setenv("OPSPILOT_HUB_URL", hub)
			t.Setenv("OPSPILOT_AGENT_STATE_PATH", filepath.Join(t.TempDir(), "identity.json"))
			if err := EnrollOnly(); err == nil {
				t.Fatal("unsafe Hub URL accepted")
			}
		})
	}
	path := filepath.Join(t.TempDir(), "identity.json")
	if err := saveIdentity(path, testIdentity); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPSPILOT_AGENT_STATE_PATH", path)
	t.Setenv("OPSPILOT_HUB_URL", "https://hub.example:443/")
	t.Setenv("OPSPILOT_ENROLL_TOKEN", "")
	if err := EnrollOnly(); err != nil {
		t.Fatalf("valid identity not reused: %v", err)
	}
}

func TestAtomicIdentityFailureCleansTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "identity.json")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveIdentity(target, testIdentity); err == nil {
		t.Fatal("rename unexpectedly succeeded")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "identity.json" {
		t.Fatal("temporary identity left behind")
	}
}

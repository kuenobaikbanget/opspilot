package agent

import "testing"

func TestRedaction(t *testing.T) {
	out := redact("password=supersecret token=abc")
	if out == "password=supersecret token=abc" {
		t.Fatal("redaction did not run")
	}
}
func TestMemParsing(t *testing.T) {
	m := parseMem([]byte("MemTotal: 1000 kB\nMemAvailable: 200 kB\n"))
	if m["MemTotal"] != 1000 || m["MemAvailable"] != 200 {
		t.Fatalf("bad parse: %v", m)
	}
}
func TestWSAddress(t *testing.T) {
	s, err := wsAddress("https://hub.example")
	if err != nil || s != "wss://hub.example/api/agents/connect" {
		t.Fatalf("got %s %v", s, err)
	}
}

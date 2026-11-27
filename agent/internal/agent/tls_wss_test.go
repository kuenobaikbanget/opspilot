package agent

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// testCA issues an ephemeral CA and a server certificate for 127.0.0.1 so tests can run a
// real TLS/WSS server without any fixtures on disk.
type testCA struct {
	caCert    *x509.Certificate
	caKey     *ecdsa.PrivateKey
	caPEM     []byte
	serverTLS tls.Certificate
}

func newTestCA(t *testing.T) *testCA {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "opspilot-test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})

	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCert, &serverKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	serverPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER})
	keyDER, err := x509.MarshalECPrivateKey(serverKey)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	serverTLS, err := tls.X509KeyPair(serverPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{caCert: caCert, caKey: caKey, caPEM: caPEM, serverTLS: serverTLS}
}

// startWSSHub runs a minimal TLS WebSocket server that mimics the Hub control socket: it
// expects a hello frame and answers with hello_ack, proving a full WSS round trip.
func startWSSHub(t *testing.T, ca *testCA) (wssURL string, caFile string, stop func()) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agents/connect" {
			http.NotFound(w, r)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var hello helloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			return
		}
		_ = conn.WriteJSON(helloAck{Type: "hello_ack", ProtocolVersion: hello.ProtocolVersion, Capabilities: hello.Capabilities})
	}))
	server.TLS = &tls.Config{
		Certificates: []tls.Certificate{ca.serverTLS},
		MinVersion:   tls.VersionTLS12,
	}
	server.StartTLS()
	t.Cleanup(server.Close)

	caFile = filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caFile, ca.caPEM, 0600); err != nil {
		t.Fatal(err)
	}
	u := "wss" + strings.TrimPrefix(server.URL, "https") + "/api/agents/connect"
	return u, caFile, server.Close
}

func dialHello(t *testing.T, endpoint string) error {
	t.Helper()
	dialer, err := websocketDialer()
	if err != nil {
		t.Fatalf("dialer: %v", err)
	}
	conn, _, err := dialer.Dial(endpoint, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.WriteJSON(helloMessage{Type: "hello", ProtocolVersion: protocolVersion, AgentVersion: "test", Capabilities: advertisedCapabilities}); err != nil {
		return err
	}
	var ack helloAck
	if err := conn.ReadJSON(&ack); err != nil {
		return err
	}
	if ack.Type != "hello_ack" || ack.ProtocolVersion != protocolVersion {
		b, _ := json.Marshal(ack)
		t.Fatalf("unexpected ack: %s", b)
	}
	return nil
}

// Positive: with OPSPILOT_CA_CERT_FILE pointing at the private CA, the agent connects over
// wss:// and completes the hello/hello_ack exchange.
func TestWSSConnectsWithTrustedCA(t *testing.T) {
	ca := newTestCA(t)
	endpoint, caFile, _ := startWSSHub(t, ca)
	t.Setenv(CACertFileEnv, caFile)
	if err := dialHello(t, endpoint); err != nil {
		t.Fatalf("wss dial with trusted CA failed: %v", err)
	}
}

// Negative: without the private CA in the trust bundle, the same wss:// endpoint must fail
// certificate verification. This fails if anyone ever sets InsecureSkipVerify.
func TestWSSRejectsUntrustedCA(t *testing.T) {
	ca := newTestCA(t)
	endpoint, _, _ := startWSSHub(t, ca)
	t.Setenv(CACertFileEnv, "")
	t.Setenv("SSL_CERT_FILE", "")
	t.Setenv("SSL_CERT_DIR", "")
	err := dialHello(t, endpoint)
	if err == nil {
		t.Fatal("wss dial succeeded without trusting the CA; TLS verification is not enforced")
	}
	if !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("expected a certificate verification error, got: %v", err)
	}
}

// Negative: a missing or garbage CA bundle must be an error, never silently ignored.
func TestCACertFileMustBeValid(t *testing.T) {
	t.Setenv(CACertFileEnv, filepath.Join(t.TempDir(), "does-not-exist.pem"))
	if _, err := websocketDialer(); err == nil {
		t.Fatal("missing CA file accepted")
	}
	bad := filepath.Join(t.TempDir(), "bad.pem")
	if err := os.WriteFile(bad, []byte("not a pem bundle"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(CACertFileEnv, bad)
	if _, err := websocketDialer(); err == nil {
		t.Fatal("garbage CA file accepted")
	}
}

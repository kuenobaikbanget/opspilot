package agent

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

// CACertFileEnv names the environment variable pointing at a PEM bundle of extra CA
// certificates trusted for https:// enrollment and wss:// control connections to the Hub
// (for example a private reverse-proxy CA). The standard SSL_CERT_FILE / SSL_CERT_DIR
// variables keep working because the system pool is always loaded first.
const CACertFileEnv = "OPSPILOT_CA_CERT_FILE"

// rootCAs returns the system root pool plus any extra CAs from OPSPILOT_CA_CERT_FILE.
func rootCAs() (*x509.CertPool, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		// SystemCertPool can fail on platforms without a bundle; fall back to an empty
		// pool so OPSPILOT_CA_CERT_FILE is still usable, never to "trust everything".
		pool = x509.NewCertPool()
	}
	path := os.Getenv(CACertFileEnv)
	if path == "" {
		return pool, nil
	}
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%s is unreadable: %w", CACertFileEnv, err)
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New(CACertFileEnv + " contains no PEM certificates")
	}
	return pool, nil
}

// tlsClientConfig enforces certificate verification against rootCAs. InsecureSkipVerify
// is deliberately never set: a wss:// Hub must chain to a trusted root.
func tlsClientConfig() (*tls.Config, error) {
	pool, err := rootCAs()
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		RootCAs:    pool,
		MinVersion: tls.VersionTLS12,
	}, nil
}

// websocketDialer builds the dialer for the Hub control socket. TLS verification is always
// enforced; there is no insecure mode.
func websocketDialer() (*websocket.Dialer, error) {
	tlsConfig, err := tlsClientConfig()
	if err != nil {
		return nil, err
	}
	return &websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		TLSClientConfig:  tlsConfig,
	}, nil
}

// hubHTTPClient returns an HTTP client for Hub API calls (enrollment) that trusts the
// system roots plus OPSPILOT_CA_CERT_FILE, with certificate verification always on.
func hubHTTPClient() (*http.Client, error) {
	tlsConfig, err := tlsClientConfig()
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{TLSClientConfig: tlsConfig},
	}, nil
}

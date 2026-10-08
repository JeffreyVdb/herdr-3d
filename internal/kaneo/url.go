package kaneo

import (
	"net"
	"net/url"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// Endpoint is a Kaneo instance: its API base (what the client calls, ending
// in /api) and its web origin (where task links point).
type Endpoint struct {
	APIBase   string
	WebOrigin string
}

// ParseURL normalizes what a person enters for an instance: its origin
// ("https://tasks.example.com") or its API base (".../api"), either with a
// trailing slash. The scheme and host are lowercased, a default port is
// dropped and /api is never doubled. It refuses anything but http(s), a
// user, a query or a fragment, and any other path (the dashboard's own
// links are not an instance); plain http only for a loopback host. The
// errors are provider.ErrBadInput.
func ParseURL(raw string) (Endpoint, error) {
	raw = strings.TrimSpace(raw)
	bad := func(why string) (Endpoint, error) {
		return Endpoint{}, provider.Errorf(provider.ErrBadInput, "the Kaneo URL %s", why)
	}
	if raw == "" {
		return bad("is empty")
	}
	if strings.ContainsAny(raw, " \t\r\n?#") {
		return bad("must not hold spaces, a query or a fragment")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" {
		return bad("is not an address")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return bad("must start with https://")
	}
	if u.User != nil {
		return bad("must not hold a user or a password")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return bad("has no host")
	}
	if u.Scheme == "http" && !loopback(host) {
		return bad("must use https:// (plain http only for this machine)")
	}
	port := u.Port()
	if u.Scheme == "https" && port == "443" || u.Scheme == "http" && port == "80" {
		port = ""
	}
	hostport := host
	if strings.Contains(host, ":") {
		hostport = "[" + host + "]"
	}
	if port != "" {
		hostport += ":" + port
	}
	switch strings.ToLower(strings.TrimRight(u.Path, "/")) {
	case "", "/api":
	default:
		return bad("must be the instance's address or its /api address")
	}
	origin := u.Scheme + "://" + hostport
	return Endpoint{APIBase: origin + "/api", WebOrigin: origin}, nil
}

// loopback reports whether host is this machine: localhost or a loopback
// address.
func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

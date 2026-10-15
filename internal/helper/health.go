package helper

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// health is a bridge connection's Status, as its supervisor last saw it.
type health struct {
	mu     sync.Mutex
	status Status
}

// Status returns the current state.
func (h *health) Status() Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.status
}

func (h *health) set(state string, err error, pid int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.status.State != state {
		h.status.Since = time.Now()
	}
	h.status.State, h.status.PID = state, pid
	if err != nil {
		h.status.LastError = err.Error()
	}
}

func (h *health) restarted() {
	h.mu.Lock()
	h.status.Restarts++
	h.mu.Unlock()
}

// probeBridge asks the bridge's /healthz over dial and returns what it says
// besides "ok": its version and the hosts it trusts for /api/open (#184).
func probeBridge(ctx context.Context, dial func(context.Context) (net.Conn, error)) (ver, openHosts string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c := &http.Client{Transport: &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return dial(ctx) },
		DisableKeepAlives: true,
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://herdr-world/healthz", nil)
	if err != nil {
		return "", "", err
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "ok" {
		return "", "", fmt.Errorf("healthz: %s %q", resp.Status, body)
	}
	return resp.Header.Get(proto.VersionHeader), resp.Header.Get(proto.OpenHostsHeader), nil
}

// noteOpenHosts records the hosts the bridge trusts for POST /api/open
// (#184): plain host names only (no scheme, port or path), at most eight,
// each checked again with every URL. A check without the header clears
// them, so a disconnected instance stops being opened within one check.
func (h *health) noteOpenHosts(log *slog.Logger, header string) {
	var hosts []string
	for _, x := range strings.Split(header, ",") {
		x = strings.ToLower(strings.TrimSpace(x))
		if validHostName(x) && !slices.Contains(hosts, x) && len(hosts) < 8 {
			hosts = append(hosts, x)
		}
	}
	h.mu.Lock()
	changed := !slices.Equal(h.status.OpenHosts, hosts)
	h.status.OpenHosts = hosts
	h.mu.Unlock()
	if changed {
		log.Info("bridge open hosts", "hosts", strings.Join(hosts, ","))
	}
}

// validHostName is a DNS name: dot-separated labels of letters, digits and
// dashes, at most 253 bytes.
func validHostName(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
				return false
			}
		}
	}
	return true
}

// noteBridge records the bridge's version and logs when it changes: a warning
// if it is not the helper's own (the two ship in one release, so they should
// match).
func (h *health) noteBridge(log *slog.Logger, v string) {
	if v == "" {
		v = "unknown"
	}
	h.mu.Lock()
	changed := h.status.Bridge != v
	h.status.Bridge = v
	h.mu.Unlock()
	switch {
	case !changed:
	case v == "unknown":
		log.Warn("bridge does not report its version (older release)", "helper", version.Version)
	case v != version.Version:
		log.Warn("bridge and helper versions differ", "bridge", v, "helper", version.Version)
	default:
		log.Info("bridge version", "version", v)
	}
}

// LocalBridge (#57) is a bridge on this machine: its unix socket is dialled
// directly, no ssh. Run checks its /healthz every HealthInterval, so its
// state is as fresh as a tunnel's: up while it answers, down while not.
type LocalBridge struct {
	Socket         string
	Log            *slog.Logger
	HealthInterval time.Duration // default 5s

	health
}

// Dial connects to the bridge's socket.
func (b *LocalBridge) Dial(ctx context.Context) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", b.Socket)
}

// Run checks the bridge until ctx is done.
func (b *LocalBridge) Run(ctx context.Context) error {
	if b.Log == nil {
		b.Log = slog.Default()
	}
	every := b.HealthInterval
	if every <= 0 {
		every = 5 * time.Second
	}
	b.set(StateConnecting, nil, 0)
	defer b.set(StateStopped, nil, 0)
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		v, hosts, err := probeBridge(ctx, b.Dial)
		if ctx.Err() != nil {
			return nil
		}
		was := b.Status().State
		if err == nil {
			b.noteBridge(b.Log, v)
			b.noteOpenHosts(b.Log, hosts)
			b.set(StateUp, nil, 0)
			if was != StateUp {
				b.Log.Info("local bridge up", "socket", b.Socket)
			}
		} else {
			b.set(StateDown, err, 0)
			if was != StateDown {
				b.Log.Warn("local bridge not answering", "socket", b.Socket, "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}

package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/manual/askpass"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

var manualIDPattern = regexp.MustCompile(`^mp_[0-9a-f]{8,}$`)

type credentialRequest struct {
	request      string
	expires      time.Time
	result       chan askpass.Response
	answered     bool
	info         proto.ManualCredential
	disconnected atomic.Bool
}

func manualStateDir() string {
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		home, _ := os.UserHomeDir()
		state = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(state, "herdr-world", "manual")
}

func validAskpassNonce(req askpass.Request) bool {
	if !manualIDPattern.MatchString(req.Process) || len(req.Nonce) != 64 || len(req.Prompt) > 4096 {
		return false
	}
	path := filepath.Join(manualStateDir(), req.Process, "nonce")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || !askpassFileOwner(st) {
		return false
	}
	nonce, err := io.ReadAll(io.LimitReader(f, 65))
	if err != nil || len(nonce) != 64 {
		return false
	}
	return subtle.ConstantTimeCompare(nonce, []byte(req.Nonce)) == 1
}

// ListenAskpass serves helper requests until ctx is cancelled. The socket is
// never replaced if another bridge already owns the path.
func (h *Hub) ListenAskpass(ctx context.Context, path string) error {
	ln, err := Listen(path)
	if err != nil {
		return err
	}
	go func() { <-ctx.Done(); _ = ln.Close() }()
	go func() {
		for {
			c, err := ln.AcceptUnix()
			if err != nil {
				return
			}
			if !askpassPeerOK(c) {
				_ = c.Close()
				continue
			}
			go h.serveAskpass(ctx, c)
		}
	}()
	return nil
}

func (h *Hub) serveAskpass(ctx context.Context, c *net.UnixConn) {
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var req askpass.Request
	if err := json.NewDecoder(io.LimitReader(c, 32<<10)).Decode(&req); err != nil || !validAskpassNonce(req) {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return
	}
	r := &credentialRequest{request: "cr_" + hex.EncodeToString(random[:]), expires: time.Now().Add(askpass.Timeout), result: make(chan askpass.Response, 1)}
	opened := make(chan bool, 1)
	if h.do(ctx, func(context.Context) {
		p, ok := h.manualProcess(req.Process)
		if !ok || !credentialProcessActive(p.State) {
			opened <- false
			return
		}
		if h.credentialTimeout > 0 {
			r.expires = time.Now().Add(h.credentialTimeout)
		}
		if h.credentials == nil {
			h.credentials = map[string]*credentialRequest{}
			h.credentialAttempts = map[string]int{}
		}
		if prev := h.credentials[req.Process]; prev != nil {
			h.expireCredential(req.Process, prev)
		}
		h.credentialAttempts[req.Process]++
		h.credentials[req.Process] = r
		r.info = proto.ManualCredential{Request: r.request, Prompt: req.Prompt, User: askpass.User(p.Launched), Attempt: h.credentialAttempts[req.Process], ExpiresAt: r.expires.UnixMilli()}
		h.setManualCredential(req.Process, &r.info)
		opened <- true
	}) != nil {
		return
	}
	select {
	case ok := <-opened:
		if !ok {
			return
		}
	case <-ctx.Done():
		return
	case <-h.done:
		return
	}
	disconnected := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, c); r.disconnected.Store(true); close(disconnected) }()
	timer := time.NewTimer(time.Until(r.expires))
	defer timer.Stop()
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	defer func() {
		_ = h.do(context.Background(), func(context.Context) {
			h.expireCredential(req.Process, r)
			select {
			case res := <-r.result:
				clear(res.Secret)
			default:
			}
		})
	}()
	for {
		select {
		case res := <-r.result:
			_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_ = json.NewEncoder(c).Encode(res)
			clear(res.Secret)
			return
		case <-disconnected:
			return
		case <-timer.C:
			return
		case <-ctx.Done():
			return
		case <-h.done:
			return
		case <-poll.C:
			_ = h.do(ctx, func(context.Context) {
				p, ok := h.manualProcess(req.Process)
				if !ok || !time.Now().Before(r.expires) || !credentialProcessActive(p.State) {
					h.expireCredential(req.Process, r)
				} else if h.credentials[req.Process] == r && !r.answered && (p.Credential == nil || p.Credential.Request != r.request) {
					h.setManualCredential(req.Process, &r.info)
				}
			})
		}
	}
}

// The launcher can ask for a credential before the first status poll marks
// it running. Starting is therefore live for the purpose of the request.
func credentialProcessActive(state string) bool {
	return state == "starting" || state == "running" || state == "waiting"
}

// Reconciliation clears metadata left by a restart or a process-status
// update that raced an answer. A secret is never stored in the record.
func (h *Hub) reconcileCredentials() {
	for _, p := range h.manualProcessViews() {
		if p.Credential == nil {
			continue
		}
		r := h.credentials[p.ID]
		if r == nil || r.answered || r.disconnected.Load() || r.request != p.Credential.Request || !time.Now().Before(r.expires) || !credentialProcessActive(p.State) {
			h.setManualCredential(p.ID, nil)
		}
	}
}

// expireCredential acts only on the current request, so a retry cannot be
// cleared by its predecessor's disconnect.
func (h *Hub) expireCredential(id string, r *credentialRequest) {
	if h.credentials[id] != r {
		return
	}
	delete(h.credentials, id)
	h.setManualCredential(id, nil)
	select {
	case res := <-r.result:
		clear(res.Secret)
	default:
	}
	select {
	case r.result <- askpass.Response{}:
	default:
	}
}

func (h *Hub) startManualCredential(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ManualProcessCredentialArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return bad("invalid credential arguments")
	}
	if (a.Secret == nil) == (a.Cancel == nil) || (a.Cancel != nil && !*a.Cancel) {
		return bad("give exactly one of secret or cancel")
	}
	r := h.credentials[a.ID]
	p, ok := h.manualProcess(a.ID)
	if r == nil || r.answered || r.disconnected.Load() || r.request != a.Request || !time.Now().Before(r.expires) || !ok || !credentialProcessActive(p.State) {
		if r != nil && (r.disconnected.Load() || !ok || !time.Now().Before(r.expires) || !credentialProcessActive(p.State)) {
			h.expireCredential(a.ID, r)
		}
		return fmt.Errorf("%w: credential request is no longer open", errStale)
	}
	r.answered = true
	h.setManualCredential(a.ID, nil)
	res := askpass.Response{}
	if a.Secret != nil {
		res.OK = true
		res.Secret = []byte(*a.Secret)
	}
	r.result <- res
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

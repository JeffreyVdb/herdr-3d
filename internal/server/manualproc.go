package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/manual"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

type ManualHerdr interface {
	CreateManualTab(context.Context, string, string, string, string) (herdr.ManualTab, error)
	CloseManualTab(context.Context, string, string) error
	LaunchManual(context.Context, string, string, string) error
}

var manualOpRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// The store is a leaf package. Its persisted model is converted at the hub
// boundary, and credential requests are deliberately excluded from storage.
func manualToStore(p proto.ManualProcess) store.ManualProcess {
	p.Credential = nil
	var record store.ManualProcess
	_ = json.Unmarshal(mustJSON(p), &record)
	return record
}
func manualFromStore(record store.ManualProcess) proto.ManualProcess {
	var p proto.ManualProcess
	_ = json.Unmarshal(mustJSON(record), &p)
	return p
}

func (h *Hub) initManualProcesses(ctx context.Context) error {
	records, err := h.st.AllManualProcesses(ctx)
	if err != nil {
		return err
	}
	for i := len(records) - 1; i >= 0; i-- {
		p := manualFromStore(records[i])
		if p.State == "waiting" {
			p.State = "unknown"
			p.Error = "credential request interrupted by bridge restart"
			if err := h.st.SaveManualProcess(ctx, manualToStore(p)); err != nil {
				return err
			}
		}
		h.rememberManualOrder(p.ID)
		h.manualProcesses[p.ID] = p
		h.manualLocks[p.ID] = &sync.Mutex{}
		b, err := os.ReadFile(filepath.Join(h.opts.ManualDir, p.ID, "cleanup-parent.json"))
		if err == nil {
			var link manualCleanupLink
			if json.Unmarshal(b, &link) == nil && link.Parent != "" {
				h.manualCleanups[p.ID] = link
			}
		}
	}
	return nil
}

// Creation order disambiguates records sharing the same millisecond.
func (h *Hub) rememberManualOrder(id string) {
	h.manualNext++
	h.manualOrder[id] = h.manualNext
}

func (h *Hub) manualProcessViews() []proto.ManualProcess {
	all := make([]proto.ManualProcess, 0, len(h.manualProcesses))
	for _, p := range h.manualProcesses {
		all = append(all, p)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].CreatedAt == all[j].CreatedAt {
			return h.manualOrder[all[i].ID] > h.manualOrder[all[j].ID]
		}
		return all[i].CreatedAt > all[j].CreatedAt
	})
	out := make([]proto.ManualProcess, 0, len(all))
	counts := map[string]int{}
	gone := 0
	for _, p := range all {
		if !manual.Terminal(p.State) || p.Cleanup == "needed" || p.Cleanup == "failed" {
			out = append(out, p)
			continue
		}
		if h.workers[p.Worker] != nil {
			if counts[p.Worker] < 20 {
				out = append(out, p)
			}
			counts[p.Worker]++
		} else {
			if gone < 20 {
				out = append(out, p)
			}
			gone++
		}
	}
	return out
}

func (h *Hub) saveManual(ctx context.Context, p proto.ManualProcess) error {
	if current, ok := h.manualProcesses[p.ID]; ok && current.State != p.State && !manual.CanTransition(current.State, p.State) {
		return fmt.Errorf("invalid manual process transition %s to %s", current.State, p.State)
	}
	if err := h.st.SaveManualProcess(ctx, manualToStore(p)); err != nil {
		return err
	}
	h.manualProcesses[p.ID] = p
	h.emit(proto.Event{T: proto.EvManualProcessUpsert, Process: &p})
	return nil
}

func (h *Hub) publishManual(ctx context.Context, p proto.ManualProcess) error {
	saved, err := query(ctx, h, func() error { return h.saveManual(ctx, p) })
	if err != nil {
		return err
	}
	return saved
}

func manualTitle(command string, max int) string {
	first, _, _ := strings.Cut(command, "\n")
	var safe strings.Builder
	for _, r := range strings.TrimSpace(first) {
		if unicode.IsPrint(r) {
			safe.WriteRune(r)
		} else {
			safe.WriteByte(' ')
		}
	}
	title := strings.TrimSpace(safe.String())
	if title == "" {
		return "command"
	}
	r := []rune(title)
	limit := len(r)
	if limit > max {
		limit = max
	}
	truncated := limit < len(r)
	for len(string(r[:limit])) > 56 && limit > 0 {
		limit--
		truncated = true
	}
	if truncated {
		for len(string(r[:limit])) > 53 && limit > 0 {
			limit--
		}
		return string(r[:limit]) + "…"
	}
	return string(r[:limit])
}

func manualEffectsConflict(a, b proto.ManualEffect) bool {
	if a.Kind != b.Kind {
		return false
	}
	if a.Endpoint == b.Endpoint {
		return true
	}
	if a.Kind != "tailscale_serve" {
		return false
	}
	_, ap, okA := strings.Cut(a.Endpoint, ":")
	_, bp, okB := strings.Cut(b.Endpoint, ":")
	return okA && okB && ap != "" && ap == bp
}

// backgroundServe recognizes the supported top-level CLI form when the
// effect adapter is absent or declines a command. Such a command must not run
// without conflict detection and a scoped cleanup record.
func backgroundServe(command string) bool {
	fields := strings.Fields(command)
	i := 0
	if i < len(fields) && fields[i] == "sudo" {
		i++
		for i < len(fields) && strings.HasPrefix(fields[i], "-") {
			i++
		}
	}
	if i+1 >= len(fields) || fields[i] != "tailscale" || fields[i+1] != "serve" {
		return false
	}
	if len(fields) > i+2 && fields[len(fields)-1] == "off" {
		return false
	}
	for _, field := range fields[i+2:] {
		if field == "--bg" {
			return true
		}
	}
	return false
}

// startManualAsync records acceptance before work starts. The completion row
// contains no result payload: a process record includes the reviewed command.
func (h *Hub) startManualAsync(ctx context.Context, c *Client, cmd proto.Command, work func(context.Context) (any, error), finish ...func()) error {
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		data, workErr := work(ctx)
		auditCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := h.st.AuditEnd(auditCtx, auditID, workErr, nil); err != nil {
			h.log.Error("manual command audit completion failed", "cmd", cmd.T, "err", err)
		}
		cancel()
		_ = h.do(ctx, func(context.Context) {
			if len(finish) > 0 && finish[0] != nil {
				finish[0]()
			}
			h.reply(c, cmd, data, workErr)
		})
	}()
	return nil
}

func (h *Hub) startManualCommand(ctx context.Context, c *Client, cmd proto.Command) error {
	switch cmd.T {
	case proto.CmdManualProcessStart:
		return h.startManualProcess(ctx, c, cmd)
	case proto.CmdManualProcessStop:
		return h.stopManualCommand(ctx, c, cmd)
	case proto.CmdManualProcessDismiss:
		return h.dismissManualCommand(ctx, c, cmd)
	}
	return bad("unknown manual process command")
}

// manualByOp keeps idempotent replies current while credentials remain ephemeral.
func (h *Hub) manualByOp(ctx context.Context, op string) (proto.ManualProcess, bool, error) {
	record, ok, err := h.st.ManualProcessByOp(ctx, op)
	if err != nil || !ok {
		return proto.ManualProcess{}, ok, err
	}
	p := manualFromStore(record)
	if current, ok := h.manualProcesses[p.ID]; ok {
		p = current
	}
	return p, true, nil
}

func (h *Hub) startManualProcess(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ManualProcessStartArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !manualOpRE.MatchString(a.Op) {
		return bad("invalid operation key")
	}
	old, exists, err := h.manualByOp(ctx, a.Op)
	if err != nil {
		return err
	}
	if exists {
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, proto.ManualProcessResult{Process: old}, nil)
		return nil
	}
	w := h.workers[a.Worker]
	if w == nil {
		return fmt.Errorf("%w: worker not found", errUnknownWorker)
	}
	f := h.floors[w.Floor]
	if f == nil || !f.running || f.op != nil {
		return fmt.Errorf("%w: floor is not running", errInvalidState)
	}
	if f.fires[w.ID] != nil {
		return fmt.Errorf("%w: worker is being sent home", errBusy)
	}
	if h.opts.Manual == nil || h.opts.ManualDir == "" || h.opts.ManualShell == "" {
		return fmt.Errorf("%w: manual process launcher unavailable", errInvalidState)
	}
	if a.Command == "" || len(a.Command) > 8192 || !utf8.ValidString(a.Command) || strings.ContainsRune(a.Command, 0) {
		return bad("command must be valid UTF-8, nonempty and at most 8 KiB")
	}
	if backgroundServe(a.Command) {
		if manual.Effects == nil {
			return &codedError{proto.ErrUnsupported, fmt.Errorf("background Tailscale Serve cleanup is unavailable")}
		}
		if _, ok := manual.Effects.Parse(a.Command); !ok {
			return bad("this background Tailscale Serve command is not supported")
		}
	}
	cwd := a.Cwd
	if cwd == "" {
		cwd = w.Cwd
	}
	if !herdr.ValidDir(cwd) {
		return bad("cwd must be an absolute path")
	}
	source := proto.ManualSource{Kind: "manual"}
	if a.Source != nil {
		source = *a.Source
	}
	switch source.Kind {
	case "manual":
	case "suggestion":
		entry, variants, host, ok := h.commandRequestEntry(a.Worker, source.Key, source.Index)
		matched := entry == a.Command
		for _, v := range variants {
			matched = matched || v == a.Command
		}
		if !ok || host != "bridge" || !matched {
			return fmt.Errorf("%w: command request is no longer current", errStale)
		}
	default:
		return bad("invalid source")
	}
	launched := ""
	if a.Askpass {
		if manual.AskpassRewrite == nil || manual.AskpassEnv == nil {
			return &codedError{proto.ErrManualBadArgs, fmt.Errorf("password dialog is unavailable")}
		}
		var ok bool
		launched, ok = manual.AskpassRewrite(a.Command)
		if !ok {
			return &codedError{proto.ErrManualBadArgs, fmt.Errorf("password dialog is not supported for this command")}
		}
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	host, _ := os.Hostname()
	p := proto.ManualProcess{ID: "mp_" + hex.EncodeToString(random[:]), Op: a.Op, Worker: w.ID, WorkerName: w.Name, Floor: w.Floor, Session: w.Session, WorkspaceID: w.WorkspaceID, Host: host, Cwd: cwd, Command: a.Command, Launched: launched, Title: manualTitle(a.Command, 60), Source: source, State: "starting", Cleanup: "none", CreatedAt: h.opts.Now().UnixMilli()}
	return h.startManualAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		info, err := os.Stat(cwd)
		if err != nil || !info.IsDir() {
			return nil, bad("cwd is not an existing directory")
		}
		newLock := &sync.Mutex{}
		newLock.Lock()
		defer newLock.Unlock()
		type reservation struct {
			p       proto.ManualProcess
			lock    *sync.Mutex
			socket  string
			created bool
			err     error
		}
		reserved, err := query(ctx, h, func() reservation {
			if existing, ok, err := h.manualByOp(ctx, a.Op); err != nil {
				return reservation{err: err}
			} else if ok {
				return reservation{p: existing}
			}
			current := h.workers[a.Worker]
			if current == nil || current.Session != p.Session || current.WorkspaceID != p.WorkspaceID {
				return reservation{err: fmt.Errorf("%w: worker is no longer available", errStale)}
			}
			p.Floor = current.Floor
			p.WorkerName = current.Name
			floor := h.floors[current.Floor]
			if floor == nil || !floor.running || floor.op != nil {
				return reservation{err: fmt.Errorf("%w: floor is not running", errInvalidState)}
			}
			if floor.fires[current.ID] != nil {
				return reservation{err: fmt.Errorf("%w: worker is being sent home", errBusy)}
			}
			if source.Kind == "suggestion" {
				entry, variants, host, ok := h.commandRequestEntry(a.Worker, source.Key, source.Index)
				matched := entry == a.Command
				for _, variant := range variants {
					matched = matched || variant == a.Command
				}
				if !ok || host != "bridge" || !matched {
					return reservation{err: fmt.Errorf("%w: command request is no longer current", errStale)}
				}
			}
			if manual.Effects != nil {
				if effect, ok := manual.Effects.Parse(p.Command); ok {
					effect.CleanupCommand = manual.Effects.CleanupCommand(effect)
					effect.State = "unknown"
					for _, other := range h.manualProcesses {
						for _, owned := range other.Effects {
							if manualEffectsConflict(owned, effect) && (owned.State == "active" || owned.State == "unknown") {
								effect.State = "conflict"
								p.State = "failed"
								p.Error = effect.Endpoint + " is already served by another manual process"
								p.EndedAt = h.opts.Now().UnixMilli()
							}
						}
					}
					p.Effects = []proto.ManualEffect{effect}
				}
			}
			saved, created, err := h.st.CreateManualProcess(ctx, manualToStore(p))
			if err != nil {
				return reservation{err: err}
			}
			if !created {
				return reservation{p: manualFromStore(saved)}
			}
			h.manualProcesses[p.ID] = p
			h.rememberManualOrder(p.ID)
			lock := newLock
			h.manualLocks[p.ID] = lock
			h.emit(proto.Event{T: proto.EvManualProcessUpsert, Process: &p})
			if source.Kind == "suggestion" {
				h.closeCommandRequest(a.Worker, source.Key, "started")
			}
			return reservation{p: p, lock: lock, socket: floor.socket, created: true}
		})
		if err != nil {
			return nil, err
		}
		if reserved.err != nil {
			return nil, reserved.err
		}
		if !reserved.created || reserved.p.State == "failed" {
			return proto.ManualProcessResult{Process: reserved.p}, nil
		}
		result := h.launchManualProcess(ctx, reserved.p, reserved.socket, a.Askpass, false)
		return proto.ManualProcessResult{Process: result}, nil
	})
}

func (h *Hub) launchManualProcess(ctx context.Context, p proto.ManualProcess, socket string, askpass, isCleanup bool) proto.ManualProcess {
	p.Effects = append([]proto.ManualEffect(nil), p.Effects...)
	launchAttempted := false
	fail := func(err error) proto.ManualProcess {
		if !launchAttempted {
			for i := range p.Effects {
				if p.Effects[i].State == "active" || p.Effects[i].State == "unknown" {
					p.Effects[i].State = "removed"
				}
			}
		}
		p.State = "failed"
		if launchAttempted {
			p.State = "unknown"
			p.Cleanup = "needed"
			p.CleanupNote = "launch outcome is uncertain"
		} else {
			p.EndedAt = h.opts.Now().UnixMilli()
		}
		p.Error = err.Error()
		_ = h.publishManual(ctx, p)
		return p
	}
	check := h.opts.ManualNoNewPrivs
	if check == nil {
		check = manual.ServerNoNewPrivs
	}
	restricted, err := check(ctx, socket)
	if err != nil {
		return fail(fmt.Errorf("cannot verify Herdr server privilege context: %w", err))
	}
	if restricted {
		return fail(fmt.Errorf("this Herdr server cannot run sudo (NoNewPrivileges)"))
	}
	if !isCleanup && manual.Effects != nil {
		if effect, ok := manual.Effects.Parse(p.Command); ok {
			status := h.opts.ManualEffectStatus
			if status == nil {
				status = func(ctx context.Context) ([]byte, error) {
					return exec.CommandContext(ctx, "tailscale", "serve", "status", "--json").Output()
				}
			}
			data, err := status(ctx)
			if err != nil {
				return fail(fmt.Errorf("cannot check existing Tailscale Serve endpoints: %w", err))
			}
			conflict, err := manual.Effects.Conflict(data, effect)
			if err != nil {
				return fail(fmt.Errorf("cannot check existing Tailscale Serve endpoints: %w", err))
			}
			effect.CleanupCommand = manual.Effects.CleanupCommand(effect)
			if conflict {
				effect.State = "conflict"
				p.Effects = []proto.ManualEffect{effect}
				return fail(fmt.Errorf("%s is already served", effect.Endpoint))
			}
			effect.State = "active"
			p.Effects = []proto.ManualEffect{effect}
		}
	}
	dir := filepath.Join(h.opts.ManualDir, p.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "command"), []byte(p.Command), 0600); err != nil {
		return fail(err)
	}
	cfg := manual.LaunchConfig{Shell: h.opts.ManualShell, Command: p.Launched}
	if askpass {
		cfg.Env, err = manual.AskpassEnv(dir, p.ID)
		if err != nil {
			return fail(err)
		}
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "launch.json"), data, 0600); err != nil {
		return fail(err)
	}
	tab, err := h.opts.Manual.CreateManualTab(ctx, p.Session, p.WorkspaceID, p.Cwd, "⚙ "+manualTitle(p.Command, 40))
	if err != nil {
		return fail(fmt.Errorf("could not create the manual tab"))
	}
	p.TabID, p.PaneID = tab.TabID, tab.PaneID
	if err := h.publishManual(ctx, p); err != nil {
		_ = h.opts.Manual.CloseManualTab(ctx, p.Session, p.TabID)
		return fail(err)
	}
	launchAttempted = true
	if err := h.opts.Manual.LaunchManual(ctx, p.Session, p.PaneID, dir); err != nil {
		_ = h.opts.Manual.CloseManualTab(ctx, p.Session, p.TabID)
		return fail(err)
	}
	return p
}

func (h *Hub) stopManualCommand(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ManualProcessIDArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	p, ok := h.manualProcess(a.ID)
	if !ok {
		return fmt.Errorf("%w: manual process not found", errStale)
	}
	if h.manualStopBusy[a.ID] {
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, proto.ManualProcessResult{Process: p}, nil)
		return nil
	}
	h.manualStopBusy[a.ID] = true
	retryReported := p.Cleanup == "needed" || p.Cleanup == "failed"
	lock := h.manualLocks[a.ID]
	err := h.startManualAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		lock.Lock()
		defer lock.Unlock()
		result, verified, err := h.cleanupManual(ctx, a.ID, "stopped by user", false, retryReported)
		if err != nil {
			return nil, err
		}
		if verified && (result.Cleanup == "needed" || result.Cleanup == "failed") {
			result = h.startEffectCleanup(ctx, result)
		}
		return proto.ManualProcessResult{Process: result}, nil
	}, func() { delete(h.manualStopBusy, a.ID) })
	if err != nil {
		delete(h.manualStopBusy, a.ID)
	}
	return err
}

func (h *Hub) dismissManualCommand(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ManualProcessIDArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	p, ok := h.manualProcess(a.ID)
	if !ok {
		return fmt.Errorf("%w: manual process not found", errStale)
	}
	if !manual.Terminal(p.State) || (p.Cleanup != "none" && p.Cleanup != "done") {
		return fmt.Errorf("%w: process still needs cleanup", errInvalidState)
	}
	lock := h.manualLocks[a.ID]
	return h.startManualAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		lock.Lock()
		defer lock.Unlock()
		current, err := query(ctx, h, func() proto.ManualProcess { return h.manualProcesses[a.ID] })
		if err != nil {
			return nil, err
		}
		if !manual.Terminal(current.State) || (current.Cleanup != "none" && current.Cleanup != "done") {
			return nil, fmt.Errorf("%w: process still needs cleanup", errInvalidState)
		}
		cleaned, verified, err := h.cleanupManual(ctx, a.ID, "dismissed", false, false)
		if err != nil {
			return nil, err
		}
		if !verified || (cleaned.Cleanup != "none" && cleaned.Cleanup != "done") {
			return nil, fmt.Errorf("%w: manual process still needs cleanup", errInvalidState)
		}
		deleteErr, err := query(ctx, h, func() error {
			if err := h.st.DeleteManualProcess(ctx, a.ID); err != nil {
				return err
			}
			delete(h.manualProcesses, a.ID)
			delete(h.manualOrder, a.ID)
			h.emit(proto.Event{T: proto.EvManualProcessRemoved, ID: a.ID})
			return nil
		})
		if err != nil {
			return nil, err
		}
		if deleteErr != nil {
			return nil, deleteErr
		}
		return struct{}{}, nil
	})
}

// cleanupManual is called while the process lock is held, off the hub loop.
// verified means the launcher and every tagged process are gone, independent
// of persistent external effects which remain visible as cleanup needed.
func (h *Hub) cleanupManual(ctx context.Context, id, reason string, tabGone, retryReported bool) (proto.ManualProcess, bool, error) {
	p, err := query(ctx, h, func() proto.ManualProcess { return h.manualProcesses[id] })
	if err != nil {
		return p, false, err
	}
	if p.ID == "" {
		return p, false, fmt.Errorf("%w: manual process not found", errStale)
	}
	retrySurvivors := reason == "stopped by user" && retryReported
	if !manual.Terminal(p.State) {
		p.State = "stopping"
		p.Credential = nil
		p.Cleanup = "pending"
		if err := h.publishManual(ctx, p); err != nil {
			return p, false, err
		}
	}
	wasTerminal := manual.Terminal(p.State)
	dir := filepath.Join(h.opts.ManualDir, p.ID)
	status, statusErr := manual.ReadStatus(dir)
	verified := wasTerminal
	var cleanupErr error
	identityGone := false
	if statusErr == nil {
		alive, err := manual.CheckIdentity(status.PID, status.StartTicks)
		if err != nil {
			cleanupErr = err
		} else if alive {
			cleanupErr = manual.StopGroup(ctx, status, 3*time.Second)
		}
		if cleanupErr == nil {
			alive, err = manual.CheckIdentity(status.PID, status.StartTicks)
			if err != nil {
				cleanupErr = err
			} else {
				identityGone = !alive
				verified = !alive
			}
		}
	}
	if cleanupErr != nil {
		verified = false
	}
	var group []manual.Identity
	if statusErr == nil && status.PGID > 1 {
		group, err = manual.GroupProcesses(status.PGID)
		if err != nil {
			cleanupErr = err
			verified = false
		}
		if len(group) > 0 && reason == "stopped for send-home" {
			verified = false
		}
	}
	if reason == "stopped for send-home" {
		tags, err := manual.TaggedProcesses(p.ID)
		if err == nil {
			if e := manual.RecordSurvivors(dir, tags); e != nil {
				err = e
			} else {
				tags, err = manual.ReadSurvivors(dir)
			}
		}
		if err != nil || len(tags) > 0 || len(group) > 0 || !verified {
			p.Cleanup = "needed"
			p.CleanupNote = "could not verify that the process stopped"
			if len(tags) > 0 || len(group) > 0 {
				tags = append(tags, group...)
				ids := make([]string, 0, len(tags))
				for _, item := range tags {
					ids = append(ids, fmt.Sprint(item.PID))
				}
				p.CleanupNote = "processes remain: " + strings.Join(ids, ", ")
			}
			if err != nil {
				p.Cleanup = "failed"
				if strings.HasPrefix(p.CleanupNote, "processes remain:") {
					p.CleanupNote = err.Error() + "; " + p.CleanupNote
				} else {
					p.CleanupNote = err.Error()
				}
			}
			if identityGone {
				p.State = "stopped"
				p.EndedAt = h.opts.Now().UnixMilli()
			} else {
				p.State = "unknown"
			}
			p.Error = "could not verify that the process stopped"
			if err := h.publishManual(ctx, p); err != nil {
				return p, false, err
			}
			return p, false, nil
		}
	}
	closed := tabGone
	if !tabGone && p.TabID != "" {
		marked, err := manual.TabClosed(dir)
		if err != nil {
			cleanupErr = fmt.Errorf("reading tab state: %w", err)
			verified = false
		} else {
			known, present := h.manualTabPresent(ctx, p)
			switch {
			case known && !present:
				closed = true
			case !known && marked:
				closed = true
			case h.opts.Manual == nil:
				cleanupErr = fmt.Errorf("manual tab control unavailable")
				verified = false
			default:
				if err := h.opts.Manual.CloseManualTab(ctx, p.Session, p.TabID); err != nil {
					afterKnown, afterPresent := h.manualTabPresent(ctx, p)
					if afterKnown && !afterPresent {
						closed = true
					} else {
						cleanupErr = fmt.Errorf("closing tab: %w", err)
						verified = false
					}
				} else {
					closed = true
				}
			}
		}
	}
	if closed && p.TabID != "" {
		if err := manual.MarkTabClosed(dir); err != nil {
			cleanupErr = fmt.Errorf("recording tab closure: %w", err)
			verified = false
		}
	}
	if errors.Is(statusErr, os.ErrNotExist) && tabGone && cleanupErr == nil {
		verified = true
	}
	if statusErr == nil {
		if updated, err := manual.ReadStatus(dir); err == nil && updated.PID == status.PID && updated.StartTicks == status.StartTicks {
			status = updated
		}
	}
	if retrySurvivors {
		recorded, err := manual.ReadSurvivors(dir)
		if err == nil && len(recorded) > 0 {
			_, err = manual.StopIdentities(ctx, recorded, 3*time.Second)
		}
		if err != nil {
			cleanupErr = err
			verified = false
		}
	}
	tags, err := manual.TaggedProcesses(p.ID)
	if err == nil {
		if e := manual.RecordSurvivors(dir, tags); e != nil {
			err = e
		} else {
			tags, err = manual.ReadSurvivors(dir)
		}
	}
	if err != nil {
		cleanupErr = err
		verified = false
	}
	if statusErr == nil && status.PGID > 1 {
		group, err = manual.GroupProcesses(status.PGID)
		if err != nil {
			cleanupErr = err
			verified = false
		}
	}
	seen := map[int]bool{}
	for _, item := range tags {
		seen[item.PID] = true
	}
	for _, item := range group {
		if !seen[item.PID] {
			tags = append(tags, item)
			seen[item.PID] = true
		}
	}
	if len(tags) > 0 {
		verified = false
		ids := make([]string, 0, len(tags))
		for _, item := range tags {
			ids = append(ids, fmt.Sprint(item.PID))
		}
		p.Cleanup = "needed"
		p.CleanupNote = "processes remain: " + strings.Join(ids, ", ")
	}
	if cleanupErr != nil {
		verified = false
		p.Cleanup = "failed"
		if len(tags) > 0 {
			p.CleanupNote = cleanupErr.Error() + "; " + p.CleanupNote
		} else {
			p.CleanupNote = cleanupErr.Error()
		}
	}
	if !verified && p.Cleanup == "pending" {
		p.Cleanup = "needed"
		p.CleanupNote = "could not verify that the process stopped"
	}
	if verified {
		p.Error = ""
		if !manual.Terminal(p.State) {
			p.State = "stopped"
			p.EndedAt = h.opts.Now().UnixMilli()
		}
		if statusErr == nil && status.ExitCode != nil {
			p.ExitCode = status.ExitCode
		}
		p.Cleanup = "done"
		p.CleanupNote = reason
		for _, effect := range p.Effects {
			if effect.State == "active" || effect.State == "unknown" {
				p.Cleanup = "needed"
				p.CleanupNote = "external effect " + effect.Endpoint + " still needs cleanup"
				break
			}
		}
	} else if !manual.Terminal(p.State) {
		if statusErr == nil && identityGone {
			p.State = "stopped"
			p.EndedAt = h.opts.Now().UnixMilli()
		} else {
			p.State = "unknown"
		}
		p.Error = "could not verify that the process stopped"
	}
	if reason == "stopped for floor sleep" && p.State == "stopped" && p.CleanupNote != "" && !strings.Contains(p.CleanupNote, reason) {
		p.CleanupNote = reason + "; " + p.CleanupNote
	}
	if verified && p.Cleanup == "done" {
		pending, err := query(ctx, h, func() bool { return h.manualCleanupPending(p.ID) })
		if err != nil {
			return p, false, err
		}
		if pending {
			p.Cleanup = "needed"
			p.CleanupNote = "cleanup workspace is still being reconciled"
		}
	}
	if err := h.publishManual(ctx, p); err != nil {
		return p, false, err
	}
	return p, verified, nil
}

func (h *Hub) pollManualProcesses(ctx context.Context) {
	if h.manualPolling || len(h.manualProcesses) == 0 {
		return
	}
	type pollEntry struct {
		id, session, socket string
		lock                *sync.Mutex
	}
	var entries []pollEntry
	for id, p := range h.manualProcesses {
		if manual.Terminal(p.State) {
			if _, ok := h.manualCleanups[id]; !ok {
				continue
			}
		}
		socket := ""
		if f := h.floors[p.Floor]; f != nil {
			socket = f.socket
		}
		entries = append(entries, pollEntry{id, p.Session, socket, h.manualLocks[id]})
	}
	if len(entries) == 0 {
		return
	}
	h.manualPolling = true
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		defer func() { _ = h.do(ctx, func(context.Context) { h.manualPolling = false }) }()
		snapshots := map[string]*herdr.Snapshot{}
		attempted := map[string]bool{}
		for _, e := range entries {
			if !e.lock.TryLock() {
				continue
			}
			p, err := query(ctx, h, func() proto.ManualProcess { return h.manualProcesses[e.id] })
			if err != nil || p.ID == "" {
				e.lock.Unlock()
				continue
			}
			if manual.Terminal(p.State) {
				h.finishEffectCleanup(ctx, p, false)
				e.lock.Unlock()
				continue
			}
			present, known := false, false
			if h.opts.ManualSnapshot != nil && e.socket != "" {
				if !attempted[e.session] {
					attempted[e.session] = true
					snapshots[e.session], _ = h.opts.ManualSnapshot(ctx, e.socket)
				}
				if snap := snapshots[e.session]; snap != nil {
					known = true
					for _, pane := range snap.Panes {
						if pane.PaneID == p.PaneID && pane.TabID == p.TabID {
							present = true
							break
						}
					}
				}
			}
			status, statusErr := manual.ReadStatus(filepath.Join(h.opts.ManualDir, p.ID))
			if p.State == "stopping" {
				_, _, _ = h.cleanupManual(ctx, p.ID, "resumed interrupted stop", known && !present, false)
				e.lock.Unlock()
				continue
			}
			if known && p.TabID != "" && !present {
				_, _, _ = h.cleanupManual(ctx, p.ID, "tab closed externally", true, false)
				e.lock.Unlock()
				continue
			}
			if statusErr == nil && status.ExitCode != nil {
				alive, identityErr := manual.CheckIdentity(status.PID, status.StartTicks)
				if identityErr != nil {
					statusErr = identityErr
				} else if alive {
					e.lock.Unlock()
					continue
				}
			}
			if statusErr == nil {
				derived := manual.Reconcile(&status, true, manual.IdentityAlive(status.PID, status.StartTicks))
				if derived == "exited" || derived == "failed" {
					p.State = derived
					p.Error = ""
					if status.Error != "" {
						p.State = "failed"
						p.Error = status.Error
						p.Effects = append([]proto.ManualEffect(nil), p.Effects...)
						for i := range p.Effects {
							if p.Effects[i].State == "active" || p.Effects[i].State == "unknown" {
								p.Effects[i].State = "removed"
							}
						}
					}
					if status.Error == "" {
						p.ExitCode = status.ExitCode
						p.StartedAt = status.StartedAt
					} else {
						p.ExitCode = nil
						p.StartedAt = 0
					}
					p.EndedAt = status.EndedAt
					p.Credential = nil
					tags, scanErr := manual.TaggedProcesses(p.ID)
					if scanErr == nil {
						if e := manual.RecordSurvivors(filepath.Join(h.opts.ManualDir, p.ID), tags); e != nil {
							scanErr = e
						} else {
							tags, scanErr = manual.ReadSurvivors(filepath.Join(h.opts.ManualDir, p.ID))
						}
					}
					if status.PGID > 1 {
						group, err := manual.GroupProcesses(status.PGID)
						if err != nil {
							scanErr = err
						} else {
							seen := map[int]bool{}
							for _, v := range tags {
								seen[v.PID] = true
							}
							for _, v := range group {
								if !seen[v.PID] {
									tags = append(tags, v)
									seen[v.PID] = true
								}
							}
						}
					}
					if scanErr != nil {
						p.Cleanup = "failed"
						p.CleanupNote = scanErr.Error()
						if len(tags) > 0 {
							ids := make([]string, 0, len(tags))
							for _, v := range tags {
								ids = append(ids, fmt.Sprint(v.PID))
							}
							p.CleanupNote += "; processes remain: " + strings.Join(ids, ", ")
						}
					} else if len(tags) > 0 {
						ids := make([]string, 0, len(tags))
						for _, v := range tags {
							ids = append(ids, fmt.Sprint(v.PID))
						}
						p.Cleanup = "needed"
						p.CleanupNote = "processes remain: " + strings.Join(ids, ", ")
					}
					for _, effect := range p.Effects {
						if effect.State == "active" || effect.State == "unknown" {
							note := "external effect " + effect.Endpoint + " still needs cleanup"
							if p.Cleanup == "failed" || (p.Cleanup == "needed" && p.CleanupNote != "") {
								p.CleanupNote += "; " + note
							} else {
								p.Cleanup = "needed"
								p.CleanupNote = note
							}
						}
					}
				} else if derived == "running" {
					p.StartedAt = status.StartedAt
					p.Error = ""
					p.State = "running"
					if p.Credential != nil {
						p.State = "waiting"
					}
				} else if p.State != "starting" || h.opts.Now().UnixMilli()-p.CreatedAt > 3000 {
					p.State = "unknown"
					p.Error = "launcher identity cannot be verified"
				}
			} else if p.State != "starting" || h.opts.Now().UnixMilli()-p.CreatedAt > 3000 {
				p.State = "unknown"
				p.Error = "launcher status is unavailable"
			}
			observed := p
			published, err := query(ctx, h, func() proto.ManualProcess {
				current, ok := h.manualProcesses[observed.ID]
				if !ok || current.State == "stopping" {
					return current
				}
				next := observed
				next.Credential = current.Credential
				if manual.Terminal(next.State) {
					next.Credential = nil
				}
				if next.Credential != nil && next.State == "running" {
					next.State = "waiting"
				}
				if next.Credential == nil && next.State == "waiting" {
					next.State = "running"
				}
				if !reflect.DeepEqual(current, next) {
					if err := h.saveManual(ctx, next); err != nil {
						h.log.Error("saving manual process status", "err", err)
						return current
					}
				}
				return next
			})
			if err == nil && manual.Terminal(published.State) {
				h.finishEffectCleanup(ctx, published, false)
			}
			e.lock.Unlock()
		}
	}()
}

type manualWork struct {
	id, title string
	lock      *sync.Mutex
}

func (h *Hub) manualWorkFor(ctx context.Context, worker, session string) ([]manualWork, error) {
	return query(ctx, h, func() []manualWork {
		var work []manualWork
		for id, p := range h.manualProcesses {
			if (worker == "" || p.Worker == worker) && (session == "" || p.Session == session) && !manual.Terminal(p.State) {
				work = append(work, manualWork{id, id, h.manualLocks[id]})
			}
		}
		return work
	})
}

func (h *Hub) stopManualForOwner(ctx context.Context, worker, reason string) (string, error) {
	work, err := h.manualWorkFor(ctx, worker, "")
	if err != nil {
		return "", err
	}
	if name, err := h.stopManualWork(ctx, work, reason, false); err != nil {
		return name, err
	}
	remaining, err := query(ctx, h, func() []manualWork {
		var out []manualWork
		for id, p := range h.manualProcesses {
			if p.Worker == worker && manual.Terminal(p.State) && (p.Cleanup == "needed" || p.Cleanup == "failed") {
				out = append(out, manualWork{id, id, h.manualLocks[id]})
			}
		}
		return out
	})
	if err != nil {
		return "", err
	}
	for _, item := range remaining {
		dir := filepath.Join(h.opts.ManualDir, item.id)
		recorded, err := manual.ReadSurvivors(dir)
		if err != nil {
			return item.title, fmt.Errorf("owned descendants could not be verified stopped")
		}
		for _, p := range recorded {
			alive, err := manual.CheckIdentity(p.PID, p.StartTicks)
			if err != nil || alive {
				return item.title, fmt.Errorf("owned descendants could not be verified stopped")
			}
		}
		tags, err := manual.TaggedProcesses(item.id)
		if err != nil || len(tags) > 0 {
			return item.title, fmt.Errorf("owned descendants could not be verified stopped")
		}
		status, err := manual.ReadStatus(dir)
		if err == nil && status.PGID > 1 {
			group, gerr := manual.GroupProcesses(status.PGID)
			if gerr != nil || len(group) > 0 {
				return item.title, fmt.Errorf("owned process group could not be verified stopped")
			}
		}
	}
	return "", nil
}
func (h *Hub) stopManualForSession(ctx context.Context, session, reason string) (string, error) {
	work, err := h.manualWorkFor(ctx, "", session)
	if err != nil {
		return "", err
	}
	return h.stopManualWork(ctx, work, reason, false)
}
func (h *Hub) stopManualWork(ctx context.Context, work []manualWork, reason string, tabGone bool) (string, error) {
	var firstName string
	var firstErr error
	for _, item := range work {
		item.lock.Lock()
		result, verified, err := h.cleanupManual(ctx, item.id, reason, tabGone, false)
		item.lock.Unlock()
		if err == nil && !verified && !(reason == "stopped for floor sleep" && result.State == "stopped") {
			err = fmt.Errorf("process could not be verified stopped")
		}
		if err != nil && firstErr == nil {
			firstName, firstErr = item.title, err
		}
	}
	return firstName, firstErr
}

// Called from the event loop when an observed owner or session disappears.
func (h *Hub) scheduleManualCleanup(ctx context.Context, worker, session, reason string, tabGone bool) {
	var work []manualWork
	for id, p := range h.manualProcesses {
		if (worker == "" || p.Worker == worker) && (session == "" || p.Session == session) && !manual.Terminal(p.State) {
			work = append(work, manualWork{id, id, h.manualLocks[id]})
		}
	}
	if len(work) == 0 {
		return
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		for _, item := range work {
			item.lock.Lock()
			_, _, _ = h.cleanupManual(ctx, item.id, reason, tabGone, false)
			item.lock.Unlock()
		}
	}()
}

func (h *Hub) closeRestoredManualTabs(ctx context.Context, session, socket string) error {
	if h.opts.Manual == nil || h.opts.ManualSnapshot == nil {
		return nil
	}
	workspaces, err := query(ctx, h, func() map[string]bool {
		out := map[string]bool{}
		for _, p := range h.manualProcesses {
			if p.Session == session {
				out[p.WorkspaceID] = true
			}
		}
		return out
	})
	if err != nil {
		return err
	}
	if len(workspaces) == 0 {
		return nil
	}
	snap, err := h.opts.ManualSnapshot(ctx, socket)
	if err != nil {
		return err
	}
	for _, tab := range snap.Tabs {
		if workspaces[tab.WorkspaceID] && strings.HasPrefix(tab.Label, "⚙ ") {
			if err := h.opts.Manual.CloseManualTab(ctx, session, tab.TabID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *Hub) manualCleanupPending(parent string) bool {
	for _, link := range h.manualCleanups {
		if link.Parent == parent {
			return true
		}
	}
	return false
}

type manualCleanupLink struct {
	Parent             string `json:"parent"`
	Endpoint           string `json:"endpoint"`
	TemporaryWorkspace bool   `json:"temporary_workspace"`
}

// startEffectCleanup starts a separately visible, interactive process for the
// scoped off command. The parent's effect remains needed until it exits zero.
func (h *Hub) startEffectCleanup(ctx context.Context, parent proto.ManualProcess) proto.ManualProcess {
	var effect *proto.ManualEffect
	for i := range parent.Effects {
		if parent.Effects[i].State == "active" || parent.Effects[i].State == "unknown" {
			effect = &parent.Effects[i]
			break
		}
	}
	if effect == nil {
		return parent
	}
	var workspaceCleanupErr error
	var workspaceToClose string
	fail := func(err error) proto.ManualProcess {
		parent.Cleanup = "failed"
		parent.CleanupNote = "could not start effect cleanup: " + err.Error()
		if workspaceCleanupErr != nil {
			parent.CleanupNote += "; cleanup workspace " + workspaceToClose + " could not close: " + workspaceCleanupErr.Error()
		}
		_ = h.publishManual(ctx, parent)
		return parent
	}
	tags, err := manual.TaggedProcesses(parent.ID)
	if err != nil {
		return fail(fmt.Errorf("cannot check descendants: %w", err))
	}
	if len(tags) != 0 {
		return parent
	}
	if manual.Effects == nil {
		return fail(fmt.Errorf("effect adapter unavailable"))
	}
	command := manual.Effects.CleanupCommand(*effect)
	if command == "" {
		return fail(fmt.Errorf("no scoped cleanup command"))
	}
	type location struct {
		socket                 string
		running, owner, active bool
	}
	loc, err := query(ctx, h, func() location {
		l := location{owner: h.workers[parent.Worker] != nil}
		if f := h.floors[parent.Session]; f != nil {
			l.socket, l.running = f.socket, f.running
		}
		for _, link := range h.manualCleanups {
			if link.Parent == parent.ID && link.Endpoint == effect.Endpoint {
				l.active = true
			}
		}
		return l
	})
	if err != nil {
		return fail(err)
	}
	if loc.active {
		return parent
	}
	if !loc.running {
		return fail(fmt.Errorf("session is not running"))
	}
	workspace := parent.WorkspaceID
	temporary := false
	if !loc.owner {
		if h.opts.Hire == nil {
			return fail(fmt.Errorf("cannot create cleanup workspace"))
		}
		cwd := parent.Cwd
		if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
			cwd = h.opts.HomeDir
		}
		created, err := h.opts.Hire.CreateWorkspace(ctx, parent.Session, cwd, "manual cleanup")
		if err != nil {
			return fail(err)
		}
		workspace, temporary = created.WorkspaceID, true
		workspaceToClose = workspace
	}
	closeTemporary := func() {
		if temporary && h.opts.Hire != nil {
			workspaceCleanupErr = h.opts.Hire.CloseWorkspace(ctx, parent.Session, workspace)
		}
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		closeTemporary()
		return fail(err)
	}
	childID := "mp_" + hex.EncodeToString(random[:])
	child := proto.ManualProcess{ID: childID, Op: "cleanup_" + hex.EncodeToString(random[:]), Worker: parent.Worker, WorkerName: parent.WorkerName, Floor: parent.Floor, Session: parent.Session, WorkspaceID: workspace, Host: parent.Host, Cwd: parent.Cwd, Command: command, Title: manualTitle(command, 60), Source: proto.ManualSource{Kind: "manual"}, State: "starting", Cleanup: "none", CreatedAt: h.opts.Now().UnixMilli()}
	if info, err := os.Stat(child.Cwd); err != nil || !info.IsDir() {
		child.Cwd = h.opts.HomeDir
	}
	askpass := false
	if parent.Launched != "" && manual.AskpassRewrite != nil && manual.AskpassEnv != nil {
		child.Launched, askpass = manual.AskpassRewrite(command)
	}
	dir := filepath.Join(h.opts.ManualDir, childID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		closeTemporary()
		return fail(err)
	}
	link := manualCleanupLink{Parent: parent.ID, Endpoint: effect.Endpoint, TemporaryWorkspace: temporary}
	b, err := json.Marshal(link)
	if err != nil {
		closeTemporary()
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cleanup-parent.json"), b, 0600); err != nil {
		closeTemporary()
		return fail(err)
	}
	childLock := &sync.Mutex{}
	childLock.Lock()
	defer childLock.Unlock()
	storeErr, err := query(ctx, h, func() error {
		if _, _, err := h.st.CreateManualProcess(ctx, manualToStore(child)); err != nil {
			return err
		}
		h.manualProcesses[child.ID] = child
		h.rememberManualOrder(child.ID)
		h.manualLocks[child.ID] = childLock
		h.manualCleanups[child.ID] = link
		h.emit(proto.Event{T: proto.EvManualProcessUpsert, Process: &child})
		return nil
	})
	if err != nil {
		closeTemporary()
		return fail(err)
	}
	if storeErr != nil {
		closeTemporary()
		return fail(storeErr)
	}
	child = h.launchManualProcess(ctx, child, loc.socket, askpass, true)
	if child.State == "failed" {
		h.finishEffectCleanup(ctx, child, true)
		return fail(fmt.Errorf("cleanup process failed to start"))
	}
	parent.Cleanup = "needed"
	if child.State == "unknown" {
		parent.CleanupNote = "cleanup process " + child.ID + " has an uncertain launch outcome"
	} else {
		parent.CleanupNote = "cleanup is running for " + effect.Endpoint
	}
	_ = h.publishManual(ctx, parent)
	return parent
}

func (h *Hub) finishEffectCleanup(ctx context.Context, child proto.ManualProcess, parentLocked bool) {
	link, err := query(ctx, h, func() manualCleanupLink { return h.manualCleanups[child.ID] })
	if err != nil || link.Parent == "" {
		return
	}
	if !parentLocked {
		lock, err := query(ctx, h, func() *sync.Mutex { return h.manualLocks[link.Parent] })
		if err != nil || lock == nil {
			return
		}
		lock.Lock()
		defer lock.Unlock()
		current, err := query(ctx, h, func() manualCleanupLink { return h.manualCleanups[child.ID] })
		if err != nil || current.Parent != link.Parent {
			return
		}
	}
	success := child.State == "exited" && child.ExitCode != nil && *child.ExitCode == 0
	note := "cleanup command did not exit successfully"
	if success {
		note = "effect removed"
	}
	workspaceClosed := !link.TemporaryWorkspace
	if link.TemporaryWorkspace {
		if h.opts.Hire == nil {
			success = false
			note = "cleanup workspace control unavailable"
		} else if err := h.opts.Hire.CloseWorkspace(ctx, child.Session, child.WorkspaceID); err != nil {
			known, present := h.manualWorkspacePresent(ctx, child.Session, child.WorkspaceID)
			if known && !present {
				workspaceClosed = true
			} else {
				success = false
				note = "could not close cleanup workspace: " + err.Error()
			}
		} else {
			workspaceClosed = true
		}
	}
	remaining, scanErr := manual.TaggedProcesses(link.Parent)
	if scanErr == nil {
		dir := filepath.Join(h.opts.ManualDir, link.Parent)
		if e := manual.RecordSurvivors(dir, remaining); e != nil {
			scanErr = e
		} else {
			remaining, scanErr = manual.ReadSurvivors(dir)
		}
	}
	if status, err := manual.ReadStatus(filepath.Join(h.opts.ManualDir, link.Parent)); err == nil && status.PGID > 1 {
		group, err := manual.GroupProcesses(status.PGID)
		if err != nil {
			scanErr = err
		} else {
			seen := map[int]bool{}
			for _, v := range remaining {
				seen[v.PID] = true
			}
			for _, v := range group {
				if !seen[v.PID] {
					remaining = append(remaining, v)
					seen[v.PID] = true
				}
			}
		}
	}
	updated, err := query(ctx, h, func() bool {
		parent, ok := h.manualProcesses[link.Parent]
		if !ok {
			delete(h.manualCleanups, child.ID)
			return true
		}
		parent.Effects = append([]proto.ManualEffect(nil), parent.Effects...)
		if child.State == "exited" && child.ExitCode != nil && *child.ExitCode == 0 {
			for i := range parent.Effects {
				if parent.Effects[i].Endpoint == link.Endpoint {
					parent.Effects[i].State = "removed"
				}
			}
		}
		if success {
			parent.Cleanup = "done"
			parent.CleanupNote = note
			for _, effect := range parent.Effects {
				if effect.State == "active" || effect.State == "unknown" {
					parent.Cleanup = "needed"
					parent.CleanupNote = "external effect " + effect.Endpoint + " still needs cleanup"
					break
				}
			}
		} else {
			parent.Cleanup = "failed"
			parent.CleanupNote = note
		}
		if scanErr != nil {
			parent.Cleanup = "failed"
			parent.CleanupNote += "; cannot check descendants: " + scanErr.Error()
		} else if len(remaining) > 0 {
			ids := make([]string, 0, len(remaining))
			for _, v := range remaining {
				ids = append(ids, fmt.Sprint(v.PID))
			}
			if parent.Cleanup != "failed" {
				parent.Cleanup = "needed"
			}
			parent.CleanupNote += "; processes remain: " + strings.Join(ids, ", ")
		}
		if current := h.manualProcesses[parent.ID]; !reflect.DeepEqual(current, parent) {
			if err := h.saveManual(ctx, parent); err != nil {
				return false
			}
		}
		if !workspaceClosed {
			return false
		}
		delete(h.manualCleanups, child.ID)
		return true
	})
	if err == nil && updated {
		_ = os.Remove(filepath.Join(h.opts.ManualDir, child.ID, "cleanup-parent.json"))
	}
}

func (h *Hub) manualTabPresent(ctx context.Context, p proto.ManualProcess) (bool, bool) {
	if h.opts.ManualSnapshot == nil {
		return false, false
	}
	socket, err := query(ctx, h, func() string {
		if f := h.floors[p.Session]; f != nil {
			return f.socket
		}
		return ""
	})
	if err != nil || socket == "" {
		return false, false
	}
	snap, err := h.opts.ManualSnapshot(ctx, socket)
	if err != nil || snap == nil {
		return false, false
	}
	for _, tab := range snap.Tabs {
		if tab.TabID == p.TabID && tab.WorkspaceID == p.WorkspaceID {
			return true, true
		}
	}
	return true, false
}

func (h *Hub) manualWorkspacePresent(ctx context.Context, session, workspace string) (bool, bool) {
	if h.opts.ManualSnapshot == nil {
		return false, false
	}
	socket, err := query(ctx, h, func() string {
		if f := h.floors[session]; f != nil {
			return f.socket
		}
		return ""
	})
	if err != nil || socket == "" {
		return false, false
	}
	snap, err := h.opts.ManualSnapshot(ctx, socket)
	if err != nil || snap == nil {
		return false, false
	}
	for _, w := range snap.Workspaces {
		if w.WorkspaceID == workspace {
			return true, true
		}
	}
	return true, false
}

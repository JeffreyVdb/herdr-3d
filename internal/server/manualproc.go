package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/manual"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

type ManualHerdr interface {
	CreateManualTab(context.Context, string, string, string, string) (herdr.ManualTab, error)
	CloseManualTab(context.Context, string, string) error
	LaunchManual(context.Context, string, string, string) error
}

var manualOpRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (h *Hub) initManualProcesses(ctx context.Context) error {
	records, err := h.st.AllManualProcesses(ctx)
	if err != nil {
		return err
	}
	for _, p := range records {
		h.manualProcesses[p.ID] = p
		h.manualLocks[p.ID] = &sync.Mutex{}
	}
	return nil
}

func (h *Hub) manualProcessViews() []proto.ManualProcess {
	all := make([]proto.ManualProcess, 0, len(h.manualProcesses))
	for _, p := range h.manualProcesses {
		all = append(all, p)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].CreatedAt == all[j].CreatedAt {
			return all[i].ID > all[j].ID
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
	if err := h.st.SaveManualProcess(ctx, p); err != nil {
		return err
	}
	h.manualProcesses[p.ID] = p
	h.emit(proto.Event{T: proto.EvManualProcessUpsert, Process: &p})
	return nil
}

func manualTitle(command string, max int) string {
	first, _, _ := strings.Cut(command, "\n")
	first = strings.TrimSpace(first)
	r := []rune(first)
	if len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return first
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

func (h *Hub) startManualProcess(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ManualProcessStartArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !manualOpRE.MatchString(a.Op) {
		return bad("invalid operation key")
	}
	old, exists, err := h.st.ManualProcessByOp(ctx, a.Op)
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
	if h.opts.Manual == nil || h.opts.ManualDir == "" || h.opts.ManualShell == "" {
		return fmt.Errorf("%w: manual process launcher unavailable", errInvalidState)
	}
	if a.Command == "" || len(a.Command) > 8192 || !utf8.ValidString(a.Command) || strings.ContainsRune(a.Command, 0) {
		return bad("command must be valid UTF-8, nonempty and at most 8 KiB")
	}
	cwd := a.Cwd
	if cwd == "" {
		cwd = w.Cwd
	}
	if !herdr.ValidDir(cwd) {
		return bad("cwd must be an absolute path")
	}
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		return bad("cwd is not an existing directory")
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
			return bad("password dialog is unavailable")
		}
		var ok bool
		launched, ok = manual.AskpassRewrite(a.Command)
		if !ok {
			return bad("password dialog is not supported for this command")
		}
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	host, _ := os.Hostname()
	p := proto.ManualProcess{ID: "mp_" + hex.EncodeToString(random[:]), Op: a.Op, Worker: w.ID, WorkerName: w.Name, Floor: w.Floor, Session: w.Session, WorkspaceID: w.WorkspaceID, Host: host, Cwd: cwd, Command: a.Command, Launched: launched, Title: manualTitle(a.Command, 60), Source: source, State: "starting", Cleanup: "none", CreatedAt: h.opts.Now().UnixMilli()}
	saved, created, err := h.st.CreateManualProcess(ctx, p)
	if err != nil {
		return err
	}
	if !created {
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, proto.ManualProcessResult{Process: saved}, nil)
		return nil
	}
	h.manualProcesses[p.ID] = p
	lock := &sync.Mutex{}
	h.manualLocks[p.ID] = lock
	h.emit(proto.Event{T: proto.EvManualProcessUpsert, Process: &p})
	if source.Kind == "suggestion" {
		h.closeCommandRequest(a.Worker, source.Key, "started")
	}
	socket := f.socket
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		lock.Lock()
		defer lock.Unlock()
		p = h.launchManualProcess(ctx, p, socket, a.Askpass)
		return proto.ManualProcessResult{Process: p}, nil
	})
	return nil
}

func (h *Hub) launchManualProcess(ctx context.Context, p proto.ManualProcess, socket string, askpass bool) proto.ManualProcess {
	fail := func(err error) proto.ManualProcess {
		p.State = "failed"
		p.Error = err.Error()
		p.EndedAt = h.opts.Now().UnixMilli()
		_ = h.doWait(ctx, func() { _ = h.saveManual(ctx, p) })
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
	if manual.Effects != nil {
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
		return fail(err)
	}
	p.TabID, p.PaneID = tab.TabID, tab.PaneID
	if err := h.doWait(ctx, func() { _ = h.saveManual(ctx, p) }); err != nil {
		return fail(err)
	}
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
	lock := h.manualLocks[a.ID]
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		lock.Lock()
		defer lock.Unlock()
		result, _, err := h.cleanupManual(ctx, a.ID, "stopped by user", false)
		if err != nil {
			return nil, err
		}
		return proto.ManualProcessResult{Process: result}, nil
	})
	_ = p
	return nil
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
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		lock.Lock()
		defer lock.Unlock()
		current, err := query(ctx, h, func() proto.ManualProcess { return h.manualProcesses[a.ID] })
		if err != nil {
			return nil, err
		}
		if !manual.Terminal(current.State) || (current.Cleanup != "none" && current.Cleanup != "done") {
			return nil, fmt.Errorf("%w: process still needs cleanup", errInvalidState)
		}
		if current.TabID != "" && h.opts.Manual != nil {
			_ = h.opts.Manual.CloseManualTab(ctx, current.Session, current.TabID)
		}
		if err := h.doWait(ctx, func() {
			_ = h.st.DeleteManualProcess(ctx, a.ID)
			delete(h.manualProcesses, a.ID)
			h.emit(proto.Event{T: proto.EvManualProcessRemoved, ID: a.ID})
		}); err != nil {
			return nil, err
		}
		return struct{}{}, nil
	})
	return nil
}

// cleanupManual is called while the process lock is held, off the hub loop.
// verified means the launcher and every tagged process are gone, independent
// of persistent external effects which remain visible as cleanup needed.
func (h *Hub) cleanupManual(ctx context.Context, id, reason string, tabGone bool) (proto.ManualProcess, bool, error) {
	p, err := query(ctx, h, func() proto.ManualProcess { return h.manualProcesses[id] })
	if err != nil {
		return p, false, err
	}
	if p.ID == "" {
		return p, false, fmt.Errorf("%w: manual process not found", errStale)
	}
	if !manual.Terminal(p.State) {
		p.State = "stopping"
		p.Credential = nil
		p.Cleanup = "pending"
		if err := h.doWait(ctx, func() { _ = h.saveManual(ctx, p) }); err != nil {
			return p, false, err
		}
	}
	dir := filepath.Join(h.opts.ManualDir, p.ID)
	status, statusErr := manual.ReadStatus(dir)
	verified := statusErr == nil
	var cleanupErr error
	if statusErr == nil && manual.IdentityAlive(status.PID, status.StartTicks) {
		cleanupErr = manual.StopGroup(ctx, status, 3*time.Second)
	}
	if cleanupErr != nil {
		verified = false
	}
	if !tabGone && p.TabID != "" && h.opts.Manual != nil {
		if err := h.opts.Manual.CloseManualTab(ctx, p.Session, p.TabID); err != nil {
			cleanupErr = fmt.Errorf("closing tab: %w", err)
			verified = false
		}
	}
	if statusErr != nil && tabGone {
		verified = true
	}
	tags, err := manual.TaggedProcesses(p.ID)
	if err != nil {
		cleanupErr = err
		verified = false
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
		p.Cleanup = "failed"
		p.CleanupNote = cleanupErr.Error()
	}
	if !verified && p.Cleanup == "pending" {
		p.Cleanup = "needed"
		p.CleanupNote = "could not verify that the process stopped"
	}
	if verified {
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
		p.State = "unknown"
		p.Error = "could not verify that the process stopped"
	}
	if err := h.doWait(ctx, func() { _ = h.saveManual(ctx, p) }); err != nil {
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
			continue
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
			if err != nil || p.ID == "" || manual.Terminal(p.State) {
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
			if known && p.TabID != "" && !present {
				_, _, _ = h.cleanupManual(ctx, p.ID, "tab closed externally", true)
				e.lock.Unlock()
				continue
			}
			if statusErr == nil {
				if status.ExitCode != nil {
					p.State = "exited"
					p.ExitCode = status.ExitCode
					p.StartedAt = status.StartedAt
					p.EndedAt = status.EndedAt
					p.Credential = nil
					if tags, err := manual.TaggedProcesses(p.ID); err != nil {
						p.Cleanup = "failed"
						p.CleanupNote = err.Error()
					} else if len(tags) > 0 {
						ids := make([]string, 0, len(tags))
						for _, v := range tags {
							ids = append(ids, fmt.Sprint(v.PID))
						}
						p.Cleanup = "needed"
						p.CleanupNote = "processes remain: " + strings.Join(ids, ", ")
					}
					for _, effect := range p.Effects {
						if effect.State == "active" {
							p.Cleanup = "needed"
							p.CleanupNote = "external effect " + effect.Endpoint + " still needs cleanup"
						}
					}
				} else if manual.IdentityAlive(status.PID, status.StartTicks) {
					p.StartedAt = status.StartedAt
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
			_ = h.doWait(ctx, func() {
				current, ok := h.manualProcesses[p.ID]
				if ok && current.State != "stopping" {
					p.Credential = current.Credential
					if !reflect.DeepEqual(current, p) {
						_ = h.saveManual(ctx, p)
					}
				}
			})
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
				work = append(work, manualWork{id, p.Title, h.manualLocks[id]})
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
	return h.stopManualWork(ctx, work, reason, false)
}
func (h *Hub) stopManualForSession(ctx context.Context, session, reason string) (string, error) {
	work, err := h.manualWorkFor(ctx, "", session)
	if err != nil {
		return "", err
	}
	return h.stopManualWork(ctx, work, reason, false)
}
func (h *Hub) stopManualWork(ctx context.Context, work []manualWork, reason string, tabGone bool) (string, error) {
	for _, item := range work {
		item.lock.Lock()
		_, verified, err := h.cleanupManual(ctx, item.id, reason, tabGone)
		item.lock.Unlock()
		if err != nil {
			return item.title, err
		}
		if !verified {
			return item.title, fmt.Errorf("process could not be verified stopped")
		}
	}
	return "", nil
}

// Called from the event loop when an observed owner or session disappears.
func (h *Hub) scheduleManualCleanup(ctx context.Context, worker, session, reason string, tabGone bool) {
	var work []manualWork
	for id, p := range h.manualProcesses {
		if (worker == "" || p.Worker == worker) && (session == "" || p.Session == session) && !manual.Terminal(p.State) {
			work = append(work, manualWork{id, p.Title, h.manualLocks[id]})
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
			_, _, _ = h.cleanupManual(ctx, item.id, reason, tabGone)
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

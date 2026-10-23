// Package harness reads model catalogs and command catalogs from the
// installed agent harnesses. Probes only initialize a protocol connection
// (and list); they never send a user turn.
package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/execpath"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

const probeTimeout = 10 * time.Second

// Match the model/effort argument bounds of herdr.Control. Catalog entries
// outside those bounds cannot be launched through the bridge.
var (
	modelID  = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,63}$`)
	effortID = regexp.MustCompile(`^[a-z]{1,16}$`)
)

type model struct {
	id      string
	label   string // the harness's readable name; "" when it has none worth showing
	efforts []string
}

// maxLabelRunes bounds a readable model name taken from a harness.
const maxLabelRunes = 64

// cleanLabel returns a harness-reported display name when it is usable plain
// text: trimmed, valid UTF-8, no control characters, not blank and not absurdly
// long. Anything else is "", and the client falls back to the id.
func cleanLabel(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || !utf8.ValidString(s) || utf8.RuneCountInString(s) > maxLabelRunes {
		return ""
	}
	if strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return ""
	}
	return s
}

// options preserves catalog order and represents exact per-model efforts in
// the existing wire format: their intersection plus each model's extras. A
// repeated id keeps its first entry, except that it takes the first usable
// label of any entry with that id (an alias's generic label is dropped before).
func options(models []model) (proto.HarnessOptions, error) {
	out := proto.HarnessOptions{Models: []string{}, Efforts: []string{}, ExtraEfforts: map[string][]string{}}
	seen := map[string]bool{}
	var accepted []model
	for _, m := range models {
		if !modelID.MatchString(m.id) {
			continue
		}
		m.label = cleanLabel(m.label)
		if seen[m.id] {
			if i := slices.IndexFunc(accepted, func(a model) bool { return a.id == m.id }); i >= 0 && accepted[i].label == "" {
				accepted[i].label = m.label
			}
			continue
		}
		efforts := []string{}
		for _, e := range m.efforts {
			if effortID.MatchString(e) && !slices.Contains(efforts, e) {
				efforts = append(efforts, e)
			}
		}
		if len(efforts) == 0 {
			continue
		}
		seen[m.id] = true
		m.efforts = efforts
		accepted = append(accepted, m)
		out.Models = append(out.Models, m.id)
		if len(accepted) == 1 {
			out.Efforts = slices.Clone(efforts)
		} else {
			out.Efforts = slices.DeleteFunc(out.Efforts, func(e string) bool { return !slices.Contains(efforts, e) })
		}
	}
	if len(accepted) == 0 {
		return out, errors.New("harness returned no launchable models with effort levels")
	}
	for _, m := range accepted {
		if m.label != "" {
			if out.ModelLabels == nil {
				out.ModelLabels = map[string]string{}
			}
			out.ModelLabels[m.id] = m.label
		}
		for _, e := range m.efforts {
			if !slices.Contains(out.Efforts, e) {
				out.ExtraEfforts[m.id] = append(out.ExtraEfforts[m.id], e)
			}
		}
	}
	return out, nil
}

type stream struct {
	write *json.Encoder
	read  *bufio.Scanner
}

// probe runs a model probe in a private temporary cwd, which avoids loading a
// random project's config or instructions.
func probe[T any](ctx context.Context, bin string, args []string, run func(*stream) (T, error)) (T, error) {
	dir, err := os.MkdirTemp("", "h3d-models-")
	if err != nil {
		var zero T
		return zero, err
	}
	defer os.RemoveAll(dir)
	return probeIn(ctx, bin, dir, args, run)
}

// probeIn bounds startup, output and cleanup, including subprocesses, of a
// harness CLI run in dir. It retains the same clean environment used when
// herdr launches a worker.
func probeIn[T any](ctx context.Context, bin, dir string, args []string, run func(*stream) (T, error)) (T, error) {
	return Run(ctx, Spawn{Bin: bin, Dir: dir, Args: args}, func(s *Stream) (T, error) { return run(s.s) })
}

// Spawn is how Run starts a harness CLI.
type Spawn struct {
	Bin, Dir string
	Args     []string
	// Env is added to the clean environment herdr launches workers with
	// (a later entry of a name wins: CODEX_HOME, CLAUDE_CONFIG_DIR).
	Env []string
	// Timeout bounds the whole run, cleanup aside (0: 10 s).
	Timeout time.Duration
}

// Stream is a running harness's protocol connection: one JSON value per
// line each way, its output capped at 8 MiB and 1 MiB a line.
type Stream struct{ s *stream }

// Send writes one message.
func (s *Stream) Send(v any) error { return s.s.write.Encode(v) }

// Next reads the next message into v.
func (s *Stream) Next(v any) error { return s.s.next(v) }

// RPC makes one JSON-RPC request and decodes its result into result,
// skipping notifications and other responses. A JSON-RPC error is an
// *RPCError.
func (s *Stream) RPC(id int, method string, params, result any) error {
	return s.s.rpc(id, method, params, result)
}

// CodexInit opens an app-server connection: initialize, then initialized.
// The initialize result is decoded into reply when it is not nil.
func (s *Stream) CodexInit(reply any) error { return s.s.codexInit(reply) }

// ClaudeInit sends Claude Code's SDK initialize control request and decodes
// its success reply into reply.
func (s *Stream) ClaudeInit(reply any) error { return s.s.claudeInit(reply) }

// RPCError is a JSON-RPC error reply (its message is not kept: it is the
// harness's text).
type RPCError struct {
	Method string
	Code   int
}

func (e *RPCError) Error() string { return fmt.Sprintf("%s failed (JSON-RPC code %d)", e.Method, e.Code) }

// Run starts sp's CLI in its own process group, hands its protocol stream
// to run and ends it: bounded by sp.Timeout (and ctx), the group killed and
// the process reaped before Run returns, also when run fails.
func Run[T any](ctx context.Context, sp Spawn, run func(*Stream) (T, error)) (T, error) {
	var zero T
	timeout := sp.Timeout
	if timeout <= 0 {
		timeout = probeTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, execpath.Resolve(sp.Bin), sp.Args...)
	cmd.Dir, cmd.Env = sp.Dir, append(probeEnv(), sp.Env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = time.Second
	in, err := cmd.StdinPipe()
	if err != nil {
		return zero, err
	}
	defer in.Close()
	out, err := cmd.StdoutPipe()
	if err != nil {
		return zero, err
	}
	defer out.Close()
	if err := cmd.Start(); err != nil {
		return zero, err
	}
	defer func() {
		cancel()
		_ = cmd.Wait()
	}()
	scanner := bufio.NewScanner(io.LimitReader(out, 8<<20))
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	result, err := run(&Stream{&stream{write: json.NewEncoder(in), read: scanner}})
	if err != nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	return result, err
}

// probeEnv is a probe's environment.
func probeEnv() []string { return herdr.CleanEnv(os.Environ()) }

func (s *stream) next(v any) error {
	if !s.read.Scan() {
		if err := s.read.Err(); err != nil {
			return err
		}
		return io.ErrUnexpectedEOF
	}
	return json.Unmarshal(s.read.Bytes(), v)
}

func (s *stream) rpc(id int, method string, params any, result any) error {
	if err := s.write.Encode(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return err
	}
	for {
		var msg struct {
			ID     *int                `json:"id"`
			Result json.RawMessage     `json:"result"`
			Error  *struct{ Code int } `json:"error"`
		}
		if err := s.next(&msg); err != nil {
			return err
		}
		if msg.ID == nil || *msg.ID != id {
			continue // notifications and unrelated responses
		}
		if msg.Error != nil {
			return &RPCError{Method: method, Code: msg.Error.Code}
		}
		return json.Unmarshal(msg.Result, result)
	}
}

// codexInit opens an app-server connection: initialize (its result into
// reply, if not nil), then initialized.
func (s *stream) codexInit(reply any) error {
	var initialized json.RawMessage
	if err := s.rpc(1, "initialize", map[string]any{"clientInfo": map[string]string{"name": "herdr_3d", "version": "1"}}, &initialized); err != nil {
		return err
	}
	if reply != nil {
		if err := json.Unmarshal(initialized, reply); err != nil {
			return err
		}
	}
	return s.write.Encode(map[string]any{"method": "initialized", "params": map[string]any{}})
}

// Codex queries app-server's picker-visible model/list, including all pages.
func Codex(ctx context.Context, bin string) (proto.HarnessOptions, error) {
	if bin == "" {
		bin = "codex"
	}
	return probe(ctx, bin, []string{"app-server"}, func(s *stream) (proto.HarnessOptions, error) {
		if err := s.codexInit(nil); err != nil {
			return proto.HarnessOptions{}, err
		}
		var models []model
		cursor := ""
		seen := map[string]bool{}
		for page := 0; page < 100; page++ {
			params := map[string]any{"limit": 100, "includeHidden": false}
			if cursor != "" {
				params["cursor"] = cursor
			}
			var response struct {
				Data []struct {
					Model       string `json:"model"`
					DisplayName string `json:"displayName"`
					Hidden      bool   `json:"hidden"`
					Efforts     []struct {
						Effort string `json:"reasoningEffort"`
					} `json:"supportedReasoningEfforts"`
				} `json:"data"`
				NextCursor string `json:"nextCursor"`
			}
			if err := s.rpc(page+2, "model/list", params, &response); err != nil {
				return proto.HarnessOptions{}, err
			}
			for _, entry := range response.Data {
				if entry.Hidden {
					continue
				}
				m := model{id: entry.Model, label: entry.DisplayName}
				for _, e := range entry.Efforts {
					m.efforts = append(m.efforts, e.Effort)
				}
				models = append(models, m)
			}
			cursor = response.NextCursor
			if cursor == "" {
				return options(models)
			}
			if seen[cursor] {
				return proto.HarnessOptions{}, errors.New("model/list repeated a pagination cursor")
			}
			seen[cursor] = true
		}
		return proto.HarnessOptions{}, errors.New("model/list exceeded 100 pages")
	})
}

// claudeArgs start Claude Code's SDK control protocol over stdio without
// hooks, tools, MCP servers or a saved session. No user turn is ever sent.
var claudeArgs = []string{"--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
	"--no-session-persistence", "--strict-mcp-config", "--tools", "", "--settings", `{"disableAllHooks":true}`}

// claudeInit sends the SDK's initialize control request and decodes the
// response of its success reply into reply.
func (s *stream) claudeInit(reply any) error {
	const requestID = "h3d-models"
	if err := s.write.Encode(map[string]any{"type": "control_request", "request_id": requestID, "request": map[string]string{"subtype": "initialize"}}); err != nil {
		return err
	}
	for {
		var msg struct {
			Type     string `json:"type"`
			Response struct {
				RequestID string          `json:"request_id"`
				Subtype   string          `json:"subtype"`
				Response  json.RawMessage `json:"response"`
			} `json:"response"`
		}
		if err := s.next(&msg); err != nil {
			return err
		}
		if msg.Type != "control_response" || msg.Response.RequestID != requestID {
			continue
		}
		if msg.Response.Subtype != "success" {
			return errors.New("Claude Code SDK initialization failed")
		}
		if len(msg.Response.Response) == 0 {
			return errors.New("Claude Code SDK initialization has no response")
		}
		return json.Unmarshal(msg.Response.Response, reply)
	}
}

// Claude reads the SDK initialization response used by supportedModels(). No
// SDK runtime is needed: Claude Code exposes that control protocol over stdio.
func Claude(ctx context.Context, bin string) (proto.HarnessOptions, error) {
	if bin == "" {
		bin = "claude"
	}
	return probe(ctx, bin, claudeArgs, func(s *stream) (proto.HarnessOptions, error) {
		var reply struct {
			Models []struct {
				Value       string   `json:"value"`
				DisplayName string   `json:"displayName"`
				Resolved    string   `json:"resolvedModel"`
				Efforts     []string `json:"supportedEffortLevels"`
			} `json:"models"`
		}
		if err := s.claudeInit(&reply); err != nil {
			return proto.HarnessOptions{}, err
		}
		var models []model
		for _, entry := range reply.Models {
			id := entry.Resolved
			if !modelID.MatchString(id) {
				// Older harnesses omit resolvedModel. A provider's resolved
				// ID may also exceed our argument bounds while its alias fits.
				id = entry.Value
			}
			efforts := entry.Efforts
			if efforts == nil {
				// Older catalogs and models without a reasoning knob omit
				// capability metadata; use the CLI's basic effort levels.
				efforts = []string{"low", "medium", "high"}
			}
			label := entry.DisplayName
			if entry.Value == "default" && id != entry.Value {
				// "Default (recommended)" names the account's pick, not the
				// model it resolves to; a concrete alias of that id (sonnet →
				// "Sonnet 5.5") supplies the label, else the client formats the id.
				label = ""
			}
			models = append(models, model{id: id, label: label, efforts: efforts})
		}
		return options(models)
	})
}

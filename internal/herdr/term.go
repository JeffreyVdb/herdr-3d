package herdr

// M5 term: the laptops. Watching a pane's screen (`terminal session
// observe`, read only) and typing into it (`pane send-keys`, `pane
// send-text`, `agent prompt`), through the same allowlist as the rest of
// Control.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

// Terminal sizes an observer may ask for (`--cols`, `--rows`).
const (
	MinCols, MaxCols = 40, 300
	MinRows, MaxRows = 10, 100
)

func validCols(v string) bool { return validInt(v, MinCols, MaxCols) }
func validRows(v string) bool { return validInt(v, MinRows, MaxRows) }

func validInt(v string, lo, hi int) bool {
	n, err := strconv.Atoi(v)
	return err == nil && strconv.Itoa(n) == v && n >= lo && n <= hi
}

// keyNames are the herdr 0.9.0 key names a player may press at a laptop
// (`pane send-keys`), each checked on a throwaway pane: what it sends is in
// docs/protocol.md "Input". herdr also takes other names; these are the
// ones the game needs.
var keyNames = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range []string{"enter", "esc", "tab", "shift+tab", "backspace", "space",
		"up", "down", "left", "right", "shift+up", "shift+down", "shift+left", "shift+right",
		"ctrl+left", "ctrl+right", "alt+left", "alt+right", "shift+enter", "alt+enter", "alt+backspace"} {
		m[k] = true
	}
	for c := 'a'; c <= 'z'; c++ {
		m["ctrl+"+string(c)] = true
	}
	for i := 1; i <= 12; i++ {
		m["f"+strconv.Itoa(i)] = true
	}
	return m
}()

// sequenceKeys are keys herdr 0.9.0 has no name for ("unsupported key"),
// sent as xterm's fixed (normal-mode) sequence with `pane send-text`.
var sequenceKeys = map[string]string{
	"delete":   "\x1b[3~",
	"home":     "\x1b[H",
	"end":      "\x1b[F",
	"pageup":   "\x1b[5~",
	"pagedown": "\x1b[6~",
}

// IsKeyName reports whether name is a herdr key name SendKeys takes.
func IsKeyName(name string) bool { return keyNames[name] }

// IsSequenceKey reports whether name is a key SendSequence takes.
func IsSequenceKey(name string) bool { _, ok := sequenceKeys[name]; return ok }

// InputKeys is every key a player may press at a laptop (worker.keys),
// sorted: the herdr names and the sequence keys.
func InputKeys() []string {
	out := make([]string, 0, len(keyNames)+len(sequenceKeys))
	for k := range keyNames {
		out = append(out, k)
	}
	for k := range sequenceKeys {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// MaxKeys bounds the keys of one SendKeys call.
const MaxKeys = 64

// validKeyList: 1-64 space-separated herdr key names, or a digit 1-9 (a
// numbered menu's choice, worker.answer).
func validKeyList(v string) bool {
	keys := strings.Fields(v)
	if len(keys) == 0 || len(keys) > MaxKeys || strings.Join(keys, " ") != v {
		return false
	}
	for _, k := range keys {
		if !keyNames[k] && !(len(k) == 1 && k[0] >= '1' && k[0] <= '9') {
			return false
		}
	}
	return true
}

func validSequence(v string) bool {
	for _, s := range sequenceKeys {
		if v == s {
			return true
		}
	}
	return false
}

// MaxInputText bounds the literal text of one SendText call.
const MaxInputText = 8 << 10

// ValidInputText reports whether text may be typed literally: 1-8 KiB of
// UTF-8 without control characters (those are keys). herdr 0.9.0 types a
// leading "-" or "--" literally too (checked live).
func ValidInputText(text string) bool {
	if text == "" || len(text) > MaxInputText || !utf8.ValidString(text) {
		return false
	}
	for _, r := range text {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// MaxMessage bounds a worker.prompt.
const MaxMessage = 16 << 10

// ValidMessage reports whether text may be submitted with worker.prompt:
// 1 byte to 16 KiB of UTF-8 without NUL. herdr 0.9.0 takes any such text as
// the prompt, even "--", "--help" or "--wait" (checked live).
func ValidMessage(text string) bool {
	return text != "" && len(text) <= MaxMessage && utf8.ValidString(text) && !strings.ContainsRune(text, 0)
}

// SendKeys presses keys in a pane, in order, in one `pane send-keys`.
func (c *Control) SendKeys(ctx context.Context, session, pane string, keys ...string) error {
	for _, k := range keys {
		if k == "" || strings.ContainsFunc(k, unicode.IsSpace) { // one key, one argv element
			return fmt.Errorf("%w: key %q", ErrNotAllowed, k)
		}
	}
	_, err := c.run(ctx, opSendKeys, map[string]string{"session": session, "pane": pane, "keys": strings.Join(keys, " ")})
	return err
}

// SendText types text literally into a pane (`pane send-text`).
func (c *Control) SendText(ctx context.Context, session, pane, text string) error {
	_, err := c.run(ctx, opSendText, map[string]string{"session": session, "pane": pane, "input": text})
	return err
}

// SendSequence presses a key herdr has no name for (delete, home, end,
// pageup, pagedown) by typing its fixed xterm sequence.
func (c *Control) SendSequence(ctx context.Context, session, pane, key string) error {
	seq, ok := sequenceKeys[key]
	if !ok {
		return fmt.Errorf("%w: key %q", ErrNotAllowed, key)
	}
	_, err := c.run(ctx, opSendSequence, map[string]string{"session": session, "pane": pane, "seq": seq})
	return err
}

// SubmitPrompt submits a prompt to the agent in a pane (`agent prompt`:
// bracketed paste and Enter) and waits until herdr sees it working or
// blocked; else herdr fails with agent_prompt_stalled.
func (c *Control) SubmitPrompt(ctx context.Context, session, pane, text string) error {
	_, err := c.run(ctx, opPromptWait, map[string]string{"session": session, "pane": pane, "message": text})
	return err
}

// QueuePrompt submits a prompt to an agent that is working, without
// waiting: the agent takes it for its next turn.
func (c *Control) QueuePrompt(ctx context.Context, session, pane, text string) error {
	_, err := c.run(ctx, opPromptQueued, map[string]string{"session": session, "pane": pane, "message": text})
	return err
}

// Streamer starts a long-running command and returns it running.
type Streamer func(argv []string) (Proc, error)

// Proc is a started long-running command.
type Proc interface {
	// Stdout is what the command writes; it ends when the command does.
	Stdout() io.Reader
	// Stop ends the command (SIGTERM, then SIGKILL after StopGrace, to its
	// whole process group) and waits for it. It is safe to call twice.
	Stop() error
}

// StopGrace is how long a stopped long-running command has between
// SIGTERM and SIGKILL.
const StopGrace = time.Second

// Frame is one line of an observer's NDJSON stream: a terminal.frame (the
// ANSI bytes of a full screen or a diff), or the stream's closing
// terminal.closed.
type Frame struct {
	Seq           uint64
	Full          bool
	Width, Height int
	Data          []byte // decoded ANSI
	Closed        bool
	Reason        string // terminal.closed's reason
}

// FrameStream is a running observer.
type FrameStream interface {
	// Next blocks for the next frame; io.EOF when the observer exited.
	Next() (Frame, error)
	// Close stops the observer and waits for it.
	Close() error
}

// maxFrameLine bounds one observer line (a full 300×100 screen with its
// colours is well under 2 MiB of base64).
const maxFrameLine = 8 << 20

// Observe starts a read-only observer of a pane's screen at cols × rows
// (`terminal session observe`): a full frame first, then diffs, each only
// when the screen changes. It ends with a terminal.closed frame or EOF when
// the pane goes. Nothing it does can type into, resize or take over the
// pane.
func (c *Control) Observe(ctx context.Context, session, pane string, cols, rows int) (FrameStream, error) {
	argv, err := c.argv(opObserve, map[string]string{"session": session, "pane": pane,
		"cols": strconv.Itoa(cols), "rows": strconv.Itoa(rows)})
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	start := c.Stream
	if start == nil {
		start = execStream
	}
	p, err := start(argv)
	if err != nil {
		return nil, fmt.Errorf("herdr control %s: %w", opObserve, err)
	}
	return &observer{p: p, r: bufio.NewReaderSize(p.Stdout(), 64<<10)}, nil
}

type observer struct {
	p Proc
	r *bufio.Reader
}

func (o *observer) Next() (Frame, error) {
	for {
		line, err := readFrameLine(o.r)
		if err != nil {
			return Frame{}, err
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var raw struct {
			Type     string `json:"type"`
			Seq      uint64 `json:"seq"`
			Full     bool   `json:"full"`
			Width    int    `json:"width"`
			Height   int    `json:"height"`
			Encoding string `json:"encoding"`
			Bytes    string `json:"bytes"`
			Reason   string `json:"reason"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return Frame{}, fmt.Errorf("herdr observe: bad line %.100q: %w", line, err)
		}
		switch raw.Type {
		case "terminal.frame":
			if raw.Encoding != "" && raw.Encoding != "ansi" {
				return Frame{}, fmt.Errorf("herdr observe: unknown encoding %q", raw.Encoding)
			}
			data, err := base64.StdEncoding.DecodeString(raw.Bytes)
			if err != nil {
				return Frame{}, fmt.Errorf("herdr observe: bad frame bytes: %w", err)
			}
			return Frame{Seq: raw.Seq, Full: raw.Full, Width: raw.Width, Height: raw.Height, Data: data}, nil
		case "terminal.closed":
			return Frame{Closed: true, Reason: raw.Reason}, nil
		}
		// Other line types: ignored.
	}
}

func (o *observer) Close() error { return o.p.Stop() }

// readFrameLine reads one line of at most maxFrameLine bytes.
func readFrameLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxFrameLine {
			return nil, fmt.Errorf("herdr observe: line longer than %d bytes", maxFrameLine)
		}
		switch {
		case err == nil:
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(line) > 0:
			return line, nil
		default:
			return nil, err
		}
	}
}

// execStream runs argv in its own process group with herdr's pane and
// Claude variables stripped. Its stdout is a pipe the caller reads to the
// end; Wait runs as soon as it starts, so it is always reaped.
func execStream(argv []string) (Proc, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = CleanEnv(os.Environ())
	cmd.Stdout = w // stderr: /dev/null (herdr reports failures as terminal.closed)
	cmd.SysProcAttr = streamProcAttr()
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		return nil, err
	}
	w.Close() // the child holds its end
	p := &proc{cmd: cmd, r: r, done: make(chan struct{})}
	go func() {
		p.err = cmd.Wait()
		close(p.done)
	}()
	return p, nil
}

type proc struct {
	cmd  *exec.Cmd
	r    *os.File
	done chan struct{}
	err  error
	once sync.Once
}

func (p *proc) Stdout() io.Reader { return p.r }

func (p *proc) Stop() error {
	p.once.Do(func() {
		pgid := p.cmd.Process.Pid
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		select {
		case <-p.done:
		case <-time.After(StopGrace):
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
			<-p.done
		}
		p.r.Close()
	})
	return nil
}

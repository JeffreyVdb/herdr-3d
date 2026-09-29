package herdr

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeProc is a Proc whose stdout is a reader.
type fakeProc struct{ r io.Reader }

func (p fakeProc) Stdout() io.Reader { return p.r }
func (p fakeProc) Stop() error       { return nil }

func TestTermControlRefusesBadInputBeforeRunning(t *testing.T) {
	ran := false
	c := &Control{Only: regexp.MustCompile(`^h3d-it-`),
		Run:    func(context.Context, []string) ([]byte, []byte, error) { ran = true; return nil, nil, nil },
		Stream: func([]string) (Proc, error) { ran = true; return fakeProc{strings.NewReader("")}, nil }}
	ctx := context.Background()
	observe := func(session, pane string, cols, rows int) error {
		_, err := c.Observe(ctx, session, pane, cols, rows)
		return err
	}
	for name, call := range map[string]func() error{
		"observe unwatched":   func() error { return observe("herdr-3d", "w1:p1", 120, 40) },
		"observe bad pane":    func() error { return observe("h3d-it-1", "w1:p1 --takeover", 120, 40) },
		"observe narrow":      func() error { return observe("h3d-it-1", "w1:p1", 39, 40) },
		"observe wide":        func() error { return observe("h3d-it-1", "w1:p1", 301, 40) },
		"observe short":       func() error { return observe("h3d-it-1", "w1:p1", 120, 9) },
		"observe tall":        func() error { return observe("h3d-it-1", "w1:p1", 120, 101) },
		"no keys":             func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1") },
		"unknown key":         func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1", "enter", "delete") },
		"key flag":            func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1", "--help") },
		"key with space":      func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1", "ctrl+c up") },
		"empty key":           func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1", "", "up") },
		"digit 0":             func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1", "0") },
		"two digits":          func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1", "12") },
		"keys unwatched":      func() error { return c.SendKeys(ctx, "code-review", "w1:p1", "enter") },
		"too many keys":       func() error { return c.SendKeys(ctx, "h3d-it-1", "w1:p1", slices.Repeat([]string{"up"}, MaxKeys+1)...) },
		"empty text":          func() error { return c.SendText(ctx, "h3d-it-1", "w1:p1", "") },
		"newline text":        func() error { return c.SendText(ctx, "h3d-it-1", "w1:p1", "ls\n") },
		"escape text":         func() error { return c.SendText(ctx, "h3d-it-1", "w1:p1", "\x1b[3~") },
		"tab text":            func() error { return c.SendText(ctx, "h3d-it-1", "w1:p1", "a\tb") },
		"C1 text":             func() error { return c.SendText(ctx, "h3d-it-1", "w1:p1", "a\u009bb") },
		"invalid utf-8":       func() error { return c.SendText(ctx, "h3d-it-1", "w1:p1", "a\xffb") },
		"huge text":           func() error { return c.SendText(ctx, "h3d-it-1", "w1:p1", strings.Repeat("x", MaxInputText+1)) },
		"text unwatched":      func() error { return c.SendText(ctx, "herdr-3d", "w1:p1", "ls") },
		"unknown sequence":    func() error { return c.SendSequence(ctx, "h3d-it-1", "w1:p1", "insert") },
		"sequence as a name":  func() error { return c.SendSequence(ctx, "h3d-it-1", "w1:p1", "\x1b[3~") },
		"empty prompt":        func() error { return c.SubmitPrompt(ctx, "h3d-it-1", "w1:p1", "") },
		"NUL prompt":          func() error { return c.SubmitPrompt(ctx, "h3d-it-1", "w1:p1", "a\x00b") },
		"huge prompt":         func() error { return c.QueuePrompt(ctx, "h3d-it-1", "w1:p1", strings.Repeat("x", MaxMessage+1)) },
		"prompt unwatched":    func() error { return c.QueuePrompt(ctx, "depot-manager", "w1:p1", "hi") },
		"prompt bad utf-8":    func() error { return c.SubmitPrompt(ctx, "h3d-it-1", "w1:p1", "\xc3") },
		"prompt pane as flag": func() error { return c.SubmitPrompt(ctx, "h3d-it-1", "--pane", "hi") },
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if ran {
		t.Fatal("a refused command ran")
	}
	// What a person typed is never quoted in an error.
	err := c.SendText(ctx, "h3d-it-1", "w1:p1", "my secret\n")
	if err == nil || strings.Contains(err.Error(), "secret") || !strings.Contains(err.Error(), "10 bytes") {
		t.Fatalf("refused text error = %v", err)
	}
	if err := c.SubmitPrompt(ctx, "h3d-it-1", "w1:p1", "secret\x00"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("refused prompt error = %v", err)
	}
	// Leading dashes are text to herdr (checked live), so they are allowed.
	for _, text := range []string{"-la", "--", "--help", "--wait"} {
		if !ValidInputText(text) || !ValidMessage(text) {
			t.Errorf("%q refused", text)
		}
	}
}

func TestInputKeysAreTheVocabulary(t *testing.T) {
	keys := InputKeys()
	for _, k := range []string{"enter", "esc", "tab", "shift+tab", "backspace", "delete", "up", "down", "left", "right",
		"home", "end", "pageup", "pagedown", "space", "ctrl+a", "ctrl+z", "f1", "f12", "alt+enter", "shift+enter"} {
		if !slices.Contains(keys, k) {
			t.Errorf("InputKeys lacks %q", k)
		}
	}
	for _, k := range []string{"escape", "insert", "f13", "1", "a", "ctrl+1", "C-c"} {
		if slices.Contains(keys, k) {
			t.Errorf("InputKeys has %q", k)
		}
	}
	if !slices.IsSorted(keys) || len(keys) != 21+26+12+5 {
		t.Fatalf("InputKeys = %d keys: %q", len(keys), keys)
	}
	for k := range sequenceKeys {
		if keyNames[k] {
			t.Errorf("%q is both a herdr name and a sequence", k)
		}
	}
}

func frameLine(seq int, full bool, data string) string {
	f := "false"
	if full {
		f = "true"
	}
	return `{"encoding":"ansi","full":` + f + `,"height":40,"seq":` + strconv.Itoa(seq) +
		`,"type":"terminal.frame","width":120,"bytes":"` + base64.StdEncoding.EncodeToString([]byte(data)) + `"}` + "\n"
}

func TestObserverFrames(t *testing.T) {
	stream := frameLine(1, true, "\x1b[2J\x1b[1;1Hhello") + "\n" + `{"type":"something.new"}` + "\n" +
		frameLine(2, false, "\x1b[2;1Hworld") +
		`{"reason":"terminal attach ended: terminal term_1 not found","type":"terminal.closed"}` + "\n"
	var argv []string
	c := &Control{Stream: func(a []string) (Proc, error) { argv = a; return fakeProc{strings.NewReader(stream)}, nil }}
	obs, err := c.Observe(context.Background(), "h3d-it-1", "w1:p1", 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	defer obs.Close()
	if !slices.Equal(argv, []string{"herdr", "--session", "h3d-it-1", "terminal", "session", "observe", "w1:p1",
		"--cols", "120", "--rows", "40"}) {
		t.Fatalf("argv = %q", argv)
	}
	f, err := obs.Next()
	if err != nil || !f.Full || f.Seq != 1 || f.Width != 120 || f.Height != 40 || string(f.Data) != "\x1b[2J\x1b[1;1Hhello" {
		t.Fatalf("first frame = %+v, %v", f, err)
	}
	if f, err = obs.Next(); err != nil || f.Full || f.Seq != 2 || string(f.Data) != "\x1b[2;1Hworld" {
		t.Fatalf("second frame = %+v, %v", f, err)
	}
	if f, err = obs.Next(); err != nil || !f.Closed || !strings.Contains(f.Reason, "not found") {
		t.Fatalf("closing frame = %+v, %v", f, err)
	}
	if _, err = obs.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("after the end: %v", err)
	}

	for name, bad := range map[string]string{
		"not json":     "garbage\n",
		"bad base64":   `{"type":"terminal.frame","bytes":"!!!"}` + "\n",
		"other coding": `{"type":"terminal.frame","encoding":"utf16","bytes":""}` + "\n",
		"huge line":    `{"type":"terminal.frame","bytes":"` + strings.Repeat("A", maxFrameLine) + `"}` + "\n",
	} {
		c.Stream = func([]string) (Proc, error) { return fakeProc{strings.NewReader(bad)}, nil }
		obs, err := c.Observe(context.Background(), "h3d-it-1", "w1:p1", 120, 40)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := obs.Next(); err == nil || errors.Is(err, io.EOF) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

// The default streamer runs herdr in its own process group, stops the
// whole group (SIGKILL when SIGTERM is ignored) and always reaps it.
func TestObserverExecStopsTheProcessGroup(t *testing.T) {
	dir := t.TempDir()
	pids := filepath.Join(dir, "pids")
	fake := filepath.Join(dir, "herdr")
	// A stubborn observer: it ignores SIGTERM, prints a frame, and has a
	// child that ignores it too.
	script := "#!/bin/sh\ntrap '' TERM\n( trap '' TERM; while :; do sleep 0.05; done ) &\necho \"$$ $!\" > " + pids + "\n" +
		"printf '%s\\n' '" + strings.TrimSpace(frameLine(1, true, "hi")) + "'\nwhile :; do sleep 0.05; done\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	c := &Control{Herdr: fake}
	obs, err := c.Observe(context.Background(), "h3d-it-x", "w1:p1", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	f, err := obs.Next()
	if err != nil || !f.Full || string(f.Data) != "hi" {
		t.Fatalf("frame = %+v, %v", f, err)
	}
	b, err := os.ReadFile(pids)
	if err != nil {
		t.Fatal(err)
	}
	var procs []int
	for _, p := range strings.Fields(string(b)) {
		n, _ := strconv.Atoi(p)
		procs = append(procs, n)
	}
	start := time.Now()
	if err := obs.Close(); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took < StopGrace || took > StopGrace+2*time.Second {
		t.Fatalf("Close took %s (SIGTERM ignored: SIGKILL after %s)", took, StopGrace)
	}
	if err := obs.Close(); err != nil { // twice is fine
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for _, pid := range procs {
		for syscall.Kill(pid, 0) == nil { // gone (and reaped: no zombie answers either)
			if time.Now().After(deadline) {
				t.Fatalf("process %d survived Close", pid)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	if _, err := obs.Next(); err == nil {
		t.Fatal("Next after Close")
	}

	// A well-behaved observer goes at SIGTERM, at once.
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' '"+strings.TrimSpace(frameLine(1, true, "hi"))+"'\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	obs, err = c.Observe(context.Background(), "h3d-it-x", "w1:p1", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := obs.Next(); err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	obs.Close()
	if took := time.Since(start); took > StopGrace/2 {
		t.Fatalf("Close of a process that honours SIGTERM took %s", took)
	}
}

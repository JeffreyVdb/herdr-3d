package herdr

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestNormalizeTyped(t *testing.T) {
	for in, want := range map[string]string{
		"fix it":                     "fix it",
		"one\r\ntwo\r\nthree\r\n":    "one\ntwo\nthree\n",
		"old\rmac\r":                 "old\nmac\n",
		"mixed\r\n\r\rend":           "mixed\n\n\nend",
		"\tindented\ta":              "    indented    a",
		"/write-code #95\n\nTeam: x": "/write-code #95\n\nTeam: x",
		"--help ✓ 漢字 🎉 € —":          "--help ✓ 漢字 🎉 € —",
		"  padded  \n":               "  padded  \n",
	} {
		if got, ok := NormalizeTyped(in); !ok || got != want {
			t.Errorf("NormalizeTyped(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", " \n\t\r\n", "esc \x1b[3~", "nul \x00", "bell \a", "del \x7f", "C1 \u0085",
		"C1 \u009b", "bad \xff utf-8", "backspace \b", "form feed \f", "vt \v"} {
		if got, ok := NormalizeTyped(in); ok {
			t.Errorf("NormalizeTyped(%q) = %q, ok; want refused", in, got)
		}
	}
}

func TestTypedChunksAreRuneSafe(t *testing.T) {
	text := strings.Repeat("aé漢🎉\n", 1000) // 1-4 byte runes and new lines
	chunks := typedChunks(text, MaxTypedChunk)
	if strings.Join(chunks, "") != text {
		t.Fatal("chunks do not join back to the text")
	}
	for i, ch := range chunks {
		n := utf8.RuneCountInString(ch)
		if !utf8.ValidString(ch) || n == 0 || n > MaxTypedChunk || (i < len(chunks)-1 && n != MaxTypedChunk) {
			t.Fatalf("chunk %d: %d runes, valid %v", i, n, utf8.ValidString(ch))
		}
		if !validTypedChunk(ch) {
			t.Fatalf("chunk %d refused", i)
		}
	}
	if want := (5000 + MaxTypedChunk - 1) / MaxTypedChunk; len(chunks) != want {
		t.Fatalf("%d chunks, want %d", len(chunks), want)
	}
	if got := typedChunks("short", MaxTypedChunk); !slices.Equal(got, []string{"short"}) {
		t.Fatalf("short = %q", got)
	}
	if got := typedChunks(strings.Repeat("€", 700), MaxTypedChunk); len(got) != 1 {
		t.Fatalf("700 characters of 3 bytes = %d chunks", len(got))
	}
	if validTypedChunk(strings.Repeat("x", MaxTypedChunk+1)) || validTypedChunk("") || validTypedChunk("a\tb") ||
		validTypedChunk("a\rb") || validTypedChunk("\x1b") {
		t.Fatal("a bad chunk passed")
	}
}

// TypePrompt types the normalized text in chunks of at most 700
// characters, TypeGap apart, then presses Enter.
func TestTypePrompt(t *testing.T) {
	var got [][]string
	var at []time.Time
	c := &Control{Herdr: "/opt/herdr", TypeGap: 5 * time.Millisecond,
		Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
			got = append(got, argv)
			at = append(at, time.Now())
			return nil, nil, nil
		}}
	text := "/write-code https://x/issues/95\r\n\tTeam:\r\n" + strings.Repeat("é", 1400)
	if err := c.TypePrompt(context.Background(), "h3d-it-1", "w7:p1", text); err != nil {
		t.Fatal(err)
	}
	norm := "/write-code https://x/issues/95\n    Team:\n" + strings.Repeat("é", 1400)
	chunks := typedChunks(norm, MaxTypedChunk)
	if len(chunks) != 3 {
		t.Fatalf("%d chunks", len(chunks))
	}
	var want [][]string
	for _, ch := range chunks {
		want = append(want, []string{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-text", "w7:p1", ch})
	}
	want = append(want, []string{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "enter"})
	if !slices.EqualFunc(got, want, slices.Equal) {
		t.Fatalf("argv =\n%q\nwant\n%q", got, want)
	}
	for i := 1; i < len(at); i++ {
		if d := at[i].Sub(at[i-1]); d < 5*time.Millisecond {
			t.Fatalf("call %d only %s after the one before", i, d)
		}
	}
}

func TestTypePromptRefusesBeforeTyping(t *testing.T) {
	ran := false
	c := &Control{Only: regexp.MustCompile(`^h3d-it-`), TypeGap: time.Millisecond,
		Run: func(context.Context, []string) ([]byte, []byte, error) { ran = true; return nil, nil, nil }}
	ctx := context.Background()
	for name, call := range map[string]func() error{
		"blank":      func() error { return c.TypePrompt(ctx, "h3d-it-1", "w1:p1", " \r\n\t") },
		"escape":     func() error { return c.TypePrompt(ctx, "h3d-it-1", "w1:p1", strings.Repeat("x", 2000)+"\x1b[3~") },
		"NUL":        func() error { return c.TypePrompt(ctx, "h3d-it-1", "w1:p1", "a\x00b") },
		"too long":   func() error { return c.TypePrompt(ctx, "h3d-it-1", "w1:p1", strings.Repeat("x", MaxTyped+1)) },
		"tabs grow":  func() error { return c.TypePrompt(ctx, "h3d-it-1", "w1:p1", strings.Repeat("\t", MaxTyped/4+1)) },
		"unwatched":  func() error { return c.TypePrompt(ctx, "herdr-3d", "w1:p1", "hi") },
		"bad pane":   func() error { return c.TypePrompt(ctx, "h3d-it-1", "--pane", "hi") },
		"bad utf-8":  func() error { return c.TypePrompt(ctx, "h3d-it-1", "w1:p1", "\xc3") },
		"C1 control": func() error { return c.TypePrompt(ctx, "h3d-it-1", "w1:p1", "a\u0085b") },
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if ran {
		t.Fatal("a refused prompt was typed")
	}
	// The text is never quoted in an error.
	if err := c.TypePrompt(ctx, "h3d-it-1", "w1:p1", "my secret\x1b"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("refused prompt error = %v", err)
	}
	// A cap-sized prompt is typed.
	if err := c.TypePrompt(ctx, "h3d-it-1", "w1:p1", strings.Repeat("x", MaxTyped)); err != nil || !ran {
		t.Fatalf("a %d byte prompt: %v", MaxTyped, err)
	}
}

// A failing chunk stops the typing: no Enter after it.
func TestTypePromptStopsAtAFailingChunk(t *testing.T) {
	var calls int
	c := &Control{TypeGap: time.Millisecond, Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
		calls++
		if calls == 2 {
			return nil, []byte(`{"error":{"code":"pane_not_found","message":"no pane"}}`), errors.New("exit status 1")
		}
		return nil, nil, nil
	}}
	err := c.TypePrompt(context.Background(), "h3d-it-1", "w1:p1", strings.Repeat("x", 2000))
	var api *APIError
	if !errors.As(err, &api) || api.Code != "pane_not_found" || !strings.Contains(err.Error(), "part 2 of 3") || calls != 2 {
		t.Fatalf("err = %v after %d calls", err, calls)
	}
	// What may be in the input box: both parts, the failed one too (it
	// may have landed). 1400 characters on one line: 1 + 1400/10.
	var part *PartlyTypedError
	if !errors.As(err, &part) || part.Erase != 141 {
		t.Fatalf("err = %#v, want a PartlyTypedError erasing 141", err)
	}
}

// R1: whatever stops a typed prompt once its first part is sent leaves a
// PartlyTypedError (the input box may hold a prefix); a refusal before
// anything is typed does not.
func TestTypePromptPartlyTyped(t *testing.T) {
	text := strings.Repeat("line\n", 300) // 1500 characters, 300 lines
	fail := func(at int) func(context.Context, []string) ([]byte, []byte, error) {
		calls := 0
		return func(context.Context, []string) ([]byte, []byte, error) {
			if calls++; calls == at {
				return nil, nil, errors.New("exit status 1")
			}
			return nil, nil, nil
		}
	}
	for name, tc := range map[string]struct {
		run   func(context.Context, []string) ([]byte, []byte, error)
		erase int
	}{
		"first part":  {fail(1), 141 + 70},  // it may have landed: 700 characters, 140 new lines
		"third part":  {fail(3), 301 + 150}, // all of it
		"enter fails": {fail(4), 301 + 150}, // typed, not sent
	} {
		c := &Control{TypeGap: time.Millisecond, Run: tc.run}
		err := c.TypePrompt(context.Background(), "h3d-it-1", "w1:p1", text)
		var part *PartlyTypedError
		if !errors.As(err, &part) || part.Erase != tc.erase || strings.Contains(err.Error(), "line") {
			t.Errorf("%s: err = %v, want a PartlyTypedError erasing %d", name, err, tc.erase)
		}
	}

	// Cancelled between two parts: the parts typed so far.
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	c := &Control{TypeGap: 20 * time.Millisecond, Run: func(context.Context, []string) ([]byte, []byte, error) {
		if calls++; calls == 2 {
			cancel()
		}
		return nil, nil, nil
	}}
	err := c.TypePrompt(ctx, "h3d-it-1", "w1:p1", text)
	var part *PartlyTypedError
	if !errors.As(err, &part) || !errors.Is(err, context.Canceled) || part.Erase != 281+140 || calls != 2 {
		t.Fatalf("cancelled: err = %v after %d calls", err, calls)
	}

	// Refused before typing: nothing to erase.
	c = &Control{TypeGap: time.Millisecond, Run: fail(1)}
	if err := c.TypePrompt(context.Background(), "h3d-it-1", "w1:p1", "a\x1bb"); errors.As(err, &part) {
		t.Fatalf("refused prompt: %v", err)
	}
}

// erasePairs bounds the ctrl+u/backspace pairs that empty Claude Code's
// input box of the text: one per visual line (a narrow pane wraps every
// eraseWidth characters), never more than one per character.
func TestErasePairs(t *testing.T) {
	for _, tc := range []struct {
		text string
		want int
	}{
		{"x", 1},
		{"short", 1},
		{strings.Repeat("\n", 9) + "x", 10}, // never more than one per character
		{strings.Repeat("y", 7000), 1 + 700},
		{strings.Repeat("STALE 0000 yyyyyyyyy\n", 100), 101 + 210}, // 2100 characters, 100 new lines
		{strings.Repeat("漢", 25), 1 + 2},
		{strings.Repeat("\n", 50) + "x", 51},
	} {
		if got := erasePairs(tc.text); got != tc.want {
			t.Errorf("erasePairs(%d characters) = %d, want %d", utf8.RuneCountInString(tc.text), got, tc.want)
		}
	}
}

// EraseTyped presses ctrl+u backspace n times, at most MaxKeys keys per
// `pane send-keys` (the laptops' send-keys shape), then lets Claude Code
// catch up.
func TestEraseTyped(t *testing.T) {
	var got [][]string
	c := &Control{Herdr: "/opt/herdr", TypeGap: time.Millisecond,
		Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
			got = append(got, argv)
			return nil, nil, nil
		}}
	if err := c.EraseTyped(context.Background(), "h3d-it-1", "w7:p1", 70); err != nil {
		t.Fatal(err)
	}
	head := []string{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1"}
	pairs := func(n int) []string {
		return append(slices.Clone(head), slices.Repeat([]string{"ctrl+u", "backspace"}, n)...)
	}
	if want := [][]string{pairs(32), pairs(32), pairs(6)}; !slices.EqualFunc(got, want, slices.Equal) {
		t.Fatalf("argv =\n%q\nwant\n%q", got, want)
	}

	ran := false
	c = &Control{Only: regexp.MustCompile(`^h3d-it-`), TypeGap: time.Millisecond,
		Run: func(context.Context, []string) ([]byte, []byte, error) { ran = true; return nil, nil, nil }}
	for name, call := range map[string]func() error{
		"none":      func() error { return c.EraseTyped(context.Background(), "h3d-it-1", "w1:p1", 0) },
		"too many":  func() error { return c.EraseTyped(context.Background(), "h3d-it-1", "w1:p1", MaxTyped+1) },
		"unwatched": func() error { return c.EraseTyped(context.Background(), "herdr-3d", "w1:p1", 1) },
		"bad pane":  func() error { return c.EraseTyped(context.Background(), "h3d-it-1", "--pane", 1) },
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if ran {
		t.Fatal("a refused erase ran")
	}

	// A failing call stops it.
	calls := 0
	c = &Control{TypeGap: time.Millisecond, Run: func(context.Context, []string) ([]byte, []byte, error) {
		calls++
		return nil, nil, errors.New("exit status 1")
	}}
	if err := c.EraseTyped(context.Background(), "h3d-it-1", "w1:p1", 100); err == nil || calls != 1 {
		t.Fatalf("err = %v after %d calls", err, calls)
	}
}

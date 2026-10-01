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
}

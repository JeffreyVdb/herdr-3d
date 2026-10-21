package herdr

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"testing"
)

func TestParseVersion(t *testing.T) {
	for out, want := range map[string]Version{
		"herdr 0.9.1\n":                   {0, 9, 1},
		"herdr 0.9.5":                     {0, 9, 5},
		"herdr v0.10.0-rc.1 (2ecf19a9)\n": {0, 10, 0},
		"herdr 1.2":                       {1, 2, 0},
		"herdr 0.9.2+git.143bf5fd":        {0, 9, 2},
		"  herdr 12.0.3\nbuilt with 1.92": {12, 0, 3},
	} {
		if got, ok := ParseVersion(out); !ok || got != want {
			t.Errorf("ParseVersion(%q) = %v, %v; want %v", out, got, ok, want)
		}
	}
	for _, out := range []string{"", "herdr", "herdr: unknown flag --version", "w1:p2", `{"result":{"process_info":{"pane_id":"w1:p2"}}}`} {
		if v, ok := ParseVersion(out); ok {
			t.Errorf("ParseVersion(%q) = %v, want none", out, v)
		}
	}
}

func TestVersionAtLeast(t *testing.T) {
	for _, c := range []struct {
		v    Version
		want bool
	}{
		{Version{0, 9, 1}, false},
		{Version{0, 9, 2}, true},
		{Version{0, 9, 10}, true},
		{Version{0, 10, 0}, true}, // not a string compare: "0.10.0" < "0.9.2"
		{Version{1, 0, 0}, true},
		{Version{0, 8, 99}, false},
	} {
		if got := c.v.AtLeast(MouseVersion); got != c.want {
			t.Errorf("%v.AtLeast(%v) = %v", c.v, MouseVersion, got)
		}
	}
}

// The version is read once (`herdr --version`, no session: Only does not
// refuse it), kept, and a failed read is tried again only after a while.
func TestVersionReadOnce(t *testing.T) {
	var runs [][]string
	out, fail := "herdr 0.9.5\n", false
	c := &Control{Herdr: "/opt/herdr", Only: regexp.MustCompile(`^h3d-it-`), Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
		runs = append(runs, argv)
		if fail {
			return nil, []byte("boom"), errors.New("exit status 1")
		}
		return []byte(out), nil, nil
	}}
	ctx := context.Background()
	if !c.MouseClicks(ctx) || !c.MouseClicks(ctx) {
		t.Fatal("0.9.5 takes clicks")
	}
	if v, ok := c.Version(ctx); !ok || v != (Version{0, 9, 5}) {
		t.Fatalf("Version = %v, %v", v, ok)
	}
	if len(runs) != 1 || !slices.Equal(runs[0], []string{"/opt/herdr", "--version"}) {
		t.Fatalf("runs = %q", runs)
	}

	old := &Control{Run: func(context.Context, []string) ([]byte, []byte, error) { return []byte("herdr 0.9.1"), nil, nil }}
	if old.MouseClicks(ctx) {
		t.Fatal("0.9.1 takes no clicks")
	}

	runs, fail = nil, true
	bad := &Control{Run: c.Run}
	if bad.MouseClicks(ctx) || bad.MouseClicks(ctx) {
		t.Fatal("an unknown version takes no clicks")
	}
	if len(runs) != 1 {
		t.Fatalf("a failed read ran again at once: %d runs", len(runs))
	}
	bad.ver.tried = bad.ver.tried.Add(-versionRetry) // a minute later
	fail = false
	if !bad.MouseClicks(ctx) || len(runs) != 2 {
		t.Fatalf("not read again after a failure: %d runs", len(runs))
	}
}

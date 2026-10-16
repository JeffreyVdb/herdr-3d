package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #63: which schedules hold a worktree, and how the reason names them.
func TestScheduleHoldsOf(t *testing.T) {
	t.Parallel()
	for _, st := range []string{store.ScheduleScheduled, store.ScheduleWaiting} {
		if !holding(store.Schedule{State: st}) {
			t.Fatalf("%s does not hold", st)
		}
	}
	for _, st := range []string{store.ScheduleRunning, store.ScheduleDone, store.ScheduleFailed, store.ScheduleSkipped,
		store.ScheduleCancelled} {
		if holding(store.Schedule{State: st}) {
			t.Fatalf("%s holds", st)
		}
	}

	zone := time.FixedZone("CEST", 2*60*60)
	due := time.Date(2026, 10, 17, 8, 45, 0, 0, time.UTC).UnixMilli()
	hs := scheduleHolds{loc: zone, all: []store.Schedule{
		{Title: "Soak done", DueAt: due, Cwd: "/x/wt/internal/server"},
		{Title: "Later", DueAt: due + time.Hour.Milliseconds(), Cwd: "/x/wt"},
		{Title: "Sibling", DueAt: due - time.Hour.Milliseconds(), Cwd: "/x/wt2"},
		{Title: "Root", DueAt: due, Cwd: "/y"},
	}}
	for top, want := range map[string]string{
		"/x/wt":                  "used by scheduled agent 'Soak done' at 2026-10-17 10:45 CEST and 1 more",
		"/x/wt/":                 "used by scheduled agent 'Soak done' at 2026-10-17 10:45 CEST and 1 more",
		"/x/wt/internal/server":  "used by scheduled agent 'Soak done' at 2026-10-17 10:45 CEST",
		"/x/wt2":                 "used by scheduled agent 'Sibling' at 2026-10-17 09:45 CEST",
		"/x/wt/internal/server2": "",
		"/x/w":                   "",
		"/x":                     "used by scheduled agent 'Sibling' at 2026-10-17 09:45 CEST and 2 more",
		"/":                      "used by scheduled agent 'Sibling' at 2026-10-17 09:45 CEST and 3 more",
		"":                       "",
	} {
		if got := hs.of(top); got != want {
			t.Errorf("of(%q) = %q, want %q", top, got, want)
		}
	}
	if got := (scheduleHolds{loc: zone}).of("/x/wt"); got != "" {
		t.Fatalf("no schedules: %q", got)
	}

	// Canonical paths: a cwd reached through a symlink holds the worktree
	// it points into, and the other way round.
	dir := t.TempDir()
	wt := filepath.Join(dir, "wt")
	if err := os.MkdirAll(filepath.Join(wt, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(wt, link); err != nil {
		t.Fatal(err)
	}
	hs = scheduleHolds{loc: zone, all: []store.Schedule{{Title: "Via a link", DueAt: due, Cwd: filepath.Join(link, "sub")}}}
	for _, top := range []string{wt, link} {
		if got := hs.of(top); got != "used by scheduled agent 'Via a link' at 2026-10-17 10:45 CEST" {
			t.Fatalf("of(%q) = %q", top, got)
		}
	}
	if got := hs.of(filepath.Join(dir, "wt2")); got != "" {
		t.Fatalf("sibling of a link: %q", got)
	}
}

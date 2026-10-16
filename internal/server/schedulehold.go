package server

// #63 (part 2 of #61): a schedule that may still fire (scheduled or
// waiting) holds the linked worktree its cwd is in, whatever its worktree
// flag (a worktree hire still needs cwd to find the repository). Nothing
// the bridge does deletes a held worktree: worker.fire.prepare says why,
// worker.fire and worker.wrapup refuse a delete, and an armed wrap-up's
// CLEAN keeps it instead. The hold is read from the schedules each time,
// never kept, so cancelling, firing or dismissing a schedule releases it.
// Removals outside the bridge are not prevented: the schedule then fails
// when it fires (its cwd is gone).

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// scheduleHolds is the schedules that may still fire, by due time, and the
// zone their due times are said in: a copy, safe off the hub goroutine.
type scheduleHolds struct {
	all []store.Schedule
	loc *time.Location
}

// scheduleHolds reads them now (hub goroutine). The zone is the bridge
// clock's (Options.Now: time.Local unless a test injects another).
func (h *Hub) scheduleHolds() scheduleHolds {
	hs := scheduleHolds{loc: h.opts.Now().Location()}
	for _, s := range h.sortedSchedules() {
		if holding(s) {
			hs.all = append(hs.all, s)
		}
	}
	return hs
}

// holding reports whether s holds its worktree: it may still fire.
func holding(s store.Schedule) bool {
	return s.State == store.ScheduleScheduled || s.State == store.ScheduleWaiting
}

// of says why the worktree whose top level is top may not be deleted: the
// earliest due schedule whose cwd is top or under it, and how many more;
// "" when none is. Both paths are compared canonical (cleaned, symlinks
// resolved where they exist).
func (hs scheduleHolds) of(top string) string {
	if top == "" || len(hs.all) == 0 {
		return ""
	}
	top = canonDir(top)
	var first *store.Schedule
	n := 0
	for i, s := range hs.all {
		if inDir(top, canonDir(s.Cwd)) {
			if first == nil || s.DueAt < first.DueAt {
				first = &hs.all[i]
			}
			n++
		}
	}
	if first == nil {
		return ""
	}
	why := fmt.Sprintf("used by scheduled agent '%s' at %s", first.Title, local(time.UnixMilli(first.DueAt).In(hs.loc)))
	if n > 1 {
		why += fmt.Sprintf(" and %d more", n-1)
	}
	return why
}

// local is an instant as a hold's reason says it, in the bridge's zone.
func local(t time.Time) string { return t.Format("2006-01-02 15:04 MST") }

// canonDir is dir cleaned, with its symlinks resolved when it exists.
func canonDir(dir string) string {
	dir = filepath.Clean(dir)
	if p, err := filepath.EvalSymlinks(dir); err == nil {
		return p
	}
	return dir
}

// inDir reports whether path is dir or under it, on separator boundaries
// (/a/wt holds /a/wt/sub, not /a/wt2).
func inDir(dir, path string) bool {
	return path == dir || strings.HasPrefix(path, strings.TrimSuffix(dir, string(filepath.Separator))+string(filepath.Separator))
}

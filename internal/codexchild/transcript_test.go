package codexchild

import (
	"context"
	"errors"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// visible are a log's items a reader sees (not hidden), oldest first.
func visible(t *testing.T, l *transcript.Log) []proto.TranscriptItem {
	t.Helper()
	pg, err := l.Before(0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var out []proto.TranscriptItem
	for _, it := range pg.Items {
		if !it.Hidden {
			out = append(out, it)
		}
	}
	return out
}

// A child's transcript is its own conversation: the Codex parser over its
// rollout, its parent's copied history (records before its history start,
// the copied session_meta among them) hidden. The parent's copied turns
// show (as "Turn done", a user prompt) only without that.
func TestReadTranscript(t *testing.T) {
	for _, tc := range []struct {
		name, thread, start string
	}{
		{"corpus-trap", trapChild, "2026-10-15T19:56:23.956Z"}, // its own task_started (ordinal 17)
		{"g-a0160-v", gChild, "2026-10-18T08:50:49.854Z"},      // its thread_settings_applied (ordinal 9)
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, tc.name)
			r.all()
			l, err := ReadTranscript(context.Background(), r.root, r.session, tc.thread)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			items := visible(t, l)
			if len(items) == 0 {
				t.Fatal("no items")
			}
			for _, it := range items {
				if it.TS < ts(tc.start) {
					t.Errorf("inherited item shown: %+v", it)
				}
			}
			if l.Version() == "" {
				t.Error("no cli version (its own session_meta's)")
			}
			whole, err := transcript.Read(context.Background(), transcript.Codex, r.path(tc.thread))
			if err != nil {
				t.Fatal(err)
			}
			defer whole.Close()
			if all := visible(t, whole); len(all) <= len(items) || all[0].TS >= ts(tc.start) {
				t.Errorf("without the history start: %d items, the first at %d", len(all), all[0].TS)
			}
		})
	}
}

// Only a spawned child of the session has a child transcript: not the root,
// a guardian, another session's child or an unknown thread.
func TestReadTranscriptRefuses(t *testing.T) {
	r := newRig(t, "corpus-guardian")
	r.all()
	b := newRig(t, "b")
	b.root = r.root
	b.all()
	for _, tc := range []struct{ session, thread string }{
		{r.session, r.session},
		{r.session, guardian},
		{r.session, bA},
		{r.session, "01a14e00-0000-7000-8000-00000000dead"},
		{cases["b"], "../x"},
	} {
		if _, err := ReadTranscript(context.Background(), r.root, tc.session, tc.thread); !errors.Is(err, ErrNoRollout) {
			t.Errorf("%s of %s: %v; want ErrNoRollout", tc.thread, tc.session, err)
		}
	}
	if l, err := ReadTranscript(context.Background(), r.root, cases["b"], bA); err != nil {
		t.Errorf("b's own child: %v", err)
	} else {
		l.Close()
	}
}

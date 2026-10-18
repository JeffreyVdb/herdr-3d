package server

import (
	"context"
	"sync"
	"time"
)

// TranscriptWatches counts the running transcript watches (tests).
func (h *Hub) TranscriptWatches() int { return len(h.tx.all()) }

// RepoCloned is repoCloned (#247), for its table test.
func RepoCloned(ctx context.Context, dir, repo string, stat func(string) error, origin func(context.Context, string) string, timeout time.Duration) bool {
	return repoCloned(ctx, dir, repo, stat, origin, timeout)
}

// FollowupPrompt is the prompt worker.answer_followup sends (#60).
var FollowupPrompt = followupPrompt

// QuestionReadGrace is questionReadGrace (#106).
const QuestionReadGrace = questionReadGrace

// CheckSchedules runs the schedule runner's look at the clock now, with
// the hub's context (#62).
func (h *Hub) CheckSchedules(ctx context.Context) error {
	done := make(chan struct{})
	if err := h.do(ctx, func(hctx context.Context) { h.checkSchedules(hctx); close(done) }); err != nil {
		return err
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// FloorsKnown reports whether discovery's first list of sessions reached
// the schedule runner (#62).
func (h *Hub) FloorsKnown(ctx context.Context) bool {
	ok, _ := query(ctx, h, func() bool { return h.sc.listed != nil })
	return ok
}

// ListedSessions is the sessions the schedule runner last got from
// discovery (#62).
func (h *Hub) ListedSessions(ctx context.Context) []string {
	l, _ := query(ctx, h, func() []string { return sortedKeys(h.sc.listed) })
	return l
}

// HoldScanSlots takes every prompt secrets scan slot (#108 review B2): a
// command's gate waits for one until release.
func (h *Hub) HoldScanSlots() (release func()) {
	for range maxSecretScans {
		h.ps.slots <- struct{}{}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			for range maxSecretScans {
				<-h.ps.slots
			}
		})
	}
}

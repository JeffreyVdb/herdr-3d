package server

import (
	"context"
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

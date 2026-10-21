package codexapp

// #139 S1e: a shared worker's thread from its own server, for a worker
// whose Codex home runs no herdr hook (herdr then never reports its
// session). Only the one root thread the server has loaded counts: the
// server loads a root's subagents too (#27), so a child, an ephemeral
// thread or a choice between two roots is no answer: the bridge never
// guesses a thread (Options.Thread).

import (
	"context"
	"encoding/json"
)

// RootThread asks a worker's own server (its socket) for the root thread
// it has loaded: its id when there is exactly one, else "".
func RootThread(ctx context.Context, sock string) (string, error) {
	c, err := dial(ctx, sock, nil)
	if err != nil {
		return "", err
	}
	defer c.close()
	if err := c.call(ctx, "initialize", initParams("thread"), nil); err != nil {
		return "", err
	}
	if err := c.notify(ctx, "initialized"); err != nil {
		return "", err
	}
	var loaded []string
	var cursor any
	for range MaxDescendantPages {
		var page struct {
			Data []string `json:"data"`
			Next *string  `json:"nextCursor"`
		}
		if err := c.call(ctx, "thread/loaded/list", map[string]any{"cursor": cursor}, &page); err != nil {
			return "", err
		}
		loaded = append(loaded, page.Data...)
		if page.Next == nil || *page.Next == "" {
			break
		}
		cursor = *page.Next
	}
	if len(loaded) > MaxLoadedReads {
		return "", nil // too many to tell
	}
	root := ""
	for _, id := range loaded {
		var res struct {
			Thread *Thread `json:"thread"`
		}
		if err := c.call(ctx, "thread/read", map[string]any{"threadId": id}, &res); err != nil {
			return "", err
		}
		if res.Thread == nil || res.Thread.ID != id || !res.Thread.isRoot() {
			continue
		}
		if root != "" {
			return "", nil // two roots: none is guessed
		}
		root = id
	}
	return root, nil
}

// isRoot reports whether the thread is a root a person works in: not
// ephemeral, no parent, and not started by an agent (any subAgent source:
// a spawn, a review, a compaction).
func (t *Thread) isRoot() bool {
	if t.Ephemeral || t.ParentID() != "" || t.ThreadSource == "subagent" {
		return false
	}
	var src struct {
		SubAgent json.RawMessage `json:"subAgent"`
	}
	return json.Unmarshal(t.Source, &src) != nil || len(src.SubAgent) == 0
}

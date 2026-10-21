package codexapp

import (
	"context"
	"testing"
	"time"
)

// #139 S1e: the one root thread a worker's server has loaded; a subagent
// (spawned, a review), an ephemeral thread or a second root is never taken.
func TestRootThread(t *testing.T) {
	root := map[string]any{"id": "th-root", "ephemeral": false, "source": "cli"}
	other := map[string]any{"id": "th-other", "ephemeral": false, "source": "vscode"}
	spawned := map[string]any{"id": "th-child", "ephemeral": false, "parentThreadId": "th-root",
		"source": map[string]any{"subAgent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": "th-root", "depth": 1}}}}
	spawnOnly := map[string]any{"id": "th-spawn", "ephemeral": false,
		"source": map[string]any{"subAgent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": "th-gone", "depth": 1}}}}
	review := map[string]any{"id": "th-review", "ephemeral": false, "source": map[string]any{"subAgent": "review"}}
	marked := map[string]any{"id": "th-marked", "ephemeral": false, "threadSource": "subagent"}
	ephemeral := map[string]any{"id": "th-eph", "ephemeral": true}
	for _, c := range []struct {
		name    string
		threads []map[string]any
		want    string
	}{
		{"the root", []map[string]any{root}, "th-root"},
		{"the root and its subagents", []map[string]any{spawned, root, review, spawnOnly, marked}, "th-root"},
		{"no source", []map[string]any{{"id": "th-bare", "ephemeral": false}}, "th-bare"},
		{"only subagents", []map[string]any{spawned, review, spawnOnly, marked}, ""},
		{"two roots", []map[string]any{root, spawned, other}, ""},
		{"ephemeral", []map[string]any{ephemeral}, ""},
		{"none", nil, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeServer(t)
			byID := map[string]map[string]any{}
			ids := []string{}
			for _, th := range c.threads {
				byID[th["id"].(string)] = th
				ids = append(ids, th["id"].(string))
			}
			f.respond = func(method string, params map[string]any) (any, any, bool) {
				switch method {
				case "thread/loaded/list":
					return map[string]any{"data": ids, "nextCursor": nil}, nil, false
				case "thread/read":
					return map[string]any{"thread": byID[params["threadId"].(string)]}, nil, false
				}
				return nil, map[string]any{"code": -32601, "message": "unknown"}, false
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			got, err := RootThread(ctx, f.sock)
			if err != nil || got != c.want {
				t.Fatalf("got %q, %v; want %q", got, err, c.want)
			}
			for _, m := range f.messages() {
				switch m["method"] {
				case "initialize", "initialized", "thread/loaded/list", "thread/read":
				default:
					t.Fatalf("sent %v", m) // nothing that subscribes, resumes or starts
				}
			}
		})
	}
}

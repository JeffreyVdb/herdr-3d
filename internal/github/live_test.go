//go:build live

package github

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
)

// A read-only look at a real repository through gh: `go test -tags live
// ./internal/github -run TestLiveBoard -v` with H3D_LIVE_REPO (default
// JeffreyVdb/herdr-3d) and H3D_LIVE_PROJECT ("<owner>/<number>", default
// JeffreyVdb/2). Writes nothing.
func TestLiveBoard(t *testing.T) {
	repo := os.Getenv("H3D_LIVE_REPO")
	if repo == "" {
		repo = "JeffreyVdb/herdr-3d"
	}
	cfg := Config{Repo: repo, ProjectOwner: "JeffreyVdb", ProjectNumber: 2}
	if p := os.Getenv("H3D_LIVE_PROJECT"); p != "" {
		cfg.ProjectOwner, _ = splitProject(p)
		_, cfg.ProjectNumber = splitProject(p)
	}
	reg := NewRegistry(&githubcli.Client{}, nil)
	tr, host := reg.For(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	prs, err := host.Board(ctx, codehost.PrevState{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := tr.Board(ctx)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.MarshalIndent(map[string]any{"columns": b.Columns, "cards": b.Cards, "truncated": b.Truncated, "rate": b.Rate,
		"prs": prs.Requests}, "", " ")
	t.Logf("%s", out)
}

func splitProject(s string) (string, int) {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' {
			n, _ := strconv.Atoi(s[i+1:])
			return s[:i], n
		}
	}
	return "", 0
}

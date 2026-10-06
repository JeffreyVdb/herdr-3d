package app

import (
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/github"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// GitHubBoards is the one place the bridge is wired to GitHub: a floor with
// an effective repo gets GitHub Issues (and its Projects v2 Status columns,
// when the floor names a project) and pull requests, through cli. The
// server, which sits above the neutral interfaces, only sees the factory.
// now is the boards' clock (the closed-issue window, the feed's age); nil is
// time.Now.
func GitHubBoards(cli *githubcli.Client, now func() time.Time) server.BoardFactory {
	reg := github.NewRegistry(cli, now)
	return func(src server.BoardSource) (server.BoardSet, bool) {
		if !gitremote.ValidRepo(src.Repo) {
			return server.BoardSet{}, false
		}
		cfg := github.Config{Repo: src.Repo, ProjectOwner: src.ProjectOwner, ProjectNumber: src.ProjectNumber, StatusField: src.StatusField}
		tr, host := reg.For(cfg)
		return server.BoardSet{Key: cfg.Key(), Tracker: tr, Host: host}, true
	}
}

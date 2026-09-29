package app

import (
	"github.com/JeffreyVdb/herdr-3d/internal/github"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// GitHubBoards is the one place the bridge is wired to GitHub: a floor with
// an effective repo gets GitHub Issues (and its Projects v2 Status columns,
// when the floor names a project) and pull requests, through cli. The
// server, which sits above the neutral interfaces, only sees the factory.
func GitHubBoards(cli *githubcli.Client) server.BoardFactory {
	reg := github.NewRegistry(cli, nil)
	return func(src server.BoardSource) (server.BoardSet, bool) {
		if !gitremote.ValidRepo(src.Repo) {
			return server.BoardSet{}, false
		}
		cfg := github.Config{Repo: src.Repo, ProjectOwner: src.ProjectOwner, ProjectNumber: src.ProjectNumber, StatusField: src.StatusField}
		tr, host := reg.For(cfg)
		return server.BoardSet{Key: cfg.Key(), Tracker: tr, Host: host}, true
	}
}

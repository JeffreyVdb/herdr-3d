package app

import (
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/github"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// KaneoTrackers builds a Kaneo floor's issue tracker from its source (the
// saved connection's instance and generation, the floor's workspace and
// project) and names its fetch (instance, workspace and project, never the
// key); ok false: none (not connected, or the generation is not the saved
// one any more).
type KaneoTrackers func(src server.BoardSource) (tr tracker.Tracker, key string, ok bool)

// Boards is the one place the bridge is wired to its providers. #184: a
// floor's issue tracker and its code host are chosen apart. A GitHub floor
// with an effective repo gets GitHub Issues (and its Projects v2 Status
// columns, when the floor names a project) and pull requests, through cli.
// A Kaneo floor gets kaneo's tracker for its project and, when it has a
// repo, that repo's GitHub pull requests (no repo: no pull request board).
// The server, which sits above the neutral interfaces, only sees the
// factory. now is the boards' clock (the closed-issue window, the feed's
// age); nil is time.Now. kaneo nil: Kaneo floors have no board.
func Boards(cli *githubcli.Client, now func() time.Time, kaneo KaneoTrackers) server.BoardFactory {
	reg := github.NewRegistry(cli, now)
	return func(src server.BoardSource) (server.BoardSet, bool) {
		if src.Tracker != server.TrackerKaneo {
			if !gitremote.ValidRepo(src.Repo) {
				return server.BoardSet{}, false
			}
			cfg := github.Config{Repo: src.Repo, ProjectOwner: src.ProjectOwner, ProjectNumber: src.ProjectNumber, StatusField: src.StatusField}
			tr, host := reg.For(cfg)
			return server.BoardSet{Key: cfg.Key(), Tracker: tr, Host: host}, true
		}
		if kaneo == nil {
			return server.BoardSet{}, false
		}
		tr, key, ok := kaneo(src)
		if !ok || tr == nil {
			return server.BoardSet{}, false
		}
		set := server.BoardSet{Key: "kaneo\x00" + key, Tracker: tr}
		if gitremote.ValidRepo(src.Repo) {
			cfg := github.Config{Repo: src.Repo}
			_, host := reg.For(cfg)
			set.Host, set.Key = host, set.Key+"\x00github\x00"+cfg.Key()
		}
		return set, true
	}
}

// GitHubBoards is Boards without Kaneo floors.
func GitHubBoards(cli *githubcli.Client, now func() time.Time) server.BoardFactory {
	return Boards(cli, now, nil)
}

// kaneoConnector is the Kaneo client behind the settings' Connector.
//
// ROUND 2 (#184): adapt internal/kaneo's client here (URL normalization,
// the connection test, the workspace and project lists, one project); a
// network failure wraps kaneoconf.ErrUnreachable. nil until then: the
// settings load and show, and kaneo.test answers unsupported.
func kaneoConnector() kaneoconf.Connector { return nil }

// kaneoTrackers builds a Kaneo floor's tracker from the saved connection.
//
// ROUND 2 (#184): svc.Credentials(src.KaneoGeneration) gives the instance
// and key while that generation is the saved one; build internal/kaneo's
// tracker for (src.KaneoWorkspace, src.KaneoProject, the web origin) and
// return its identity (instance, workspace, project) with the generation
// appended. nil until then: a Kaneo floor's board.watch says it cannot read
// Kaneo boards.
func kaneoTrackers(svc *kaneoconf.Service) KaneoTrackers {
	_ = svc
	return nil
}

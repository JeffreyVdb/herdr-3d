package app

import (
	"context"
	"errors"
	"strconv"
	"sync"

	"github.com/JeffreyVdb/herdr-3d/internal/kaneo"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// #184: the Kaneo wiring. internal/kaneoconf holds the connection and
// reaches Kaneo through its Connector; the board factory builds a Kaneo
// floor's tracker through a KaneoTrackers hook. Both are internal/kaneo's
// client here, and nowhere else (TestBoardLayerIsProviderNeutral).

// kaneoOptions are the clients' transport and per-call timeout: the
// default transport (its pool shared by every client) and the settings'
// call bound, so a board read's calls are bounded like a test's.
var kaneoOptions = kaneo.Options{Timeout: kaneoconf.DefaultTimeout}

// Kaneo opens the bridge's Kaneo connection (opts, its Connector being
// internal/kaneo's client) and the hook that builds Kaneo floors' trackers
// from it: what the world command wires in.
func Kaneo(opts kaneoconf.Options) (*kaneoconf.Service, KaneoTrackers, error) {
	opts.Connector = KaneoConnector()
	svc, err := kaneoconf.New(opts)
	if err != nil {
		return nil, nil, err
	}
	return svc, KaneoFloors(svc), nil
}

// KaneoConnector is internal/kaneo's client behind the settings' Connector.
// Each call makes the client of the instance and key it is given (a draft
// being tested is not the saved connection); a client is a few fields, and
// they share the transport. Every call is a GET.
func KaneoConnector() kaneoconf.Connector { return kaneoConnector{} }

type kaneoConnector struct{}

func (kaneoConnector) Resolve(raw string) (kaneoconf.Instance, error) {
	ep, err := kaneo.ParseURL(raw)
	if err != nil {
		return kaneoconf.Instance{}, err
	}
	return kaneoconf.Instance{APIBase: ep.APIBase, WebOrigin: ep.WebOrigin}, nil
}

func (kaneoConnector) Test(ctx context.Context, in kaneoconf.Instance, key string) (kaneoconf.TestResult, error) {
	c, err := kaneo.New(in.APIBase, key, kaneoOptions)
	if err != nil {
		return kaneoconf.TestResult{}, err
	}
	r, err := c.Test(ctx)
	if err != nil {
		return kaneoconf.TestResult{}, kaneoErr(err)
	}
	return kaneoconf.TestResult{Workspaces: kaneoWorkspaces(r.Workspaces), User: r.User}, nil
}

func (kaneoConnector) Workspaces(ctx context.Context, in kaneoconf.Instance, key string) ([]kaneoconf.Workspace, error) {
	c, err := kaneo.New(in.APIBase, key, kaneoOptions)
	if err != nil {
		return nil, err
	}
	ws, err := c.Workspaces(ctx)
	if err != nil {
		return nil, kaneoErr(err)
	}
	return kaneoWorkspaces(ws), nil
}

func (kaneoConnector) Projects(ctx context.Context, in kaneoconf.Instance, key, workspaceID string) ([]kaneoconf.Project, error) {
	c, err := kaneo.New(in.APIBase, key, kaneoOptions)
	if err != nil {
		return nil, err
	}
	ps, err := c.Projects(ctx, workspaceID, false)
	if err != nil {
		return nil, kaneoErr(err)
	}
	out := make([]kaneoconf.Project, 0, len(ps))
	for _, p := range ps {
		out = append(out, kaneoProject(p))
	}
	return out, nil
}

// Project is the project as Kaneo has it, its workspace and archived state
// included: kaneoconf.VerifyProject tells "gone" (not found, which a 400 on
// the id read is too) from "of another workspace" and "archived" itself.
func (kaneoConnector) Project(ctx context.Context, in kaneoconf.Instance, key, projectID string) (kaneoconf.Project, error) {
	c, err := kaneo.New(in.APIBase, key, kaneoOptions)
	if err != nil {
		return kaneoconf.Project{}, err
	}
	p, err := c.Project(ctx, projectID)
	if err != nil {
		return kaneoconf.Project{}, kaneoErr(err)
	}
	return kaneoProject(p), nil
}

func kaneoWorkspaces(ws []kaneo.Workspace) []kaneoconf.Workspace {
	out := make([]kaneoconf.Workspace, 0, len(ws))
	for _, w := range ws {
		out = append(out, kaneoconf.Workspace{ID: w.ID, Name: w.Name, Slug: w.Slug})
	}
	return out
}

func kaneoProject(p kaneo.Project) kaneoconf.Project {
	return kaneoconf.Project{ID: p.ID, WorkspaceID: p.WorkspaceID, Name: p.Name, Slug: p.Slug, Archived: p.Archived}
}

// kaneoErr keeps the provider's error kinds and adds the settings' mark of
// a call that never reached Kaneo.
func kaneoErr(err error) error {
	if errors.Is(err, kaneo.ErrUnreachable) {
		return unreachableErr{err}
	}
	return err
}

// unreachableErr is a kaneo.ErrUnreachable failure that is also
// kaneoconf.ErrUnreachable; its message is the call's.
type unreachableErr struct{ err error }

func (e unreachableErr) Error() string   { return e.err.Error() }
func (e unreachableErr) Unwrap() []error { return []error{kaneoconf.ErrUnreachable, e.err} }

// KaneoFloors builds Kaneo floors' trackers from svc's saved connection:
// while a floor's source names the saved generation, the tracker of its
// workspace and project through one client of the saved instance and key.
// Its identity is the tracker's Key (API base, workspace, project) and the
// generation, never the key. Floors of one project share their tracker, and
// a tracker lives on while the generation does, so its last board (what a
// move is computed and checked against) survives the factory's calls. It
// runs on the hub goroutine: nothing here calls Kaneo.
func KaneoFloors(svc *kaneoconf.Service) KaneoTrackers {
	var (
		mu       sync.Mutex
		gen      int64
		client   *kaneo.Client
		trackers = map[string]*kaneo.Tracker{}
	)
	return func(src server.BoardSource) (tracker.Tracker, string, bool) {
		if src.KaneoWorkspace == "" || src.KaneoProject == "" {
			return nil, "", false
		}
		in, key, ok := svc.Credentials(src.KaneoGeneration)
		if !ok {
			return nil, "", false
		}
		mu.Lock()
		defer mu.Unlock()
		if client == nil || gen != src.KaneoGeneration {
			c, err := kaneo.New(in.APIBase, key, kaneoOptions)
			if err != nil {
				return nil, "", false
			}
			client, gen = c, src.KaneoGeneration
			clear(trackers) // of an older connection: their key is not the saved one
		}
		tr := kaneo.NewTracker(client, src.KaneoWorkspace, src.KaneoProject, in.WebOrigin)
		id := tr.Key() + "|g" + strconv.FormatInt(gen, 10)
		if have := trackers[id]; have != nil {
			return have, id, true
		}
		trackers[id] = tr
		return tr, id, true
	}
}

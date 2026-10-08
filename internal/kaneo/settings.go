package kaneo

import (
	"context"
	"encoding/json"
	"net/url"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// Workspace is a workspace the key reaches (Kaneo's auth API calls it an
// organization).
type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// Project is a project of a workspace.
type Project struct {
	ID, WorkspaceID, Name, Slug string
	Archived                    bool
}

// TestResult is a successful connection test: the workspaces the key
// reaches (none: authenticated, but no floor can be linked yet), how long
// their list took and, when Kaneo said, whose key it is.
type TestResult struct {
	Workspaces []Workspace
	Latency    time.Duration
	User       string
}

// Test checks the connection with reads only: the workspace list
// (authenticated: it is what proves the key), then the key's owner, which
// is optional (its failure is not the test's).
func (c *Client) Test(ctx context.Context) (TestResult, error) {
	start := time.Now()
	ws, err := c.Workspaces(ctx)
	if err != nil {
		return TestResult{}, err
	}
	r := TestResult{Workspaces: ws, Latency: time.Since(start)}
	var me struct {
		Name string `json:"name"`
	}
	if err := c.get(ctx, "/user/me", nil, &me); err == nil {
		r.User = me.Name
	} else if ctx.Err() != nil {
		return TestResult{}, err
	}
	return r, nil
}

// Workspaces lists the workspaces the key reaches. The schema leaves the
// items open: one without an id is skipped.
func (c *Client) Workspaces(ctx context.Context) ([]Workspace, error) {
	var raw []json.RawMessage
	if err := c.get(ctx, "/auth/organization/list", nil, &raw); err != nil {
		return nil, err
	}
	out := []Workspace{}
	for _, r := range raw {
		var w Workspace
		if json.Unmarshal(r, &w) != nil || w.ID == "" {
			continue
		}
		if w.Name == "" {
			w.Name = w.ID
		}
		out = append(out, w)
	}
	return out, nil
}

// wireProject is a project as Kaneo sends it.
type wireProject struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspaceId"`
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	ArchivedAt  *string `json:"archivedAt"`
}

func (p wireProject) project() Project {
	return Project{ID: p.ID, WorkspaceID: p.WorkspaceID, Name: p.Name, Slug: p.Slug, Archived: p.ArchivedAt != nil}
}

// Projects lists a workspace's projects in Kaneo's order; archived ones
// only with includeArchived. One that says it is of another workspace is
// left out.
func (c *Client) Projects(ctx context.Context, workspaceID string, includeArchived bool) ([]Project, error) {
	if workspaceID == "" {
		return nil, provider.Errorf(provider.ErrBadInput, "no workspace")
	}
	q := url.Values{"workspaceId": {workspaceID}}
	if includeArchived {
		q.Set("includeArchived", "true")
	}
	var raw []wireProject
	if err := c.get(ctx, "/project", q, &raw); err != nil {
		return nil, err
	}
	out := []Project{}
	for _, p := range raw {
		if p.ID == "" || p.WorkspaceID != workspaceID || p.ArchivedAt != nil && !includeArchived {
			continue
		}
		out = append(out, p.project())
	}
	return out, nil
}

// Project reads one project; an unknown one is provider.ErrNotFound.
func (c *Client) Project(ctx context.Context, id string) (Project, error) {
	if id == "" {
		return Project{}, provider.Errorf(provider.ErrNotFound, "no project")
	}
	var p wireProject
	if err := notFoundOn400(c.get(ctx, "/project/"+esc(id), nil, &p)); err != nil {
		return Project{}, err
	}
	if p.ID != id {
		return Project{}, provider.Failed("Kaneo: GET /project/%s: answered another project", esc(id))
	}
	return p.project(), nil
}

// ProjectIn reads a project and checks it is of workspaceID: a floor's link
// is saved only when it is (provider.ErrNotFound when it is not).
func (c *Client) ProjectIn(ctx context.Context, workspaceID, projectID string) (Project, error) {
	p, err := c.Project(ctx, projectID)
	if err != nil {
		return Project{}, err
	}
	if p.WorkspaceID != workspaceID {
		return Project{}, provider.Errorf(provider.ErrNotFound, "Kaneo project %s is not in workspace %s", projectID, workspaceID)
	}
	return p, nil
}

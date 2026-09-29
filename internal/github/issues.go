package github

import (
	"context"
	"fmt"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// issues is the tracker.Tracker of a source.
type issues struct{ *source }

var (
	_ tracker.Tracker   = (*issues)(nil)
	_ tracker.RunLinker = (*issues)(nil)
)

func (t *issues) Info() tracker.Info {
	return tracker.Info{ID: ProviderID, Name: ProviderName, Capabilities: t.trackerCaps()}
}

func (t *issues) Board(ctx context.Context) (tracker.Board, error) {
	f, err := t.feed(ctx, nil)
	if err != nil {
		return tracker.Board{}, err
	}
	return f.issues, nil
}

// ItemFromRun and RunFromItem map M6's run issue link and item ids.
func (t *issues) ItemFromRun(repo string, number int) (string, bool) {
	if number < 1 || repo == "" {
		return "", false
	}
	return t.itemID(repo, number), true
}

func (t *issues) RunFromItem(id string) (string, int, string, bool) {
	repo, n, ok := t.parseID(id)
	if !ok || repo == "" {
		return "", 0, "", false
	}
	return repo, n, fmt.Sprintf("https://github.com/%s/issues/%d", repo, n), true
}

// node is the GraphQL node id of an issue of this repository.
func (s *source) issueNode(ctx context.Context, id string) (string, error) {
	n, err := s.own(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	node, ok := s.nodes[id]
	s.mu.Unlock()
	if ok {
		return node, nil
	}
	var res struct {
		Repository *struct {
			Issue *struct {
				ID string `json:"id"`
			} `json:"issue"`
		} `json:"repository"`
	}
	if err := s.query(ctx, githubcli.DocIssueNode, map[string]any{"owner": s.owner(), "repo": s.repoName(), "number": n}, &res); err != nil {
		return "", err
	}
	if res.Repository == nil || res.Repository.Issue == nil {
		return "", provider.Errorf(provider.ErrNotFound, "%s is not on %s", id, s.cfg.Repo)
	}
	s.remember(res.Repository.Issue.ID, id)
	return res.Repository.Issue.ID, nil
}

func (t *issues) Get(ctx context.Context, id string) (tracker.Detail, error) {
	n, err := t.own(id)
	if err != nil {
		return tracker.Detail{}, err
	}
	var res struct {
		Repository *struct {
			Issue *struct {
				issueNode
				Comments struct {
					PageInfo pageInfo `json:"pageInfo"`
					Nodes    []struct {
						ID        string `json:"id"`
						Body      string `json:"body"`
						Author    *user  `json:"author"`
						CreatedAt string `json:"createdAt"`
					} `json:"nodes"`
				} `json:"comments"`
			} `json:"issue"`
		} `json:"repository"`
	}
	if err := t.query(ctx, githubcli.DocIssueDetail, map[string]any{"owner": t.owner(), "repo": t.repoName(), "number": n}, &res); err != nil {
		return tracker.Detail{}, err
	}
	if res.Repository == nil || res.Repository.Issue == nil {
		return tracker.Detail{}, provider.Errorf(provider.ErrNotFound, "%s is not on %s", id, t.cfg.Repo)
	}
	is := res.Repository.Issue
	t.remember(is.ID, id)
	d := tracker.Detail{Body: is.Body, CreatedAt: ms(is.CreatedAt), Comments: []provider.Comment{},
		CommentsTruncated: is.Comments.PageInfo.HasNextPage}
	// The card as the board shows it (its column comes from the project), else
	// as the issue itself says.
	var pr *project
	if f := t.lastFeed(); f != nil {
		pr = f.project
		for _, c := range f.issues.Cards {
			if c.ID == id {
				d.Card = c
			}
		}
	}
	if d.Card.ID == "" {
		d.Card, _ = t.card(&is.issueNode, pr)
		if t.hasProject() && pr == nil {
			d.Card.Column = "" // its status is in the project: not known without a board read
		}
	}
	if is.Author != nil {
		d.Author = provider.Person{Name: is.Author.Login, AvatarURL: is.Author.AvatarURL}
	}
	for _, c := range is.Comments.Nodes {
		cm := provider.Comment{ID: c.ID, Body: c.Body, CreatedAt: ms(c.CreatedAt)}
		if c.Author != nil {
			cm.Author = provider.Person{Name: c.Author.Login, AvatarURL: c.Author.AvatarURL}
		}
		d.Comments = append(d.Comments, cm)
	}
	return d, nil
}

func (t *issues) Comment(ctx context.Context, id, body string) (provider.Comment, error) {
	node, err := t.issueNode(ctx, id)
	if err != nil {
		return provider.Comment{}, err
	}
	return t.addComment(ctx, node, body)
}

// addComment comments on an issue or a pull request (its node id).
func (s *source) addComment(ctx context.Context, node, body string) (provider.Comment, error) {
	var res struct {
		AddComment struct {
			CommentEdge struct {
				Node struct {
					ID        string `json:"id"`
					Body      string `json:"body"`
					CreatedAt string `json:"createdAt"`
					Author    *user  `json:"author"`
				} `json:"node"`
			} `json:"commentEdge"`
		} `json:"addComment"`
	}
	if err := s.query(ctx, githubcli.DocAddComment, map[string]any{"subjectId": node, "body": body}, &res); err != nil {
		return provider.Comment{}, err
	}
	s.changed()
	n := res.AddComment.CommentEdge.Node
	c := provider.Comment{ID: n.ID, Body: n.Body, CreatedAt: ms(n.CreatedAt)}
	if n.Author != nil {
		c.Author = provider.Person{Name: n.Author.Login, AvatarURL: n.Author.AvatarURL}
	}
	return c, nil
}

var closeReasons = map[string]string{
	tracker.ReasonCompleted:  "COMPLETED",
	tracker.ReasonNotPlanned: "NOT_PLANNED",
	tracker.ReasonDuplicate:  "DUPLICATE",
}

func (t *issues) Close(ctx context.Context, id, reason string) error {
	gh, ok := closeReasons[reason]
	if !ok {
		return provider.Errorf(provider.ErrBadInput, "close reason must be completed, not_planned or duplicate")
	}
	node, err := t.issueNode(ctx, id)
	if err != nil {
		return err
	}
	if err := t.query(ctx, githubcli.DocCloseIssue, map[string]any{"issueId": node, "reason": gh}, nil); err != nil {
		return err
	}
	t.changed()
	return nil
}

func (t *issues) SetStatus(ctx context.Context, id, columnID string) error {
	if !t.hasProject() {
		return provider.Errorf(provider.ErrUnsupported, "this board has no project: issues have no status to set")
	}
	n, err := t.own(id)
	if err != nil {
		return err
	}
	projectOwner := t.cfg.ProjectOwner
	if projectOwner == "" {
		projectOwner = t.owner()
	}
	var res struct {
		Repository *struct {
			Issue *struct {
				ID           string `json:"id"`
				ProjectItems struct {
					Nodes []struct {
						ID      string `json:"id"`
						Project struct {
							ID     string `json:"id"`
							Number int    `json:"number"`
						} `json:"project"`
					} `json:"nodes"`
				} `json:"projectItems"`
			} `json:"issue"`
		} `json:"repository"`
		RepositoryOwner *struct {
			Project *projectNode `json:"projectV2"`
		} `json:"repositoryOwner"`
	}
	if err := t.query(ctx, githubcli.DocStatusTarget, map[string]any{"owner": t.owner(), "repo": t.repoName(), "number": n,
		"projectOwner": projectOwner, "projectNumber": t.cfg.ProjectNumber}, &res); err != nil {
		return err
	}
	if res.Repository == nil || res.Repository.Issue == nil {
		return provider.Errorf(provider.ErrNotFound, "%s is not on %s", id, t.cfg.Repo)
	}
	if res.RepositoryOwner == nil || res.RepositoryOwner.Project == nil {
		return provider.Failed("GitHub project %d of %s not found", t.cfg.ProjectNumber, projectOwner)
	}
	p := res.RepositoryOwner.Project
	fieldID := ""
	valid := false
	for _, f := range p.Fields.Nodes {
		if f.ID == "" || !strings.EqualFold(f.Name, t.statusField()) {
			continue
		}
		fieldID = f.ID
		for _, o := range f.Options {
			valid = valid || o.ID == columnID
		}
		break
	}
	if fieldID == "" {
		return provider.Failed("GitHub project %d has no field %q", t.cfg.ProjectNumber, t.statusField())
	}
	if !valid {
		return provider.Errorf(provider.ErrBadInput, "%q is not a column of the board", columnID)
	}
	issue := res.Repository.Issue
	itemID := ""
	for _, it := range issue.ProjectItems.Nodes {
		if it.Project.ID == p.ID {
			itemID = it.ID
			break
		}
	}
	if itemID == "" { // the issue is not in the project yet
		var add struct {
			Add struct {
				Item struct {
					ID string `json:"id"`
				} `json:"item"`
			} `json:"addProjectV2ItemById"`
		}
		if err := t.query(ctx, githubcli.DocAddProjectItem, map[string]any{"projectId": p.ID, "contentId": issue.ID}, &add); err != nil {
			return err
		}
		if itemID = add.Add.Item.ID; itemID == "" {
			return provider.Failed("GitHub did not add %s to the project", id)
		}
	}
	if err := t.query(ctx, githubcli.DocSetStatus, map[string]any{"projectId": p.ID, "itemId": itemID, "fieldId": fieldID,
		"optionId": columnID}, nil); err != nil {
		return err
	}
	t.changed()
	return nil
}

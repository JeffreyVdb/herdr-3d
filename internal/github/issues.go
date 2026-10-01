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
		// Off the board is not there: an issue closed before the board's window.
		if c := d.Card; c.ClosedAt != nil && *c.ClosedAt < t.now().Add(-closedWindow).UnixMilli() {
			return tracker.Detail{}, provider.Errorf(provider.ErrNotFound, "%s is not on the board of %s", id, t.cfg.Repo)
		}
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

// SetStatus moves an issue to a column (a Status option of the project),
// adding it to the project first when it is not in it. With an anchor it
// then sets its place (updateProjectV2ItemPosition, which only knows "after
// this item" in the project's one order across all statuses): the status is
// written only when it changes, so a move within the column writes its place
// only. The writes are not one transaction: when one fails after another
// landed, the error says what changed and is a provider.ErrPartial.
func (t *issues) SetStatus(ctx context.Context, id, columnID string, at *tracker.Anchor) error {
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
						Value *struct {
							OptionID string `json:"optionId"`
						} `json:"fieldValueByName"`
					} `json:"nodes"`
				} `json:"projectItems"`
			} `json:"issue"`
		} `json:"repository"`
		RepositoryOwner *struct {
			Project *projectNode `json:"projectV2"`
		} `json:"repositoryOwner"`
	}
	if err := t.query(ctx, githubcli.DocStatusTarget, map[string]any{"owner": t.owner(), "repo": t.repoName(), "number": n,
		"projectOwner": projectOwner, "projectNumber": t.cfg.ProjectNumber, "statusField": t.statusField()}, &res); err != nil {
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
	itemID, status := "", ""
	for _, it := range issue.ProjectItems.Nodes {
		if it.Project.ID == p.ID {
			itemID = it.ID
			if it.Value != nil {
				status = it.Value.OptionID
			}
			break
		}
	}
	// Where it lands, worked out before anything is written.
	var afterID *string
	if at != nil {
		if afterID, err = t.placeAfter(ctx, p.ID, id, itemID, columnID, at); err != nil {
			return err
		}
	}
	added := false
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
		added = true
		t.changed()
	}
	wrote := false
	if at == nil || status != columnID {
		if err := t.query(ctx, githubcli.DocSetStatus, map[string]any{"projectId": p.ID, "itemId": itemID, "fieldId": fieldID,
			"optionId": columnID}, nil); err != nil {
			if added {
				return provider.Partial(fmt.Errorf("it was added to the project, but its status did not change: %w", err))
			}
			return err
		}
		wrote = true
		t.changed()
	}
	if at == nil {
		return nil
	}
	vars := map[string]any{"projectId": p.ID, "itemId": itemID}
	if afterID != nil {
		vars["afterId"] = *afterID
	}
	if err := t.query(ctx, githubcli.DocSetPosition, vars, nil); err != nil {
		if wrote {
			return provider.Partial(fmt.Errorf("its status changed, but its place in the column did not: %w", err))
		}
		return err
	}
	t.changed()
	return nil
}

// placeAfter is the project item a moved card goes right after (nil: the
// top of the project). After a card: that card's item. At the top of a
// column: the item right before the column's first card in the project's
// order (the moved one left out), none when that card is the project's
// first; an empty column has nothing to go after either.
func (t *issues) placeAfter(ctx context.Context, projectID, id, itemID, columnID string, at *tracker.Anchor) (*string, error) {
	o, err := t.orderNow(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if at.After != "" {
		if at.After == id {
			return nil, provider.Errorf(provider.ErrBadInput, "a card cannot go after itself")
		}
		a := o.itemOf(at.After)
		if a == "" || a == itemID {
			return nil, provider.Errorf(provider.ErrStale, "%s is not in the project's order any more: refresh the board", at.After)
		}
		return &a, nil
	}
	var prev *string
	for i := range o.items {
		it := &o.items[i]
		if it.id == itemID && itemID != "" {
			continue
		}
		if it.card != "" && it.card != id && it.column == columnID {
			return prev, nil
		}
		prev = &it.id
	}
	return nil, nil // an empty column: the top of the project
}

// orderNow is the project's order as it is now: the last feed's when nothing
// was written since, else read again (its cards are the last feed's).
func (t *issues) orderNow(ctx context.Context, projectID string) (*order, error) {
	t.fetch.Lock()
	last, cards := t.last, t.cards
	t.fetch.Unlock()
	if last != nil && last.order != nil {
		return last.order, nil
	}
	if cards == nil { // no board read yet: the feed has both
		f, err := t.feed(ctx, nil)
		if err != nil {
			return nil, err
		}
		if f.order == nil {
			return nil, provider.Errorf(provider.ErrUnsupported, "the project has more items than the bridge reads: cards cannot be ordered")
		}
		return f.order, nil
	}
	o, complete, err := t.readOrder(ctx, projectID, nil, nil)
	if err != nil {
		return nil, err
	}
	if !complete {
		return nil, provider.Errorf(provider.ErrUnsupported, "the project has more items than the bridge reads: cards cannot be ordered")
	}
	for i := range o.items {
		o.items[i].card = cards[o.items[i].node]
	}
	return o, nil
}

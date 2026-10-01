package github

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// Feed limits.
const (
	// pageLimit is how many pages of 100 the open issues and pull requests
	// are followed for: a board past 500 of either is truncated.
	pageLimit = 5
	// closedWindow is how long a closed issue stays on the board.
	closedWindow = 7 * 24 * time.Hour
	// lookupBatch is how many requests one lookup call reads (GitHub's limit
	// of nodes(ids:), and the slots of the pr-nodes document): the requests
	// of the last poll are all checked for a merge, in as many calls as needed.
	lookupBatch = 100
)

// feed is one poll of the repository: what both boards are made from.
type feed struct {
	fetchedAt time.Time
	issues    tracker.Board
	requests  []codehost.Request
	merged    []codehost.Merged
	keep      []string // open at the last poll, still open or unreadable, and not in requests
	truncated bool
	rate      *provider.Rate
	watched   map[string]bool   // request ids the merges were looked up for
	project   *project          // the live project and its status field, project mode
	order     *order            // the project's order, project mode (nil when it was longer than the pages read)
	cardNodes map[string]string // issue node id → card id, of the cards of this feed
}

// order is every item of the project in its manual order (GitHub's
// position, the order of an unsorted board view), the ones that are no card
// of this board too: other repositories' issues, drafts, pull requests.
type order struct {
	items []orderItem
}

type orderItem struct {
	id     string // the project item
	node   string // its issue's node id; "" for a draft, a pull request or content out of reach
	card   string // the card id when the issue is a card of the board
	column string // its status option id ("": none)
}

// itemOf is the project item of a card ("" when it has none).
func (o *order) itemOf(card string) string {
	for _, it := range o.items {
		if it.card == card {
			return it.id
		}
	}
	return ""
}

// orderPage is one page of the project's items (the ProjectOrder fragment).
type orderPage struct {
	PageInfo pageInfo `json:"pageInfo"`
	Nodes    []struct {
		ID      string `json:"id"`
		Content *struct {
			Typename string `json:"__typename"`
			ID       string `json:"id"`
		} `json:"content"`
		Value *struct {
			OptionID string `json:"optionId"`
		} `json:"fieldValueByName"`
	} `json:"nodes"`
}

// project is the configured project as GitHub returned it.
type project struct {
	ID      string
	Number  int
	FieldID string
	Options []option
}

type option struct{ ID, Name string }

// Wire shapes of the feed query (see queries/feed.graphql).

type pageInfo struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

type user struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

type issueNode struct {
	ID          string `json:"id"`
	Number      int    `json:"number"`
	Title       string `json:"title"`
	State       string `json:"state"`
	StateReason string `json:"stateReason"`
	URL         string `json:"url"`
	Body        string `json:"body"`
	Labels      struct {
		PageInfo pageInfo `json:"pageInfo"`
		Nodes    []struct {
			Name  string `json:"name"`
			Color string `json:"color"`
		} `json:"nodes"`
	} `json:"labels"`
	Assignees struct {
		PageInfo pageInfo `json:"pageInfo"`
		Nodes    []user   `json:"nodes"`
	} `json:"assignees"`
	Author       *user  `json:"author"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	ClosedAt     string `json:"closedAt"`
	ProjectItems struct {
		PageInfo pageInfo `json:"pageInfo"`
		Nodes    []struct {
			ID      string `json:"id"`
			Project struct {
				ID     string `json:"id"`
				Number int    `json:"number"`
			} `json:"project"`
			Value *struct {
				Name     string `json:"name"`
				OptionID string `json:"optionId"`
			} `json:"fieldValueByName"`
		} `json:"nodes"`
	} `json:"projectItems"`
}

type closing struct {
	Number     int `json:"number"`
	Repository struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
}

type rollup struct {
	State    string `json:"state"`
	Contexts struct {
		PageInfo pageInfo `json:"pageInfo"`
		Nodes    []struct {
			// CheckRun
			Name       string `json:"name"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			DetailsURL string `json:"detailsUrl"`
			// StatusContext
			Context   string `json:"context"`
			State     string `json:"state"`
			TargetURL string `json:"targetUrl"`
		} `json:"nodes"`
	} `json:"contexts"`
}

type prNode struct {
	ID          string `json:"id"`
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	URL         string `json:"url"`
	State       string `json:"state"`
	IsDraft     bool   `json:"isDraft"`
	HeadRefName string `json:"headRefName"`
	BaseRefName string `json:"baseRefName"`
	HeadRefOid  string `json:"headRefOid"`
	Author      *user  `json:"author"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
	MergedAt    string `json:"mergedAt"`
	Mergeable   string `json:"mergeable"`
	Review      string `json:"reviewDecision"`
	Additions   int    `json:"additions"`
	Deletions   int    `json:"deletions"`
	Changed     int    `json:"changedFiles"`
	Closing     struct {
		PageInfo pageInfo  `json:"pageInfo"`
		Nodes    []closing `json:"nodes"`
	} `json:"closingIssuesReferences"`
	Commits struct {
		Nodes []struct {
			Commit struct {
				Oid    string  `json:"oid"`
				Rollup *rollup `json:"statusCheckRollup"`
			} `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
}

type projectNode struct {
	ID     string     `json:"id"`
	Number int        `json:"number"`
	Items  *orderPage `json:"items"`
	Fields struct {
		PageInfo pageInfo `json:"pageInfo"`
		Nodes    []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Options []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"options"`
		} `json:"nodes"`
	} `json:"fields"`
}

type feedData struct {
	Repository *struct {
		ID         string `json:"id"`
		OpenIssues struct {
			PageInfo pageInfo    `json:"pageInfo"`
			Nodes    []issueNode `json:"nodes"`
		} `json:"openIssues"`
		OpenPRs struct {
			PageInfo pageInfo `json:"pageInfo"`
			Nodes    []prNode `json:"nodes"`
		} `json:"openPRs"`
	} `json:"repository"`
	RecentClosedIssues struct {
		PageInfo pageInfo    `json:"pageInfo"`
		Nodes    []issueNode `json:"nodes"`
	} `json:"recentClosedIssues"`
	PreviouslyOpenPRs []*prNode `json:"previouslyOpenPRs"`
	RepositoryOwner   *struct {
		Project *projectNode `json:"projectV2"`
	} `json:"repositoryOwner"`
	RateLimit *rateNode `json:"rateLimit"`
}

type rateNode struct {
	Cost      int       `json:"cost"`
	Limit     int       `json:"limit"`
	Remaining int       `json:"remaining"`
	ResetAt   time.Time `json:"resetAt"`
}

func (r *rateNode) rate() *provider.Rate {
	if r == nil {
		return nil
	}
	return &provider.Rate{Remaining: r.Remaining, ResetAt: r.ResetAt.UnixMilli(), Cost: r.Cost, Limit: r.Limit}
}

// fetchFeed runs the feed query, follows the paging of the open issues and
// pull requests, and maps everything to the neutral boards. watched are the
// ids of the requests that were open at the last poll.
func (s *source) fetchFeed(ctx context.Context, watched []string) (*feed, error) {
	now := s.now()
	prior, err := s.priorOf(ctx, watched)
	if err != nil {
		return nil, err
	}
	nodeIDs := []string{}
	for _, p := range prior {
		nodeIDs = append(nodeIDs, p.node)
	}
	first := nodeIDs[:min(len(nodeIDs), lookupBatch)] // the rest are read below
	owner, repo := s.owner(), s.repoName()
	projectOwner := s.cfg.ProjectOwner
	if projectOwner == "" {
		projectOwner = owner
	}
	cutoff := now.Add(-closedWindow)
	vars := map[string]any{
		"owner": owner, "repo": repo, "projectOwner": projectOwner, "projectNumber": s.cfg.ProjectNumber,
		"statusField": s.statusField(), "hasProject": s.hasProject(), "watchedPRIds": first,
		"closedQuery": fmt.Sprintf("repo:%s is:issue is:closed closed:>=%s", s.cfg.Repo, cutoff.UTC().Format("2006-01-02")),
	}
	resp, err := s.cli.Query(ctx, githubcli.DocFeed, vars)
	if err != nil {
		return nil, err
	}
	if e := resp.FirstError("NOT_FOUND"); e != nil {
		if len(e.Path) > 0 && fmt.Sprint(e.Path[0]) == "repositoryOwner" {
			return nil, provider.Failed("GitHub project %d of %s not found", s.cfg.ProjectNumber, projectOwner)
		}
		if len(e.Path) > 0 && fmt.Sprint(e.Path[0]) == "repository" {
			return nil, provider.Errorf(provider.ErrNotFound, "GitHub repository %s not found", s.cfg.Repo)
		}
	}
	if len(resp.Errors) > 0 && len(resp.Data) == 0 {
		return nil, provider.Failed("GitHub: %s", clip(resp.Errors[0].Message))
	}
	var d feedData
	if err := json.Unmarshal(resp.Data, &d); err != nil {
		return nil, provider.Failed("GitHub: unreadable answer")
	}
	if d.Repository == nil {
		return nil, provider.Errorf(provider.ErrNotFound, "GitHub repository %s not found", s.cfg.Repo)
	}
	f := &feed{fetchedAt: now, rate: d.RateLimit.rate(), watched: map[string]bool{}}
	for _, id := range watched {
		f.watched[id] = true
	}
	issues := d.Repository.OpenIssues.Nodes
	prs := d.Repository.OpenPRs.Nodes
	hasNextIssues, cursorIssues := d.Repository.OpenIssues.PageInfo.HasNextPage, d.Repository.OpenIssues.PageInfo.EndCursor
	hasNextPRs, cursorPRs := d.Repository.OpenPRs.PageInfo.HasNextPage, d.Repository.OpenPRs.PageInfo.EndCursor
	for page := 1; page < pageLimit && hasNextIssues; page++ {
		var more struct {
			Repository *struct {
				OpenIssues struct {
					PageInfo pageInfo    `json:"pageInfo"`
					Nodes    []issueNode `json:"nodes"`
				} `json:"openIssues"`
			} `json:"repository"`
			RateLimit *rateNode `json:"rateLimit"`
		}
		if err := s.query(ctx, githubcli.DocIssuesPage, map[string]any{"owner": owner, "repo": repo, "after": cursorIssues,
			"statusField": s.statusField()}, &more); err != nil {
			return nil, err
		}
		if more.Repository == nil {
			break
		}
		issues = append(issues, more.Repository.OpenIssues.Nodes...)
		hasNextIssues, cursorIssues = more.Repository.OpenIssues.PageInfo.HasNextPage, more.Repository.OpenIssues.PageInfo.EndCursor
		if r := more.RateLimit.rate(); r != nil {
			f.rate = r
		}
	}
	for page := 1; page < pageLimit && hasNextPRs; page++ {
		var more struct {
			Repository *struct {
				OpenPRs struct {
					PageInfo pageInfo `json:"pageInfo"`
					Nodes    []prNode `json:"nodes"`
				} `json:"openPRs"`
			} `json:"repository"`
			RateLimit *rateNode `json:"rateLimit"`
		}
		if err := s.query(ctx, githubcli.DocPRsPage, map[string]any{"owner": owner, "repo": repo, "after": cursorPRs}, &more); err != nil {
			return nil, err
		}
		if more.Repository == nil {
			break
		}
		prs = append(prs, more.Repository.OpenPRs.Nodes...)
		hasNextPRs, cursorPRs = more.Repository.OpenPRs.PageInfo.HasNextPage, more.Repository.OpenPRs.PageInfo.EndCursor
		if r := more.RateLimit.rate(); r != nil {
			f.rate = r
		}
	}
	f.truncated = hasNextIssues || hasNextPRs

	// The issues closed in the window: the same page limit.
	closed := d.RecentClosedIssues.Nodes
	hasNextClosed, cursorClosed := d.RecentClosedIssues.PageInfo.HasNextPage, d.RecentClosedIssues.PageInfo.EndCursor
	for page := 1; page < pageLimit && hasNextClosed; page++ {
		var more struct {
			RecentClosedIssues struct {
				PageInfo pageInfo    `json:"pageInfo"`
				Nodes    []issueNode `json:"nodes"`
			} `json:"recentClosedIssues"`
			RateLimit *rateNode `json:"rateLimit"`
		}
		if err := s.query(ctx, githubcli.DocClosedPage, map[string]any{"closedQuery": vars["closedQuery"], "after": cursorClosed,
			"statusField": s.statusField()}, &more); err != nil {
			return nil, err
		}
		closed = append(closed, more.RecentClosedIssues.Nodes...)
		hasNextClosed, cursorClosed = more.RecentClosedIssues.PageInfo.HasNextPage, more.RecentClosedIssues.PageInfo.EndCursor
		if r := more.RateLimit.rate(); r != nil {
			f.rate = r
		}
	}
	f.truncated = f.truncated || hasNextClosed

	// The project and its status field: the live column list.
	var columns []tracker.Column
	if s.hasProject() {
		p := (*projectNode)(nil)
		if d.RepositoryOwner != nil {
			p = d.RepositoryOwner.Project
		}
		if p == nil {
			return nil, provider.Failed("GitHub project %d of %s not found", s.cfg.ProjectNumber, projectOwner)
		}
		pr := &project{ID: p.ID, Number: p.Number}
		for _, fld := range p.Fields.Nodes {
			if fld.ID == "" || !strings.EqualFold(fld.Name, s.statusField()) || len(fld.Options) == 0 {
				continue
			}
			pr.FieldID = fld.ID
			for _, o := range fld.Options {
				pr.Options = append(pr.Options, option{ID: o.ID, Name: o.Name})
			}
			break
		}
		if pr.FieldID == "" {
			return nil, provider.Failed("GitHub project %d has no single-select field %q", s.cfg.ProjectNumber, s.statusField())
		}
		f.project = pr
		ord, complete, err := s.readOrder(ctx, pr.ID, p.Items, f)
		if err != nil {
			return nil, err
		}
		if complete {
			f.order = ord
		} else { // never a partial order: the cards keep the old one
			f.truncated = true
		}
		for _, o := range pr.Options {
			columns = append(columns, tracker.Column{ID: o.ID, Name: o.Name, Done: strings.EqualFold(strings.TrimSpace(o.Name), "done")})
		}
	} else {
		columns = []tracker.Column{{ID: "open", Name: "Open"}, {ID: "closed", Name: "Closed", Done: true}}
	}

	// Cards: the open issues, and the ones closed since the cut-off.
	seen := map[int]bool{}
	var cards []tracker.Card
	cardNodes := map[string]string{} // issue node id → card id
	noStatus := false
	add := func(n *issueNode, closedOnly bool) {
		if seen[n.Number] {
			return
		}
		card, trunc := s.card(n, f.project)
		if closedOnly {
			if card.ClosedAt == nil || *card.ClosedAt < cutoff.UnixMilli() {
				return
			}
		}
		seen[n.Number] = true
		f.truncated = f.truncated || trunc
		if card.Column == "" {
			noStatus = true
		}
		s.remember(n.ID, card.ID)
		cardNodes[n.ID] = card.ID
		cards = append(cards, card)
	}
	for i := range issues {
		add(&issues[i], false)
	}
	for i := range closed {
		if n := &closed[i]; n.ID != "" {
			add(n, true)
		}
	}
	sort.SliceStable(cards, func(i, j int) bool { return cards[i].UpdatedAt > cards[j].UpdatedAt })
	f.cardNodes = cardNodes
	if f.order != nil {
		rankCards(f.order, cards, cardNodes)
	}
	if cards == nil {
		cards = []tracker.Card{}
	}
	if noStatus && s.hasProject() {
		columns = append([]tracker.Column{{ID: "", Name: "No status"}}, columns...)
	}
	f.issues = tracker.Board{Columns: columns, Cards: cards, Truncated: f.truncated, Rate: f.rate}

	// Requests.
	for i := range prs {
		req, trunc := s.request(&prs[i])
		f.truncated = f.truncated || trunc
		s.remember(prs[i].ID, req.ID)
		f.requests = append(f.requests, req)
	}
	if f.requests == nil {
		f.requests = []codehost.Request{}
	}
	f.issues.Truncated = f.truncated

	// Merges: the previously open requests that are merged now. A null (the
	// request can no longer be read) is never a merge, and is kept watched,
	// like one that is still open but past the board's page limit: a poll
	// forgets a request only when it has seen its state.
	listed := map[string]bool{}
	for _, r := range f.requests {
		listed[r.ID] = true
	}
	nodes := d.PreviouslyOpenPRs
	for at := len(first); at < len(nodeIDs); at += lookupBatch {
		var more struct {
			PreviouslyOpenPRs []*prNode `json:"previouslyOpenPRs"`
			RateLimit         *rateNode `json:"rateLimit"`
		}
		if err := s.query(ctx, githubcli.DocPRsByNode, map[string]any{"ids": nodeIDs[at:min(at+lookupBatch, len(nodeIDs))]}, &more); err != nil {
			return nil, err
		}
		nodes = append(nodes, more.PreviouslyOpenPRs...)
		if r := more.RateLimit.rate(); r != nil {
			f.rate = r
		}
	}
	for i, p := range prior {
		var n *prNode
		if i < len(nodes) {
			n = nodes[i]
		}
		switch {
		case n == nil || n.ID == "":
			f.keep = append(f.keep, p.id)
		case n.State == "MERGED" && n.MergedAt != "":
			m := codehost.Merged{ID: p.id, Key: fmt.Sprintf("#%d", n.Number), Title: n.Title, MergedAt: ms(n.MergedAt), Closes: []string{}}
			for _, c := range n.Closing.Nodes {
				m.Closes = append(m.Closes, s.itemID(c.Repository.NameWithOwner, c.Number))
			}
			f.merged = append(f.merged, m)
		case n.State == "OPEN" && !listed[p.id]:
			f.keep = append(f.keep, p.id)
		}
	}
	return f, nil
}

// readOrder reads the project's items in their order: first is the page the
// feed brought (nil: none yet, the first page is read here), the rest is
// read a page at a time up to the page limit. complete is false when there
// were more. A repeated item (the order changed while it was paged) counts
// where it was first seen. f takes the rate of the pages.
func (s *source) readOrder(ctx context.Context, projectID string, first *orderPage, f *feed) (*order, bool, error) {
	o := &order{}
	seen := map[string]bool{}
	page := first
	cursor := ""
	for n := 0; ; n++ {
		if page == nil {
			if n >= pageLimit {
				return nil, false, nil
			}
			var more struct {
				Node *struct {
					Items *orderPage `json:"items"`
				} `json:"node"`
				RateLimit *rateNode `json:"rateLimit"`
			}
			vars := map[string]any{"projectId": projectID, "statusField": s.statusField()}
			if cursor != "" {
				vars["after"] = cursor
			}
			if err := s.query(ctx, githubcli.DocItemsPage, vars, &more); err != nil {
				return nil, false, err
			}
			if r := more.RateLimit.rate(); r != nil && f != nil {
				f.rate = r
			}
			if more.Node == nil || more.Node.Items == nil {
				return nil, false, provider.Failed("GitHub: the project's items could not be read")
			}
			page = more.Node.Items
		}
		for _, it := range page.Nodes {
			if it.ID == "" || seen[it.ID] {
				continue
			}
			seen[it.ID] = true
			item := orderItem{id: it.ID}
			if it.Content != nil && it.Content.Typename == "Issue" {
				item.node = it.Content.ID
			}
			if it.Value != nil {
				item.column = it.Value.OptionID
			}
			o.items = append(o.items, item)
		}
		if !page.PageInfo.HasNextPage {
			return o, true, nil
		}
		cursor, page = page.PageInfo.EndCursor, nil
	}
}

// rankCards gives the cards their Position, 0 first, in the project's
// order, and the order's items their card. Items are matched to cards by
// the issue's node id (nodes: node id → card id), never by number (another
// repository's issue may have the same one).
func rankCards(o *order, cards []tracker.Card, nodes map[string]string) {
	at := map[string]int{}
	for i := range cards {
		cards[i].Position = nil
		at[cards[i].ID] = i
	}
	byNode := map[string]int{}
	for node, id := range nodes {
		if i, ok := at[id]; ok {
			byNode[node] = i
		}
	}
	rank := 0
	for k := range o.items {
		i, ok := byNode[o.items[k].node]
		if o.items[k].node == "" || !ok || cards[i].Position != nil {
			continue
		}
		r := rank
		cards[i].Position = &r
		o.items[k].card = cards[i].ID
		rank++
	}
}

// prior is a request of the last poll with its GraphQL node id.
type prior struct{ id, node string }

// priorOf maps the request ids of the last poll to their node ids: from
// what this run has seen, else by looking them up (after a restart), a
// hundred to a call. An id of another repository, or of a request that does
// not exist, is left out.
func (s *source) priorOf(ctx context.Context, watched []string) ([]prior, error) {
	out := make([]prior, 0, len(watched))
	type todo struct {
		id string
		n  int
		at int // where in out
	}
	var lookups []todo
	seen := map[string]bool{}
	for _, id := range watched {
		if seen[id] {
			continue
		}
		seen[id] = true
		s.mu.Lock()
		node, ok := s.nodes[id]
		s.mu.Unlock()
		if ok {
			out = append(out, prior{id, node})
			continue
		}
		if repo, n, valid := s.parseID(id); valid && repo != "" {
			lookups = append(lookups, todo{id, n, len(out)})
			out = append(out, prior{id: id})
		}
	}
	found := map[string]string{}
	for at := 0; at < len(lookups); at += lookupBatch {
		batch := lookups[at:min(at+lookupBatch, len(lookups))]
		vars := map[string]any{"owner": s.owner(), "repo": s.repoName()}
		for i := range lookupBatch { // unused slots repeat the last number
			vars[fmt.Sprintf("n%d", i)] = batch[min(i, len(batch)-1)].n
		}
		resp, err := s.cli.Query(ctx, githubcli.DocPRNodes, vars)
		if err != nil {
			return nil, err
		}
		for _, e := range resp.Errors { // a request that does not exist is a NOT_FOUND: it is left out
			if e.Type != "NOT_FOUND" {
				return nil, provider.Failed("GitHub: %s", clip(e.Message))
			}
		}
		var res struct {
			Repository map[string]*struct {
				ID string `json:"id"`
			} `json:"repository"`
		}
		if err := json.Unmarshal(resp.Data, &res); err != nil {
			return nil, provider.Failed("GitHub: unreadable answer")
		}
		if res.Repository == nil {
			return nil, provider.Errorf(provider.ErrNotFound, "GitHub repository %s not found", s.cfg.Repo)
		}
		for i, t := range batch {
			if pr := res.Repository[fmt.Sprintf("p%d", i)]; pr != nil && pr.ID != "" {
				found[t.id] = pr.ID
				s.remember(pr.ID, t.id)
			}
		}
	}
	kept := out[:0]
	for _, p := range out {
		if p.node == "" {
			p.node = found[p.id]
		}
		if p.node != "" {
			kept = append(kept, p)
		}
	}
	return kept, nil
}

// card maps an issue to a card. trunc: one of its nested connections has
// more than it returned.
func (s *source) card(n *issueNode, pr *project) (tracker.Card, bool) {
	c := tracker.Card{
		ID: s.itemID(s.cfg.Repo, n.Number), Key: fmt.Sprintf("#%d", n.Number), Title: n.Title, URL: n.URL,
		State: tracker.StateOpen, Labels: []tracker.Label{}, Assignees: []provider.Person{}, UpdatedAt: ms(n.UpdatedAt),
	}
	trunc := n.Labels.PageInfo.HasNextPage || n.Assignees.PageInfo.HasNextPage || n.ProjectItems.PageInfo.HasNextPage
	if n.State == "CLOSED" {
		c.State = tracker.StateClosed
		if at := ms(n.ClosedAt); at > 0 {
			c.ClosedAt = &at
		} else {
			at := c.UpdatedAt
			c.ClosedAt = &at
		}
	}
	if n.Author != nil {
		c.Author = n.Author.Login
	}
	for _, l := range n.Labels.Nodes {
		c.Labels = append(c.Labels, tracker.Label{Name: l.Name, Color: color(l.Color)})
	}
	c.Priority = priorityOf(c.Labels)
	for _, a := range n.Assignees.Nodes {
		c.Assignees = append(c.Assignees, provider.Person{Name: a.Login, AvatarURL: a.AvatarURL})
	}
	if pr == nil {
		c.Column = "open"
		if c.State == tracker.StateClosed {
			c.Column = "closed"
		}
	} else {
		for _, it := range n.ProjectItems.Nodes {
			if it.Project.ID != pr.ID && !(it.Project.ID == "" && it.Project.Number == pr.Number) {
				continue
			}
			if it.Value != nil {
				for _, o := range pr.Options {
					if o.ID == it.Value.OptionID {
						c.Column = o.ID
					}
				}
			}
			break
		}
	}
	if c.State == tracker.StateClosed {
		caps := s.trackerCaps()
		caps.Close = false
		c.Capabilities = &caps
	}
	return c, trunc
}

// request maps a pull request to a Request.
func (s *source) request(n *prNode) (codehost.Request, bool) {
	r := codehost.Request{
		ID: s.itemID(s.cfg.Repo, n.Number), Key: fmt.Sprintf("#%d", n.Number), Title: n.Title, State: "open", Draft: n.IsDraft,
		URL: n.URL, HeadBranch: n.HeadRefName, BaseBranch: n.BaseRefName, Checks: codehost.ChecksNone,
		Review: reviewOf(n.Review), Mergeable: mergeableOf(n.Mergeable), Closes: []string{}, Additions: n.Additions,
		Deletions: n.Deletions, ChangedFiles: n.Changed, UpdatedAt: ms(n.UpdatedAt),
	}
	if n.Author != nil {
		r.Author = n.Author.Login
	}
	trunc := n.Closing.PageInfo.HasNextPage
	for _, c := range n.Closing.Nodes {
		r.Closes = append(r.Closes, s.itemID(c.Repository.NameWithOwner, c.Number))
	}
	if len(n.Commits.Nodes) > 0 {
		if ru := n.Commits.Nodes[0].Commit.Rollup; ru != nil {
			r.Checks = checksOf(ru.State)
			trunc = trunc || ru.Contexts.PageInfo.HasNextPage
		}
	}
	return r, trunc
}

func checksOf(state string) string {
	switch state {
	case "SUCCESS":
		return codehost.ChecksSuccess
	case "FAILURE", "ERROR":
		return codehost.ChecksFailure
	case "PENDING", "EXPECTED":
		return codehost.ChecksPending
	}
	return codehost.ChecksNone
}

func reviewOf(d string) string {
	switch d {
	case "APPROVED":
		return codehost.ReviewApproved
	case "CHANGES_REQUESTED":
		return codehost.ReviewChangesRequested
	case "REVIEW_REQUIRED":
		return codehost.ReviewRequired
	}
	return codehost.ReviewNone
}

func mergeableOf(m string) string {
	switch m {
	case "MERGEABLE":
		return codehost.Mergeable
	case "CONFLICTING":
		return codehost.Conflicting
	}
	return codehost.Unknown
}

var (
	hexRe      = regexp.MustCompile(`^[0-9a-fA-F]{6}$`)
	priorityRe = regexp.MustCompile(`^(?:priority\s*[:/-]\s*)?(p0|critical|urgent|p1|high|p2|medium|p3|p4|low)$`)
)

// color is a label colour as "#rrggbb".
func color(c string) string {
	c = strings.TrimPrefix(c, "#")
	if !hexRe.MatchString(c) {
		return "#ededed"
	}
	return "#" + strings.ToLower(c)
}

// priorityOf derives a priority from labels (case-insensitive): the most
// urgent one that names one.
func priorityOf(labels []tracker.Label) string {
	rank := map[string]int{"urgent": 4, "high": 3, "medium": 2, "low": 1}
	best := ""
	for _, l := range labels {
		m := priorityRe.FindStringSubmatch(strings.ToLower(strings.TrimSpace(l.Name)))
		if m == nil {
			continue
		}
		var p string
		switch m[1] {
		case "p0", "critical", "urgent":
			p = "urgent"
		case "p1", "high":
			p = "high"
		case "p2", "medium":
			p = "medium"
		default:
			p = "low"
		}
		if rank[p] > rank[best] {
			best = p
		}
	}
	return best
}

// ms is an RFC 3339 time as unix ms (0 for none).
func ms(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func clip(s string) string {
	s = githubcli.Redact(s)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

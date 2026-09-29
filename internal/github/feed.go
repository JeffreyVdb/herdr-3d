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
	// maxNodeLookups bounds the extra lookups (one per open request that
	// this run has not seen) a feed makes to find merges after a restart.
	maxNodeLookups = 40
)

// feed is one poll of the repository: what both boards are made from.
type feed struct {
	fetchedAt time.Time
	issues    tracker.Board
	requests  []codehost.Request
	merged    []codehost.Merged
	truncated bool
	rate      *provider.Rate
	watched   map[string]bool // request ids the merges were looked up for
	project   *project        // the live project and its status field, project mode
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
	ID     string `json:"id"`
	Number int    `json:"number"`
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
	nodeIDs, err := s.nodeIDsOf(ctx, watched)
	if err != nil {
		return nil, err
	}
	owner, repo := s.owner(), s.repoName()
	projectOwner := s.cfg.ProjectOwner
	if projectOwner == "" {
		projectOwner = owner
	}
	cutoff := now.Add(-closedWindow)
	vars := map[string]any{
		"owner": owner, "repo": repo, "projectOwner": projectOwner, "projectNumber": s.cfg.ProjectNumber,
		"statusField": s.statusField(), "hasProject": s.hasProject(), "watchedPRIds": nodeIDs,
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
		for _, o := range pr.Options {
			columns = append(columns, tracker.Column{ID: o.ID, Name: o.Name, Done: strings.EqualFold(strings.TrimSpace(o.Name), "done")})
		}
	} else {
		columns = []tracker.Column{{ID: "open", Name: "Open"}, {ID: "closed", Name: "Closed", Done: true}}
	}

	// Cards: the open issues, and the ones closed since the cut-off.
	seen := map[int]bool{}
	var cards []tracker.Card
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
		cards = append(cards, card)
	}
	for i := range issues {
		add(&issues[i], false)
	}
	for i := range d.RecentClosedIssues.Nodes {
		if n := &d.RecentClosedIssues.Nodes[i]; n.ID != "" {
			add(n, true)
		}
	}
	sort.SliceStable(cards, func(i, j int) bool { return cards[i].UpdatedAt > cards[j].UpdatedAt })
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
	// request can no longer be read) is never a merge.
	for _, n := range d.PreviouslyOpenPRs {
		if n == nil || n.ID == "" || n.State != "MERGED" || n.MergedAt == "" {
			continue
		}
		id := s.itemID(s.cfg.Repo, n.Number)
		m := codehost.Merged{ID: id, Key: fmt.Sprintf("#%d", n.Number), Title: n.Title, MergedAt: ms(n.MergedAt), Closes: []string{}}
		for _, c := range n.Closing.Nodes {
			m.Closes = append(m.Closes, s.itemID(c.Repository.NameWithOwner, c.Number))
		}
		f.merged = append(f.merged, m)
	}
	return f, nil
}

// nodeIDsOf maps the request ids of the last poll to their GraphQL node ids:
// from what this run has seen, else by looking each one up (after a
// restart). An id that cannot be found is left out: it is never a merge.
func (s *source) nodeIDsOf(ctx context.Context, watched []string) ([]string, error) {
	out := []string{}
	lookups := 0
	for _, id := range watched {
		s.mu.Lock()
		node, ok := s.nodes[id]
		s.mu.Unlock()
		if !ok {
			repo, n, valid := s.parseID(id)
			if !valid || repo == "" || lookups >= maxNodeLookups {
				continue
			}
			lookups++
			var res struct {
				Repository *struct {
					PullRequest *struct {
						ID string `json:"id"`
					} `json:"pullRequest"`
				} `json:"repository"`
			}
			if err := s.query(ctx, githubcli.DocPRNode, map[string]any{"owner": s.owner(), "repo": s.repoName(), "number": n}, &res); err != nil {
				if isKind(err, provider.ErrNotFound) {
					continue
				}
				return nil, err
			}
			if res.Repository == nil || res.Repository.PullRequest == nil {
				continue
			}
			node = res.Repository.PullRequest.ID
			s.remember(node, id)
		}
		out = append(out, node)
	}
	return out, nil
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

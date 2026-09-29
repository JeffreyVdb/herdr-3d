package github

import (
	"context"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// requests is the codehost.Host of a source.
type requests struct{ *source }

var _ codehost.Host = (*requests)(nil)

func (h *requests) Info() codehost.Info {
	return codehost.Info{ID: ProviderID, Name: ProviderName,
		Capabilities: codehost.Capabilities{Comment: true, Merge: true, OpenFromBranch: true}}
}

func (h *requests) Board(ctx context.Context, prev codehost.PrevState) (codehost.Board, error) {
	f, err := h.feed(ctx, prev.OpenIDs)
	if err != nil {
		return codehost.Board{}, err
	}
	return codehost.Board{Requests: f.requests, Merged: f.merged, Truncated: f.truncated, Rate: f.rate}, nil
}

// prNodeOf is the GraphQL node id of a pull request of this repository.
func (s *source) prNodeOf(ctx context.Context, id string) (string, error) {
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
			PullRequest *struct {
				ID string `json:"id"`
			} `json:"pullRequest"`
		} `json:"repository"`
	}
	if err := s.query(ctx, githubcli.DocPRNode, map[string]any{"owner": s.owner(), "repo": s.repoName(), "number": n}, &res); err != nil {
		return "", err
	}
	if res.Repository == nil || res.Repository.PullRequest == nil {
		return "", provider.Errorf(provider.ErrNotFound, "%s is not on %s", id, s.cfg.Repo)
	}
	s.remember(res.Repository.PullRequest.ID, id)
	return res.Repository.PullRequest.ID, nil
}

type prDetailData struct {
	Repository *struct {
		PullRequest *struct {
			prNode
			Files struct {
				TotalCount int      `json:"totalCount"`
				PageInfo   pageInfo `json:"pageInfo"`
				Nodes      []struct {
					Path       string `json:"path"`
					Additions  int    `json:"additions"`
					Deletions  int    `json:"deletions"`
					ChangeType string `json:"changeType"`
				} `json:"nodes"`
			} `json:"files"`
			Comments struct {
				PageInfo pageInfo `json:"pageInfo"`
				Nodes    []struct {
					ID        string `json:"id"`
					Body      string `json:"body"`
					Author    *user  `json:"author"`
					CreatedAt string `json:"createdAt"`
				} `json:"nodes"`
			} `json:"comments"`
		} `json:"pullRequest"`
	} `json:"repository"`
}

// read fetches a pull request with its files, comments and checks.
func (s *source) readPR(ctx context.Context, id string) (*prDetailData, error) {
	n, err := s.own(id)
	if err != nil {
		return nil, err
	}
	var res prDetailData
	if err := s.query(ctx, githubcli.DocPRDetail, map[string]any{"owner": s.owner(), "repo": s.repoName(), "number": n}, &res); err != nil {
		return nil, err
	}
	if res.Repository == nil || res.Repository.PullRequest == nil {
		return nil, provider.Errorf(provider.ErrNotFound, "%s is not on %s", id, s.cfg.Repo)
	}
	s.remember(res.Repository.PullRequest.ID, id)
	return &res, nil
}

func (h *requests) Get(ctx context.Context, id string) (codehost.Detail, error) {
	res, err := h.readPR(ctx, id)
	if err != nil {
		return codehost.Detail{}, err
	}
	pr := res.Repository.PullRequest
	req, _ := h.request(&pr.prNode)
	req.State = strings.ToLower(pr.State)
	d := codehost.Detail{Request: req, Body: pr.Body, CreatedAt: ms(pr.CreatedAt), Files: []codehost.File{},
		Checks: []codehost.Check{}, Comments: []provider.Comment{}, FilesTruncated: pr.Files.PageInfo.HasNextPage,
		CommentsTruncated: pr.Comments.PageInfo.HasNextPage}
	if pr.Author != nil {
		d.Author = provider.Person{Name: pr.Author.Login, AvatarURL: pr.Author.AvatarURL}
	}
	for _, f := range pr.Files.Nodes {
		d.Files = append(d.Files, codehost.File{Path: f.Path, Additions: f.Additions, Deletions: f.Deletions, Change: changeOf(f.ChangeType)})
	}
	if len(pr.Commits.Nodes) > 0 {
		if ru := pr.Commits.Nodes[0].Commit.Rollup; ru != nil {
			for _, c := range ru.Contexts.Nodes {
				d.Checks = append(d.Checks, checkOf(c.Name, c.Status, c.Conclusion, c.DetailsURL, c.Context, c.State, c.TargetURL))
			}
		}
	}
	for _, c := range pr.Comments.Nodes {
		cm := provider.Comment{ID: c.ID, Body: c.Body, CreatedAt: ms(c.CreatedAt)}
		if c.Author != nil {
			cm.Author = provider.Person{Name: c.Author.Login, AvatarURL: c.Author.AvatarURL}
		}
		d.Comments = append(d.Comments, cm)
	}
	return d, nil
}

func changeOf(t string) string {
	switch t {
	case "ADDED":
		return "added"
	case "DELETED":
		return "removed"
	case "RENAMED":
		return "renamed"
	case "COPIED":
		return "copied"
	case "MODIFIED":
		return "modified"
	}
	return "changed"
}

// checkOf maps a CheckRun or a StatusContext to a Check.
func checkOf(name, status, conclusion, detailsURL, context, state, targetURL string) codehost.Check {
	if name == "" && context != "" { // a status context
		c := codehost.Check{Name: context, URL: targetURL, State: "pending"}
		switch state {
		case "SUCCESS":
			c.State = "success"
		case "FAILURE", "ERROR":
			c.State = "failure"
		}
		return c
	}
	c := codehost.Check{Name: name, URL: detailsURL, State: "pending"}
	if status != "COMPLETED" {
		return c
	}
	switch conclusion {
	case "SUCCESS":
		c.State = "success"
	case "NEUTRAL":
		c.State = "neutral"
	case "SKIPPED":
		c.State = "skipped"
	default: // FAILURE, TIMED_OUT, CANCELLED, STARTUP_FAILURE, ACTION_REQUIRED, STALE
		c.State = "failure"
	}
	return c
}

func (h *requests) Comment(ctx context.Context, id, body string) (provider.Comment, error) {
	node, err := h.prNodeOf(ctx, id)
	if err != nil {
		return provider.Comment{}, err
	}
	return h.addComment(ctx, node, body)
}

var mergeMethods = map[string]string{
	codehost.MethodMerge:  "MERGE",
	codehost.MethodSquash: "SQUASH",
	codehost.MethodRebase: "REBASE",
}

func (h *requests) Merge(ctx context.Context, id, method string, override bool) error {
	gh, ok := mergeMethods[method]
	if !ok {
		return provider.Errorf(provider.ErrBadInput, "merge method must be merge, squash or rebase")
	}
	res, err := h.readPR(ctx, id) // right before merging: the state as it is now
	if err != nil {
		return err
	}
	pr := res.Repository.PullRequest
	if pr.State != "OPEN" {
		return provider.Errorf(provider.ErrNotMergeable, "%s is %s, not open", "#"+itoa(pr.Number), strings.ToLower(pr.State))
	}
	req, _ := h.request(&pr.prNode)
	if err := codehost.Gate(req, override); err != nil {
		return err
	}
	if pr.HeadRefOid == "" {
		return provider.Failed("GitHub did not say the head of #%d", pr.Number)
	}
	if err := h.query(ctx, githubcli.DocMergePR, map[string]any{"pullRequestId": pr.ID, "expectedHeadOid": pr.HeadRefOid,
		"method": gh}, nil); err != nil {
		return err
	}
	h.changed()
	return nil
}

func (h *requests) OpenFromBranch(ctx context.Context, b codehost.Branch) (codehost.Opened, error) {
	var res struct {
		Repository *struct {
			ID           string `json:"id"`
			PullRequests struct {
				Nodes []struct {
					ID     string `json:"id"`
					Number int    `json:"number"`
					URL    string `json:"url"`
				} `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"repository"`
	}
	// Retry-safe: an open request for the head first.
	if err := h.query(ctx, githubcli.DocOpenPRForHead, map[string]any{"owner": h.owner(), "repo": h.repoName(), "head": b.Name}, &res); err != nil {
		return codehost.Opened{}, err
	}
	if res.Repository == nil {
		return codehost.Opened{}, provider.Errorf(provider.ErrNotFound, "%s was not found", h.cfg.Repo)
	}
	if ns := res.Repository.PullRequests.Nodes; len(ns) > 0 {
		h.remember(ns[0].ID, h.itemID(h.cfg.Repo, ns[0].Number))
		return codehost.Opened{ID: h.itemID(h.cfg.Repo, ns[0].Number), Key: "#" + itoa(ns[0].Number), URL: ns[0].URL, Existed: true}, nil
	}
	var made struct {
		CreatePullRequest struct {
			PullRequest struct {
				ID     string `json:"id"`
				Number int    `json:"number"`
				URL    string `json:"url"`
			} `json:"pullRequest"`
		} `json:"createPullRequest"`
	}
	if err := h.query(ctx, githubcli.DocCreatePR, map[string]any{"repositoryId": res.Repository.ID, "baseRefName": b.Base,
		"headRefName": b.Name, "title": b.Title, "body": b.Body, "draft": false}, &made); err != nil {
		return codehost.Opened{}, err
	}
	pr := made.CreatePullRequest.PullRequest
	if pr.Number == 0 {
		return codehost.Opened{}, provider.Failed("GitHub did not open the pull request")
	}
	h.changed()
	h.remember(pr.ID, h.itemID(h.cfg.Repo, pr.Number))
	return codehost.Opened{ID: h.itemID(h.cfg.Repo, pr.Number), Key: "#" + itoa(pr.Number), URL: pr.URL}, nil
}

package kaneo

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// descriptionPages bounds the description pages a Get follows (32,768
// characters each).
const descriptionPages = 64

// task reads a task's detail and checks it is of this project (and
// workspace): one that is not, or that Kaneo does not know, is
// provider.ErrNotFound.
func (t *Tracker) task(ctx context.Context, id string) (wireTask, error) {
	if id == "" {
		return wireTask{}, provider.Errorf(provider.ErrNotFound, "no task")
	}
	var w wireTask
	if err := notFoundOn400(t.c.get(ctx, "/task/"+esc(id), url.Values{"view": {"detail"}}, &w)); err != nil {
		return wireTask{}, err
	}
	if w.ID != id || w.ProjectID != t.project || w.WorkspaceID != "" && w.WorkspaceID != t.ws {
		return wireTask{}, provider.Errorf(provider.ErrNotFound, "Kaneo task %s is not in this floor's project", id)
	}
	return w, nil
}

// Get reads a task: its detail (the whole description, read page by page
// when Kaneo deferred it), its card as the last board has it with what the
// detail says now, and its comments. Kaneo records no task author.
func (t *Tracker) Get(ctx context.Context, id string) (tracker.Detail, error) {
	w, err := t.task(ctx, id)
	if err != nil {
		return tracker.Detail{}, err
	}
	body := deref(w.Description)
	if w.DescriptionDeferred {
		if body, err = t.description(ctx, id); err != nil {
			return tracker.Detail{}, err
		}
	}
	s, err := t.snapshot(ctx)
	if err != nil {
		return tracker.Detail{}, err
	}
	comments, err := t.comments(ctx, id)
	if err != nil {
		return tracker.Detail{}, err
	}
	return tracker.Detail{Card: t.detailCard(s, &w), Body: body, CreatedAt: ms(w.CreatedAt), Comments: comments}, nil
}

// detailCard is the board's card of w (labels, avatar, place) with the
// detail's title, status, priority and assignee; a card off the board is
// made from the detail alone.
func (t *Tracker) detailCard(s *snapshot, w *wireTask) tracker.Card {
	t.mu.Lock()
	defer t.mu.Unlock()
	fresh := t.card(w, s)
	c, ok := s.cards[w.ID]
	if !ok {
		return fresh
	}
	if c.Column != fresh.Column {
		c.Position = nil
	}
	c.Title, c.Column, c.State, c.Priority = fresh.Title, fresh.Column, fresh.State, fresh.Priority
	if len(fresh.Assignees) == 0 || len(c.Assignees) == 0 || c.Assignees[0].Name != fresh.Assignees[0].Name {
		c.Assignees = fresh.Assignees
	}
	return c
}

// description reads a deferred description page by page, carrying the
// version Kaneo gives; when the text changes under the read (409) it starts
// over, once.
func (t *Tracker) description(ctx context.Context, id string) (string, error) {
	for attempt := 0; ; attempt++ {
		text, err := t.descriptionOnce(ctx, id)
		if errors.Is(err, provider.ErrStale) && attempt == 0 {
			continue
		}
		return text, err
	}
}

func (t *Tracker) descriptionOnce(ctx context.Context, id string) (string, error) {
	var sb strings.Builder
	offset, version := 0, ""
	for range descriptionPages {
		q := url.Values{"offset": {strconv.Itoa(offset)}}
		if version != "" {
			q.Set("version", version)
		}
		var p struct {
			Content    string   `json:"content"`
			Version    string   `json:"version"`
			NextOffset *float64 `json:"nextOffset"`
		}
		if err := t.c.get(ctx, "/task/"+esc(id)+"/description", q, &p); err != nil {
			return "", err
		}
		sb.WriteString(p.Content)
		if p.NextOffset == nil {
			return sb.String(), nil
		}
		next := int(*p.NextOffset)
		if next <= offset {
			return "", provider.Failed("Kaneo: the description of %s does not advance", id)
		}
		offset, version = next, p.Version
	}
	return "", provider.Failed("Kaneo: the description of %s is longer than the bridge reads", id)
}

// wireComment is a comment of the comment list.
type wireComment struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	CreatedAt string `json:"createdAt"`
	User      *struct {
		Name  string  `json:"name"`
		Image *string `json:"image"`
	} `json:"user"`
}

func (c wireComment) comment() provider.Comment {
	out := provider.Comment{ID: c.ID, Body: c.Content, CreatedAt: ms(c.CreatedAt)}
	if c.User != nil {
		out.Author = provider.Person{Name: c.User.Name, AvatarURL: deref(c.User.Image)}
	}
	return out
}

// comments is a task's comments, oldest first (Kaneo sends them all).
func (t *Tracker) comments(ctx context.Context, id string) ([]provider.Comment, error) {
	var raw []wireComment
	if err := notFoundOn400(t.c.get(ctx, "/comment/"+esc(id), nil, &raw)); err != nil {
		return nil, err
	}
	out := []provider.Comment{}
	for _, c := range raw {
		out = append(out, c.comment())
	}
	return out, nil
}

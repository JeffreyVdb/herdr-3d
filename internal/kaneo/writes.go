package kaneo

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// maxComment is Kaneo's comment limit, in UTF-16 code units (what its
// validator counts).
const maxComment = 10000

// Comment posts a comment on a task of this project. The answer is the
// stored activity row, which names no author: the comment list is read
// again for it (the comment is posted either way).
func (t *Tracker) Comment(ctx context.Context, id, body string) (provider.Comment, error) {
	if strings.TrimSpace(body) == "" {
		return provider.Comment{}, provider.Errorf(provider.ErrBadInput, "the comment is empty")
	}
	if n := utf16Len(body); n > maxComment {
		return provider.Comment{}, provider.Errorf(provider.ErrBadInput, "a Kaneo comment is at most %d characters (this one is %d)", maxComment, n)
	}
	if _, err := t.task(ctx, id); err != nil {
		return provider.Comment{}, err
	}
	var a struct {
		ID        string  `json:"id"`
		Content   *string `json:"content"`
		CreatedAt string  `json:"createdAt"`
	}
	if err := t.c.call(ctx, http.MethodPost, "/comment/"+esc(id), nil, map[string]string{"content": body}, &a); err != nil {
		return provider.Comment{}, err
	}
	c := provider.Comment{ID: a.ID, Body: body, CreatedAt: ms(a.CreatedAt)}
	if a.Content != nil {
		c.Body = *a.Content
	}
	if list, err := t.comments(ctx, id); err == nil {
		for _, l := range list {
			if l.ID == c.ID {
				c.Author = l.Author
			}
		}
	}
	return c, nil
}

// utf16Len is the length of s in UTF-16 code units.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 && r <= utf8.MaxRune {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Close is not Kaneo's: a task is completed by moving it to a final column.
func (t *Tracker) Close(ctx context.Context, id, reason string) error {
	return provider.Errorf(provider.ErrUnsupported, "Kaneo has no close: move the task to a done column")
}

// SetStatus moves a task to a column of the last board (a board is read
// first when there is none). Without an anchor it is PUT /task/status with
// the column's slug, after the task's detail says it is of this project.
// With one it is a reorder (see reorder).
func (t *Tracker) SetStatus(ctx context.Context, id, columnID string, at *tracker.Anchor) error {
	s, err := t.snapshot(ctx)
	if err != nil {
		return err
	}
	t.mu.Lock()
	ok := s.hasColumn(columnID)
	t.mu.Unlock()
	if !ok {
		return provider.Errorf(provider.ErrBadInput, "%q is not a column of the board", columnID)
	}
	if at != nil {
		return t.reorder(ctx, id, columnID, at)
	}
	if _, err := t.task(ctx, id); err != nil {
		return err
	}
	var w wireTask
	if err := t.c.call(ctx, http.MethodPut, "/task/status/"+esc(id), nil, map[string]string{"status": columnID}, &w); err != nil {
		return err
	}
	if w.Status == "" {
		w.Status = columnID
	}
	t.moved(id, w.Status, intPos(w.Position))
	return nil
}

// reorderTask and expectedTask are POST /task/reorder's items: what to
// write, and the snapshot the write is computed from.
type reorderTask struct {
	ID       string `json:"id"`
	Position int64  `json:"position"`
	Status   string `json:"status,omitempty"`
}

type expectedTask struct {
	ID       string `json:"id"`
	Position *int64 `json:"position"`
	Status   string `json:"status"`
}

type reorderBody struct {
	ProjectID     string         `json:"projectId"`
	Tasks         []reorderTask  `json:"tasks"`
	ExpectedTasks []expectedTask `json:"expectedTasks"`
}

// reorder moves a card to its anchor's place in a column, in one write:
// the column's cards are numbered again from 0 in their new order (only
// the ones whose position changes are sent, the moved one always, with its
// status), and expectedTasks is every task of the columns it leaves and
// enters as the last board has them, so Kaneo refuses the move (409,
// provider.ErrStale) when the board changed since. A truncated board
// cannot be ordered: its columns may lack tasks, which Kaneo would always
// refuse.
func (t *Tracker) reorder(ctx context.Context, id, columnID string, at *tracker.Anchor) error {
	if at.After == id {
		return provider.Errorf(provider.ErrBadInput, "a card cannot go after itself")
	}
	t.mu.Lock()
	body, err := t.last.reorder(t.project, id, columnID, at.After)
	t.mu.Unlock()
	if err != nil {
		return err
	}
	var rows []struct {
		ID       string   `json:"id"`
		Position *float64 `json:"position"`
		Status   string   `json:"status"`
	}
	if err := t.c.call(ctx, http.MethodPost, "/task/reorder", nil, body, &rows); err != nil {
		return err
	}
	for _, r := range rows {
		t.moved(r.ID, r.Status, intPos(r.Position))
	}
	return nil
}

func (s *snapshot) reorder(projectID, id, columnID, after string) (*reorderBody, error) {
	if s.truncated {
		return nil, provider.Errorf(provider.ErrUnsupported, "the project has more tasks than the bridge reads: its cards cannot be ordered")
	}
	p := s.tasks[id]
	if p == nil {
		return nil, provider.Errorf(provider.ErrStale, "%s is not on the last board: refresh it", id)
	}
	if after != "" {
		if a := s.tasks[after]; a == nil || a.status != columnID {
			return nil, provider.Errorf(provider.ErrStale, "%s is not in that column any more: refresh the board", after)
		}
	}
	var dest []string
	if after == "" {
		dest = append(dest, id)
	}
	for _, o := range s.order(columnID) {
		if o == id {
			continue
		}
		dest = append(dest, o)
		if o == after {
			dest = append(dest, id)
		}
	}
	b := &reorderBody{ProjectID: projectID}
	for i, o := range dest {
		switch at := s.tasks[o].position; {
		case o == id:
			b.Tasks = append(b.Tasks, reorderTask{ID: o, Position: int64(i), Status: columnID})
		case at == nil || *at != int64(i):
			b.Tasks = append(b.Tasks, reorderTask{ID: o, Position: int64(i)})
		}
	}
	statuses := []string{p.status}
	if columnID != p.status {
		statuses = append(statuses, columnID)
	}
	for _, st := range statuses {
		for _, o := range s.order(st) {
			b.ExpectedTasks = append(b.ExpectedTasks, expectedTask{ID: o, Position: s.tasks[o].position, Status: st})
		}
	}
	return b, nil
}

// moved records a write's outcome in the last board, so the next move is
// computed from what Kaneo has now.
func (t *Tracker) moved(id, status string, position *int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.last
	if s == nil || id == "" {
		return
	}
	if p := s.tasks[id]; p != nil {
		p.status, p.position = status, position
	}
	if c, ok := s.cards[id]; ok {
		if c.Column != status {
			c.Position = nil
		}
		c.Column, c.State = status, tracker.StateOpen
		if s.final[status] {
			c.State = tracker.StateClosed
		}
		s.cards[id] = c
	}
}

package kaneo

import (
	"context"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// Board read limits. A read is the column list and the board pages: each
// task page of 100, and for each its related-metadata pages (labels, links
// and columns, 100 of each per page; Kaneo repeats the page's tasks on
// every one). Past a limit the board is Truncated.
const (
	// taskPages is how many task pages a read follows: past 500 tasks a
	// board is truncated.
	taskPages = 5
	// relatedPages is how many related pages a task page is followed for.
	relatedPages = 3
	// boardCalls bounds one read's calls, the column list included (Kaneo
	// limits a key to 100 calls a minute by default).
	boardCalls = 12
	pageSize   = 100
)

// The virtual statuses: Kaneo keeps a task that is in no workflow column as
// planned or archived. They are columns of the board (Column.Kind), around
// the workflow ones.
const (
	ColumnPlanned  = "planned"
	ColumnArchived = "archived"
)

// Tracker is the tracker.Tracker of one Kaneo project of a workspace.
type Tracker struct {
	c       *Client
	ws      string
	project string
	web     string

	fetch sync.Mutex // one board read at a time

	mu   sync.Mutex
	last *snapshot // the last board read (kept up to date by the writes)
}

var _ tracker.Tracker = (*Tracker)(nil)

// NewTracker is the tracker of project projectID of workspace workspaceID
// through c; its task links point at webOrigin (Endpoint.WebOrigin).
func NewTracker(c *Client, workspaceID, projectID, webOrigin string) *Tracker {
	return &Tracker{c: c, ws: workspaceID, project: projectID, web: strings.TrimRight(webOrigin, "/")}
}

// Key identifies the tracker's fetch: the API base, the workspace and the
// project (never the key).
func (t *Tracker) Key() string {
	return "kaneo:" + t.c.base + "|" + t.ws + "|" + t.project
}

func (t *Tracker) Info() tracker.Info {
	return tracker.Info{ID: ProviderID, Name: ProviderName,
		Capabilities: tracker.Capabilities{Comment: true, Close: false, SetStatus: true, Order: true}}
}

// snapshot is a board read: what Get, the scope checks and the reorders
// work from. Its fields are read and changed under Tracker.mu.
type snapshot struct {
	slug      string
	columns   []tracker.Column
	final     map[string]bool // a status → it is a final column
	cards     map[string]tracker.Card
	tasks     map[string]*place
	truncated bool
}

// place is where a task is in Kaneo's order: its status, its position
// (nil when Kaneo has none) and, for ties, its rank in the board's order.
type place struct {
	status   string
	position *int64
	seq      int
}

// hasColumn reports whether id is a column of the board.
func (s *snapshot) hasColumn(id string) bool {
	for _, c := range s.columns {
		if c.ID == id {
			return true
		}
	}
	return false
}

// order is the ids of status's tasks in Kaneo's order (position, no
// position last).
func (s *snapshot) order(status string) []string {
	var ids []string
	for id, p := range s.tasks {
		if p.status == status {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := s.tasks[ids[i]], s.tasks[ids[j]]
		switch {
		case a.position == nil || b.position == nil:
			if (a.position == nil) != (b.position == nil) {
				return b.position == nil
			}
		case *a.position != *b.position:
			return *a.position < *b.position
		}
		return a.seq < b.seq
	})
	return ids
}

// Wire shapes.

type wireColumn struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Slug     string   `json:"slug"`
	Position *float64 `json:"position"`
	IsFinal  bool     `json:"isFinal"`
}

type wireLabel struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type wireTask struct {
	ID                  string      `json:"id"`
	ProjectID           string      `json:"projectId"`
	WorkspaceID         string      `json:"workspaceId"`
	Number              *float64    `json:"number"`
	Title               string      `json:"title"`
	Description         *string     `json:"description"`
	DescriptionDeferred bool        `json:"descriptionDeferred"`
	Status              string      `json:"status"`
	Priority            string      `json:"priority"`
	Position            *float64    `json:"position"`
	CreatedAt           string      `json:"createdAt"`
	AssigneeName        *string     `json:"assigneeName"`
	AssigneeImage       *string     `json:"assigneeImage"`
	Labels              []wireLabel `json:"labels"`
}

type wireBoard struct {
	Data struct {
		ID          string `json:"id"`
		Slug        string `json:"slug"`
		WorkspaceID string `json:"workspaceId"`
		Columns     []struct {
			wireColumn
			Tasks []wireTask `json:"tasks"`
		} `json:"columns"`
		PlannedTasks  []wireTask `json:"plannedTasks"`
		ArchivedTasks []wireTask `json:"archivedTasks"`
	} `json:"data"`
	Pagination struct {
		Total             int `json:"total"`
		TotalPages        int `json:"totalPages"`
		RelatedTotalPages int `json:"relatedTotalPages"`
	} `json:"pagination"`
}

// Board reads the project's columns and its tasks: every status, the final
// columns' too (Kaneo says nothing of when a task was completed, so there
// is no recent-days window), up to the read's limits.
func (t *Tracker) Board(ctx context.Context) (tracker.Board, error) {
	t.fetch.Lock()
	defer t.fetch.Unlock()
	s, b, err := t.read(ctx)
	if err != nil {
		return tracker.Board{}, err
	}
	t.mu.Lock()
	t.last = s
	t.mu.Unlock()
	return b, nil
}

// snapshot is the last board read, read now when there is none.
func (t *Tracker) snapshot(ctx context.Context) (*snapshot, error) {
	t.mu.Lock()
	s := t.last
	t.mu.Unlock()
	if s != nil {
		return s, nil
	}
	if _, err := t.Board(ctx); err != nil {
		return nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last, nil
}

// read is one board read.
func (t *Tracker) read(ctx context.Context) (*snapshot, tracker.Board, error) {
	var cols []wireColumn
	if err := notFoundOn400(t.c.get(ctx, "/column/"+esc(t.project), nil, &cols)); err != nil {
		return nil, tracker.Board{}, err
	}
	acc := accumulator{byID: map[string]*wireTask{}, labels: map[string]map[string]bool{}, meta: map[string]wireColumn{}}
	calls, total, truncated := 1, -1, false
pages:
	for page := 1; ; page++ {
		totalPages := 1
		for rel := 1; ; rel++ {
			if calls >= boardCalls {
				truncated = true
				break pages
			}
			var bp wireBoard
			q := url.Values{"limit": {strconv.Itoa(pageSize)}, "page": {strconv.Itoa(page)}, "relatedPage": {strconv.Itoa(rel)}}
			calls++
			if err := notFoundOn400(t.c.get(ctx, "/task/tasks/"+esc(t.project), q, &bp)); err != nil {
				return nil, tracker.Board{}, err
			}
			if bp.Data.ID != "" && bp.Data.ID != t.project {
				return nil, tracker.Board{}, provider.Failed("Kaneo: the board of %s answered another project", t.project)
			}
			if bp.Data.WorkspaceID != t.ws {
				return nil, tracker.Board{}, provider.Errorf(provider.ErrNotFound, "Kaneo project %s is not in workspace %s any more", t.project, t.ws)
			}
			// The board moved under the read: what it has is not the whole of it.
			if total >= 0 && bp.Pagination.Total != total {
				truncated = true
			}
			total = bp.Pagination.Total
			acc.add(&bp)
			totalPages = bp.Pagination.TotalPages
			if rel >= bp.Pagination.RelatedTotalPages {
				break
			}
			if rel >= relatedPages {
				truncated = true
				break
			}
		}
		if page >= totalPages {
			break
		}
		if page >= taskPages {
			truncated = true
			break
		}
	}
	// Every task Kaneo counts is in one of the page's columns, so a whole
	// read has seen each. Fewer is a board that moved under the read with
	// the total unchanged (a reorder between pages), more one that grew.
	if total >= 0 && len(acc.order) != total {
		truncated = true
	}
	s, b := t.build(cols, &acc)
	s.truncated, b.Truncated = truncated, truncated
	return s, b, nil
}

// accumulator merges board pages: a task once (in Kaneo's order), its
// labels from every related page.
type accumulator struct {
	slug   string
	order  []string
	byID   map[string]*wireTask
	labels map[string]map[string]bool // task → label ids it has
	meta   map[string]wireColumn      // the board's own columns, by slug
}

func (a *accumulator) add(bp *wireBoard) {
	if a.slug == "" {
		a.slug = bp.Data.Slug
	}
	var tasks []wireTask
	for _, c := range bp.Data.Columns {
		if _, ok := a.meta[c.Slug]; !ok && c.Slug != "" {
			a.meta[c.Slug] = c.wireColumn
		}
		tasks = append(tasks, c.Tasks...)
	}
	tasks = append(tasks, bp.Data.PlannedTasks...)
	tasks = append(tasks, bp.Data.ArchivedTasks...)
	for i := range tasks {
		w := tasks[i]
		if w.ID == "" {
			continue
		}
		have := a.byID[w.ID]
		if have == nil {
			have = &wireTask{}
			*have = w
			have.Labels = nil
			a.byID[w.ID] = have
			a.labels[w.ID] = map[string]bool{}
			a.order = append(a.order, w.ID)
		}
		for _, l := range w.Labels {
			a.label(have, l)
		}
	}
}

func (a *accumulator) label(w *wireTask, l wireLabel) {
	key := l.ID
	if key == "" {
		key = "name:" + l.Name
	}
	if a.labels[w.ID][key] {
		return
	}
	a.labels[w.ID][key] = true
	w.Labels = append(w.Labels, l)
}

// build makes the board and its snapshot from the column list and the
// merged pages. Columns: Planned, the workflow columns in their order (a
// task's column that only the board pages named after them), Archived.
func (t *Tracker) build(cols []wireColumn, acc *accumulator) (*snapshot, tracker.Board) {
	s := &snapshot{slug: acc.slug, final: map[string]bool{}, cards: map[string]tracker.Card{}, tasks: map[string]*place{}}
	sort.SliceStable(cols, func(i, j int) bool { return pos(cols[i].Position) < pos(cols[j].Position) })
	var work []tracker.Column
	seen := map[string]bool{}
	for _, c := range cols {
		if c.Slug == "" || seen[c.Slug] {
			continue
		}
		seen[c.Slug] = true
		s.final[c.Slug] = c.IsFinal
		work = append(work, tracker.Column{ID: c.Slug, Name: nameOr(c.Name, c.Slug), Done: c.IsFinal})
	}
	var extra []wireColumn
	for _, id := range acc.order {
		st := acc.byID[id].Status
		if m, ok := acc.meta[st]; ok && !seen[st] && st != ColumnPlanned && st != ColumnArchived {
			seen[st] = true
			s.final[st] = m.IsFinal
			extra = append(extra, m)
		}
	}
	sort.SliceStable(extra, func(i, j int) bool { return pos(extra[i].Position) < pos(extra[j].Position) })
	for _, c := range extra {
		work = append(work, tracker.Column{ID: c.Slug, Name: nameOr(c.Name, c.Slug), Done: c.IsFinal})
	}
	if !seen[ColumnPlanned] {
		s.columns = append(s.columns, tracker.Column{ID: ColumnPlanned, Name: "Planned", Kind: ColumnPlanned})
	}
	s.columns = append(s.columns, work...)
	if !seen[ColumnArchived] {
		s.columns = append(s.columns, tracker.Column{ID: ColumnArchived, Name: "Archived", Kind: ColumnArchived})
	}
	b := tracker.Board{Columns: s.columns, Cards: []tracker.Card{}}
	rank := map[string]int{}
	for i, id := range acc.order {
		w := acc.byID[id]
		c := t.card(w, s)
		r := rank[w.Status]
		rank[w.Status]++
		c.Position = &r
		s.cards[id] = c
		s.tasks[id] = &place{status: w.Status, position: intPos(w.Position), seq: i}
		b.Cards = append(b.Cards, c)
	}
	return s, b
}

// card maps a task to a card: State is closed only in a final column (an
// archived task is open); Kaneo gives no update or close time.
func (t *Tracker) card(w *wireTask, s *snapshot) tracker.Card {
	c := tracker.Card{ID: w.ID, Key: keyOf(s.slug, w.Number), Title: w.Title, State: tracker.StateOpen, Column: w.Status,
		URL: t.taskURL(w.ID), Labels: []tracker.Label{}, Priority: priorityOf(w.Priority), Assignees: []provider.Person{}}
	if s.final[w.Status] {
		c.State = tracker.StateClosed
	}
	for _, l := range w.Labels {
		c.Labels = append(c.Labels, tracker.Label{Name: l.Name, Color: color(l.Color)})
	}
	if w.AssigneeName != nil && *w.AssigneeName != "" {
		c.Assignees = append(c.Assignees, provider.Person{Name: *w.AssigneeName, AvatarURL: deref(w.AssigneeImage)})
	}
	return c
}

// taskURL is a task's canonical page: by ids, which no rename moves.
func (t *Tracker) taskURL(id string) string {
	return t.web + "/dashboard/workspace/" + esc(t.ws) + "/project/" + esc(t.project) + "/task/" + esc(id)
}

// keyOf is a task's key for people: "<project slug>-<number>" (the slug
// alone for a task without a number).
func keyOf(slug string, number *float64) string {
	if number == nil {
		return slug
	}
	return slug + "-" + strconv.FormatInt(int64(*number), 10)
}

// priorityOf maps Kaneo's priority; "no-priority" and anything unknown is
// none.
func priorityOf(p string) string {
	switch p = strings.ToLower(strings.TrimSpace(p)); p {
	case "urgent", "high", "medium", "low":
		return p
	}
	return ""
}

var hexRe = regexp.MustCompile(`^[0-9a-fA-F]{6}$`)

// color is a label colour as "#rrggbb" ("#abc" is widened; anything else
// is grey).
func color(c string) string {
	c = strings.TrimPrefix(strings.TrimSpace(c), "#")
	if len(c) == 3 {
		c = string([]byte{c[0], c[0], c[1], c[1], c[2], c[2]})
	}
	if !hexRe.MatchString(c) {
		return "#ededed"
	}
	return "#" + strings.ToLower(c)
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

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func nameOr(name, slug string) string {
	if name == "" {
		return slug
	}
	return name
}

// pos is a column's position for sorting (none last).
func pos(p *float64) float64 {
	if p == nil {
		return 1 << 53
	}
	return *p
}

func intPos(p *float64) *int64 {
	if p == nil {
		return nil
	}
	n := int64(*p)
	return &n
}

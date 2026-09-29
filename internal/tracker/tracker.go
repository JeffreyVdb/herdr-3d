// Package tracker is the bridge's neutral issue interface. A floor's issues
// come from a Tracker: GitHub Issues (and Projects) today, later files in
// the repository or Monday.com. Everything above it (the poller, the cache,
// the commands, the audit log) sees only these types and the opaque item
// ids a provider hands out; GitHub's node ids, field and option ids stay
// inside its package. The types carry the wire's JSON tags: they are what
// board.issues and issue.get send.
package tracker

import (
	"context"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// Info says which provider this is and what it can do.
type Info struct {
	ID           string       // "github"
	Name         string       // "GitHub", for the game's "Open in GitHub"
	Capabilities Capabilities // of the board; a card may override them
}

// Capabilities are what a board (or one card) allows. The bridge refuses a
// write whose capability is off, whatever a client sends.
type Capabilities struct {
	Comment   bool `json:"comment"`
	Close     bool `json:"close"`
	SetStatus bool `json:"set_status"`
}

// Column is one status column, in provider order. Done marks a done column.
type Column struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Done bool   `json:"done"`
}

// Label is a label with its colour as "#rrggbb".
type Label struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

// Card is one issue on the board.
type Card struct {
	ID        string            `json:"id"`  // opaque, scoped by the provider
	Key       string            `json:"key"` // for people: "#9"
	Title     string            `json:"title"`
	State     string            `json:"state"` // open | closed
	Column    string            `json:"column"`
	URL       string            `json:"url,omitempty"`
	Labels    []Label           `json:"labels"`
	Priority  string            `json:"priority,omitempty"` // urgent | high | medium | low
	Assignees []provider.Person `json:"assignees"`
	Author    string            `json:"author"`
	UpdatedAt int64             `json:"updated_at"`
	ClosedAt  *int64            `json:"closed_at"`
	// Capabilities, when set, replace the board's for this card.
	Capabilities *Capabilities `json:"capabilities,omitempty"`
}

// Card states.
const (
	StateOpen   = "open"
	StateClosed = "closed"
)

// Board is the provider's issues: columns and cards. Truncated means the
// provider hit its paging limit and the board is incomplete.
type Board struct {
	Columns   []Column
	Cards     []Card
	Truncated bool
	Rate      *provider.Rate
}

// Detail is issue.get's answer.
type Detail struct {
	Card              Card               `json:"card"`
	Body              string             `json:"body"` // raw markdown
	Author            provider.Person    `json:"author"`
	CreatedAt         int64              `json:"created_at"`
	Comments          []provider.Comment `json:"comments"`
	CommentsTruncated bool               `json:"comments_truncated"`
}

// Close reasons.
const (
	ReasonCompleted  = "completed"
	ReasonNotPlanned = "not_planned"
	ReasonDuplicate  = "duplicate"
)

// ValidReason reports whether r is a close reason.
func ValidReason(r string) bool {
	return r == ReasonCompleted || r == ReasonNotPlanned || r == ReasonDuplicate
}

// Tracker is one floor's issues. Errors are the provider package's kinds.
type Tracker interface {
	Info() Info
	// Board reads the columns and cards: open issues and the ones closed in
	// the last seven days.
	Board(ctx context.Context) (Board, error)
	Get(ctx context.Context, id string) (Detail, error)
	Comment(ctx context.Context, id, body string) (provider.Comment, error)
	// Close closes the issue for reason (completed, not_planned, duplicate).
	Close(ctx context.Context, id, reason string) error
	// SetStatus moves the issue to a column of the last Board.
	SetStatus(ctx context.Context, id, columnID string) error
}

// RunLinker is what a tracker implements when a write-code run's issue
// link (a repository and a number, the way M6 names it) maps onto its
// items. A provider whose items are not numbered issues of a repository
// does not implement it.
type RunLinker interface {
	// ItemFromRun is the item id of issue number of repo.
	ItemFromRun(repo string, number int) (id string, ok bool)
	// RunFromItem is the repository and number behind an item id, and its
	// URL, so a run can start on it (run.start's work_item).
	RunFromItem(id string) (repo string, number int, url string, ok bool)
}

// Package codehost is the bridge's neutral change-request (pull request)
// interface, next to the issue interface in internal/tracker: a floor's
// pull requests come from a Host. Like tracker it carries the wire's JSON
// tags, and provider-private ids never leave the provider.
package codehost

import (
	"context"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// Info says which provider this is and what it can do.
type Info struct {
	ID           string
	Name         string
	Capabilities Capabilities
}

// Capabilities are what the host allows.
type Capabilities struct {
	Comment        bool `json:"comment"`
	Merge          bool `json:"merge"`
	OpenFromBranch bool `json:"open_from_branch"`
}

// Values of Request.Checks, Review and Mergeable.
const (
	ChecksSuccess = "success"
	ChecksFailure = "failure"
	ChecksPending = "pending"
	ChecksNone    = "none"

	ReviewApproved         = "approved"
	ReviewChangesRequested = "changes_requested"
	ReviewRequired         = "review_required"
	ReviewNone             = "none"

	Mergeable   = "mergeable"
	Conflicting = "conflicting"
	Unknown     = "unknown"
)

// Request is one open change request.
type Request struct {
	ID           string   `json:"id"`
	Key          string   `json:"key"`
	Title        string   `json:"title"`
	State        string   `json:"state"` // open
	Draft        bool     `json:"draft"`
	URL          string   `json:"url,omitempty"`
	HeadBranch   string   `json:"head_branch"`
	BaseBranch   string   `json:"base_branch"`
	Author       string   `json:"author"`
	Checks       string   `json:"checks"`
	Review       string   `json:"review"`
	Mergeable    string   `json:"mergeable"`
	Closes       []string `json:"closes"` // ids of the issues it closes
	Additions    int      `json:"additions"`
	Deletions    int      `json:"deletions"`
	ChangedFiles int      `json:"changed_files"`
	UpdatedAt    int64    `json:"updated_at"`
}

// Merged is a request that was open at the previous poll and is merged now.
type Merged struct {
	ID       string   `json:"id"`
	Key      string   `json:"key"`
	Title    string   `json:"title"`
	MergedAt int64    `json:"merged_at"`
	Closes   []string `json:"closes"`
}

// PrevState is what the poller remembers of the last good poll.
type PrevState struct {
	// OpenIDs are the ids of the requests that were open then.
	OpenIDs []string
}

// Board is the open requests, and the transitions of the previous ones.
type Board struct {
	Requests  []Request
	Merged    []Merged
	Truncated bool
	Rate      *provider.Rate
}

// File is one file of a change request.
type File struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Change    string `json:"change"` // added | modified | removed | renamed | copied | changed
}

// Check is one check of the head commit.
type Check struct {
	Name  string `json:"name"`
	State string `json:"state"` // success | failure | pending | neutral | skipped
	URL   string `json:"url,omitempty"`
}

// Detail is pr.get's answer.
type Detail struct {
	Request           Request            `json:"pr"`
	Body              string             `json:"body"` // raw markdown
	Author            provider.Person    `json:"author"`
	CreatedAt         int64              `json:"created_at"`
	Files             []File             `json:"files"`
	FilesTruncated    bool               `json:"files_truncated"`
	Checks            []Check            `json:"checks"`
	Comments          []provider.Comment `json:"comments"`
	CommentsTruncated bool               `json:"comments_truncated"`
}

// Merge methods.
const (
	MethodMerge  = "merge"
	MethodSquash = "squash"
	MethodRebase = "rebase"
)

// ValidMethod reports whether m is a merge method.
func ValidMethod(m string) bool {
	return m == MethodMerge || m == MethodSquash || m == MethodRebase
}

// Branch is a branch the bridge pushed and wants a request for.
type Branch struct {
	Name  string
	Base  string
	Title string
	Body  string
}

// Opened is the request OpenFromBranch made or found.
type Opened struct {
	ID      string `json:"id"`
	Key     string `json:"key"`
	URL     string `json:"url"`
	Existed bool   `json:"-"`
}

// Gate is the rule a normal merge follows, for a fresh read of the
// request: checks must be success and it must be mergeable. override
// lets failing or pending checks and an unknown mergeability through; a
// conflicting request is never merged.
func Gate(r Request, override bool) error {
	switch {
	case r.Mergeable == Conflicting:
		return provider.Errorf(provider.ErrNotMergeable, "%s has conflicts", r.Key)
	case !override && r.Checks != ChecksSuccess:
		return provider.Errorf(provider.ErrChecksNotGreen, "checks of %s are %s", r.Key, r.Checks)
	case !override && r.Mergeable != Mergeable:
		return provider.Errorf(provider.ErrNotMergeable, "%s is not mergeable (%s)", r.Key, r.Mergeable)
	}
	return nil
}

// Host is one floor's change requests. Errors are the provider package's
// kinds.
type Host interface {
	Info() Info
	// Board reads the open requests and, of the ones prev says were open,
	// which are merged now (a request that cannot be read is not merged).
	Board(ctx context.Context, prev PrevState) (Board, error)
	Get(ctx context.Context, id string) (Detail, error)
	Comment(ctx context.Context, id, body string) (provider.Comment, error)
	// Merge reads the request again right before merging and applies Gate;
	// a head that moved meanwhile is provider.ErrStale.
	Merge(ctx context.Context, id, method string, override bool) error
	// OpenFromBranch opens a request for a branch already pushed, or returns
	// the open one for that head (Existed).
	OpenFromBranch(ctx context.Context, b Branch) (Opened, error)
}

package proto

import (
	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// M7 boards: a floor's issues and pull requests, from the provider its repo
// is linked to. board.issues and board.prs are connection-scoped messages
// (no seq, not in the replay ring or the snapshot). Items are addressed by
// an opaque id scoped by the provider; the card, pull request and detail
// shapes are the tracker and codehost packages' (they carry the wire's JSON
// tags).

// Messages of the boards.
const (
	TBoardIssues = "board.issues"
	TBoardPRs    = "board.prs"
)

// Commands of the boards.
const (
	CmdBoardWatch     = "board.watch"
	CmdBoardUnwatch   = "board.unwatch"
	CmdBoardRefresh   = "board.refresh"
	CmdIssueGet       = "issue.get"
	CmdIssueComment   = "issue.comment"
	CmdIssueClose     = "issue.close"
	CmdIssueSetStatus = "issue.set_status"
	CmdPRGet          = "pr.get"
	CmdPRComment      = "pr.comment"
	CmdPRMerge        = "pr.merge"
	CmdOpenPRPrepare  = "worker.open_pr.prepare"
	CmdWorkerOpenPR   = "worker.open_pr"
)

// Error codes of the boards.
const (
	ErrConfirmationRequired = "confirmation_required" // issue.close, pr.merge, worker.open_pr without confirm: true
	ErrUnsupported          = "unsupported"           // the provider or the floor cannot do this
	ErrProviderFailed       = "provider_failed"       // the provider call failed (never holds a token)
	ErrRateLimited          = "rate_limited"
	ErrChecksNotGreen       = "checks_not_green" // pr.merge, checks are not success
	ErrNotMergeable         = "not_mergeable"    // pr.merge, not mergeable
)

func init() {
	Commands = append(Commands, CmdBoardWatch, CmdBoardUnwatch, CmdBoardRefresh, CmdIssueGet, CmdIssueComment, CmdIssueClose,
		CmdIssueSetStatus, CmdPRGet, CmdPRComment, CmdPRMerge, CmdOpenPRPrepare, CmdWorkerOpenPR)
}

// WorkItemRef names an item of a provider: a worker's work (Worker.WorkItem)
// or what a run starts on (run.prepare and run.start).
type WorkItemRef struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

// BoardIssues is a floor's issues, as of FetchedAt (unix ms; 0: nothing
// fetched yet). Initial marks the replay of the cache on board.watch.
type BoardIssues struct {
	T            string               `json:"t"`
	Session      string               `json:"session"`
	Provider     string               `json:"provider"`
	ProviderName string               `json:"provider_name"`
	Initial      bool                 `json:"initial"`
	FetchedAt    int64                `json:"fetched_at"`
	Stale        bool                 `json:"stale"`
	Error        string               `json:"error,omitempty"`
	Truncated    bool                 `json:"truncated"`
	Rate         *provider.Rate       `json:"rate,omitempty"`
	Capabilities tracker.Capabilities `json:"capabilities"`
	Columns      []tracker.Column     `json:"columns"`
	Cards        []tracker.Card       `json:"cards"`
}

// BoardPRs is a floor's open pull requests, and the ones merged since the
// last poll (never on an initial message).
type BoardPRs struct {
	T            string                `json:"t"`
	Session      string                `json:"session"`
	Provider     string                `json:"provider"`
	ProviderName string                `json:"provider_name"`
	Initial      bool                  `json:"initial"`
	FetchedAt    int64                 `json:"fetched_at"`
	Stale        bool                  `json:"stale"`
	Error        string                `json:"error,omitempty"`
	Truncated    bool                  `json:"truncated"`
	Rate         *provider.Rate        `json:"rate,omitempty"`
	Capabilities codehost.Capabilities `json:"capabilities"`
	PRs          []codehost.Request    `json:"prs"`
	Merged       []codehost.Merged     `json:"merged"`
}

// BoardArgs are the args of board.watch, board.unwatch and board.refresh.
type BoardArgs struct {
	Session string `json:"session"`
}

// BoardWatchResult is the ack data of board.watch.
type BoardWatchResult struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
}

// BoardRefreshResult is the ack data of board.refresh.
type BoardRefreshResult struct {
	Queued bool `json:"queued"`
}

// ItemArgs are the args of issue.get and pr.get.
type ItemArgs struct {
	Session string `json:"session"`
	ID      string `json:"id"`
}

// CommentArgs are the args of issue.comment and pr.comment.
type CommentArgs struct {
	Session string `json:"session"`
	ID      string `json:"id"`
	Body    string `json:"body"`
}

// CommentResult is the ack data of issue.comment and pr.comment.
type CommentResult struct {
	Comment provider.Comment `json:"comment"`
}

// IssueCloseArgs are the args of issue.close.
type IssueCloseArgs struct {
	Session string `json:"session"`
	ID      string `json:"id"`
	Reason  string `json:"reason"`
	Confirm bool   `json:"confirm"`
}

// IssueSetStatusArgs are the args of issue.set_status.
type IssueSetStatusArgs struct {
	Session string `json:"session"`
	ID      string `json:"id"`
	Column  string `json:"column"`
}

// PRMergeArgs are the args of pr.merge. Override lets a pull request whose
// checks are not green (or whose mergeability is unknown) through, and
// then needs ConfirmOverride too; a conflicting one is never merged.
type PRMergeArgs struct {
	Session         string `json:"session"`
	ID              string `json:"id"`
	Method          string `json:"method"`
	Confirm         bool   `json:"confirm"`
	Override        bool   `json:"override,omitempty"`
	ConfirmOverride bool   `json:"confirm_override,omitempty"`
}

// PRMergeResult is the ack data of pr.merge.
type PRMergeResult struct {
	Merged bool `json:"merged"`
}

// OpenPRRef names the pull request of worker.open_pr.
type OpenPRRef struct {
	ID  string `json:"id"`
	Key string `json:"key"`
	URL string `json:"url"`
}

// OpenPRPrepareResult is the ack data of worker.open_pr.prepare.
type OpenPRPrepareResult struct {
	CanOpen  bool       `json:"can_open"`
	Reason   string     `json:"reason,omitempty"`
	Branch   string     `json:"branch"`
	Base     string     `json:"base"`
	Ahead    int        `json:"ahead"`
	Dirty    bool       `json:"dirty"`
	Existing *OpenPRRef `json:"existing,omitempty"`
	Title    string     `json:"title"`
	Body     string     `json:"body"`
}

// OpenPRArgs are the args of worker.open_pr.
type OpenPRArgs struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	Confirm bool   `json:"confirm"`
}

// OpenPRResult is the ack data of worker.open_pr.
type OpenPRResult struct {
	PR      OpenPRRef `json:"pr"`
	Pushed  bool      `json:"pushed"`
	Existed bool      `json:"existed"`
}

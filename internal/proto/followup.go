package proto

import "github.com/JeffreyVdb/herdr-3d/internal/followup"

// #90 follow-up questions (docs/protocol.md "Follow-up questions"): the open
// questions of an agent's final message, found by the AI integration's
// classifier and LLM (#92) once the feature is switched on. The settings are
// in the snapshot (World.Followups) and every change is a followups.update
// event with the fields of Followups flat in it; a worker's questions are
// Worker.Followup.

// EvFollowupsUpdate carries the feature's settings and state (the fields of
// Followups).
const EvFollowupsUpdate = "followups.update"

// Commands of the follow-up questions.
const (
	CmdFollowupsGet          = "followups.get"
	CmdFollowupsSet          = "followups.set"
	CmdFollowupsTest         = "followups.test"
	CmdWorkerAnswerFollowup  = "worker.answer_followup"
	CmdWorkerDismissFollowup = "worker.dismiss_followup"
	// #60: the extraction once more (a fallback's), and the whole message.
	CmdWorkerRetryFollowup   = "worker.retry_followup"
	CmdWorkerFollowupMessage = "worker.followup_message"
)

func init() {
	Commands = append(Commands, CmdFollowupsGet, CmdFollowupsSet, CmdFollowupsTest, CmdWorkerAnswerFollowup,
		CmdWorkerDismissFollowup, CmdWorkerRetryFollowup, CmdWorkerFollowupMessage)
}

// Followups is the feature's state: followups.get's and followups.set's
// ack, World.Followups, and flat in followups.update.
type Followups = followup.View

// Followup is a worker's open questions (Worker.Followup).
type Followup = followup.Followup

// FollowupQuestion is one of them.
type FollowupQuestion = followup.Question

// FollowupRecommendation is the agent's proposed answer to one (#60).
type FollowupRecommendation = followup.Recommendation

// FollowupsTestResult is followups.test's ack.
type FollowupsTestResult = followup.TestResult

// Feature states (Followups.State).
const (
	FollowupsOff        = followup.StateOff
	FollowupsIncomplete = followup.StateIncomplete
	FollowupsReady      = followup.StateReady
)

// Question kinds and sources.
const (
	FollowupYesNo    = followup.KindYesNo
	FollowupChoice   = followup.KindChoice
	FollowupOpen     = followup.KindOpen
	FollowupModel    = followup.SourceModel
	FollowupFallback = followup.SourceFallback
	FollowupParsed   = followup.SourceParsed
)

// FollowupsSetArgs are the args of followups.set (a field left out is kept).
type FollowupsSetArgs struct {
	Enabled   *bool    `json:"enabled,omitempty"`
	Threshold *float64 `json:"threshold,omitempty"`
}

// FollowupsTestArgs are the args of followups.test (threshold: the one to
// test with, default the current one).
type FollowupsTestArgs struct {
	Threshold *float64 `json:"threshold,omitempty"`
}

// MaxFollowupAnswer bounds one answer's value and its note, and the round's
// note, in bytes (#60: a recommendation's bound, so an accepted one is copied
// whole; a longer one is cut and never offered to accept).
const MaxFollowupAnswer = followup.MaxRecommendationLen

// FollowupAnswer answers one question: value is the answer (yes_no: "Yes" or
// "No"; choice: an option or the typed Other; open: the text), note an
// optional free-text note after it.
type FollowupAnswer struct {
	ID    string `json:"id"`
	Value string `json:"value"`
	Note  string `json:"note,omitempty"`
}

// WorkerAnswerFollowupArgs are the args of worker.answer_followup.
type WorkerAnswerFollowupArgs struct {
	ID      string           `json:"id"`
	TurnID  string           `json:"turn_id"`
	Answers []FollowupAnswer `json:"answers"`
	// Note is free text after the answers (#60: a fallback's draft kept
	// when its questions were read on a retry).
	Note string `json:"note,omitempty"`
}

// WorkerDismissFollowupArgs are the args of worker.dismiss_followup.
type WorkerDismissFollowupArgs struct {
	ID     string `json:"id"`
	TurnID string `json:"turn_id"`
}

// WorkerRetryFollowupArgs are the args of worker.retry_followup (#60).
type WorkerRetryFollowupArgs struct {
	ID     string `json:"id"`
	TurnID string `json:"turn_id"`
}

// WorkerRetryFollowupResult is worker.retry_followup's ack: the new source,
// and why it fell back again.
type WorkerRetryFollowupResult struct {
	Source string `json:"source"`
	Error  string `json:"error,omitempty"`
}

// WorkerFollowupMessageArgs are the args of worker.followup_message (#60).
type WorkerFollowupMessageArgs struct {
	ID     string `json:"id"`
	TurnID string `json:"turn_id"`
}

// WorkerFollowupMessageResult is worker.followup_message's ack: the message
// the questions are of (its last MaxMessageChars characters: cut says it is
// longer).
type WorkerFollowupMessageResult struct {
	Text string `json:"text"`
	Cut  bool   `json:"cut,omitempty"`
}

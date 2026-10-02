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
)

func init() {
	Commands = append(Commands, CmdFollowupsGet, CmdFollowupsSet, CmdFollowupsTest, CmdWorkerAnswerFollowup,
		CmdWorkerDismissFollowup)
}

// Followups is the feature's state: followups.get's and followups.set's
// ack, World.Followups, and flat in followups.update.
type Followups = followup.View

// Followup is a worker's open questions (Worker.Followup).
type Followup = followup.Followup

// FollowupQuestion is one of them.
type FollowupQuestion = followup.Question

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

// MaxFollowupAnswer bounds one answer's value and its note, in bytes.
const MaxFollowupAnswer = 4000

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
}

// WorkerDismissFollowupArgs are the args of worker.dismiss_followup.
type WorkerDismissFollowupArgs struct {
	ID     string `json:"id"`
	TurnID string `json:"turn_id"`
}

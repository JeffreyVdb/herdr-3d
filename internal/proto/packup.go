package proto

import "github.com/JeffreyVdb/herdr-3d/internal/packup"

// #110 pack up on request (docs/protocol.md "Pack up on request"): before a
// prompt goes out, the game asks packup.detect whether it also tells the
// worker to leave once the task is done; the AI integration's classifier and
// LLM (#92) say so and what to cut, once the feature is switched on. The
// settings are in the snapshot (World.Packup) and every change is a
// packup.update event (PackupUpdate: the fields of Packup flat in it).

// EvPackupUpdate carries the feature's settings and state.
const EvPackupUpdate = "packup.update"

// Commands of pack up on request.
const (
	CmdPackupGet    = "packup.get"
	CmdPackupSet    = "packup.set"
	CmdPackupTest   = "packup.test"
	CmdPackupDetect = "packup.detect"
)

func init() {
	Commands = append(Commands, CmdPackupGet, CmdPackupSet, CmdPackupTest, CmdPackupDetect)
}

// Packup is the feature's state: packup.get's and packup.set's ack,
// World.Packup, and flat in packup.update.
type Packup = packup.View

// PackupUpdate is the packup.update event. It is not an Event: the fields
// of Packup would collide with Followups' flat in it.
type PackupUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	Packup
}

// PackupTestResult is packup.test's ack.
type PackupTestResult = packup.TestResult

// PackupRange is a part packup.detect cut: UTF-16 code units of the text.
type PackupRange = packup.Range

// Feature states (Packup.State).
const (
	PackupOff        = packup.StateOff
	PackupIncomplete = packup.StateIncomplete
	PackupReady      = packup.StateReady
)

// PackupSetArgs are the args of packup.set (a field left out is kept).
type PackupSetArgs struct {
	Enabled   *bool    `json:"enabled,omitempty"`
	Threshold *float64 `json:"threshold,omitempty"`
}

// PackupTestArgs are the args of packup.test (threshold: the one to test
// with, default the current one).
type PackupTestArgs struct {
	Threshold *float64 `json:"threshold,omitempty"`
}

// PackupDetectArgs are the args of packup.detect: the worker the prompt is
// for, and the prompt as worker.prompt would send it.
type PackupDetectArgs struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	// Secrets (#108 round 2, optional): the review of Text's possible
	// secrets, before the language model reads it.
	Secrets *SecretsReview `json:"secrets,omitempty"`
}

// PackupDetectResult is packup.detect's ack. Matched false: send the prompt
// as written (also on any failure, a timeout, the feature off). Matched:
// Task is what is left once the leaving part is cut ("" or left out:
// nothing, open the send-home dialog), Removed the parts cut.
type PackupDetectResult struct {
	Matched bool          `json:"matched"`
	Task    string        `json:"task,omitempty"`
	Removed []PackupRange `json:"removed,omitempty"`
	Score   float64       `json:"score"`
	// #108 round 2: Sent is the text the model read (references in place of
	// the protected secrets; absent: as typed): Removed indexes it, and it
	// (or Task) is what worker.prompt sends next, with SecretsPending (the
	// reviewed text needs no review again; the files become the worker's).
	// Protected: how many ranges went to files.
	Sent           string `json:"sent,omitempty"`
	Protected      int    `json:"protected,omitempty"`
	SecretsPending string `json:"secrets_pending,omitempty"`
}

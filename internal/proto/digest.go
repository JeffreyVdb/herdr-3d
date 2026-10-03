package proto

import "github.com/JeffreyVdb/herdr-3d/internal/digest"

// #118 phase 2 floor overview summaries (docs/protocol.md "Floor overview
// summaries"): the configured LLM (#92) writes the overview's task and now
// lines (Worker.Digest with source DigestLLM), once the feature is switched
// on. The settings are in the snapshot (World.Digest) and every change is a
// digest.update event (DigestUpdate: the fields of DigestState flat in it).

// EvDigestUpdate carries the feature's settings and state.
const EvDigestUpdate = "digest.update"

// Commands of the floor overview summaries.
const (
	CmdDigestGet  = "digest.get"
	CmdDigestSet  = "digest.set"
	CmdDigestTest = "digest.test"
)

func init() { Commands = append(Commands, CmdDigestGet, CmdDigestSet, CmdDigestTest) }

// DigestState is the feature's settings and state: digest.get's and
// digest.set's ack, World.Digest, and flat in digest.update.
type DigestState = digest.View

// Feature states (DigestState.State).
const (
	DigestOff        = digest.StateOff
	DigestIncomplete = digest.StateIncomplete
	DigestReady      = digest.StateReady
)

// DigestUpdate is the digest.update event. It is not an Event: the fields
// of DigestState would collide with the other flat ones.
type DigestUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	DigestState
}

// DigestSetArgs are the args of digest.set (a field left out is kept).
type DigestSetArgs struct {
	Enabled  *bool `json:"enabled,omitempty"`
	DailyCap *int  `json:"daily_cap,omitempty"`
}

// DigestTestResult is digest.test's ack.
type DigestTestResult = digest.TestResult

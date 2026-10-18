package proto

import "github.com/JeffreyVdb/herdr-3d/internal/hireintent"

// #211 (phase 2 of #209) dictated hiring (docs/protocol.md "Hire
// interpretation"): hire.interpret reads one dictated sentence with the AI
// integration's LLM (#92) and answers a hire proposal for review, or that it
// is not a hire. It never hires and the bridge keeps nothing: a follow-up
// reply sends the pending proposal back with it.

// CmdHireInterpret interprets a dictated sentence.
const CmdHireInterpret = "hire.interpret"

func init() { Commands = append(Commands, CmdHireInterpret) }

// HireInterpretArgs are the args of hire.interpret: the sentence, and the
// proposal it replies to (left out: a new request), as the last
// hire.interpret answered it. The proposal is checked again against its own
// sources and the bridge's current catalog; the catalog is never the
// client's.
type HireInterpretArgs struct {
	Text    string              `json:"text"`
	Pending *HireInterpretation `json:"pending,omitempty"`
	// #108 round 2 (optional): the review of Text's possible secrets, and
	// the last answer's secrets_pending (with Pending: its sources need no
	// review again, and new files join its own).
	Secrets        *SecretsReview `json:"secrets,omitempty"`
	SecretsPending string         `json:"secrets_pending,omitempty"`
}

// HireInterpretResult is hire.interpret's ack: the intent, the proposal of a
// hire, or the operational error (error: no intent, no proposal, the text
// kept). A failure of the model is never an error of the command. #108
// round 2: Text is the sentence the model read (references in place of the
// protected secrets); Protected how many ranges went to files;
// SecretsPending, with a review, what the follow-up (the next
// hire.interpret, the worker.hire of its task) sends back.
type HireInterpretResult struct {
	hireintent.Result
	Protected      int    `json:"protected,omitempty"`
	SecretsPending string `json:"secrets_pending,omitempty"`
}

// HireInterpretation is a hire proposal: its sources, harness, model,
// effort and task with their provenance, the questions to ask, and whether
// it is ready for review (never a launch).
type HireInterpretation = hireintent.Interpretation

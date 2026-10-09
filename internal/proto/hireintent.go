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
}

// HireInterpretResult is hire.interpret's ack: the intent, the proposal of a
// hire, or the operational error (error: no intent, no proposal, the text
// kept). A failure of the model is never an error of the command.
type HireInterpretResult = hireintent.Result

// HireInterpretation is a hire proposal: its sources, harness, model,
// effort and task with their provenance, the questions to ask, and whether
// it is ready for review (never a launch).
type HireInterpretation = hireintent.Interpretation

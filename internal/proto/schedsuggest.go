package proto

import "github.com/JeffreyVdb/herdr-3d/internal/schedsuggest"

// #66 schedule suggestions (docs/protocol.md "Schedule suggestions"): when
// an agent's final message says a step must wait ("24h soak, until about
// 10:45 UTC tomorrow"), the AI integration's classifier and LLM (#92) draft a
// schedule (#62) once the feature is switched on. The settings are in the
// snapshot (World.ScheduleSuggestions) and every change is a
// schedule_suggestions.update event (ScheduleSuggestionsUpdate: the fields
// of ScheduleSuggestions flat in it); a worker's suggestion is
// Worker.ScheduleSuggestion. Nothing is scheduled without a schedule.create.

// EvScheduleSuggestionsUpdate carries the feature's settings and state.
const EvScheduleSuggestionsUpdate = "schedule_suggestions.update"

// Commands of the schedule suggestions.
const (
	CmdScheduleSuggestionsGet = "schedule_suggestions.get"
	CmdScheduleSuggestionsSet = "schedule_suggestions.set"
	// CmdScheduleSuggestionsZone stores the user's time zone (the game's,
	// on connect and when it changes): the extraction reads clock times in
	// it.
	CmdScheduleSuggestionsZone         = "schedule_suggestions.zone"
	CmdWorkerDismissScheduleSuggestion = "worker.dismiss_schedule_suggestion"
)

func init() {
	Commands = append(Commands, CmdScheduleSuggestionsGet, CmdScheduleSuggestionsSet, CmdScheduleSuggestionsZone,
		CmdWorkerDismissScheduleSuggestion)
}

// ScheduleSuggestions is the feature's state: schedule_suggestions.get's,
// .set's and .zone's ack, World.ScheduleSuggestions, and flat in
// schedule_suggestions.update.
type ScheduleSuggestions = schedsuggest.View

// ScheduleSuggestionsUpdate is the schedule_suggestions.update event. It is
// not an Event: the fields of ScheduleSuggestions would collide with
// Followups' flat in it.
type ScheduleSuggestionsUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	ScheduleSuggestions
}

// ScheduleSuggestion is a worker's suggested schedule
// (Worker.ScheduleSuggestion).
type ScheduleSuggestion = schedsuggest.Suggestion

// Feature states (ScheduleSuggestions.State).
const (
	ScheduleSuggestionsOff        = schedsuggest.StateOff
	ScheduleSuggestionsIncomplete = schedsuggest.StateIncomplete
	ScheduleSuggestionsReady      = schedsuggest.StateReady
)

// ScheduleSuggestionsSetArgs are the args of schedule_suggestions.set (a
// field left out is kept).
type ScheduleSuggestionsSetArgs struct {
	Enabled   *bool    `json:"enabled,omitempty"`
	Threshold *float64 `json:"threshold,omitempty"`
}

// ScheduleSuggestionsZoneArgs are the args of schedule_suggestions.zone: an
// IANA time zone name the bridge's time package knows (not "Local").
type ScheduleSuggestionsZoneArgs struct {
	Zone string `json:"zone"`
}

// WorkerDismissScheduleSuggestionArgs are the args of
// worker.dismiss_schedule_suggestion: the worker and its suggestion's id.
type WorkerDismissScheduleSuggestionArgs struct {
	ID         string `json:"id"`
	Suggestion string `json:"suggestion"`
}

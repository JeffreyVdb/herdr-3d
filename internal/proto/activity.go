package proto

import "github.com/JeffreyVdb/herdr-3d/internal/activity"

// #98 activity (docs/protocol.md "Activity"): what a worker's agent is doing
// right now, Worker.Activity, in one word from its tool calls (the rules)
// and, opt-in, the classification model for the commands the rules cannot
// place ("Classify unknown commands"). Changes of a worker's activity are
// worker.activity events; the feature's settings are in the snapshot
// (World.Activity) and every change of them is an activity.update event
// (ActivityUpdate: the fields of ActivityState flat in it).

// Events of the activity.
const (
	EvWorkerActivity = "worker.activity"
	EvActivityUpdate = "activity.update"
)

// Commands of the activity.
const (
	CmdActivityGet = "activity.get"
	CmdActivitySet = "activity.set"
)

func init() { Commands = append(Commands, CmdActivityGet, CmdActivitySet) }

// Activity is what a worker's agent is doing (Worker.Activity).
type Activity = activity.Activity

// ActivityImage is the image an Activity of kind image shows.
type ActivityImage = activity.Image

// ActivityKind is an Activity's kind.
type ActivityKind = activity.Kind

// ActivityState is the feature's settings and state: activity.get's and
// activity.set's ack, World.Activity, and flat in activity.update.
type ActivityState = activity.State

// The feature's states (ActivityState.State).
const (
	ActivityOff        = activity.StateOff
	ActivityIncomplete = activity.StateIncomplete
	ActivityReady      = activity.StateReady
	ActivityCapped     = activity.StateCapped
)

// ActivityUpdate is the activity.update event. It is not an Event: the
// fields of ActivityState would collide with the other flat ones of Event
// (threshold, state, env).
type ActivityUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	ActivityState
}

// ActivitySetArgs are the args of activity.set (a field left out is kept).
type ActivitySetArgs struct {
	ModelEnabled *bool    `json:"model_enabled,omitempty"`
	Threshold    *float64 `json:"threshold,omitempty"`
	Margin       *float64 `json:"margin,omitempty"`
	DailyCap     *int     `json:"daily_cap,omitempty"`
}

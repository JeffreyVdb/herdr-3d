package proto

import "github.com/JeffreyVdb/herdr-3d/internal/notify"

// #11 notifications (docs/protocol.md "Notifications"): the bridge sends a
// message to your phone (Telegram) when a worker needs you or finishes. The
// settings and the channel's state are in the snapshot (World.Notify) and
// every change is a notify.update event (NotifyUpdate: the fields of
// NotifyState flat in it). No bot token is ever in either: only key_set and
// a four-character hint.

// EvNotifyUpdate carries the feature's settings and state.
const EvNotifyUpdate = "notify.update"

// Commands of the notifications. Each acks with the NotifyState after it
// (notify.test with NotifyTestResult).
const (
	CmdNotifyGet = "notify.get"
	CmdNotifySet = "notify.set"
	// CmdNotifyTest sends the test message to the paired person.
	CmdNotifyTest = "notify.test"
	// CmdNotifyTokenSet checks a bot token with the provider and saves it;
	// CmdNotifyTokenClear forgets it (and the paired person).
	CmdNotifyTokenSet   = "notify.token.set"
	CmdNotifyTokenClear = "notify.token.clear"
	// CmdNotifyPairStart shows a one-time code to send to the bot;
	// CmdNotifyPairCancel stops waiting for it; CmdNotifyUnpair forgets the
	// paired person.
	CmdNotifyPairStart  = "notify.pair.start"
	CmdNotifyPairCancel = "notify.pair.cancel"
	CmdNotifyUnpair     = "notify.unpair"
)

func init() {
	Commands = append(Commands, CmdNotifyGet, CmdNotifySet, CmdNotifyTest, CmdNotifyTokenSet, CmdNotifyTokenClear,
		CmdNotifyPairStart, CmdNotifyPairCancel, CmdNotifyUnpair)
}

// NotifyState is the feature's settings and state: the acks, World.Notify,
// and flat in notify.update.
type NotifyState = notify.View

// Feature states (NotifyState.State).
const (
	NotifyOff        = notify.StateOff
	NotifyIncomplete = notify.StateIncomplete
	NotifyReady      = notify.StateReady
	NotifyBlocked    = notify.StateBlocked
)

// NotifyUpdate is the notify.update event. It is not an Event: the fields
// of NotifyState would collide with the other flat ones.
type NotifyUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	NotifyState
}

// NotifyEventsArgs are notify.set's events (a field left out is kept).
type NotifyEventsArgs struct {
	NeedsYou *bool `json:"needs_you,omitempty"`
	Done     *bool `json:"done,omitempty"`
}

// NotifySetArgs are the args of notify.set (a field left out is kept).
type NotifySetArgs struct {
	Enabled     *bool             `json:"enabled,omitempty"`
	Events      *NotifyEventsArgs `json:"events,omitempty"`
	Quiet       *bool             `json:"quiet,omitempty"`
	Freelancers *bool             `json:"freelancers,omitempty"`
	// Replies (#13): a reply to a notification is typed into its worker.
	Replies *bool `json:"replies,omitempty"`
}

// NotifyTokenSetArgs are the args of notify.token.set: the bot token
// @BotFather gave (never logged, never sent back).
type NotifyTokenSetArgs struct {
	Key string `json:"key"`
}

// NotifyTestResult is notify.test's ack.
type NotifyTestResult = notify.TestResult

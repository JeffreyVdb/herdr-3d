package proto

// #62 scheduled agents (docs/protocol.md "Scheduled agents"): a one-shot
// hire at a wall-clock time. The bridge stores the schedule and, once it is
// due, hires a fresh worker with its prompt on its floor, with no client
// connected. Every schedule in view is in the snapshot (World.Schedules);
// each change is a schedule.upsert (Schedule), and one that leaves the view
// (cancelled, dismissed, a done one pruned) a schedule.removed (ID, FloorID).

// Commands and events of the feature.
const (
	CmdScheduleCreate  = "schedule.create"
	CmdScheduleUpdate  = "schedule.update"
	CmdScheduleCancel  = "schedule.cancel"
	CmdScheduleRunNow  = "schedule.run_now"
	CmdScheduleRetry   = "schedule.retry"
	CmdScheduleDismiss = "schedule.dismiss"
	EvScheduleUpsert   = "schedule.upsert"
	EvScheduleRemoved  = "schedule.removed"
)

func init() {
	Commands = append(Commands, CmdScheduleCreate, CmdScheduleUpdate, CmdScheduleCancel, CmdScheduleRunNow, CmdScheduleRetry,
		CmdScheduleDismiss)
}

// Schedule states (Schedule.State): scheduled → waiting → running → done,
// failed, skipped or cancelled.
const (
	ScheduleScheduled = "scheduled" // not due yet
	ScheduleWaiting   = "waiting"   // due, its fire waits (its floor wakes, or is not seen yet; no free desk)
	ScheduleRunning   = "running"   // its hire is in flight
	ScheduleDone      = "done"      // hired: WorkerID, FiredAt
	ScheduleFailed    = "failed"    // its fire failed: StateReason (needs attention)
	ScheduleSkipped   = "skipped"   // missed and its policy skipped it: StateReason (needs attention)
	ScheduleCancelled = "cancelled" // never in view: schedule.removed
)

// What a schedule missed by more than the grace does (Schedule.OnMiss).
const (
	ScheduleRunLate = "run_late"
	ScheduleSkip    = "skip"
)

// Where a schedule comes from (ScheduleSource.Kind).
const (
	ScheduleFromManual     = "manual"
	ScheduleFromTranscript = "transcript"
	ScheduleFromSuggestion = "suggestion"
)

// Limits of a schedule.
const (
	ScheduleMaxTitle = 200 // bytes
	// ScheduleKeepDone is how many done schedules a floor keeps.
	ScheduleKeepDone = 50
)

// ScheduleSource is where a schedule comes from: by hand, a transcript row
// or a suggestion, with the source worker and message when known.
type ScheduleSource struct {
	Kind    string `json:"kind"`
	Worker  string `json:"worker,omitempty"`
	Message string `json:"message,omitempty"`
}

// ScheduleSpec is what a schedule fires: schedule.create's and
// schedule.update's args (with ID on update).
type ScheduleSpec struct {
	Floor string `json:"floor"`
	Title string `json:"title"`
	// Prompt is the worker's first prompt (at most herdr.MaxPrompt bytes);
	// it may be empty only with a HandoffPath.
	Prompt string `json:"prompt"`
	// DueAt is when it fires (unix ms, UTC); in the future on create and
	// update.
	DueAt int64 `json:"due_at"`
	// OnMiss is what a schedule first seen due more than the grace late
	// does (default run_late); MaxLatenessMS, with run_late, skips it when
	// it is later than that (null: no limit).
	OnMiss        string `json:"on_miss,omitempty"`
	MaxLatenessMS *int64 `json:"max_lateness_ms,omitempty"`
	Harness       string `json:"harness"`
	Model         string `json:"model"`
	Effort        string `json:"effort"`
	// Cwd is the absolute directory the worker works in (a worktree hire's
	// repository); it is never replaced by another one.
	Cwd      string `json:"cwd"`
	Worktree bool   `json:"worktree,omitempty"`
	// WakeFloor wakes the floor if it is asleep when the schedule fires
	// (default true).
	WakeFloor *bool `json:"wake_floor,omitempty"`
	// HandoffPath is a handoff the worker is told to read (absolute).
	HandoffPath string `json:"handoff_path,omitempty"`
	// Source is set on create only (absent: manual).
	Source *ScheduleSource `json:"source,omitempty"`
	// Secrets (#108 round 2, optional): the review of Prompt's possible
	// secrets; a stored prompt's decisions all ignore.
	Secrets *SecretsReview `json:"secrets,omitempty"`
}

// ScheduleCreateArgs are the args of schedule.create.
type ScheduleCreateArgs = ScheduleSpec

// ScheduleUpdateArgs are the args of schedule.update: the whole spec,
// replaced (its floor and source stay).
type ScheduleUpdateArgs struct {
	ID string `json:"id"`
	ScheduleSpec
}

// ScheduleArgs are the args of schedule.cancel, schedule.run_now,
// schedule.retry and schedule.dismiss.
type ScheduleArgs struct {
	ID string `json:"id"`
}

// Schedule is one schedule as clients see it: every schedule.* command's
// ack, World.Schedules and schedule.upsert's.
type Schedule struct {
	ID            string         `json:"id"`
	Floor         string         `json:"floor"`
	Title         string         `json:"title"`
	Prompt        string         `json:"prompt"`
	DueAt         int64          `json:"due_at"`
	OnMiss        string         `json:"on_miss"`
	MaxLatenessMS *int64         `json:"max_lateness_ms,omitempty"`
	Harness       string         `json:"harness"`
	Model         string         `json:"model"`
	Effort        string         `json:"effort"`
	Cwd           string         `json:"cwd"`
	Worktree      bool           `json:"worktree"`
	WakeFloor     bool           `json:"wake_floor"`
	HandoffPath   string         `json:"handoff_path,omitempty"`
	Source        ScheduleSource `json:"source"`
	State         string         `json:"state"`
	// StateReason says why it is waiting, failed or skipped, naming the
	// flag or path.
	StateReason string `json:"state_reason,omitempty"`
	// FiredAt is when its hire began (unix ms), WorkerID the worker it
	// hired.
	FiredAt     *int64 `json:"fired_at,omitempty"`
	WorkerID    string `json:"worker_id,omitempty"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedAt   int64  `json:"updated_at"`
	DismissedAt *int64 `json:"dismissed_at,omitempty"`
}

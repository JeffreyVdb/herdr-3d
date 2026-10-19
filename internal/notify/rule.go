package notify

import (
	"regexp"
	"strings"
)

// The inbox rule (#100) on the bridge: the game's WorldStore.workerView
// display, inboxReason and inboxQueue's candidates, ported field for field
// (game/src/world/store.ts, crew.ts, inbox.ts, activity.ts, codexQuestions.ts,
// derive.ts). Both sides are pinned by one vector file,
// internal/notify/testdata/inbox_vectors.json (written by internal/server's
// TestNotifyInboxVectors, read by game/src/world/notifyVectors.test.ts). The
// read and dismissed state of the inbox is the browser's: the bridge never
// sees it.

// Displays the rule tells apart (the game's Display).
const (
	DisplayNeedsYou = "needs_you"
	DisplayDone     = "done"
	DisplayWaiting  = "waiting"
	DisplayWorking  = "working"
	DisplayIdle     = "idle"
	DisplayAsleep   = "asleep"
)

// Reasons, as the inbox row (and a notification) says them (inboxReason).
const (
	ReasonNeedsYou = "Needs you"
	ReasonQuestion = "Question"
	ReasonFollowup = "Follow-up"
	ReasonWrapUp   = "Wrap-up stuck"
	ReasonReport   = "Report request"
	ReasonFinished = "Finished"
)

// Worker is what the rule reads of a worker: the protocol's fields, copied
// as they are (the server maps a proto.Worker; nothing is interpreted there).
type Worker struct {
	ID          string
	Status      string
	StatusSince int64 // unix ms
	// Asleep: the worker's floor sleeps.
	Asleep bool
	// Role and Label: the crew role is Role (lowercased), else the label's
	// ORCH|/CODE|/… prefix when Role is empty.
	Role, Label string
	// An orchestrator's review passes (OverCap, Pass, Phase).
	OverCap bool
	Pass    *int
	Phase   string
	Report  *Report
	Ask     *Ask
	// Followup is the open follow-up questions (nil: none).
	Followup *Followup
	// WrapUpState is the wrap-up's state ("": none); WrapUpArmedAt when it
	// was armed, unix ms (H3D-1: which wrap-up it is).
	WrapUpState   string
	WrapUpArmedAt int64
	// CodexShared and CodexAsyncBlocked: a shared Codex worker whose blocked
	// is only an async question's (#157).
	CodexShared, CodexAsyncBlocked bool
	// ActivityKind is the activity's kind ("": none).
	ActivityKind string
	// Menu is the permission or folder-trust menu a blocked worker's screen
	// shows (#88: its card; nil: none).
	Menu *Menu
}

// Report is a freelancer's report.
type Report struct {
	State string
	// InputRequired is the request (nil: none).
	InputRequired *string
	// Resolved: the report carries an input_resolved.
	Resolved bool
	// Request is InputRequired as a notification may show it (H3D-1:
	// scrubbed by the bridge, trimmed, marked when it was cut).
	Request string
}

// Ask is the agent's structured question.
type Ask struct {
	ToolUseID string
	// Questions: one per question, whether it has an options list (a JSON
	// array: nil marshals to null, which the game does not accept).
	Questions []AskQuestion
	Since     int64 // unix ms
}

// AskQuestion is one question of an ask.
type AskQuestion struct {
	HasOptions bool
	// Secret: its answer is masked (no question text may leave the bridge).
	Secret bool
	// #14: what its card shows. The bridge leaves them empty for every
	// question of an ask with a secret one: none of its text goes out.
	Header, Question string
	Multi, Other     bool
	Options          []AskOption
}

// AskOption is one suggested answer of an ask's question (#14).
type AskOption struct {
	Label, Description, Preview string
}

// Followup is the follow-up questions of a final message.
type Followup struct {
	TurnID    string
	Questions []FollowupQuestion
	At        int64 // unix ms
	// Tail is the end of the message, a fallback's (#14: its card shows it).
	Tail string
}

// FollowupQuestion is one follow-up question.
type FollowupQuestion struct {
	ID, Question, Kind string
	Options            int
	// #14: what its card shows: the message's label for it, a choice's
	// options, the rest the message says of it, the agent's recommendation.
	Label, Context, Recommendation string
	Choices                        []string
}

// Menu is a blocked worker's screen menu (#88), as the bridge lets it go:
// its choices' labels, scrubbed, and (#106) what it is about, redacted and
// bounded by the bridge; never the screen's lines as they are.
type Menu struct {
	// Hash is the question's (worker.answer's): a new one for each menu and
	// each time the worker is blocked again.
	Hash string
	// Kind is "permission" or "trust".
	Kind    string
	Choices []MenuChoice
	// #106: Op names the operation it asks about through redraws, a rewrap
	// and a hash that changed with them: one card while it stays the same
	// ("": the Hash does). Native names the agent's own pending call it is
	// for ("": not known); a menu whose Native changes from one to another
	// is another operation, though its Op stays.
	Op, Native string
	// Decision (H3D-1) names what it asks across blocked spells: its Op
	// without the spell ("": Op's identity, else Hash's). The episode a
	// notification is about; never a card's or an answer's key.
	Decision string
	// Source is where its identity is from ("native", "screen"), for the
	// diagnostics.
	Source string
	// About is what it is about as its card shows it: lines the bridge
	// redacted and bounded, what is cut or uncertain marked (none: the card
	// says to look in the game).
	About []string
}

// MenuChoice is one choice of a menu: its number on the screen and its
// label.
type MenuChoice struct {
	N     int
	Label string
	// Withheld: no button (#106: it would approve an operation the card
	// cannot show whole).
	Withheld bool
}

// Verdict is what the rule says of a worker.
type Verdict struct {
	Display string
	// Reason is inboxReason's: meaningful for needs_you and done.
	Reason string
	// Since is when the display's episode started, unix ms.
	Since int64
	// Role is the crew role ("": an employee).
	Role string
}

// Candidate reports whether the worker is in the inbox (and may notify):
// needing you, any role; done, unless it is a freelancer and freelancers
// are not listed.
func (v Verdict) Candidate(freelancers bool) bool {
	return v.Display == DisplayNeedsYou || (v.Display == DisplayDone && (freelancers || !isFreelancer(v.Role)))
}

var crewRoles = map[string]bool{"orch": true, "code": true, "review": true, "ux": true, "ground": true}

var labelRole = regexp.MustCompile(`^(ORCH|CODE|REVIEW|UX|GROUND)\|`)

// passCap is write-code's review-pass cap (crew.ts PASS_CAP).
const passCap = 3

// CrewRole is the worker's crew role (crew.ts crewRole).
func CrewRole(role, label string) string {
	if r := strings.ToLower(role); r != "" {
		if crewRoles[r] {
			return r
		}
		return ""
	}
	if m := labelRole.FindStringSubmatch(label); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

func isFreelancer(role string) bool { return role != "" && role != "orch" }

func overCap(w Worker) bool {
	if w.OverCap {
		return true
	}
	if w.Pass == nil {
		return false
	}
	return *w.Pass > passCap || (*w.Pass == passCap && w.Phase == "waiting_user")
}

// reportAsks is a freelancer's report request that still asks (crew.ts
// inputRequired): a ready report's trimmed input_required, unless resolved.
func reportAsks(r *Report) bool {
	if r == nil || r.State != "ready" || r.InputRequired == nil || strings.TrimSpace(*r.InputRequired) == "" {
		return false
	}
	return !r.Resolved
}

func validAsk(a *Ask) bool {
	if a == nil || a.ToolUseID == "" || len(a.Questions) == 0 {
		return false
	}
	for _, q := range a.Questions {
		if !q.HasOptions {
			return false
		}
	}
	return true
}

// validMenu: the worker is blocked on a menu it can be answered on, with
// 1-9 choices (worker.answer's).
func validMenu(w Worker) bool {
	m := w.Menu
	if w.Asleep || w.Status != "blocked" || m == nil || m.Hash == "" || len(m.Choices) == 0 || len(m.Choices) > 9 {
		return false
	}
	for _, c := range m.Choices {
		if c.N < 1 || c.N > 9 {
			return false
		}
	}
	return true
}

var followupKinds = map[string]bool{"yes_no": true, "choice": true, "open": true}

func validFollowup(f *Followup) bool {
	if f == nil || f.TurnID == "" || len(f.Questions) == 0 {
		return false
	}
	for _, q := range f.Questions {
		if q.ID == "" || !followupKinds[q.Kind] || (q.Kind == "choice" && q.Options == 0) {
			return false
		}
	}
	return true
}

// effectiveStatus is working for a shared Codex worker blocked only by an
// async question (codexQuestions.ts), else the status.
func effectiveStatus(w Worker) string {
	if w.Status == "blocked" && w.CodexShared && w.CodexAsyncBlocked {
		return "working"
	}
	return w.Status
}

// waiting: idle or done, waiting on its own background tasks (activity.ts
// isWaiting).
func waiting(w Worker) bool {
	return (w.Status == "idle" || w.Status == "done") && w.ActivityKind == "waiting"
}

func displayStatus(status string, asleep bool) string {
	if asleep {
		return DisplayAsleep
	}
	switch status {
	case "working":
		return DisplayWorking
	case "done":
		return DisplayDone
	case "blocked":
		return DisplayNeedsYou
	}
	return DisplayIdle
}

// Judge applies the rule to a worker.
func Judge(w Worker) Verdict {
	role := CrewRole(w.Role, w.Label)
	freelancer := isFreelancer(role)
	crewNeeds := (role == "orch" && overCap(w)) || (freelancer && reportAsks(w.Report))
	ask := !w.Asleep && validAsk(w.Ask)
	followup := !w.Asleep && !ask && validFollowup(w.Followup)
	wrapStuck := w.WrapUpState == "needs_you"
	v := Verdict{Role: role, Since: w.StatusSince}
	switch {
	case ask:
		v.Since = w.Ask.Since
	case followup:
		v.Since = w.Followup.At
	}
	switch {
	case (crewNeeds || ask || followup || wrapStuck) && !w.Asleep:
		v.Display = DisplayNeedsYou
	case !w.Asleep && waiting(w):
		v.Display = DisplayWaiting
	default:
		v.Display = displayStatus(effectiveStatus(w), w.Asleep)
	}
	switch {
	case v.Display == DisplayDone:
		v.Reason = ReasonFinished
	case validAsk(w.Ask):
		v.Reason = ReasonQuestion
	case validFollowup(w.Followup):
		v.Reason = ReasonFollowup
	case wrapStuck:
		v.Reason = ReasonWrapUp
	case freelancer && reportAsks(w.Report):
		v.Reason = ReasonReport
	default:
		v.Reason = ReasonNeedsYou
	}
	return v
}

// Secret reports whether any of the worker's ask questions is secret: then
// no question text goes into a notification.
func (w Worker) Secret() bool {
	if w.Ask == nil {
		return false
	}
	for _, q := range w.Ask.Questions {
		if q.Secret {
			return true
		}
	}
	return false
}

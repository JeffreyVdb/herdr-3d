package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/schedsuggest"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #66 schedule suggestions on the follow-up questions' bridge (followup_test.go):
// w1 is a Claude agent, w2 a Codex one; the classifier scores the follow-up
// gate by a "?" and the schedule gate by a "soak" in the message, the LLM
// answers each extraction by its system prompt.

const ssSoakText = "Vector 0.59 is rolled out on all 14 shippers.\n\n" +
	"Remaining: 24h soak, until about 10:45 UTC tomorrow. After the soak: delete the backups, attach the evidence to OPS-2291 and close it."

const ssSoakQuestionText = ssSoakText + "\n\nDo you want me to open the cleanup PR already?"

// ssRoles are fuRoles whose classifier and LLM also answer the schedule
// suggestion's gate and extraction; due is what the LLM suggests.
func ssRoles(due time.Time) *fuRoles {
	r := newFuRoles()
	r.cls.Func = func(_ context.Context, state map[string]any, q string) (float64, error) {
		msg := state["last_agent_message"].(string)
		switch q {
		case schedsuggest.GateQuestion:
			if strings.Contains(msg, "soak") {
				return 0.93, nil
			}
			return 0.04, nil
		default:
			if strings.Contains(msg, "?") {
				return 0.96, nil
			}
			return 0.02, nil
		}
	}
	r.llm.Text = ""
	r.llm.Func = func(_ context.Context, req ai.Request) (string, error) {
		if isScheduleExtraction(req) {
			b, _ := json.Marshal(map[string]string{"due_at": due.Format(time.RFC3339), "title": "Post-soak cleanup",
				"draft_prompt": "You are picking up after the soak. Read the attached handoff first, then delete the backups."})
			return string(b), nil
		}
		return fuExtracted, nil
	}
	return r
}

func isScheduleExtraction(req ai.Request) bool {
	return strings.Contains(req.Messages[0].Content, "draft the schedule")
}

// startSsBridge is the follow-up bridge with the schedule suggestions'
// environment toggle too (nil: the stored one).
func startSsBridge(t *testing.T, db, dir string, roles *fuRoles, fu, ss *bool) *fuBridge {
	t.Helper()
	return startFuBridgeWith(t, db, dir, roles, fu, "", func(o *server.Options) { o.ScheduleSuggestionsEnabled = ss })
}

// say appends a Claude turn ending in text, its message msgID, to w1's
// transcript.
func (fb *fuBridge) say(t *testing.T, msgID, text string) {
	t.Helper()
	appendTo(t, fb.claude, wrapUser("Roll it out.")+wrapSay(msgID, text, "end_turn")+wrapTurnEnd)
}

func suggestionOf(c *client, id string) *proto.Worker {
	c.t.Helper()
	return upsertFor(c, id, func(w *proto.Worker) bool { return w.ScheduleSuggestion != nil })
}

func off() *bool { v := false; return &v }

// classifyCalls splits the classifier's calls: single questions, and the
// ClassifyMany calls.
func classifyCalls(r *fuRoles) (single []string, many []map[string]string) {
	for _, c := range r.cls.Calls() {
		if c.Questions != nil {
			many = append(many, c.Questions)
		} else {
			single = append(single, c.Question)
		}
	}
	return single, many
}

func (fb *fuBridge) noSuggestions(t *testing.T) {
	t.Helper()
	for k, w := range workersOf(fb.world(func(proto.World) bool { return true }), "s") {
		if w.ScheduleSuggestion != nil {
			t.Fatalf("%s has a schedule suggestion: %+v", k, w.ScheduleSuggestion)
		}
	}
}

// Both features on: one ClassifyMany scores both gates of the message, the
// follow-up extraction runs before the schedule's, and the worker gets both:
// the suggestion names the message's row and is due when the LLM said, in
// UTC.
func TestScheduleSuggestionBothOneClassifyMany(t *testing.T) {
	t.Parallel()
	due := time.Now().Add(26 * time.Hour).Truncate(time.Second)
	roles := ssRoles(due.In(time.FixedZone("CEST", 2*3600)))
	fb := startSsBridge(t, "", "", roles, on(), on())
	c := fb.connect(proto.Hello{})
	if v := c.snapshot().World.ScheduleSuggestions; v == nil || v.State != proto.ScheduleSuggestionsReady || len(v.Env) != 1 {
		t.Fatalf("snapshot schedule_suggestions = %+v", v)
	}
	id := fb.ids["w1"]
	fb.say(t, "msg_ss1", ssSoakQuestionText)
	w := suggestionOf(c, id) // after the follow-up: the worker has both
	s := w.ScheduleSuggestion
	if s == nil || s.Message != "msg_ss1" || s.DueAt != due.UnixMilli() || s.Title != "Post-soak cleanup" || s.ID == "" || s.Score != 0.93 {
		t.Fatalf("suggestion = %+v", s)
	}
	if w.Followup == nil || len(w.Followup.Questions) != 2 {
		t.Fatalf("followup = %+v", w.Followup)
	}
	single, many := classifyCalls(roles)
	if len(single) != 0 || len(many) != 1 || len(many[0]) != 2 {
		t.Fatalf("classifier: %d single, many %v", len(single), many)
	}
	qs := []string{}
	for _, q := range many[0] {
		qs = append(qs, q)
	}
	if !strings.Contains(strings.Join(qs, "|"), followup.GateQuestion) || !strings.Contains(strings.Join(qs, "|"), schedsuggest.GateQuestion) {
		t.Fatalf("questions = %v", many[0])
	}
	if st := roles.cls.Calls()[0].State["last_agent_message"]; st != ssSoakQuestionText {
		t.Fatalf("state = %q", st)
	}
	llm := roles.llm.Calls()
	if len(llm) != 2 || isScheduleExtraction(llm[0]) || !isScheduleExtraction(llm[1]) {
		t.Fatalf("LLM calls: %d, the first the schedule's: %v", len(llm), len(llm) > 0 && isScheduleExtraction(llm[0]))
	}
	// Nothing was scheduled.
	if got := fb.world(func(proto.World) bool { return true }).Schedules; len(got) != 0 {
		t.Fatalf("schedules = %+v", got)
	}
}

// The schedule extraction stuck (or failing) never holds the follow-up
// questions back: they are shown while it waits; once it times out the
// worker gets no suggestion, and the message is not asked about again after
// a restart.
func TestScheduleSuggestionNeverDelaysFollowups(t *testing.T) {
	t.Parallel()
	roles := ssRoles(time.Now().Add(time.Hour))
	release := make(chan struct{})
	var once sync.Once
	inner := roles.llm.Func
	roles.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		if isScheduleExtraction(req) {
			<-release
			return "", &ai.Error{Kind: ai.KindTimeout, Msg: "the LLM did not answer in time"}
		}
		return inner(ctx, req)
	}
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	fb := startSsBridge(t, "", "", roles, on(), on())
	c := fb.connect(proto.Hello{})
	c.snapshot()
	id := fb.ids["w1"]
	fb.say(t, "msg_ss2", ssSoakQuestionText)
	w := followupOf(c, id)
	if w.ScheduleSuggestion != nil || len(roles.llm.Calls()) == 0 {
		t.Fatalf("followup shown with %+v", w.ScheduleSuggestion)
	}
	waitFor(t, "the schedule extraction to be asked", func() bool { return len(roles.llm.Calls()) == 2 })
	once.Do(func() { close(release) })
	fuQuiet()
	fb.noSuggestions(t)
	if fu := workersOf(fb.world(func(proto.World) bool { return true }), "s")["w1"].Followup; fu == nil {
		t.Fatal("the follow-up went with the schedule's failure")
	}
	fb.stop()

	fb2 := startSsBridge(t, fb.db, fb.dir, roles, on(), on())
	c2 := fb2.connect(proto.Hello{})
	c2.snapshot()
	followupOf(c2, fb2.ids["w1"])
	fuQuiet()
	if single, many := classifyCalls(roles); len(single)+len(many) != 1 || len(roles.llm.Calls()) != 2 {
		t.Fatalf("after a restart: %d single, %d many, %d LLM", len(single), len(many), len(roles.llm.Calls()))
	}
	fb2.noSuggestions(t)
}

// Follow-up questions alone: their own Classify, byte for byte; no
// ClassifyMany, no schedule extraction, no suggestion.
func TestScheduleSuggestionOffLeavesFollowups(t *testing.T) {
	t.Parallel()
	roles := ssRoles(time.Now().Add(time.Hour))
	fb := startSsBridge(t, "", "", roles, on(), nil)
	c := fb.connect(proto.Hello{})
	if v := c.snapshot().World.ScheduleSuggestions; v == nil || v.State != proto.ScheduleSuggestionsOff || v.Enabled {
		t.Fatalf("schedule_suggestions = %+v", v)
	}
	fb.say(t, "msg_ss3", ssSoakQuestionText)
	followupOf(c, fb.ids["w1"])
	single, many := classifyCalls(roles)
	if len(many) != 0 || len(single) != 1 || single[0] != followup.GateQuestion {
		t.Fatalf("classifier: single %v, many %v", single, many)
	}
	if llm := roles.llm.Calls(); len(llm) != 1 || isScheduleExtraction(llm[0]) {
		t.Fatalf("LLM calls = %d", len(llm))
	}
	fb.noSuggestions(t)
}

// Schedule suggestions alone: one Classify with their question, then the
// extraction; a message without a wait is classified and that is all.
func TestScheduleSuggestionAlone(t *testing.T) {
	t.Parallel()
	due := time.Now().Add(3 * time.Hour).Truncate(time.Second)
	roles := ssRoles(due)
	fb := startSsBridge(t, "", "", roles, nil, on())
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.say(t, "msg_a1", "All done, the PR is merged.")
	waitFor(t, "a classification", func() bool { return len(roles.cls.Calls()) == 1 })
	fuQuiet()
	fb.say(t, "msg_a2", ssSoakText)
	s := suggestionOf(c, fb.ids["w1"]).ScheduleSuggestion
	if s.Message != "msg_a2" || s.DueAt != due.UnixMilli() || !strings.Contains(s.DraftPrompt, "handoff") {
		t.Fatalf("suggestion = %+v", s)
	}
	single, many := classifyCalls(roles)
	if len(many) != 0 || len(single) != 2 || single[0] != schedsuggest.GateQuestion || single[1] != schedsuggest.GateQuestion {
		t.Fatalf("classifier: single %v, many %v", single, many)
	}
	if llm := roles.llm.Calls(); len(llm) != 1 || !isScheduleExtraction(llm[0]) {
		t.Fatalf("LLM calls = %d", len(llm))
	}
	if w := workersOf(fb.world(func(proto.World) bool { return true }), "s")["w1"]; w.Followup != nil {
		t.Fatalf("a follow-up while they are off: %+v", w.Followup)
	}
}

// Off, or a role not ready: no call at all on a turn end, and the state
// says which role is missing.
func TestScheduleSuggestionNotReadyMakesNoCall(t *testing.T) {
	t.Parallel()
	t.Run("off", func(t *testing.T) {
		roles := ssRoles(time.Now().Add(time.Hour))
		fb := startSsBridge(t, "", "", roles, nil, nil)
		c := fb.connect(proto.Hello{})
		if v := c.snapshot().World.ScheduleSuggestions; v.State != proto.ScheduleSuggestionsOff || v.Threshold != schedsuggest.DefaultThreshold {
			t.Fatalf("schedule_suggestions = %+v", v)
		}
		fb.say(t, "msg_o1", ssSoakQuestionText)
		fuQuiet()
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls while off: %d, %d", c, l)
		}
		fb.noSuggestions(t)
	})
	t.Run("llm missing", func(t *testing.T) {
		roles := ssRoles(time.Now().Add(time.Hour))
		roles.set(ai.RoleLLM, ai.StateOff)
		fb := startSsBridge(t, "", "", roles, nil, on())
		c := fb.connect(proto.Hello{})
		v := c.snapshot().World.ScheduleSuggestions
		if v.State != proto.ScheduleSuggestionsIncomplete || len(v.Missing) != 1 || v.Missing[0] != "llm" || v.Roles.LLM != "off" {
			t.Fatalf("schedule_suggestions = %+v", v)
		}
		fb.say(t, "msg_o2", ssSoakText)
		fuQuiet()
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls with the LLM missing: %d, %d", c, l)
		}
		fb.noSuggestions(t)
	})
}

// Accepting is saving: no schedule exists until schedule.create, a create
// from another source leaves the suggestion, and a create whose source
// names it closes it for good (also after a restart, with no new call).
func TestScheduleSuggestionAcceptedBySave(t *testing.T) {
	t.Parallel()
	due := time.Now().Add(26 * time.Hour).Truncate(time.Second)
	roles := ssRoles(due)
	fb := startSsBridge(t, "", "", roles, nil, on())
	c := fb.connect(proto.Hello{})
	c.snapshot()
	id := fb.ids["w1"]
	fb.say(t, "msg_acc", ssSoakText)
	s := suggestionOf(c, id).ScheduleSuggestion
	if got := fb.world(func(proto.World) bool { return true }).Schedules; len(got) != 0 {
		t.Fatalf("scheduled without a save: %+v", got)
	}
	sp := proto.ScheduleSpec{Floor: "s", Title: s.Title, Prompt: s.DraftPrompt, DueAt: s.DueAt, Harness: "codex", Model: "gpt-6-astra",
		Effort: "ultra", Cwd: "/home/u/repo"}
	// The plain "Schedule follow-up…" of the same row: the chip stays.
	plain := sp
	plain.Source = &proto.ScheduleSource{Kind: proto.ScheduleFromTranscript, Worker: id, Message: s.Message}
	evs, _ := c.mustAck(proto.CmdScheduleCreate, plain)
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.ScheduleSuggestion == nil {
			t.Fatal("a transcript schedule closed the suggestion")
		}
	}
	// Another message's suggestion source: stays too.
	other := sp
	other.Source = &proto.ScheduleSource{Kind: proto.ScheduleFromSuggestion, Worker: id, Message: "msg_other"}
	c.mustAck(proto.CmdScheduleCreate, other)
	if w := workersOf(fb.world(func(proto.World) bool { return true }), "s")["w1"]; w.ScheduleSuggestion == nil {
		t.Fatal("another message's create closed the suggestion")
	}
	mine := sp
	mine.Source = &proto.ScheduleSource{Kind: proto.ScheduleFromSuggestion, Worker: id, Message: s.Message}
	evs, m := c.command(proto.CmdScheduleCreate, "mine", mine)
	created := ackData[proto.Schedule](t, m)
	if created.Source.Kind != proto.ScheduleFromSuggestion || created.DueAt != due.UnixMilli() {
		t.Fatalf("created = %+v", created)
	}
	cleared := false
	for _, ev := range evs {
		cleared = cleared || (ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.ScheduleSuggestion == nil)
	}
	if !cleared {
		upsertFor(c, id, func(w *proto.Worker) bool { return w.ScheduleSuggestion == nil })
	}
	fb.stop()

	fb2 := startSsBridge(t, fb.db, fb.dir, roles, nil, on())
	fuQuiet()
	if c, l := roles.calls(); c != 1 || l != 1 {
		t.Fatalf("calls after a restart: %d, %d", c, l)
	}
	fb2.noSuggestions(t)
}

// Dismissing: a stale id is refused; the right one closes it, and a restart
// neither shows it again nor asks the models. An open one comes back after
// a restart, with no new call.
func TestScheduleSuggestionDismissAndRestart(t *testing.T) {
	t.Parallel()
	roles := ssRoles(time.Now().Add(5 * time.Hour).Truncate(time.Second))
	fb := startSsBridge(t, "", "", roles, nil, on())
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.say(t, "msg_dis", ssSoakText)
	s := suggestionOf(c, fb.ids["w1"]).ScheduleSuggestion
	fb.stop()

	// Open: restored as it was, not looked at again.
	fb2 := startSsBridge(t, fb.db, fb.dir, roles, nil, on())
	c2 := fb2.connect(proto.Hello{})
	c2.snapshot()
	id := fb2.ids["w1"]
	if got := suggestionOf(c2, id).ScheduleSuggestion; *got != *s {
		t.Fatalf("restored %+v, want %+v", got, s)
	}
	if c, l := roles.calls(); c != 1 || l != 1 {
		t.Fatalf("calls after a restart: %d, %d", c, l)
	}
	c2.mustError(proto.CmdWorkerDismissScheduleSuggestion, proto.WorkerDismissScheduleSuggestionArgs{ID: id, Suggestion: "0123456789abcdef"}, "stale")
	c2.mustError(proto.CmdWorkerDismissScheduleSuggestion, proto.WorkerDismissScheduleSuggestionArgs{ID: "nobody", Suggestion: s.ID}, "unknown_worker")
	evs, _ := c2.mustAck(proto.CmdWorkerDismissScheduleSuggestion, proto.WorkerDismissScheduleSuggestionArgs{ID: id, Suggestion: s.ID})
	cleared := false
	for _, ev := range evs {
		cleared = cleared || (ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.ScheduleSuggestion == nil)
	}
	if !cleared {
		upsertFor(c2, id, func(w *proto.Worker) bool { return w.ScheduleSuggestion == nil })
	}
	if row := auditRow(t, fb2.bridge, proto.CmdWorkerDismissScheduleSuggestion); !row.OK {
		t.Fatalf("audit = %+v", row)
	}
	fb2.stop()

	// Dismissed: never again.
	fb3 := startSsBridge(t, fb.db, fb.dir, roles, nil, on())
	fuQuiet()
	if c, l := roles.calls(); c != 1 || l != 1 {
		t.Fatalf("calls after the second restart: %d, %d", c, l)
	}
	fb3.noSuggestions(t)
}

// The transcript going on closes it: a new prompt (moved), or a newer turn
// in its place; the closed one never comes back.
func TestScheduleSuggestionTranscriptMovesOn(t *testing.T) {
	t.Parallel()
	roles := ssRoles(time.Now().Add(5 * time.Hour).Truncate(time.Second))
	fb := startSsBridge(t, "", "", roles, nil, on())
	c := fb.connect(proto.Hello{})
	c.snapshot()
	id := fb.ids["w1"]
	fb.say(t, "msg_m1", ssSoakText)
	suggestionOf(c, id)
	appendTo(t, fb.claude, wrapUser("Also bump the chart."))
	upsertFor(c, id, func(w *proto.Worker) bool { return w.ScheduleSuggestion == nil })
	// A newer turn's suggestion replaces it, on its own row.
	appendTo(t, fb.claude, wrapSay("msg_m2", ssSoakText+" (chart too)", "end_turn")+wrapTurnEnd)
	if s := suggestionOf(c, id).ScheduleSuggestion; s.Message != "msg_m2" {
		t.Fatalf("newer suggestion = %+v", s)
	}
	fb.say(t, "msg_m3", "Done with the chart.")
	upsertFor(c, id, func(w *proto.Worker) bool { return w.ScheduleSuggestion == nil })
	fb.stop()
	fb2 := startSsBridge(t, fb.db, fb.dir, roles, nil, on())
	fuQuiet()
	fb2.noSuggestions(t)
}

// A suggestion made after its turn was superseded (a prompt came while the
// LLM drafted it) is recorded, never shown.
func TestScheduleSuggestionStaleResult(t *testing.T) {
	t.Parallel()
	roles := ssRoles(time.Now().Add(5 * time.Hour))
	release, asked := make(chan struct{}), make(chan struct{}, 1)
	inner := roles.llm.Func
	roles.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		asked <- struct{}{}
		<-release
		return inner(ctx, req)
	}
	fb := startSsBridge(t, "", "", roles, nil, on())
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.say(t, "msg_st", ssSoakText)
	<-asked
	appendTo(t, fb.claude, wrapUser("Never mind, roll it back."))
	fuQuiet()
	close(release)
	fuQuiet()
	fb.noSuggestions(t)
	if c, l := roles.calls(); c != 1 || l != 1 {
		t.Fatalf("calls = %d, %d", c, l)
	}
}

// The settings: switched on without a test (both roles ready), the
// threshold bounded, the zone an IANA name; each change one
// schedule_suggestions.update. The environment's toggle is read-only.
func TestScheduleSuggestionsSettings(t *testing.T) {
	t.Parallel()
	roles := ssRoles(time.Now().Add(time.Hour))
	fb := startSsBridge(t, "", "", roles, nil, nil)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	_, m := c.command(proto.CmdScheduleSuggestionsSet, "set", proto.ScheduleSuggestionsSetArgs{Enabled: on(), Threshold: ptrF(0.8)})
	v := ackData[proto.ScheduleSuggestions](t, m)
	if v.State != proto.ScheduleSuggestionsReady || v.Threshold != 0.8 || !v.Enabled {
		t.Fatalf("after set = %+v", v)
	}
	c.mustError(proto.CmdScheduleSuggestionsSet, proto.ScheduleSuggestionsSetArgs{Threshold: ptrF(1.2)}, "bad_request")
	c.mustError(proto.CmdScheduleSuggestionsZone, proto.ScheduleSuggestionsZoneArgs{Zone: "Mars/Base"}, "bad_request")
	c.mustError(proto.CmdScheduleSuggestionsZone, proto.ScheduleSuggestionsZoneArgs{Zone: "Local"}, "bad_request")
	c.mustAck(proto.CmdScheduleSuggestionsZone, proto.ScheduleSuggestionsZoneArgs{Zone: "Europe/Brussels"})
	_, m = c.command(proto.CmdScheduleSuggestionsGet, "get", struct{}{})
	v = ackData[proto.ScheduleSuggestions](t, m)
	if v.Zone != "Europe/Brussels" || !v.Enabled {
		t.Fatalf("get = %+v", v)
	}
	// Each change was published, as its own event, to another client too.
	c2 := fb.connect(proto.Hello{})
	if w := c2.snapshot().World.ScheduleSuggestions; w.Zone != "Europe/Brussels" || w.Threshold != 0.8 {
		t.Fatalf("second client's snapshot = %+v", w)
	}
	c2.mustAck(proto.CmdScheduleSuggestionsZone, proto.ScheduleSuggestionsZoneArgs{Zone: "Asia/Tokyo"})
	ev := c.untilMsg(proto.EvScheduleSuggestionsUpdate)
	var up proto.ScheduleSuggestionsUpdate
	if err := json.Unmarshal(ev.raw, &up); err != nil || up.Zone != "Asia/Tokyo" || up.State != proto.ScheduleSuggestionsReady {
		t.Fatalf("update = %s", ev.raw)
	}
	// The extraction reads the zone.
	fb.say(t, "msg_z", ssSoakText)
	suggestionOf(c, fb.ids["w1"])
	if user := roles.llm.Calls()[0].Messages[1].Content; !strings.Contains(user, "The user's time zone: Asia/Tokyo") {
		t.Fatalf("request = %q", user)
	}
	fb.stop()

	envOn := startSsBridge(t, "", "", ssRoles(time.Now().Add(time.Hour)), nil, on())
	ce := envOn.connect(proto.Hello{})
	if w := ce.snapshot().World.ScheduleSuggestions; w.State != proto.ScheduleSuggestionsReady || len(w.Env) != 1 || w.Env[0] != "enabled" {
		t.Fatalf("env snapshot = %+v", w)
	}
	ce.mustError(proto.CmdScheduleSuggestionsSet, proto.ScheduleSuggestionsSetArgs{Enabled: off()}, "env_locked")
	envOff := startSsBridge(t, "", "", ssRoles(time.Now().Add(time.Hour)), nil, off())
	if w := envOff.connect(proto.Hello{}).snapshot().World.ScheduleSuggestions; w.State != proto.ScheduleSuggestionsOff || len(w.Env) != 1 {
		t.Fatalf("env off snapshot = %+v", w)
	}
	// Incomplete: refused with which.
	missing := ssRoles(time.Now().Add(time.Hour))
	missing.set(ai.RoleClassifier, ai.StateIncomplete)
	inc := startSsBridge(t, "", "", missing, nil, nil)
	inc.connect(proto.Hello{}).mustError(proto.CmdScheduleSuggestionsSet, proto.ScheduleSuggestionsSetArgs{Enabled: on()}, "incomplete")
}

func ptrF(v float64) *float64 { return &v }

// The suggestion's bounds are the schedule form's: a title and a prompt
// the package accepts are ones schedule.create accepts.
func TestScheduleSuggestBounds(t *testing.T) {
	t.Parallel()
	if schedsuggest.MaxTitle != proto.ScheduleMaxTitle || schedsuggest.MaxPrompt != herdr.MaxPrompt {
		t.Fatalf("bounds %d/%d, want %d/%d", schedsuggest.MaxTitle, schedsuggest.MaxPrompt, proto.ScheduleMaxTitle, herdr.MaxPrompt)
	}
}

package server

import (
	"encoding/json"
	"flag"
	"os"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

var updateNotifyVectors = flag.Bool("update-notify-vectors", false, "rewrite internal/notify/testdata/inbox_vectors.json")

// notifyVectorsPath is the file the game's vitest reads too
// (game/src/world/notifyVectors.test.ts).
const notifyVectorsPath = "../notify/testdata/inbox_vectors.json"

type notifyExpect struct {
	Display string `json:"display"`
	Reason  string `json:"reason"`
	Since   int64  `json:"since"`
	// Candidate is whether the worker is in the inbox, and so may notify,
	// with Settings' "include freelancers" off and on.
	Candidate      bool `json:"candidate"`
	CandidateWithF bool `json:"candidate_with_freelancers"`
}

type notifyVector struct {
	Name   string          `json:"name"`
	Asleep bool            `json:"asleep"`
	Worker json.RawMessage `json:"worker"`
	Expect notifyExpect    `json:"expect"`
}

type notifyVectorFile struct {
	Comment string         `json:"comment"`
	Vectors []notifyVector `json:"vectors"`
}

func ptr[T any](v T) *T { return &v }

// notifyVectorTable is the inbox rule's cases: a worker as the protocol
// carries it, its floor asleep or not, and what the game's
// WorldStore.workerView, inboxReason and inboxQueue say of it.
func notifyVectorTable() []struct {
	name   string
	asleep bool
	w      proto.Worker
	want   notifyExpect
} {
	const st = 1000 // status_since
	ask := func(since int64, opts bool) *proto.Ask {
		q := proto.AskQuestion{Header: "Pick", Question: "Which color?"}
		if opts {
			q.Options = []proto.AskOption{{Label: "Green"}, {Label: "Blue"}}
		}
		return &proto.Ask{ToolUseID: "toolu_1", Source: "transcript", Agent: "claude", Questions: []proto.AskQuestion{q}, Since: since}
	}
	fu := func(at int64, qs ...followup.Question) *proto.Followup {
		if len(qs) == 0 {
			qs = []followup.Question{{ID: "q1", Question: "Ship it?", Kind: "yes_no"}}
		}
		return &proto.Followup{TurnID: "turn-1", Questions: qs, Source: "model", At: at}
	}
	report := func(state, input string, resolved bool) *proto.RunReport {
		r := &proto.RunReport{State: state, InputRequired: &input}
		if resolved {
			r.InputResolved = &proto.InputResolved{By: "orchestrator", At: 5}
		}
		return r
	}
	waiting := &activity.Activity{Kind: activity.KindWaiting, Detail: "Testing in the background", Since: 900, Source: "rule"}
	shared := func(async bool) *proto.WorkerCodex {
		return &proto.WorkerCodex{Mode: proto.CodexModeShared, Server: "running", Attached: true, AsyncBlocked: async}
	}
	no := notifyExpect{}
	needs := func(reason string, since int64) notifyExpect {
		return notifyExpect{Display: notify.DisplayNeedsYou, Reason: reason, Since: since, Candidate: true, CandidateWithF: true}
	}
	done := notifyExpect{Display: notify.DisplayDone, Reason: notify.ReasonFinished, Since: st, Candidate: true, CandidateWithF: true}
	freelancerDone := done
	freelancerDone.Candidate = false
	show := func(display string) notifyExpect {
		e := no
		e.Display, e.Reason, e.Since = display, notify.ReasonNeedsYou, st
		return e
	}
	return []struct {
		name   string
		asleep bool
		w      proto.Worker
		want   notifyExpect
	}{
		{"working", false, proto.Worker{Status: "working"}, show(notify.DisplayWorking)},
		{"idle", false, proto.Worker{Status: "idle"}, show(notify.DisplayIdle)},
		{"unknown status is idle", false, proto.Worker{Status: "unknown"}, show(notify.DisplayIdle)},
		{"blocked needs you", false, proto.Worker{Status: "blocked"}, needs(notify.ReasonNeedsYou, st)},
		{"done employee", false, proto.Worker{Status: "done"}, done},
		{"done orchestrator", false, proto.Worker{Status: "done", Role: "orch"}, done},
		{"done coder (freelancer)", false, proto.Worker{Status: "done", Role: "code"}, freelancerDone},
		{"done reviewer, role in capitals", false, proto.Worker{Status: "done", Role: "Review"}, freelancerDone},
		{"done freelancer by its label", false, proto.Worker{Status: "done", Label: "CODE|h3d-11|r1"}, freelancerDone},
		{"an unknown role is no crew, whatever the label", false, proto.Worker{Status: "done", Role: "designer", Label: "CODE|x"}, done},
		{"ask while idle", false, proto.Worker{Status: "idle", Ask: ask(1500, true)}, needs(notify.ReasonQuestion, 1500)},
		{"ask while working", false, proto.Worker{Status: "working", Ask: ask(1500, true)}, needs(notify.ReasonQuestion, 1500)},
		{"ask without options is not an ask", false, proto.Worker{Status: "idle", Ask: ask(1500, false)}, show(notify.DisplayIdle)},
		{"ask without a tool use id is not an ask", false, proto.Worker{Status: "idle", Ask: &proto.Ask{Questions: ask(1, true).Questions, Since: 1500}}, show(notify.DisplayIdle)},
		{"ask with no question is not an ask", false, proto.Worker{Status: "idle", Ask: &proto.Ask{ToolUseID: "t", Questions: []proto.AskQuestion{}, Since: 1500}}, show(notify.DisplayIdle)},
		{"secret ask", false, proto.Worker{Status: "blocked", Ask: &proto.Ask{ToolUseID: "t", Questions: []proto.AskQuestion{{Question: "API key?", Secret: true, Options: []proto.AskOption{}}}, Since: 1600}}, needs(notify.ReasonQuestion, 1600)},
		{"follow-up after done", false, proto.Worker{Status: "done", Followup: fu(1700)}, needs(notify.ReasonFollowup, 1700)},
		{"ask wins over a follow-up", false, proto.Worker{Status: "idle", Ask: ask(1500, true), Followup: fu(1700)}, needs(notify.ReasonQuestion, 1500)},
		{"follow-up choice without options is none", false, proto.Worker{Status: "done", Followup: fu(1700, followup.Question{ID: "q", Question: "A or B?", Kind: "choice"})}, done},
		{"follow-up choice with options", false, proto.Worker{Status: "done", Followup: fu(1700, followup.Question{ID: "q", Question: "A or B?", Kind: "choice", Options: []string{"A", "B"}})}, needs(notify.ReasonFollowup, 1700)},
		{"follow-up of an unknown kind is none", false, proto.Worker{Status: "done", Followup: fu(1700, followup.Question{ID: "q", Question: "?", Kind: "essay"})}, done},
		{"follow-up question without an id is none", false, proto.Worker{Status: "idle", Followup: fu(1700, followup.Question{Question: "?", Kind: "open"})}, show(notify.DisplayIdle)},
		{"wrap-up stuck", false, proto.Worker{Status: "idle", WrapUp: &proto.WrapUp{State: proto.WrapUpNeedsYou, ArmedAt: 1}}, needs(notify.ReasonWrapUp, st)},
		{"wrap-up armed and done", false, proto.Worker{Status: "done", WrapUp: &proto.WrapUp{State: proto.WrapUpArmed, ArmedAt: 1}}, done},
		{"orchestrator over the cap", false, proto.Worker{Status: "idle", Role: "orch", OverCap: true}, needs(notify.ReasonNeedsYou, st)},
		{"orchestrator at the cap waiting for you", false, proto.Worker{Status: "idle", Role: "orch", Pass: ptr(3), Phase: "waiting_user"}, needs(notify.ReasonNeedsYou, st)},
		{"orchestrator at the cap, reviewing", false, proto.Worker{Status: "working", Role: "orch", Pass: ptr(3), Phase: "review"}, show(notify.DisplayWorking)},
		{"orchestrator past the cap", false, proto.Worker{Status: "working", Role: "orch", Pass: ptr(4)}, needs(notify.ReasonNeedsYou, st)},
		{"a coder's over_cap does not count", false, proto.Worker{Status: "idle", Role: "code", OverCap: true}, show(notify.DisplayIdle)},
		{"report request", false, proto.Worker{Status: "done", Role: "code", Report: report("ready", "I need the staging password", false)}, needs(notify.ReasonReport, st)},
		{"report request resolved", false, proto.Worker{Status: "done", Role: "code", Report: report("ready", "I need the staging password", true)}, freelancerDone},
		{"report request of blanks", false, proto.Worker{Status: "idle", Role: "code", Report: report("ready", "   ", false)}, show(notify.DisplayIdle)},
		{"report request of an invalid report", false, proto.Worker{Status: "idle", Role: "review", Report: report("invalid", "help", false)}, show(notify.DisplayIdle)},
		{"an employee's report request does not count", false, proto.Worker{Status: "idle", Report: report("ready", "help", false)}, show(notify.DisplayIdle)},
		{"waiting while idle", false, proto.Worker{Status: "idle", Activity: waiting}, show(notify.DisplayWaiting)},
		{"waiting while done", false, proto.Worker{Status: "done", Activity: waiting}, show(notify.DisplayWaiting)},
		{"waiting while working is working", false, proto.Worker{Status: "working", Activity: waiting}, show(notify.DisplayWorking)},
		{"waiting with an ask needs you", false, proto.Worker{Status: "idle", Activity: waiting, Ask: ask(1500, true)}, needs(notify.ReasonQuestion, 1500)},
		{"blocked only by a Codex async question works", false, proto.Worker{Status: "blocked", Codex: shared(true)}, show(notify.DisplayWorking)},
		{"a real Codex block needs you", false, proto.Worker{Status: "blocked", Codex: shared(false)}, needs(notify.ReasonNeedsYou, st)},
		{"async_blocked of a legacy Codex does not count", false, proto.Worker{Status: "blocked", Codex: &proto.WorkerCodex{Mode: proto.CodexModeLegacy, AsyncBlocked: true}}, needs(notify.ReasonNeedsYou, st)},
		{"asleep and blocked", true, proto.Worker{Status: "blocked"}, show(notify.DisplayAsleep)},
		{"asleep and done", true, proto.Worker{Status: "done"}, show(notify.DisplayAsleep)},
		{"asleep with an ask", true, proto.Worker{Status: "idle", Ask: ask(1500, true)}, notifyExpect{Display: notify.DisplayAsleep, Reason: notify.ReasonQuestion, Since: st}},
		{"asleep with a follow-up", true, proto.Worker{Status: "done", Followup: fu(1700)}, notifyExpect{Display: notify.DisplayAsleep, Reason: notify.ReasonFollowup, Since: st}},
		{"asleep with a stuck wrap-up", true, proto.Worker{Status: "idle", WrapUp: &proto.WrapUp{State: proto.WrapUpNeedsYou}}, notifyExpect{Display: notify.DisplayAsleep, Reason: notify.ReasonWrapUp, Since: st}},
		{"asleep orchestrator over the cap", true, proto.Worker{Status: "idle", Role: "orch", OverCap: true}, show(notify.DisplayAsleep)},
	}
}

// TestNotifyInboxVectors pins the bridge's inbox rule (internal/notify, fed
// by notifyFacts) to the game's: each case goes through the protocol's JSON
// and back, then the rule; the same file feeds the game's own functions
// (game/src/world/notifyVectors.test.ts). With -update-notify-vectors it is
// written again.
func TestNotifyInboxVectors(t *testing.T) {
	var file notifyVectorFile
	file.Comment = "Written by go test ./internal/server -run TestNotifyInboxVectors -update-notify-vectors. " +
		"The inbox rule's cases: a worker as the protocol carries it (on a floor asleep or not) and what the game's " +
		"WorldStore.workerView (display, since), inboxReason and inboxQueue (candidate, with freelancers off and on) say. " +
		"internal/notify and game/src/world/notifyVectors.test.ts both check it."
	for i, c := range notifyVectorTable() {
		w := c.w
		w.ID = "w" + string(rune('a'+i/26)) + string(rune('a'+i%26))
		w.Session, w.Floor, w.WorkspaceID, w.Name, w.DeskIndex, w.StatusSince = "awake", "awake", "ws-"+w.ID, "Pixel", i, 1000
		if c.asleep {
			w.Session, w.Floor = "sleepy", "sleepy"
		}
		if w.Label == "" {
			w.Label = "worker " + w.ID
		}
		raw, err := json.Marshal(w)
		if err != nil {
			t.Fatal(err)
		}
		var back proto.Worker // what the wire carries
		if err := json.Unmarshal(raw, &back); err != nil {
			t.Fatal(err)
		}
		v := notify.Judge(notifyFacts(&back, c.asleep))
		got := notifyExpect{Display: v.Display, Reason: v.Reason, Since: v.Since, Candidate: v.Candidate(false), CandidateWithF: v.Candidate(true)}
		if got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
		file.Vectors = append(file.Vectors, notifyVector{Name: c.name, Asleep: c.asleep, Worker: raw, Expect: c.want})
	}
	if *updateNotifyVectors {
		out, _ := json.MarshalIndent(file, "", "  ")
		if err := os.WriteFile(notifyVectorsPath, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(notifyVectorsPath)
	if err != nil {
		t.Fatalf("%v (run go test ./internal/server -run TestNotifyInboxVectors -update-notify-vectors)", err)
	}
	var want notifyVectorFile
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	norm := func(f notifyVectorFile) []any {
		var out []any
		for _, v := range f.Vectors {
			var w any
			_ = json.Unmarshal(v.Worker, &w)
			out = append(out, []any{v.Name, v.Asleep, w, v.Expect})
		}
		return out
	}
	if !reflect.DeepEqual(norm(file), norm(want)) {
		t.Fatalf("%s is out of date: run with -update-notify-vectors and check the game's notifyVectors test", notifyVectorsPath)
	}
}

// A secret ask's question never goes into a notification: the line is
// empty however much the overview or the transcript say.
func TestNotifyLineOfASecretAsk(t *testing.T) {
	h := &Hub{}
	w := &proto.Worker{ID: "a", Digest: &proto.WorkerDigest{Now: "Asking for the deploy key ghp_abcdefghijklmnop"}}
	if got := h.notifyLine(w, true); got != "" {
		t.Fatalf("secret ask's line %q", got)
	}
	if got := h.notifyLine(w, false); got != "Asking for the deploy key [key]" {
		t.Fatalf("line %q (not scrubbed?)", got)
	}
	nw := notifyFacts(&proto.Worker{Ask: &proto.Ask{ToolUseID: "t", Questions: []proto.AskQuestion{{Secret: true}}}}, false)
	if !nw.Secret() {
		t.Fatal("a secret question is not seen")
	}
}

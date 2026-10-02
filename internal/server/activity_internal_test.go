package server

import (
	"context"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// readyRoles is a classifier role that is always ready.
type readyRoles struct{ cls *ai.FakeClassifier }

func (r readyRoles) State(ai.Role) ai.State    { return ai.StateReady }
func (r readyRoles) Classifier() ai.Classifier { return r.cls }

// #98 review B-R5: herdr working after an idle the tracker's turn opened
// before (a new turn, nothing of it read yet): the previous turn's command
// neither shows with the model's cached answer nor is asked about. Once the
// tracker has read the new turn, its own command's answer shows.
func TestActivityCandidateOfAnOverTurn(t *testing.T) {
	ctx := context.Background()
	cls := &ai.FakeClassifier{ManyFunc: func(context.Context, map[string]any, map[string]string) (map[string]float64, error) {
		return map[string]float64{"testing": 0.99}, nil
	}}
	on := true
	svc, err := activity.NewService(ctx, activity.Options{Roles: readyRoles{cls}, EnvModel: &on})
	if err != nil {
		t.Fatal(err)
	}
	cand := &transcript.ActivityCandidate{Item: "old", Tool: "Bash", Command: "custom-test-runner"}
	if k, err := svc.Classify(ctx, cand.Tool, cand.Command); err != nil || k != activity.KindTesting {
		t.Fatalf("%q %v", k, err)
	}
	c := &Client{}
	w := &proto.Worker{ID: "w", Session: "s", Status: statusWorking, StatusSince: 300}
	aw := &actWorker{view: transcript.ActivityView{TurnAt: 100, Working: &activity.Activity{Kind: activity.KindWorking}, Candidate: cand}}
	h := &Hub{opts: Options{Now: time.Now}, clients: map[*Client]struct{}{c: {}}, workers: map[string]*proto.Worker{"w": w},
		act: activityHub{svc: svc, idleAt: map[string]int64{"w": 200}, views: map[*Client]string{c: "s"},
			ws: map[string]*actWorker{"w": aw}}}
	if a := h.composeActivity("w", w); a == nil || a.Kind != activity.KindThinking || a.Source != activity.SourceDerived {
		t.Fatalf("a new turn shows %+v", a)
	}
	// Another command of the over turn, not answered yet: not asked about.
	aw.view.Candidate = &transcript.ActivityCandidate{Item: "old2", Tool: "Bash", Command: "other-runner"}
	h.pumpActivity(ctx)
	if h.act.inflight || aw.tried != "" || len(cls.Calls()) != 1 {
		t.Fatalf("the over turn's command was asked about: %d calls", len(cls.Calls()))
	}
	// The tracker has read the new turn: its command's answer shows.
	aw.view.TurnAt, aw.view.Candidate = 250, cand
	if a := h.composeActivity("w", w); a == nil || a.Kind != activity.KindTesting || a.Source != activity.SourceModel {
		t.Fatalf("the turn's own command shows %+v", a)
	}
}

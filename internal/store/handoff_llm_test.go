package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #9: the LLM handoffs' settings and jobs survive a restart; an op is one
// job; a restart fails every unfinished job (never resumed); each worker's
// newest job is found; settled ones are pruned.
func TestHandoffLLMJobsAndSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, ok, err := st.LoadHandoffLLMSettings(ctx); ok || err != nil {
		t.Fatalf("%v %v", ok, err)
	}
	set := store.HandoffLLMSettings{Enabled: true, InputBytes: 65536, MaxTokens: 2048, ReasoningEffort: "low", Bound: "fp|low|2048"}
	if err := st.SaveHandoffLLMSettings(ctx, set); err != nil {
		t.Fatal(err)
	}
	a := store.HandoffLLMJob{Op: "op-a", WorkerID: "a", Floor: "s", AgentSession: "sess", Candidate: "c1", ArgsHash: "h1", Config: "fp",
		PromptVersion: "v1", SendHome: true, State: store.HandoffJobRunning, CreatedAt: 1000, UpdatedAt: 1000}
	b := store.HandoffLLMJob{Op: "op-b", WorkerID: "a", Floor: "s", Candidate: "c2", ArgsHash: "h2", PromptVersion: "v1",
		State: store.HandoffJobFiled, HandoffID: 7, CreatedAt: 2000, UpdatedAt: 2500}
	c := store.HandoffLLMJob{Op: "op-c", WorkerID: "b", Floor: "s", Candidate: "c3", ArgsHash: "h3", PromptVersion: "v1",
		State: store.HandoffJobQueued, CreatedAt: 1500, UpdatedAt: 1500}
	for _, j := range []store.HandoffLLMJob{a, b, c} {
		if err := st.AddHandoffLLMJob(ctx, j); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.AddHandoffLLMJob(ctx, a); !errors.Is(err, store.ErrRequestTaken) {
		t.Fatalf("a second job of one op: %v", err)
	}
	st.Close()
	st = open(t, path)
	if got, ok, err := st.LoadHandoffLLMSettings(ctx); !ok || err != nil || got != set {
		t.Fatalf("%+v %v", got, err)
	}
	got, err := st.HandoffLLMJobByOp(ctx, "op-a")
	if err != nil || !reflect.DeepEqual(got, a) {
		t.Fatalf("%+v %v", got, err)
	}
	n, err := st.FailUnfinishedHandoffLLMJobs(ctx, "interrupted", "the bridge restarted", 3000)
	if err != nil || n != 2 {
		t.Fatalf("%d %v", n, err)
	}
	if got, _ := st.HandoffLLMJobByOp(ctx, "op-c"); got.State != store.HandoffJobFailed || got.Code != "interrupted" || got.UpdatedAt != 3000 {
		t.Fatalf("%+v", got)
	}
	latest, err := st.LatestHandoffLLMJobs(ctx)
	if err != nil || len(latest) != 2 || latest[0].Op != "op-c" || latest[1].Op != "op-b" || latest[1].HandoffID != 7 {
		t.Fatalf("%+v %v", latest, err)
	}
	b.State, b.Code, b.Message, b.UpdatedAt = store.HandoffJobCancelled, "cancelled", "", 4000
	if err := st.UpdateHandoffLLMJob(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateHandoffLLMJob(ctx, store.HandoffLLMJob{Op: "nope", State: store.HandoffJobFailed}); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if err := st.UpdateHandoffLLMJob(ctx, store.HandoffLLMJob{Op: "op-a", State: "bogus"}); err == nil {
		t.Fatal("an unknown state was stored")
	}
	if err := st.PruneHandoffLLMJobs(ctx, 1600); err != nil {
		t.Fatal(err)
	}
	if _, err := st.HandoffLLMJobByOp(ctx, "op-a"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a settled old job stayed: %v", err)
	}
	if _, err := st.HandoffLLMJobByOp(ctx, "op-b"); err != nil {
		t.Fatal(err)
	}
}

package hireintent_test

import (
	"context"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
)

// metadataRoles' ModelReasoning waits for its context, or 80 ms.
type metadataRoles struct {
	roles
	deadline bool
}

func (r *metadataRoles) ModelReasoning(ctx context.Context) ai.Reasoning {
	_, r.deadline = ctx.Deadline()
	select {
	case <-ctx.Done():
	case <-time.After(80 * time.Millisecond):
	}
	return ai.UnknownReasoning()
}

// R5: Run's bound covers the reasoning metadata: a slow fetch is cut off,
// the result is a timeout and the LLM is not called.
func TestRunBoundsTheMetadata(t *testing.T) {
	llm := answerLLM(ans("hire", "", "", "", ""))
	rs := &metadataRoles{roles: roles{ai.StateReady, llm}}
	start := time.Now()
	r := hireintent.Run(context.Background(), rs, 10*time.Millisecond, hireintent.Request{Text: "Spawn an agent.", Catalog: matrixCatalog()})
	if !rs.deadline {
		t.Fatal("the metadata had no deadline")
	}
	if took := time.Since(start); took > 60*time.Millisecond {
		t.Fatalf("took %v", took)
	}
	if r.Error == nil || r.Error.Code != string(ai.KindTimeout) || len(llm.Calls()) != 0 {
		t.Fatalf("error %+v, %d LLM calls", r.Error, len(llm.Calls()))
	}
}

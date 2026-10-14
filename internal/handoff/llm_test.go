package handoff_test

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #9: an LLM handoff's provenance goes in its front matter under the known
// keys only, is read back with it, and survives a reconcile that registers
// the file again.
func TestLLMProvenanceInTheFrontMatter(t *testing.T) {
	svc, st, _ := service(t)
	s := src("op-llm")
	s.Kind, s.Items = store.HandoffLLM, ""
	s.Provenance = map[string]string{"llm_model": "gpt-x", "llm_host": "llm.example:8443", "prompt_version": "h3d-handoff-llm-1",
		"snapshot": "cand-1@4096", "coverage": "12 of 40 messages", "redactions": `{"github_token":1}`, "secret": "never"}
	h, _, err := svc.File(context.Background(), s, "# Done\n\nbody\n")
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(h.Path)
	if err != nil {
		t.Fatal(err)
	}
	fm := string(b)
	for _, want := range []string{`source: "llm"`, `llm_model: "gpt-x"`, `llm_host: "llm.example:8443"`, `prompt_version: "h3d-handoff-llm-1"`,
		`snapshot: "cand-1@4096"`, `coverage: "12 of 40 messages"`, `redactions: "{\"github_token\":1}"`} {
		if !strings.Contains(fm, want+"\n") {
			t.Fatalf("missing %s in\n%s", want, fm)
		}
	}
	if strings.Contains(fm, "never") {
		t.Fatal("an unknown key went in")
	}
	got, body, prov, err := svc.ReadProvenance(context.Background(), h.ID)
	if err != nil || body != "# Done\n\nbody\n" || got.Source != store.HandoffLLM || prov["llm_model"] != "gpt-x" || prov["redactions"] != `{"github_token":1}` || len(prov) != 6 {
		t.Fatalf("%+v %q %v %v", got, body, prov, err)
	}
	// The row lost (a crash after the write): the reconcile registers the
	// file again, as an LLM handoff, its provenance still read back.
	if err := st.DeleteHandoff(context.Background(), h.ID); err != nil {
		t.Fatal(err)
	}
	if r, err := svc.Reconcile(context.Background()); err != nil || r.Registered != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	again, err := st.HandoffByOp(context.Background(), "op-llm")
	if err != nil || again.Source != store.HandoffLLM {
		t.Fatalf("%+v %v", again, err)
	}
	if _, _, prov, err := svc.ReadProvenance(context.Background(), again.ID); err != nil || prov["prompt_version"] != "h3d-handoff-llm-1" {
		t.Fatalf("%v %v", prov, err)
	}
}

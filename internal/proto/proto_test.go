package proto

import (
	"encoding/json"
	"testing"
)

func TestOptionalAbsentNullValue(t *testing.T) {
	var a FloorSettingsArgs
	if err := json.Unmarshal([]byte(`{"session":"s","repo":null,"project":{"owner":"o","number":2}}`), &a); err != nil {
		t.Fatal(err)
	}
	if !a.Repo.Set || a.Repo.Value != nil {
		t.Errorf("repo = %+v, want null", a.Repo)
	}
	if !a.Project.Set || a.Project.Value == nil || *a.Project.Value != (Project{"o", 2}) {
		t.Errorf("project = %+v", a.Project)
	}
	if a.StatusField.Set || a.DefaultCwd.Set || a.DefaultHire.Set {
		t.Errorf("absent keys set: %+v", a)
	}
	if err := json.Unmarshal([]byte(`{"session":"s","project":{"owner":"o","number":2,"extra":1}}`), &a); err == nil {
		t.Error("unknown field inside a value accepted")
	}
	b, err := json.Marshal(FloorSettingsArgs{Session: "s", Repo: Some("o/r"), DefaultCwd: Null[string]()})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"session":"s","repo":"o/r","default_cwd":null}` {
		t.Errorf("marshal = %s", b)
	}
}

func TestHarnessOptionsModelLabels(t *testing.T) {
	in := HarnessOptions{Models: []string{"claude-opus-5"}, Efforts: []string{"high"}, ModelLabels: map[string]string{"claude-opus-5": "Opus 5"}}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"models":["claude-opus-5"],"efforts":["high"],"model_labels":{"claude-opus-5":"Opus 5"}}` {
		t.Errorf("marshal = %s", b)
	}
	var out HarnessOptions
	if err := json.Unmarshal(b, &out); err != nil || out.ModelLabels["claude-opus-5"] != "Opus 5" {
		t.Errorf("round trip = %+v, %v", out, err)
	}
	// A catalog without labels (an older bridge, a fallback catalog) leaves the key out and decodes to none.
	b, _ = json.Marshal(HarnessOptions{Models: []string{"m"}, Efforts: []string{}})
	if string(b) != `{"models":["m"],"efforts":[]}` {
		t.Errorf("marshal without labels = %s", b)
	}
	out = HarnessOptions{}
	if err := json.Unmarshal(b, &out); err != nil || out.ModelLabels != nil {
		t.Errorf("decode without labels = %+v, %v", out, err)
	}
}

// #22: the child events' fields survive Event's embedded flat structs (a
// name two of them share would silently drop out of the JSON), and the
// snapshot always has its children.
func TestChildWire(t *testing.T) {
	b, err := json.Marshal(Event{T: EvChildRemoved, Seq: 7, ID: "ch_1", WorkerID: "w", Generation: 3})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"t":"child.removed","seq":7,"id":"ch_1","worker_id":"w","generation":3}` {
		t.Errorf("child.removed = %s", b)
	}
	c := Child{ID: "ch_1", Provider: ChildClaude, WorkerID: "w", AgentSession: "s", Generation: 3, Parent: ParentUnresolved,
		State: ChildUnknown, Source: ChildFromFixture, Transcript: TranscriptUnavailable}
	b, _ = json.Marshal(Event{T: EvChildUpsert, Seq: 8, Child: &c})
	want := `{"t":"child.upsert","seq":8,"child":{"id":"ch_1","provider":"claude","worker_id":"w","agent_session":"s","generation":3,` +
		`"parent":"unresolved","state":"unknown","source":"fixture","transcript":"unavailable"}}`
	if string(b) != want {
		t.Errorf("child.upsert = %s", b)
	}
	var back Event
	if err := json.Unmarshal(b, &back); err != nil || back.Child == nil || *back.Child != c {
		t.Errorf("round trip = %+v, %v", back.Child, err)
	}
	b, _ = json.Marshal(World{})
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	if string(m["children"]) != "null" {
		t.Errorf("children = %s", m["children"])
	}
	b, _ = json.Marshal(Worker{ID: "w"})
	m = nil
	if _ = json.Unmarshal(b, &m); m["child_generation"] != nil {
		t.Errorf("child_generation of 0 = %s", m["child_generation"])
	}
}

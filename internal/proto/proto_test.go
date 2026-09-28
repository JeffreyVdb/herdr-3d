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

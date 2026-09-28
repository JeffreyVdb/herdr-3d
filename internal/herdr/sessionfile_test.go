package herdr_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
)

func TestParseSessionFileV3(t *testing.T) {
	sf, err := herdr.ParseSessionFile(herdrtest.Fixture(t, "session_v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(sf.Workspaces) != 4 {
		t.Fatalf("workspaces = %d", len(sf.Workspaces))
	}
	w := sf.Workspaces[1]
	if w.ID != "w1Q" || *w.CustomName != "CODE|learnpref|100|r1" || w.PublicPaneNumbers["7"] != 2 {
		t.Fatalf("w1Q = %+v", w)
	}
	p := w.Tabs[0].Panes["7"]
	if *p.Label != "h3d-7f3a9c" || *p.ManagedAgentKind != "claude" || p.AgentSession.Value != "3a7b87bd-b68e-4e7b-95d7-6f8384da8e6d" {
		t.Fatalf("pane 7 = %+v", p)
	}
	if w.WorktreeSpace == nil || !w.WorktreeSpace.IsLinkedWorktree {
		t.Fatalf("worktree = %+v", w.WorktreeSpace)
	}
	if sf.Workspaces[2].CustomName != nil {
		t.Fatal("null custom_name should decode to nil")
	}
}

func TestParseSessionFileToleratesUnknownFields(t *testing.T) {
	sf, err := herdr.ParseSessionFile(herdrtest.Fixture(t, "session_v3_unknown_fields.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := sf.Workspaces[0].Tabs[0].Panes["4"]
	if *p.AgentName != "r-herdr" || p.AgentSession.Agent != "codex" {
		t.Fatalf("pane = %+v", p)
	}
}

func TestParseSessionFileRejectsOtherVersions(t *testing.T) {
	for name, data := range map[string][]byte{
		"future":     herdrtest.Fixture(t, "session_bad_version.json"),
		"no version": []byte(`{"workspaces":[]}`),
		"v2":         []byte(`{"version":2,"workspaces":[]}`),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := herdr.ParseSessionFile(data)
			var uv *herdr.UnsupportedVersionError
			if !errors.As(err, &uv) {
				t.Fatalf("err = %v, want UnsupportedVersionError", err)
			}
		})
	}
}

func TestParseSessionFileGarbage(t *testing.T) {
	_, err := herdr.ParseSessionFile([]byte(`{"version":3,"workspaces":"nope"}`))
	var uv *herdr.UnsupportedVersionError
	if err == nil || errors.As(err, &uv) {
		t.Fatalf("err = %v, want a decode error", err)
	}
	if _, err := herdr.ParseSessionFile([]byte(`not json`)); err == nil {
		t.Fatal("expected an error")
	}
}

func TestReadSessionFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.json")
	if _, err := herdr.ReadSessionFile(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing file: err = %v", err)
	}
	if err := os.WriteFile(path, herdrtest.Fixture(t, "session_v3.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	sf, err := herdr.ReadSessionFile(path)
	if err != nil || len(sf.Workspaces) != 4 {
		t.Fatalf("sf = %v, err = %v", sf, err)
	}
}

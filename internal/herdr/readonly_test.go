package herdr

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
)

// TestReadOnlyAllowlist is a tripwire: widening what the bridge may ask
// herdr must be a deliberate, reviewed change to this test. Client stays
// read-only; the write path is Control (TestControlAllowlist).
func TestReadOnlyAllowlist(t *testing.T) {
	got := slices.Sorted(maps.Keys(readOnlyMethods))
	if want := []string{"events.subscribe", "pane.get", "ping", "session.snapshot"}; !slices.Equal(got, want) {
		t.Fatalf("readOnlyMethods = %v, want %v", got, want)
	}
	if !slices.Equal(listArgs, []string{"session", "list", "--json"}) {
		t.Fatalf("listArgs = %v", listArgs)
	}
}

func TestMutatingMethodsAreRefusedBeforeDialing(t *testing.T) {
	c := &Client{}
	for _, m := range []string{"workspace.create", "workspace.close", "pane.rename", "agent.start", "pane.report_metadata", "server.stop"} {
		// The socket does not exist: refusal must come before any dial.
		err := c.call(context.Background(), "/nonexistent/herdr.sock", m, struct{}{}, &struct{}{})
		if !errors.Is(err, ErrNotReadOnly) {
			t.Errorf("%s: err = %v, want ErrNotReadOnly", m, err)
		}
	}
}

func TestCleanEnv(t *testing.T) {
	env := []string{
		"PATH=/usr/bin", "HOME=/home/u", "HERDR_ENV=1", "HERDR_SOCKET_PATH=/x", "HERDR_SESSION=s",
		"HERDR_PANE_ID=w1:p1", "HERDR_TAB_ID=w1:t1", "HERDR_WORKSPACE_ID=w1", "HERDR_BIN_PATH=/b",
		"CLAUDE_CODE_CHILD_SESSION=1", "CLAUDECODE=1", "HERDR_WORLD_DB=/db",
	}
	got := strings.Join(CleanEnv(env), " ")
	if want := "PATH=/usr/bin HOME=/home/u HERDR_WORLD_DB=/db"; got != want {
		t.Fatalf("CleanEnv = %q, want %q", got, want)
	}
}

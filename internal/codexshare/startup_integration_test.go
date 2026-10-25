//go:build integration

package codexshare

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// Exercise the actual remote TUI and Herdr readiness boundary with a
// deliberately silent MCP and mock inference. No user's config is read.
func TestCodexShareMCPStartup(t *testing.T) {
	for _, required := range []bool{false, true} {
		t.Run(fmt.Sprintf("required=%v", required), func(t *testing.T) {
			starts := filepath.Join(t.TempDir(), "starts")
			script := filepath.Join(t.TempDir(), "slow.sh")
			if err := os.WriteFile(script, []byte("#!/bin/sh\necho start >> '"+starts+"'\nexec sleep 60\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			f := newFx(t, fxOptions{noMCP: true, extra: fmt.Sprintf("[mcp_servers.slow]\ncommand = %s\nstartup_timeout_sec = 2\nrequired = %v\n", TOMLString(script), required)}, "bare-startup")
			ctl := f.control(filepath.Join(f.root, "run"))
			s := &sharedLaunch{ws: "bare-startup", name: "startup", cwd: filepath.Join(f.root, "bare-startup"), l: codexapp.Launch{Name: "c00000000004"}}
			s.pane = f.pane(s.ws)
			f.startShared(ctl, s)
			observer := f.client(s.l.Socket(), "startup_observer")
			startup, err := codexapp.ObserveStartup(f.ctx, s.l.Socket(), s.cwd, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer startup.Close()
			err = ctl.StartCodexRemote(f.ctx, f.h.Name, s.pane, s.name, herdr.Agent{Harness: "codex", Model: "mock", Effort: "low"}, herdr.Remote{Socket: s.l.Socket(), Cwd: s.cwd})
			t.Logf("remote startup: %v", err)
			// Allow the optional connection to settle after terminal readiness.
			if !required {
				for end := time.Now().Add(8 * time.Second); time.Now().Before(end); time.Sleep(100 * time.Millisecond) {
					rows := startup.Snapshot()
					if len(rows) == 1 && rows[0].Stage == "failed" {
						break
					}
				}
			}
			if got := observer.Notifications("mcpServer/startupStatus/updated"); len(got) != 0 {
				t.Fatalf("unsubscribed observer got MCP events: %v", got)
			}
			if required {
				f.snap("startup", s.pane)
			}
			if required {
				if err == nil || !strings.Contains(err.Error(), "slow") {
					t.Fatalf("required MCP startup cause missing: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("optional MCP prevented startup: %v", err)
				}
				rows := startup.Snapshot()
				if len(rows) != 1 || rows[0].Name != "slow" || rows[0].Stage != "failed" || rows[0].Category != "timeout" {
					t.Fatalf("startup diagnostics: %+v", rows)
				}
			}
			if f.mock.ModelRequests() != 0 {
				t.Fatal("startup observation submitted a prompt")
			}
			if !required {
				f.prompt(s.name, "MOCK:say startup recovered")
				th := observer.Notifications("thread/started")[0]
				var n struct {
					Thread struct {
						ID string `json:"id"`
					} `json:"thread"`
				}
				if err := json.Unmarshal(th.Params, &n); err != nil {
					t.Fatal(err)
				}
				w, ev := watch(t, s.l.Socket(), n.Thread.ID)
				ev.wait(t, codexapp.EvJoined, 10*time.Second)
				before := f.mock.ModelRequests()
				rows, err := w.StartupDiagnostics(f.ctx)
				if err != nil || len(rows) != 1 || rows[0].Category != "timeout" {
					t.Fatalf("late observation: %+v %v", rows, err)
				}
				if before != f.mock.ModelRequests() {
					t.Fatal("late observation submitted a turn")
				}
			}
			// Observation must reuse the TUI's connection. A bare threadId
			// used to start a new MCP on every read, even on this same server.
			raw, err := os.ReadFile(starts)
			if err != nil || strings.Count(string(raw), "start") != 1 {
				t.Fatalf("MCP was started more than once: %q, %v", raw, err)
			}

		})
	}
}

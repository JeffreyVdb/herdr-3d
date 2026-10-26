package server_test

import (
	"context"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/cmdrequest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func TestCommandRequestDismissAndRestart(t *testing.T) {
	roles := newFuRoles()
	roles.cls.Func = func(_ context.Context, _ map[string]any, q string) (float64, error) {
		if q == cmdrequest.GateQuestion {
			return .95, nil
		}
		return .01, nil
	}
	roles.llm.Func = func(_ context.Context, _ ai.Request) (string, error) {
		return `{"commands":[{"command":"pwd","host":"bridge"}]}`, nil
	}
	start := func(db, dir string) *fuBridge {
		return startFuBridgeWith(t, db, dir, roles, off(), "", func(o *server.Options) { o.CommandRequestsEnabled = on(); o.ScheduleSuggestionsEnabled = off() })
	}
	fb := start("", "")
	c := fb.connect(proto.Hello{})
	c.snapshot()
	id := fb.ids["w1"]
	fb.say(t, "cmd1", "Please run `pwd`.")
	req := upsertFor(c, id, func(w *proto.Worker) bool { return w.CommandRequest != nil }).CommandRequest
	if len(req.Commands) != 1 || req.Commands[0].Command != "pwd" || req.Commands[0].Host != "bridge" {
		t.Fatalf("%+v", req)
	}
	c.mustError(proto.CmdWorkerDismissCommandRequest, proto.WorkerDismissCommandRequestArgs{ID: id, Key: "wrong"}, "stale")
	c.mustAck(proto.CmdWorkerDismissCommandRequest, proto.WorkerDismissCommandRequestArgs{ID: id, Key: req.Key})
	fb.say(t, "cmd_duplicate", "Please run `pwd`.")
	fuQuiet()
	if len(roles.cls.Calls()) != 1 {
		t.Fatalf("duplicate classified %d times", len(roles.cls.Calls()))
	}
	fb.stop()
	fb2 := start(fb.db, fb.dir)
	defer fb2.stop()
	fuQuiet()
	if len(roles.cls.Calls()) != 1 {
		t.Fatalf("classified %d times", len(roles.cls.Calls()))
	}
	for _, w := range workersOf(fb2.world(func(proto.World) bool { return true }), "s") {
		if w.CommandRequest != nil {
			t.Fatalf("restored dismissed request: %+v", w.CommandRequest)
		}
	}
}

func TestCommandRequestStaleResult(t *testing.T) {
	roles := newFuRoles()
	roles.cls.Func = func(_ context.Context, _ map[string]any, q string) (float64, error) {
		if q == cmdrequest.GateQuestion {
			return .95, nil
		}
		return 0, nil
	}
	asked, release := make(chan struct{}, 1), make(chan struct{})
	roles.llm.Func = func(_ context.Context, _ ai.Request) (string, error) {
		asked <- struct{}{}
		<-release
		return `{"commands":[{"command":"pwd","host":"bridge"}]}`, nil
	}
	fb := startFuBridgeWith(t, "", "", roles, off(), "", func(o *server.Options) { o.CommandRequestsEnabled = on(); o.ScheduleSuggestionsEnabled = off() })
	defer fb.stop()
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.say(t, "cmd_stale", "Please run `pwd`.")
	<-asked
	appendTo(t, fb.claude, wrapUser("Never mind."))
	fuQuiet()
	close(release)
	fuQuiet()
	for _, w := range workersOf(fb.world(func(proto.World) bool { return true }), "s") {
		if w.CommandRequest != nil {
			t.Fatalf("stale request: %+v", w.CommandRequest)
		}
	}
}

func TestCommandRequestModelFailure(t *testing.T) {
	roles := newFuRoles()
	roles.cls.Func = func(_ context.Context, _ map[string]any, q string) (float64, error) {
		if q == cmdrequest.GateQuestion {
			return .95, nil
		}
		return 0, nil
	}
	roles.llm.Err = context.DeadlineExceeded
	fb := startFuBridgeWith(t, "", "", roles, off(), "", func(o *server.Options) { o.CommandRequestsEnabled = on(); o.ScheduleSuggestionsEnabled = off() })
	defer fb.stop()
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.say(t, "cmd_error", "Please run `pwd`.")
	fuQuiet()
	for _, w := range workersOf(fb.world(func(proto.World) bool { return true }), "s") {
		if w.CommandRequest != nil {
			t.Fatalf("request after model failure: %+v", w.CommandRequest)
		}
	}
}

func TestCommandRequestUnconfigured(t *testing.T) {
	roles := newFuRoles()
	roles.set(ai.RoleLLM, ai.StateOff)
	fb := startFuBridgeWith(t, "", "", roles, off(), "", func(o *server.Options) { o.CommandRequestsEnabled = on(); o.ScheduleSuggestionsEnabled = off() })
	defer fb.stop()
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.say(t, "cmd_unconfigured", "Please run `pwd`.")
	fuQuiet()
	if cls, llm := roles.calls(); cls != 0 || llm != 0 {
		t.Fatalf("calls = %d, %d", cls, llm)
	}
	for _, w := range workersOf(fb.world(func(proto.World) bool { return true }), "s") {
		if w.CommandRequest != nil {
			t.Fatalf("request with unconfigured AI: %+v", w.CommandRequest)
		}
	}
}

func TestReviewCommandRequestReplacedAgentSession(t *testing.T) {
	roles := newFuRoles()
	roles.cls.Func = func(_ context.Context, _ map[string]any, q string) (float64, error) {
		if q == cmdrequest.GateQuestion {
			return .95, nil
		}
		return 0, nil
	}
	roles.llm.Text = `{"commands":[{"command":"pwd","host":"bridge"}]}`
	start := func(db, dir string) *fuBridge {
		return startFuBridgeWith(t, db, dir, roles, off(), "", func(o *server.Options) { o.CommandRequestsEnabled = on(); o.ScheduleSuggestionsEnabled = off() })
	}
	fb := start("", "")
	c := fb.connect(proto.Hello{})
	c.snapshot()
	id := fb.ids["w1"]
	fb.say(t, "review-session", "Please run pwd.")
	upsertFor(c, id, func(w *proto.Worker) bool { return w.CommandRequest != nil })
	fb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = "11111111-1111-4111-8111-111111111111" })
	fb.world(func(v proto.World) bool {
		for _, w := range workersOf(v, "s") {
			if w.ID == id {
				return w.AgentSession == "11111111-1111-4111-8111-111111111111"
			}
		}
		return false
	})
	fuQuiet()
	for _, w := range workersOf(fb.world(func(proto.World) bool { return true }), "s") {
		if w.ID == id && w.CommandRequest != nil {
			t.Fatalf("old command request survives replacement agent session: %+v", w.CommandRequest)
		}
	}
	fb.stop()
	fb2 := start(fb.db, fb.dir)
	defer fb2.stop()
	fuQuiet()
	if w := workersOf(fb2.world(func(proto.World) bool { return true }), "s")["w1"]; w.CommandRequest != nil {
		t.Fatalf("closed request restored after restart: %+v", w.CommandRequest)
	}
}

// The scores are fixture labels, not a test of model quality. They exercise the
// shared gate and extraction pipeline with the same kinds of replies as AC7.
func TestCommandRequestReplyFixtures(t *testing.T) {
	fixtures := []struct {
		name, reply, answer          string
		score                        float64
		command, host, hostText, cwd string
		cwdNamed                     bool
	}{
		{"documentation", "Example: run make test", `{"commands":[{"command":"make test","host":"bridge"}]}`, .1, "", "", "", "", false},
		{"quoted error", "Error: command make test failed", `{"commands":[{"command":"make test","host":"bridge"}]}`, .1, "", "", "", "", false},
		{"already executed", "I ran make test and it passed", `{"commands":[{"command":"make test","host":"bridge"}]}`, .1, "", "", "", "", false},
		{"alternative", "Alternatively you could run make test", `{"commands":[{"command":"make test","host":"bridge"}]}`, .1, "", "", "", "", false},
		{"hypothetical", "If needed, one might run make test", `{"commands":[{"command":"make test","host":"bridge"}]}`, .1, "", "", "", "", false},
		{"bridge", "Please run sudo make install on the bridge host", `{"commands":[{"command":"sudo make install","host":"bridge"}]}`, .95, "sudo make install", "bridge", "", "", false},
		{"multiline", "Run:\ncat <<'EOF'\nhello\nEOF", `{"commands":[{"command":"cat <<'EOF'\nhello\nEOF","host":"bridge"}]}`, .95, "cat <<'EOF'\nhello\nEOF", "bridge", "", "", false},
		{"named cwd", "In /tmp run pwd", `{"commands":[{"command":"pwd","cwd":"/tmp","host":"bridge"}]}`, .95, "pwd", "bridge", "", "/tmp", true},
		{"other host", "On your Mac run pwd", `{"commands":[{"command":"pwd","host":"other","host_text":"your Mac"}]}`, .95, "pwd", "other", "your Mac", "", false},
		{"unknown host", "Run pwd", `{"commands":[{"command":"pwd","host":"unknown"}]}`, .95, "pwd", "unknown", "", "", false},
		{"continued line", "Run make \\\n test", `{ "commands":[{"command":"make \\\n test","host":"bridge"}]}`, .95, "make \\\n test", "bridge", "", "", false},
		{"quotes", `Run echo 'a' "b"`, `{"commands":[{"command":"echo 'a' \"b\"","host":"bridge"}]}`, .95, `echo 'a' "b"`, "bridge", "", "", false},
		{"fabricated cwd", "Run pwd", `{"commands":[{"command":"pwd","cwd":"/made-up","host":"bridge"}]}`, .95, "", "", "", "", false},
		{"fabricated host", "Run pwd", `{"commands":[{"command":"pwd","host":"other","host_text":"Mac"}]}`, .95, "", "", "", "", false},
		{"other without text", "Run pwd", `{"commands":[{"command":"pwd","host":"other"}]}`, .95, "", "", "", "", false},
		{"empty command", "Run pwd", `{"commands":[{"command":"","host":"bridge"}]}`, .95, "", "", "", "", false},
		{"invalid host", "Run pwd", `{"commands":[{"command":"pwd","host":"bogus"}]}`, .95, "", "", "", "", false},
		{"invented reason", "Run `pwd`", `{"commands":[{"command":"pwd","host":"bridge","why":"invented"}]}`, .95, "pwd", "bridge", "", "", false},
		{"duplicate", "Run pwd", `{"commands":[{"command":"pwd","host":"bridge"},{"command":"pwd","host":"bridge"}]}`, .95, "pwd", "bridge", "", "", false},
		{"echo", "Run `echo ok`", `{"commands":[{"command":"echo ok","host":"bridge"}]}`, .95, "echo ok", "bridge", "", "", false},
		{"fabricated", "Run pwd", `{"commands":[{"command":"rm -rf /","host":"bridge"}]}`, .95, "", "", "", "", false},
		{"altered", "Run make test", `{"commands":[{"command":"make  test","host":"bridge"}]}`, .95, "", "", "", "", false},
	}
	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			roles := newFuRoles()
			roles.cls.Func = func(_ context.Context, _ map[string]any, q string) (float64, error) {
				if q == cmdrequest.GateQuestion {
					return f.score, nil
				}
				return 0, nil
			}
			roles.llm.Text = f.answer
			fb := startFuBridgeWith(t, "", "", roles, off(), "", func(o *server.Options) { o.CommandRequestsEnabled = on(); o.ScheduleSuggestionsEnabled = off() })
			defer fb.stop()
			c := fb.connect(proto.Hello{})
			c.snapshot()
			id := fb.ids["w1"]
			fb.say(t, "fixture", f.reply)
			fuQuiet()
			if len(roles.cls.Calls()) != 1 {
				t.Fatalf("classifier calls: %d", len(roles.cls.Calls()))
			}
			wantCalls := 1
			if f.score < cmdrequest.Threshold {
				wantCalls = 0
			}
			if got := len(roles.llm.Calls()); got != wantCalls {
				t.Fatalf("extraction calls = %d, want %d", got, wantCalls)
			}
			for _, w := range workersOf(fb.world(func(proto.World) bool { return true }), "s") {
				if w.ID != id {
					continue
				}
				if f.command == "" {
					if w.CommandRequest != nil {
						t.Fatalf("unexpected request: %+v", w.CommandRequest)
					}
					return
				}
				if w.CommandRequest == nil || len(w.CommandRequest.Commands) != 1 {
					t.Fatalf("request: %+v", w.CommandRequest)
				}
				got := w.CommandRequest.Commands[0]
				cwd := f.cwd
				if cwd == "" {
					cwd = w.Cwd
				}
				if got.Command != f.command || got.Host != f.host || got.HostText != f.hostText || got.Cwd != cwd || got.CwdNamed != f.cwdNamed {
					t.Fatalf("command: %+v; want command=%q host=%q host_text=%q cwd=%q cwd_named=%v", got, f.command, f.host, f.hostText, cwd, f.cwdNamed)
				}
				return
			}
			t.Fatal("worker missing")
		})
	}
}

func TestCommandRequestResultAfterSessionReplacement(t *testing.T) {
	roles := newFuRoles()
	roles.cls.Func = func(_ context.Context, _ map[string]any, q string) (float64, error) {
		if q == cmdrequest.GateQuestion {
			return .95, nil
		}
		return 0, nil
	}
	asked, release := make(chan struct{}, 1), make(chan struct{})
	roles.llm.Func = func(_ context.Context, _ ai.Request) (string, error) {
		asked <- struct{}{}
		<-release
		return `{"commands":[{"command":"pwd","host":"bridge"}]}`, nil
	}
	fb := startFuBridgeWith(t, "", "", roles, off(), "", func(o *server.Options) { o.CommandRequestsEnabled = on(); o.ScheduleSuggestionsEnabled = off() })
	defer fb.stop()
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.say(t, "old-session", "Please run pwd.")
	<-asked
	fb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = "11111111-1111-4111-8111-111111111111" })
	fb.world(func(v proto.World) bool {
		return workersOf(v, "s")["w1"].AgentSession == "11111111-1111-4111-8111-111111111111"
	})
	close(release)
	fuQuiet()
	if w := workersOf(fb.world(func(proto.World) bool { return true }), "s")["w1"]; w.CommandRequest != nil {
		t.Fatalf("stale result shown: %+v", w.CommandRequest)
	}
}

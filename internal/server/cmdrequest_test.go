package server_test

import (
	"context"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/cmdrequest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
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

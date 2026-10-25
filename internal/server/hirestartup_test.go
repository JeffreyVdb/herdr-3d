package server_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/mcpdiag"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

type startupRollback struct {
	server.HireHerdr
	before func()
}

func (h startupRollback) CloseWorkspace(ctx context.Context, session, ws string) error {
	h.before()
	return h.HireHerdr.CloseWorkspace(ctx, session, ws)
}

func TestHireStartupDiagnosticSurvivesRollback(t *testing.T) {
	for _, closeFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "removed", true: "cleanup failed"}[closeFails], func(t *testing.T) {
			var hb *hireBridge
			hb = startHireBridge(t, func(o *server.Options) {
				o.Hire = startupRollback{HireHerdr: o.Hire, before: func() {
					audit := auditRow(t, hb.bridge, proto.CmdWorkerHire)
					if audit.Done || !strings.Contains(audit.Result, "code-intel") {
						t.Error("startup evidence was not saved before removing the workspace")
					}
				}}
			})
			hb.fl.startErr = &mcpdiag.Failure{Cause: errors.New("https://user:PRIVATE@example.test/token"), Diagnostics: []mcpdiag.Diagnostic{{Name: "code-intel", Stage: "failed", Category: "timeout", Source: "terminal"}}}
			if closeFails {
				hb.fl.closeErrs = map[string]error{"w1": errors.New("close refused")}
			}
			a := hireArgs(0)
			a.Harness, a.Model, a.Effort = "codex", "gpt-6-astra", "ultra"
			a.Prompt = "task to preserve"
			_, m := hb.c.command(proto.CmdWorkerHire, "startup", a)
			e := errorOf(m)
			if e.Code != proto.ErrHireFailed || !strings.Contains(e.Message, "code-intel timed out") {
				t.Fatalf("failure %s", m.raw)
			}
			data, ok := e.Data.(map[string]any)
			if !ok || data["delivery"] != "not_sent" || data["retryable"] != !closeFails || data["operation"] == "" {
				t.Fatalf("recovery %s", m.raw)
			}
			audit := auditRow(t, hb.bridge, proto.CmdWorkerHire)
			if !strings.Contains(audit.Result, `"startup"`) || !strings.Contains(audit.Result, "code-intel") || !strings.Contains(audit.Result, `"delivery":"not_sent"`) {
				t.Fatalf("audit lost evidence: %+v", audit)
			}
			for _, text := range []string{string(m.raw), audit.Result, audit.Error} {
				if strings.Contains(text, "PRIVATE") {
					t.Fatal("raw startup error leaked")
				}
			}
			for _, call := range hb.fl.Calls() {
				if strings.HasPrefix(call, "prompt ") {
					t.Fatalf("prompt sent during failed startup: %s", call)
				}
			}
		})
	}
}

func TestHirePromptDeliveryEvidence(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		delivery string
	}{
		{"accepted", nil, "accepted"},
		{"confirmed unsent", &herdr.APIError{Code: "agent_not_ready", Message: "starting"}, "not_sent"},
		{"lost reply", errors.New("connection dropped"), "unknown"},
		{"stalled", &herdr.APIError{Code: "agent_prompt_stalled", Message: "no acknowledgement"}, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hb := startHireBridge(t, nil)
			if tc.err != nil {
				for range 1000 {
					hb.fl.promptErrs = append(hb.fl.promptErrs, tc.err)
				}
			}
			a := hireArgs(0)
			a.Harness, a.Model, a.Effort = "codex", "gpt-6-astra", "ultra"
			a.Prompt = "only once"
			_, m := hb.c.command(proto.CmdWorkerHire, "delivery", a)
			r := ackData[proto.HireResult](t, m)
			if r.Delivery != tc.delivery {
				t.Fatalf("delivery %s", m.raw)
			}
		})
	}
}

func TestMCPStartupNotificationUpdatesWorker(t *testing.T) {
	sb, _ := asyncWorker(t)
	sb.emit(note("mcpServer/startupStatus/updated", map[string]any{"name": "code-intel", "status": "failed", "error": "timeout https://PRIVATE.example"}))
	v := sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return len(c.Startup) == 1 })
	if v.Startup[0].Category != "timeout" || v.Startup[0].Stage != "failed" {
		t.Fatalf("failure %+v", v.Startup)
	}
	sb.emit(note("mcpServer/startupStatus/updated", map[string]any{"name": "code-intel", "status": "ready"}))
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return len(c.Startup) == 1 && c.Startup[0].Stage == "ready" })
}

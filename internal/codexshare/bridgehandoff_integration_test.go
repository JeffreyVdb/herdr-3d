//go:build integration

package codexshare

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TestCodexShareBridgeAgentHandoff (#224): herdr-world asks a Codex worker
// (the real TUI, mock inference) for a handoff through the fixture's own
// "handoff" skill: the catalog lists it, the request goes out once as
// "$handoff <instruction>" with the reserved path, the agent's shell call
// writes the .tmp and renames it, and once its turn ended the bridge files
// it as an agent handoff with its own front matter. A second request whose
// turn writes nothing fails and files nothing. No real model is called.
func TestCodexShareBridgeAgentHandoff(t *testing.T) {
	f := newFx(t, fxOptions{noMCP: true}, "bare-h")
	f.installHerdrHook()
	// The fixture's own handoff skill (never the user's): the bridge only
	// checks Codex lists it.
	skill := filepath.Join(f.home, "skills", "handoff")
	if err := os.MkdirAll(skill, 0o755); err != nil {
		t.Fatal(err)
	}
	f.write(filepath.Join(skill, "SKILL.md"), "---\nname: handoff\ndescription: Fixture handoff skill for the #224 checks.\n---\n\nWrite the handoff where the request says.\n", 0o644)
	hdir := filepath.Join(f.root, "handoff")
	b := f.startBridge(bridgeOptions{handoffs: hdir})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
	w := c.hire("h", "bare-h", 0)
	c.prompt("first", w.id, "MOCK:say ready")
	c.settle(w)

	var pv proto.WorkerHandoffPreviewResult
	raw := c.ack(proto.CmdWorkerHandoffPreview, proto.WorkerHandoffPreviewArgs{Worker: w.id, Mode: proto.HandoffModeAgent}, 60*time.Second, &pv)
	f.record("preview.json", scrub(f, string(raw)))
	if pv.Agent == nil || !pv.Agent.CanAsk || pv.Agent.Call != "$handoff" {
		t.Fatalf("agent preview: %s", raw)
	}

	path := filepath.Join(hdir, handoff.PendingDir, handoff.FloorDir(f.h.Name), "op-ok.md")
	write := fmt.Sprintf(`sh -c "printf '# Codex fixture handoff\n\nWritten by the mock.\n' > %s.tmp && mv %s.tmp %s"`, path, path, path)
	before := len(f.mock.Requests())
	var res proto.WorkerHandoffRequestResult
	raw = c.ack(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: w.id, Mode: proto.HandoffModeAgent, Op: "op-ok",
		Instruction: "MOCK:shell " + write}, 120*time.Second, &res)
	f.record("ask-ack.json", scrub(f, string(raw)))
	if res.Request.State != proto.AgentHandoffPending {
		t.Fatalf("ask: %s", raw)
	}
	got := c.waitWorker("filed", w.id, 120*time.Second, func(x proto.Worker) bool {
		return x.AgentHandoff != nil && (x.AgentHandoff.State == proto.AgentHandoffFiled || x.AgentHandoff.State == proto.AgentHandoffFailed)
	})
	f.recordJSON("filed-view", got.AgentHandoff)
	if got.AgentHandoff.State != proto.AgentHandoffFiled {
		t.Fatalf("not filed: %+v", got.AgentHandoff)
	}
	var sent []string
	for _, r := range f.mock.Requests()[before:] {
		if strings.Contains(r.UserText, "H3D-HANDOFF") {
			sent = append(sent, r.UserText)
		}
	}
	f.record("mock-user-texts.txt", scrub(f, strings.Join(sent, "\n----\n")))
	if len(sent) == 0 || !strings.Contains(sent[0], "$handoff MOCK:shell") || !strings.Contains(sent[0], path+".tmp") {
		t.Fatalf("the request the model saw: %q", sent)
	}
	var list proto.HandoffListResult
	c.ack(proto.CmdHandoffList, proto.HandoffListArgs{Floor: f.h.Name}, 30*time.Second, &list)
	if len(list.Handoffs) != 1 || list.Handoffs[0].Source != proto.HandoffSourceAgent || list.Handoffs[0].Title != "Codex fixture handoff" ||
		list.Handoffs[0].Harness != "codex" {
		t.Fatalf("cabinet: %+v", list.Handoffs)
	}
	body, err := os.ReadFile(list.Handoffs[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	f.record("filed.md", scrub(f, string(body)))
	fm, text := handoff.SplitFrontMatter(string(body))
	if fm["source"] != "agent" || fm["op"] != "op-ok" || text != "# Codex fixture handoff\n\nWritten by the mock.\n" {
		t.Fatalf("filed file:\n%s", body)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("the reserved file is still there: %v", err)
	}
	c.settle(w)

	// A turn that writes nothing: failed with why, nothing filed.
	c.ack(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: w.id, Mode: proto.HandoffModeAgent, Op: "op-none",
		Instruction: "MOCK:say I saved it somewhere else."}, 120*time.Second, nil)
	got = c.waitWorker("failed", w.id, 120*time.Second, func(x proto.Worker) bool {
		return x.AgentHandoff != nil && x.AgentHandoff.Op == "op-none" && x.AgentHandoff.State == proto.AgentHandoffFailed
	})
	f.recordJSON("failed-view", got.AgentHandoff)
	if !strings.Contains(got.AgentHandoff.Reason, "without the handoff") {
		t.Fatalf("failed: %+v", got.AgentHandoff)
	}
	c.ack(proto.CmdHandoffList, proto.HandoffListArgs{Floor: f.h.Name}, 30*time.Second, &list)
	if len(list.Handoffs) != 1 {
		t.Fatalf("cabinet after the failure: %+v", list.Handoffs)
	}
}

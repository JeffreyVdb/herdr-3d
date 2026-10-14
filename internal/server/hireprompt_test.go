package server_test

import (
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// sentPrompt is the first prompt herdr was given for pane (sent or typed).
func sentPrompt(t *testing.T, hb *hireBridge, pane string) string {
	t.Helper()
	for _, call := range hb.fl.Calls() {
		for _, verb := range []string{"prompt ", "type "} {
			if rest, ok := strings.CutPrefix(call, verb+pane+" "); ok {
				s, err := strconv.Unquote(rest)
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
		}
	}
	t.Fatalf("no prompt for %s in %q", pane, hb.fl.Calls())
	return ""
}

// cachedAsks are the translator's TranslateCached asks.
func cachedAsks(fp *fakePrompts) []string {
	var out []string
	for _, a := range fp.Asks() {
		if strings.HasPrefix(a, "cached ") {
			out = append(out, a)
		}
	}
	return out
}

// #39: a hire's first task is what a person typed in the dialog, with the
// skills and files completion offered: a Codex hire gets it translated
// ($skill, plain paths) from the catalog already cached for the folder it
// was looked up in, never waiting for a probe; a Claude hire gets it as
// typed. A worktree hire's skills are its repository root's (where the
// dialog looked), its files the new worktree's.
func TestHireFirstPromptIsTranslated(t *testing.T) {
	t.Parallel()
	fp := &fakePrompts{}
	hb := startHireBridge(t, func(o *server.Options) { o.Prompts = fp })
	hb.git.repos["/home/u/repo/sub"] = "/home/u/repo"
	const typed = "run /grill on @a.go"
	hire := func(desk int, harness string, worktree bool) proto.HireResult {
		t.Helper()
		a := hireArgs(desk)
		if harness == "codex" {
			a.Harness, a.Model, a.Effort = "codex", "gpt-6-astra", "ultra"
		}
		if worktree {
			a.Cwd, a.Worktree = "/home/u/repo/sub", true
		}
		a.Prompt = typed
		_, m := hb.c.command(proto.CmdWorkerHire, "h"+strconv.Itoa(desk), a)
		res := ackData[proto.HireResult](t, m)
		if res.Prompted == nil || !*res.Prompted {
			t.Fatalf("ack = %s", m.raw)
		}
		return res
	}

	res := hire(0, "claude", false)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != typed {
		t.Fatalf("claude got %q", got)
	}
	if asks := cachedAsks(fp); len(asks) != 0 {
		t.Fatalf("a Claude prompt was translated: %q", asks)
	}

	res = hire(1, "codex", false)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != "run $grill on a.go" {
		t.Fatalf("codex got %q", got)
	}
	if asks := cachedAsks(fp); !slices.Equal(asks, []string{"cached codex /home/u /home/u " + typed}) {
		t.Fatalf("asks = %q", asks)
	}

	res = hire(2, "codex", true)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != "run $grill on a.go" {
		t.Fatalf("worktree codex got %q", got)
	}
	checkout := "/home/u/.herdr/worktrees/repo/" + strings.ReplaceAll(res.Branch, "/", "-")
	if asks := cachedAsks(fp); len(asks) != 2 || asks[1] != "cached codex /home/u/repo "+checkout+" "+typed {
		t.Fatalf("worktree asks = %q", asks)
	}

	// No catalog cached for the folder yet: the skill goes as typed (the files are still rewritten), at once.
	fp.mu.Lock()
	fp.cold = true
	fp.mu.Unlock()
	res = hire(3, "codex", false)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != "run /grill on a.go" {
		t.Fatalf("cold codex got %q", got)
	}
	// The translator's blocking path is never used for a first prompt.
	for _, a := range fp.Asks() {
		if !strings.HasPrefix(a, "cached ") {
			t.Fatalf("Translate was asked: %q", a)
		}
	}
}

// #39: a Codex first prompt that ends in a $skill leaves the skill popup
// open, which takes the Enter (agent_prompt_stalled): the hire presses the
// harness's retry keys (Esc, then Enter), as a follow-up does.
func TestHireStalledPromptPressesRetryKeys(t *testing.T) {
	t.Parallel()
	fp := &fakePrompts{}
	term := newFakeTerm()
	hb := startHireBridge(t, func(o *server.Options) { o.Prompts, o.Term = fp, term })
	term.onKeys = func(pane string, keys []string) {
		if slices.Equal(keys, []string{"esc", "enter"}) {
			hb.fl.update(wsOf(pane), func(w *world.WorkerObs) { w.Status = "working" })
		}
	}
	hb.fl.promptErrs = []error{&herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000 ms"}}
	a := hireArgs(0)
	a.Harness, a.Model, a.Effort = "codex", "gpt-6-astra", "ultra"
	a.Prompt = "please use /grill"
	_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	res := ackData[proto.HireResult](t, m)
	if res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	pane := res.WorkspaceID + ":p1"
	if got := sentPrompt(t, hb, pane); got != "please use $grill" {
		t.Fatalf("sent %q", got)
	}
	if calls := term.Calls(); !slices.Equal(calls, []string{"keys " + pane + " esc enter"}) {
		t.Fatalf("term calls = %q", calls)
	}
	if slices.Contains(hb.fl.Calls(), "key "+pane+" enter") {
		t.Fatalf("a lone Enter was pressed: %q", hb.fl.Calls())
	}

	// A prompt that does not end in a skill keeps the lone Enter.
	enters := 0
	hb.fl.onKey = func(pane string, key herdr.Key) {
		if key == herdr.KeyEnter {
			if enters++; enters == 1 {
				hb.fl.update(wsOf(pane), func(w *world.WorkerObs) { w.Status = "working" })
			}
		}
	}
	hb.fl.promptErrs = []error{&herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000 ms"}}
	a.DeskIndex, a.Prompt = ptr(1), "use /grill on it"
	_, m = hb.c.command(proto.CmdWorkerHire, "h2", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	if enters != 1 || len(term.Calls()) != 1 {
		t.Fatalf("enters %d, term calls %q", enters, term.Calls())
	}
}

// #39: run.start translates what was typed, once, when the orchestrator is
// hired: the extra inside the composed prompt (never the ticket the bridge
// composes around it, whatever its text holds), or an edited prompt whole.
// The ack's prompt is the one sent.
func TestRunStartTranslatesTypedTextOnly(t *testing.T) {
	t.Parallel()
	fp := &fakePrompts{}
	hb2, w := launchBridgeWith(t, fp)
	seed := w.Presets[0].ID
	orch := proto.Hire{Harness: "codex", Model: "gpt-6-astra", Effort: "ultra"}
	start := func(desk int, args map[string]any) proto.RunStartResult {
		t.Helper()
		args["session"], args["desk_index"], args["orch"], args["preset"] = "s", desk, orch, seed
		_, m := hb2.c.command(proto.CmdRunStart, "rs"+strconv.Itoa(desk), args)
		if m.env.T != proto.TAck {
			t.Fatalf("run.start: %s", m.raw)
		}
		return ackData[proto.RunStartResult](t, m)
	}

	res := start(1, map[string]any{"text": "Fix /grill and @a.go in the lobby", "extra": "Please use /grill on @a.go"})
	want := "$write-code Fix /grill and @a.go in the lobby\n\n" + buildHead + "\n\nPlease use $grill on a.go"
	if got := sentPrompt(t, hb2, res.WorkspaceID+":p1"); got != want || res.Prompt != want {
		t.Fatalf("composed prompt sent\n%q\nack %q\nwant\n%q", got, res.Prompt, want)
	}
	checkout := "/home/u/.herdr/worktrees/repo/" + strings.ReplaceAll(res.Branch, "/", "-")
	if asks := cachedAsks(fp); !slices.Equal(asks, []string{"cached codex /home/u/lab " + checkout + " Please use /grill on @a.go"}) {
		t.Fatalf("asks = %q", asks)
	}

	res = start(2, map[string]any{"text": "Fix the lobby", "prompt": "Do /grill with @a.go"})
	if got := sentPrompt(t, hb2, res.WorkspaceID+":p1"); got != "Do $grill with a.go" || res.Prompt != got {
		t.Fatalf("edited prompt sent %q, ack %q", got, res.Prompt)
	}
	if asks := cachedAsks(fp); len(asks) != 2 || !strings.HasSuffix(asks[1], " Do /grill with @a.go") {
		t.Fatalf("asks = %q", asks)
	}
}

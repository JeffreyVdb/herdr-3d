package server_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// H3D-2: what a worker shows as its model and effort, field by field: what
// its current agent session's transcript says, else what was reported (hire
// op, stored record, h3d_* tokens), else nothing. The transcript's values are
// never stored.

const (
	codexA = "0a0b0c0d-7777-4777-8777-77777777777a"
	codexB = "0a0b0c0d-7777-4777-8777-77777777777b"
)

type modelMetaEnv struct {
	t      *testing.T
	codex  string // Roots.CodexSessions
	claude string // Roots.ClaudeProjects
	db     string
	clk    *clock // the bridge's, which the usage tracker's rescans follow
}

func newModelMetaEnv(t *testing.T) *modelMetaEnv {
	t.Helper()
	return &modelMetaEnv{t: t, codex: t.TempDir(), claude: t.TempDir(), db: filepath.Join(t.TempDir(), "world.db"), clk: newClock(1_000_000)}
}

// discover lets the tracker look again for a transcript it missed: it
// waits usage.MissRescan between looks.
func (e *modelMetaEnv) discover() { e.clk.advance(usage.MissRescan + time.Second) }

// start runs a bridge reading the env's transcripts (or none, as a bridge
// without usage config does).
func (e *modelMetaEnv) start(transcripts bool) *bridge {
	opts := server.Options{Now: e.clk.now}
	if transcripts {
		opts.Usage = &server.UsageConfig{Roots: usage.Roots{CodexSessions: e.codex, ClaudeProjects: e.claude},
			Interval: 10 * time.Millisecond, Throttle: 10 * time.Millisecond}
	}
	return startBridge(e.t, e.db, opts)
}

func (e *modelMetaEnv) rollout(session string) string {
	return filepath.Join(e.codex, "2026", "10", "19", "rollout-x-"+session+".jsonl")
}

func (e *modelMetaEnv) transcript(session string) string {
	return filepath.Join(e.claude, "-home-u-w1", session+".jsonl")
}

func (e *modelMetaEnv) write(path string, lines ...string) {
	e.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		e.t.Fatal(err)
	}
	var s string
	for _, l := range lines {
		s += l + "\n"
	}
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		e.t.Fatal(err)
	}
}

// writeRollout starts a Codex rollout, which is found by the id its first
// line carries.
func (e *modelMetaEnv) writeRollout(session string, lines ...string) {
	e.t.Helper()
	meta := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"model_provider":"openai","cwd":"/home/u/w1"}}`, session)
	e.write(e.rollout(session), append([]string{meta}, lines...)...)
}

// append adds lines to a transcript and moves the clock past the usage
// throttle, so that they are published.
func (e *modelMetaEnv) append(path string, lines ...string) {
	e.t.Helper()
	e.clk.advance(time.Minute)
	for _, l := range lines {
		appendLine(e.t, path, l+"\n")
	}
}

// turnContext is a Codex rollout's turn_context line; effort "" leaves it out.
func turnContext(model, effort string) string {
	if effort == "" {
		return fmt.Sprintf(`{"type":"turn_context","payload":{"model":%q}}`, model)
	}
	return fmt.Sprintf(`{"type":"turn_context","payload":{"model":%q,"effort":%q}}`, model, effort)
}

// codexTokens is a token_count: a rollout has no usage to show without one.
func codexTokens(total int) string {
	return fmt.Sprintf(`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"output_tokens":10,`+
		`"total_tokens":%d},"last_token_usage":{"input_tokens":%d,"total_tokens":%d},"model_context_window":258400}}}`, total, total+10, total, total)
}

// claudeAssistant is a Claude Code assistant line; effort "" leaves it out.
func claudeAssistant(id, model, effort string) string {
	e := ""
	if effort != "" {
		e = fmt.Sprintf(`"effort":%q,`, effort)
	}
	return fmt.Sprintf(`{"type":"assistant",%s"message":{"id":%q,"model":%q,"usage":{"input_tokens":100,"output_tokens":10,`+
		`"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}`, e, id, model)
}

// codexWorker is a Codex agent on workspace w1 as herdr reports it, with
// the floor token only: what a raw `herdr agent start` leaves.
func codexWorker(session string) world.WorkerObs {
	w := worker("w1", "CODE|w1", session, "working")
	w.AgentKind = world.HarnessCodex
	w.Tokens = map[string]string{"h3d_floor": "s"}
	w.Harness, _, _ = world.HarnessOf(w.Tokens, w.AgentKind)
	return w
}

// reported adds what a direct hire's tokens say.
func reported(w world.WorkerObs, harness, model, effort string) world.WorkerObs {
	w.Harness, w.Model, w.Effort = harness, model, effort
	return w
}

func shown(b *bridge, ok func(proto.Worker) bool) proto.Worker {
	b.t.Helper()
	var got proto.Worker
	b.world(func(w proto.World) bool {
		got = workersOf(w, "s")["w1"]
		return got.ID != "" && ok(got)
	})
	return got
}

// stored fails the test unless the store's record of the floor's only worker has this model and effort.
func stored(b *bridge, model, effort string) {
	b.t.Helper()
	recs, err := b.st.SessionWorkers(context.Background(), "s")
	if err != nil || len(recs) != 1 {
		b.t.Fatalf("stored workers = %+v, %v", recs, err)
	}
	if recs[0].Model != model || recs[0].Effort != effort {
		b.t.Fatalf("stored model %q effort %q, want %q %q", recs[0].Model, recs[0].Effort, model, effort)
	}
}

func is(model, effort string) func(proto.Worker) bool {
	return func(w proto.Worker) bool { return w.Model == model && w.Effort == effort }
}

func TestRawCodexWorkerShowsItsTranscriptsModelAndEffort(t *testing.T) {
	t.Parallel()
	e := newModelMetaEnv(t)
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "medium"), codexTokens(1000))
	b := e.start(true)
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, codexWorker(codexA))
	// The first upsert has nothing yet; the next one has the transcript's.
	var up proto.Event
	for up = c.until(proto.EvWorkerUpsert); up.Worker.Model == ""; up = c.until(proto.EvWorkerUpsert) {
	}
	if up.Worker.Model != "gpt-6.1-sol" || up.Worker.Effort != "medium" || up.Worker.Harness != world.HarnessCodex {
		t.Fatalf("worker.upsert = %+v", up.Worker)
	}
	got := shown(b, is("gpt-6.1-sol", "medium"))
	if got.Usage == nil || got.Usage.Model != "gpt-6.1-sol" {
		t.Fatalf("snapshot worker = %+v", got)
	}
	stored(b, "", "")
	b.stop()

	// Restarted without a transcript to read: what was observed was never
	// stored, so nothing is shown.
	b2 := e.start(false)
	b2.floor("s", true, codexWorker(codexA))
	if got := shown(b2, func(proto.Worker) bool { return true }); got.Model != "" || got.Effort != "" {
		t.Fatalf("after a restart without the transcript: model %q effort %q", got.Model, got.Effort)
	}
}

func TestDirectHireShowsItsHireUntilItsTranscriptSaysOtherwise(t *testing.T) {
	t.Parallel()
	e := newModelMetaEnv(t)
	b := e.start(true)
	b.floor("s", true, reported(codexWorker(codexA), "codex", "gpt-6.1-sol", "high"))
	// No transcript yet: the hire's.
	shown(b, is("gpt-6.1-sol", "high"))
	// It says the same: nothing to flip.
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "high"), codexTokens(1000))
	e.discover()
	got := shown(b, func(w proto.Worker) bool { return w.Usage != nil })
	if got.Model != "gpt-6.1-sol" || got.Effort != "high" {
		t.Fatalf("same transcript: %+v", got)
	}
	// The session switched model mid-way: the hire's declaration loses.
	e.append(e.rollout(codexA), turnContext("gpt-6.1-luna", "medium"), codexTokens(2000))
	shown(b, is("gpt-6.1-luna", "medium"))
	stored(b, "gpt-6.1-sol", "high") // the record stays the hire
	e.clk.advance(time.Minute)
	b.floor("s", true, reported(codexWorker(codexA), "codex", "gpt-6.1-sol", "high")) // another sync of the worker
	shown(b, is("gpt-6.1-luna", "medium"))
	stored(b, "gpt-6.1-sol", "high")
}

// A transcript that agrees with the hire never changes what the worker
// shows: no upsert between the first sight and the usage, and the usage
// arrives as a worker.usage, not an upsert.
func TestAgreeingTranscriptDoesNotFlipTheLabel(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, harness, model, effort string
		setup                        func(e *modelMetaEnv, session string)
		session                      string
		kind                         string
	}{
		{"codex", "codex", "gpt-6.1-sol", "high", func(e *modelMetaEnv, s string) {
			e.writeRollout(s, turnContext("gpt-6.1-sol", "high"), codexTokens(1000))
		}, codexA, world.HarnessCodex},
		{"claude [1m]", "claude", "claude-opus-5-5", "high", func(e *modelMetaEnv, s string) {
			e.write(e.transcript(s), claudeAssistant("m1", "claude-opus-5-5[1m]", "high"))
		}, "0a0b0c0d-7777-4777-8777-77777777777c", world.HarnessClaude},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newModelMetaEnv(t)
			tc.setup(e, tc.session)
			b := e.start(true)
			c := b.connect(proto.Hello{})
			c.snapshot()
			w := reported(worker("w1", "CODE|w1", tc.session, "working"), tc.harness, tc.model, tc.effort)
			w.AgentKind = tc.kind
			b.floor("s", true, w)
			for {
				ev := c.event()
				if ev.T == proto.EvWorkerUsage {
					break
				}
				if ev.T == proto.EvWorkerUpsert && (ev.Worker.Model != tc.model || ev.Worker.Effort != tc.effort) {
					t.Fatalf("an upsert flipped the label: %+v", ev.Worker)
				}
			}
			shown(b, is(tc.model, tc.effort))
		})
	}
}

func TestTranscriptAppearingLaterIsObservedWhenItAppears(t *testing.T) {
	t.Parallel()
	e := newModelMetaEnv(t)
	b := e.start(true)
	b.floor("s", true, codexWorker(codexA))
	if got := shown(b, func(proto.Worker) bool { return true }); got.Model != "" || got.Effort != "" {
		t.Fatalf("before the rollout: model %q effort %q", got.Model, got.Effort)
	}
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "medium"), codexTokens(1000))
	e.discover()
	shown(b, is("gpt-6.1-sol", "medium"))
}

// Each field on its own: a transcript that records no effort leaves the
// reported effort (or none), and one that does overrides only that.
func TestEffortIsNeverInvented(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-7777-4777-8777-77777777777d"
	e := newModelMetaEnv(t)
	e.write(e.transcript(sess), claudeAssistant("m1", "claude-opus-5-5", ""))
	b := e.start(true)
	w := worker("w1", "CODE|w1", sess, "working")
	w.AgentKind = world.HarnessClaude
	b.floor("s", true, w)
	if got := shown(b, func(w proto.Worker) bool { return w.Model != "" }); got.Model != "claude-opus-5-5" || got.Effort != "" {
		t.Fatalf("no effort anywhere: model %q effort %q", got.Model, got.Effort)
	}
	// Reported effort stays under an observed model.
	b.floor("s", true, reported(w, "claude", "claude-fable-5-1", "high"))
	if got := shown(b, is("claude-opus-5-5", "high")); got.Usage == nil {
		t.Fatalf("worker = %+v", got)
	}
	// A transcript that records one wins, for the effort alone.
	e.append(e.transcript(sess), claudeAssistant("m2", "claude-opus-5-5", "xhigh"))
	shown(b, is("claude-opus-5-5", "xhigh"))
}

func TestObservedChangesWithinTheSessionShow(t *testing.T) {
	t.Parallel()
	e := newModelMetaEnv(t)
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "medium"), codexTokens(1000))
	b := e.start(true)
	b.floor("s", true, codexWorker(codexA))
	shown(b, is("gpt-6.1-sol", "medium"))
	e.append(e.rollout(codexA), turnContext("gpt-6.1-sol", "high"), codexTokens(2000))
	shown(b, is("gpt-6.1-sol", "high"))
	e.append(e.rollout(codexA), turnContext("gpt-6.1-luna", "high"), codexTokens(3000))
	shown(b, is("gpt-6.1-luna", "high"))
	// A turn that states no effort: unknown again (this worker has no reported one).
	e.append(e.rollout(codexA), turnContext("gpt-6.1-luna", ""), codexTokens(4000))
	shown(b, is("gpt-6.1-luna", ""))
}

// Another agent session in the workspace: the old one's evidence goes at
// once, the new one's shows when its transcript says something, and none
// of it is stored.
func TestNewAgentSessionDropsTheOldEvidence(t *testing.T) {
	t.Parallel()
	e := newModelMetaEnv(t)
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "medium"), codexTokens(1000))
	b := e.start(true)
	b.floor("s", true, reported(codexWorker(codexA), "codex", "gpt-6.1-terra", "low"))
	shown(b, is("gpt-6.1-sol", "medium"))

	// B has no transcript yet: the reported values show, not A's.
	b.floor("s", true, reported(codexWorker(codexB), "codex", "gpt-6.1-terra", "low"))
	shown(b, func(w proto.Worker) bool {
		return w.AgentSession == codexB && w.Model == "gpt-6.1-terra" && w.Effort == "low" && w.Usage == nil
	})
	e.writeRollout(codexB, turnContext("gpt-6.1-luna", "high"), codexTokens(500))
	e.discover()
	shown(b, func(w proto.Worker) bool {
		return w.AgentSession == codexB && w.Model == "gpt-6.1-luna" && w.Effort == "high"
	})
	b.stop()

	// A bridge restart with A's session back and B's transcript gone from
	// view: A's transcript speaks for A, and the stored record is the hire.
	b2 := e.start(false)
	b2.floor("s", true, worker("w1", "CODE|w1", codexA, "working"))
	if got := shown(b2, func(w proto.Worker) bool { return w.AgentSession == codexA }); got.Model != "gpt-6.1-terra" || got.Effort != "low" {
		t.Fatalf("stored record after the restart: model %q effort %q", got.Model, got.Effort)
	}
}

// After a restart the worker's session is the one whose transcript is
// read: a stale model of the previous session never comes back.
func TestRestartReadsTheCurrentSessionsTranscript(t *testing.T) {
	t.Parallel()
	e := newModelMetaEnv(t)
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "medium"), codexTokens(1000))
	e.writeRollout(codexB, turnContext("gpt-6.1-luna", "low"), codexTokens(1000))
	b := e.start(true)
	b.floor("s", true, codexWorker(codexA))
	shown(b, is("gpt-6.1-sol", "medium"))
	b.stop()

	b2 := e.start(true)
	b2.floor("s", true, codexWorker(codexB))
	shown(b2, func(w proto.Worker) bool {
		return w.AgentSession == codexB && w.Model == "gpt-6.1-luna" && w.Effort == "low"
	})
}

// #192: observed model and effort require identity and disappear on session replacement.
func TestIdentifiedEvidenceDoesNotSurviveANamedSessionChange(t *testing.T) {
	e := newModelMetaEnv(t)
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "medium"), codexTokens(1000))
	b := e.start(true)
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, codexWorker(""))
	w := shown(b, func(w proto.Worker) bool { return w.AgentSession == "" })
	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: w.ID})
	if res := decode[proto.TranscriptWatchResult](t, ack); !res.Pending || len(res.Items) != 0 {
		t.Fatalf("unidentified transcript: %+v", res)
	}
	if w.Model != "" || w.Effort != "" || w.Usage != nil {
		t.Fatalf("unidentified evidence: %+v", w)
	}

	// The same rollout, now named; unchanged usage rounds pass without a
	// republish (they would not have retagged it).
	b.floor("s", true, codexWorker(codexA))
	shown(b, func(w proto.Worker) bool {
		return w.AgentSession == codexA && w.Model == "gpt-6.1-sol" && w.Effort == "medium"
	})
	time.Sleep(100 * time.Millisecond)

	b.floor("s", true, codexWorker(codexB))
	for {
		ev := c.until(proto.EvWorkerUpsert)
		if ev.Worker.AgentSession != codexB {
			continue
		}
		if ev.Worker.Model != "" || ev.Worker.Effort != "" {
			t.Fatalf("first upsert of the new session shows the old one's evidence: model %q effort %q", ev.Worker.Model, ev.Worker.Effort)
		}
		return
	}
}

// #192: repeated observations of a worker with no identity cannot adopt a model from its directory.
func TestUnidentifiedWorkerHasNoTranscriptEvidence(t *testing.T) {
	t.Parallel()
	e := newModelMetaEnv(t)
	e.writeRollout(codexA, turnContext("gpt-6.1-sol", "medium"), codexTokens(1000))
	b := e.start(true)
	c := b.connect(proto.Hello{})
	c.snapshot()
	for range 2 {
		b.floor("s", true, codexWorker(""))
		w := shown(b, func(w proto.Worker) bool { return w.AgentSession == "" })
		c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: w.ID})
		got := shown(b, func(w proto.Worker) bool { return w.AgentSession == "" })
		if got.Model != "" || got.Effort != "" || got.Usage != nil {
			t.Fatalf("unidentified evidence: %+v", got)
		}
		e.discover()
	}
}

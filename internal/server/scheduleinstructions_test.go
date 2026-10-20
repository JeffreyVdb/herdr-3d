package server_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #127: schedules' "Add herdr hiring instructions".

// virtualFloor makes a virtual floor of the session "s" and returns its id.
func (sb *schedBridge) virtualFloor(name string) string {
	sb.t.Helper()
	_, ack := sb.c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: name, BaseSession: "s"})
	id := ack.Data.(map[string]any)["id"].(string)
	if !strings.HasPrefix(id, "v-") {
		sb.t.Fatalf("virtual floor id %q", id)
	}
	return id
}

// The snapshot says schedules take the flag; it is off unless sent, in
// the ack, every client's schedule.upsert and the snapshot; an update
// replaces it with the rest of the spec, and it survives a restart.
func TestScheduleHerdrInstructionsSaved(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	if w := sb.connect(proto.Hello{}).snapshot().World; !w.ScheduleHerdrInstructions || !w.HerdrInstructions {
		t.Fatal("snapshot has no schedule_herdr_instructions")
	}
	other := sb.connect(proto.Hello{Client: "other"})
	other.snapshot()
	mon := sb.virtualFloor("Monitoring")
	due := t0.Add(time.Hour)

	sp := spec(due)
	sp.Floor = mon
	if off := sb.create(sp); off.HerdrInstructions {
		t.Fatalf("unsent flag is on: %+v", off)
	}
	sp.HerdrInstructions = true
	evs, m := sb.c.command(proto.CmdScheduleCreate, "on", sp)
	s := ackData[proto.Schedule](t, m)
	if !s.HerdrInstructions || s.Prompt != sp.Prompt || len(evs) != 1 || !evs[0].Schedule.HerdrInstructions {
		t.Fatalf("created %s, events %+v", m.raw, evs)
	}
	if ev := other.until(proto.EvScheduleUpsert); ev.Schedule.ID == s.ID && !ev.Schedule.HerdrInstructions {
		t.Fatalf("other client: %+v", ev.Schedule)
	}
	if row, err := sb.st.ScheduleByID(context.Background(), s.ID); err != nil || !row.HerdrInstructions || row.Prompt != sp.Prompt {
		t.Fatalf("stored %+v, %v", row, err)
	}

	up := proto.ScheduleUpdateArgs{ID: s.ID, ScheduleSpec: sp}
	up.HerdrInstructions = false
	if _, m = sb.c.command(proto.CmdScheduleUpdate, "u1", up); ackData[proto.Schedule](t, m).HerdrInstructions {
		t.Fatalf("update off: %s", m.raw)
	}
	up.HerdrInstructions = true
	evs, m = sb.c.command(proto.CmdScheduleUpdate, "u2", up)
	if !ackData[proto.Schedule](t, m).HerdrInstructions || len(evs) != 1 || !evs[0].Schedule.HerdrInstructions {
		t.Fatalf("update on: %s, %+v", m.raw, evs)
	}

	sb.stop()
	sb = startSchedBridgeAt(t, sb.db, sb.clk, nil)
	if got := sb.schedule(s.ID, inState(proto.ScheduleScheduled)); !got.HerdrInstructions || got.Floor != mon {
		t.Fatalf("after a restart %+v", got)
	}
}

// A fire on a virtual floor with the flag gets that floor's lines (its
// v-… id, not the base session's), once and last: a fire on time, run
// now, a retry; after a late run's notice and a handoff too. Off, the
// prompt is exactly what it was before #127.
func TestScheduleHerdrInstructionsFire(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	mon := sb.virtualFloor("Monitoring")
	lines := "\n\n" + herdrLines(mon)
	path := filepath.Join(t.TempDir(), "20261016-0900-pixel-soak.md")
	if err := os.WriteFile(path, []byte("# Soak\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mk := func(due time.Time, flag bool, mut func(*proto.ScheduleSpec)) proto.Schedule {
		sp := spec(due)
		sp.Floor, sp.HerdrInstructions = mon, flag
		if mut != nil {
			mut(&sp)
		}
		return sb.create(sp)
	}
	last := func(id string) string {
		t.Helper()
		sb.schedule(id, inState(proto.ScheduleDone))
		p := sb.prompts()
		return p[len(p)-1]
	}
	once := func(what, got, want string) {
		t.Helper()
		if got != want {
			t.Fatalf("%s: prompt\n%q\nwant\n%q", what, got, want)
		}
		if n := strings.Count(got, placementLine); n != 1 || strings.Contains(got, "h3d_floor=s,") {
			t.Fatalf("%s: %d placement lines, base floor named: %q", what, n, got)
		}
	}

	// On time.
	onTime := mk(t0.Add(time.Hour), true, nil)
	sb.at(t0.Add(time.Hour))
	once("on time", last(onTime.ID), "Delete the backups."+lines)

	// Off: as before.
	off := mk(t0.Add(2*time.Hour), false, nil)
	sb.at(t0.Add(2 * time.Hour))
	if got := last(off.ID); got != "Delete the backups." {
		t.Fatalf("off: prompt %q", got)
	}

	// Run now, with a handoff.
	now := mk(t0.Add(10*time.Hour), true, func(sp *proto.ScheduleSpec) { sp.HandoffPath = path })
	sb.c.mustAck(proto.CmdScheduleRunNow, proto.ScheduleArgs{ID: now.ID})
	once("run now", last(now.ID), "Delete the backups.\n\n"+handoff.HireTask(path)+lines)

	// A handoff alone may have the flag.
	alone := mk(t0.Add(11*time.Hour), true, func(sp *proto.ScheduleSpec) { sp.Prompt, sp.HandoffPath = "", path })
	sb.c.mustAck(proto.CmdScheduleRunNow, proto.ScheduleArgs{ID: alone.ID})
	once("handoff alone", last(alone.ID), handoff.HireTask(path)+lines)

	// Retry of a failed fire, an hour late, with a handoff: the notice,
	// the prompt, the handoff, then the lines.
	retried := mk(t0.Add(3*time.Hour), true, func(sp *proto.ScheduleSpec) { sp.HandoffPath = path })
	sb.fl.mu.Lock()
	sb.fl.createErr = errors.New("herdr: no such session")
	sb.fl.mu.Unlock()
	sb.at(t0.Add(3 * time.Hour))
	sb.schedule(retried.ID, inState(proto.ScheduleFailed))
	sb.fl.mu.Lock()
	sb.fl.createErr = nil
	sb.fl.mu.Unlock()
	sb.clk.set(t0.Add(4 * time.Hour).UnixMilli())
	sb.c.mustAck(proto.CmdScheduleRetry, proto.ScheduleArgs{ID: retried.ID})
	got := last(retried.ID)
	notice, rest, _ := strings.Cut(got, "\n\n")
	if !strings.Contains(notice, "1h late") {
		t.Fatalf("retry: no late notice: %q", got)
	}
	once("retry", rest, "Delete the backups.\n\n"+handoff.HireTask(path)+lines)
	sb.harmless()
}

// Size: a prompt that fits alone but not with its floor's lines is refused
// at save (create and update; Claude's typed prompt as typed too); one
// that fits with them is saved, and a late run's notice that pushes it over
// fails that fire, nothing hired.
func TestScheduleHerdrInstructionsSize(t *testing.T) {
	t.Parallel()
	claude, _, _ := catalogTuples(t)
	sb := startSchedBridge(t, nil)
	mon := sb.virtualFloor("Monitoring")
	room := herdr.MaxPrompt - 2 - len(herdrLines(mon))
	for _, harness := range []string{"claude", "codex"} {
		sp := spec(t0.Add(time.Hour))
		if harness == "claude" {
			sp.Harness, sp.Model, sp.Effort = claude.Harness, claude.Model, claude.Effort
		}
		sp.Floor, sp.Prompt, sp.HerdrInstructions = mon, strings.Repeat("x", room+1), true
		_, m := sb.c.command(proto.CmdScheduleCreate, "big-"+harness, sp)
		if e := errorOf(m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, "herdr hiring instructions") {
			t.Fatalf("%s over the limit with the lines: %s", harness, m.raw)
		}
		sp.HerdrInstructions, sp.DueAt = false, t0.Add(10*time.Hour).UnixMilli()
		sb.create(sp) // fits alone
	}
	sp := spec(t0.Add(time.Hour))
	sp.Floor, sp.Prompt, sp.HerdrInstructions = mon, strings.Repeat("x", room), true
	s := sb.create(sp)
	up := proto.ScheduleUpdateArgs{ID: s.ID, ScheduleSpec: sp}
	up.Prompt += "x"
	sb.c.mustError(proto.CmdScheduleUpdate, up, proto.ErrBadRequest)

	// Late: the notice pushes the whole prompt over the limit at the fire.
	sb.at(t0.Add(2 * time.Hour))
	failed := sb.schedule(s.ID, inState(proto.ScheduleFailed))
	if !strings.Contains(failed.StateReason, "prompt must be") || len(sb.creates()) != 0 {
		t.Fatalf("late over the limit: %+v, creates %q", failed, sb.creates())
	}
}

// With prompt secrets reviewed, a reviewed schedule with the flag passes
// its stored prompt's check and fires with the lines; one saved while the
// switch was off is still refused at its fire, nothing sent.
func TestScheduleHerdrInstructionsStoredReview(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	sb := startSchedBridge(t, func(o *server.Options) { o.SecretsDir = dir })
	mon := sb.virtualFloor("Monitoring")
	const before = "Rotate it: DB_PASSWORD=Before-Switch-3!"
	sp := spec(t0.Add(time.Hour))
	sp.Floor, sp.Prompt, sp.HerdrInstructions = mon, before, true
	old := sb.create(sp) // saved while the switch was off
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})

	const kept = "Rotate it: DB_PASSWORD=Kept-As-Typed-8!"
	sp = spec(t0.Add(2 * time.Hour))
	sp.Floor, sp.Prompt, sp.HerdrInstructions, sp.Secrets = mon, kept, true, reviewOf(t, sb.c, kept, "c1")
	s := sb.create(sp)
	if !s.HerdrInstructions {
		t.Fatalf("reviewed: %+v", s)
	}

	sb.at(t0.Add(time.Hour))
	if failed := sb.schedule(old.ID, inState(store.ScheduleFailed)); !strings.Contains(failed.StateReason, "review") ||
		len(sb.prompts()) != 0 {
		t.Fatalf("unreviewed fire: %+v, prompts %q", failed, sb.prompts())
	}
	sb.at(t0.Add(2 * time.Hour))
	sb.schedule(s.ID, inState(store.ScheduleDone))
	if p := sb.prompts(); !slices.Equal(p, []string{kept + "\n\n" + herdrLines(mon)}) {
		t.Fatalf("prompts %q", p)
	}
}

// A Codex schedule's prompt is translated (#39), never the lines the
// bridge adds.
func TestScheduleHerdrInstructionsTranslatesOnlyTheTask(t *testing.T) {
	t.Parallel()
	fp := &fakePrompts{}
	sb := startSchedBridge(t, func(o *server.Options) { o.Prompts = fp })
	mon := sb.virtualFloor("Monitoring")
	const typed = "run /grill on @a.go"
	sp := spec(t0.Add(time.Hour))
	sp.Floor, sp.Prompt, sp.HerdrInstructions = mon, typed, true
	s := sb.create(sp)
	sb.at(t0.Add(time.Hour))
	sb.schedule(s.ID, inState(proto.ScheduleDone))
	if p := sb.prompts(); !slices.Equal(p, []string{"run $grill on a.go\n\n" + herdrLines(mon)}) {
		t.Fatalf("prompts %q", p)
	}
	asks := cachedAsks(fp)
	if len(asks) != 1 || !strings.HasSuffix(asks[0], " "+typed) {
		t.Fatalf("asks = %q", asks)
	}
}

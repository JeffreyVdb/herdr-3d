package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// noLimits switches the notifications' send budget off (#106: the tests of
// everything else run on a clock that does not move).
func noLimits() *notify.Limits {
	l := notify.NoLimits()
	return &l
}

func notifyRows(t *testing.T, st *store.Store, cmd string) []store.AuditEntry {
	t.Helper()
	rows, err := st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []store.AuditEntry
	for _, r := range rows {
		if r.Cmd == cmd {
			out = append(out, r)
		}
	}
	return out
}

func waitNotifyRows(t *testing.T, st *store.Store, cmd string, n int) []store.AuditEntry {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		rows := notifyRows(t, st, cmd)
		if len(rows) >= n || time.Now().After(deadline) {
			if len(rows) < n {
				t.Fatalf("%d %s rows, want %d", len(rows), cmd, n)
			}
			return rows
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// #11: a worker going to needs you sends one message at once, a worker done
// one after the 5 s settle, from the hub's own worker events; what the
// bridge saw first is known and sends nothing; each send is audited without
// its text.
func TestNotifyFromWorkerEvents(t *testing.T) {
	t.Parallel()
	on := true
	ch := notify.NewFakeChannel(true)
	clock := notify.NewFakeClock(time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC))
	b := startBridge(t, "", server.Options{NotifyChannel: ch, NotifyEnabled: &on, NotifyClock: clock, NotifyLimits: noLimits()})
	c := b.connect(proto.Hello{})
	if s := c.snapshot(); s.World.Notify == nil || s.World.Notify.State != proto.NotifyReady {
		t.Fatalf("snapshot notify %+v", s.World.Notify)
	}
	// Already blocked when the bridge first sees it: known, silent.
	b.floor("s", true, worker("w1", "x", "", "blocked"), worker("w2", "y", "", "working"))
	c.until(proto.EvWorkerUpsert)
	b.floor("s", true, worker("w1", "x", "", "blocked"), worker("w2", "y", "", "blocked"))
	if !ch.WaitSent(1, 5*time.Second) {
		t.Fatal("needs you was not sent")
	}
	n := ch.Sent()[0]
	if n.Reason != notify.ReasonNeedsYou || n.Name == "" || n.Name == "y" {
		t.Fatalf("sent %+v (want the worker's name)", n)
	}
	b.floor("s", true, worker("w1", "x", "", "working"), worker("w2", "y", "", "done"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !clock.WaitFor(ctx, 1) {
		t.Fatal("done is not settling")
	}
	clock.Advance(notify.DefaultSettle)
	if !ch.WaitSent(2, 5*time.Second) {
		t.Fatal("done was not sent after the settle")
	}
	if n := ch.Sent()[1]; n.Reason != notify.ReasonFinished {
		t.Fatalf("sent %+v", n)
	}
	if ch.WaitSent(3, 200*time.Millisecond) {
		t.Fatalf("more than two messages: %+v", ch.Sent())
	}
	rows := waitNotifyRows(t, b.st, notify.AuditSend, 2)
	for _, r := range rows {
		if r.Client != "bridge" || !r.OK || strings.Contains(r.Args, n.Name) {
			t.Fatalf("audit row %+v", r)
		}
		var a struct {
			ID, Kind string
			Attempts int
		}
		if err := json.Unmarshal([]byte(r.Args), &a); err != nil || a.ID == "" || a.Attempts != 1 {
			t.Fatalf("audit args %s", r.Args)
		}
	}
}

// Switched off, nothing is sent, whatever the workers do.
func TestNotifyOffSendsNothing(t *testing.T) {
	t.Parallel()
	ch := notify.NewFakeChannel(true)
	clock := notify.NewFakeClock(time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC))
	b := startBridge(t, "", server.Options{NotifyChannel: ch, NotifyClock: clock, NotifyLimits: noLimits()})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, worker("w1", "x", "", "working"))
	c.until(proto.EvWorkerUpsert)
	b.floor("s", true, worker("w1", "x", "", "blocked"))
	b.floor("s", true, worker("w1", "x", "", "done"))
	clock.Advance(time.Minute)
	if ch.WaitSent(1, 300*time.Millisecond) {
		t.Fatalf("switched off but sent %+v", ch.Sent())
	}
}

// Not parallel (a wall-clock bound): a channel that hangs on every send
// never slows the hub: observations, events and commands go on.
func TestNotifyEmitNeverBlocks(t *testing.T) {
	on := true
	ch := notify.NewFakeChannel(true)
	ch.SendErr = func(ctx context.Context, _ int) error {
		<-ctx.Done() // hangs until shutdown (or the send timeout)
		return ctx.Err()
	}
	b := startBridge(t, "", server.Options{NotifyChannel: ch, NotifyEnabled: &on, NotifySettle: time.Millisecond, NotifyLimits: noLimits()})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, worker("w1", "x", "", "working"))
	c.until(proto.EvWorkerUpsert)
	start := time.Now()
	for i := range 200 {
		status := []string{"blocked", "working", "done", "idle"}[i%4]
		b.floor("s", true, worker("w1", "x", "", status))
	}
	b.floor("marker", false)
	for {
		ev := c.event()
		if ev.T == proto.EvFloorUpsert && ev.Floor != nil && ev.Floor.Session == "marker" {
			break
		}
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("200 observations took %v with Telegram hanging", d)
	}
	_, reply := c.command(proto.CmdNotifyGet, "g1", nil)
	if reply.env.T != proto.TAck {
		t.Fatalf("notify.get: %s", reply.raw)
	}
}

// The commands: notify.get, enabling gated by a passing test, the token
// set (its audit row holds no token, nor does anything on the wire), the
// pairing, the environment's lock.
func TestNotifyCommands(t *testing.T) {
	t.Parallel()
	ch := notify.NewFakeChannel(false)
	b := startBridge(t, "", server.Options{NotifyChannel: ch, NotifyLimits: noLimits()})
	c := b.connect(proto.Hello{})
	c.snapshot()
	state := func(m msg) proto.NotifyState {
		t.Helper()
		if m.env.T != proto.TAck {
			t.Fatalf("not an ack: %s", m.raw)
		}
		var a struct {
			Data proto.NotifyState `json:"data"`
		}
		if err := json.Unmarshal(m.raw, &a); err != nil {
			t.Fatal(err)
		}
		return a.Data
	}
	code := func(m msg) string {
		t.Helper()
		var e proto.Error
		if m.env.T != proto.TError || json.Unmarshal(m.raw, &e) != nil {
			t.Fatalf("not an error: %s", m.raw)
		}
		return e.Code
	}
	_, r := c.command(proto.CmdNotifyGet, "r1", nil)
	if s := state(r); s.Enabled || s.State != proto.NotifyOff || s.Channel.KeySet || !s.Events.NeedsYou || !s.Events.Done || s.Freelancers {
		t.Fatalf("fresh state %+v", s)
	}
	on := true
	_, r = c.command(proto.CmdNotifySet, "r2", proto.NotifySetArgs{Enabled: &on})
	if got := code(r); got != notify.CodeNotConfigured {
		t.Fatalf("enable without a token: %s", got)
	}
	const tok = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
	_, r = c.command(proto.CmdNotifyTokenSet, "r3", proto.NotifyTokenSetArgs{Key: tok})
	if s := state(r); !s.Channel.KeySet {
		t.Fatalf("token not set: %+v", s)
	}
	_, r = c.command(proto.CmdNotifyPairStart, "r4", nil)
	if s := state(r); s.Channel.Pairing == nil || s.Channel.Pairing.Code == "" {
		t.Fatalf("no pairing code: %+v", s.Channel)
	}
	ch.CompletePairing("Ada")
	waitNotifyRows(t, b.st, notify.AuditPair, 1)
	_, r = c.command(proto.CmdNotifySet, "r5", proto.NotifySetArgs{Enabled: &on})
	if got := code(r); got != notify.CodeTestRequired {
		t.Fatalf("enable untested: %s", got)
	}
	_, r = c.command(proto.CmdNotifyTest, "r6", nil)
	if r.env.T != proto.TAck || !strings.Contains(string(r.raw), `"ok":true`) {
		t.Fatalf("test: %s", r.raw)
	}
	off := false
	evs, r := c.command(proto.CmdNotifySet, "r7", proto.NotifySetArgs{Enabled: &on, Quiet: &on, Events: &proto.NotifyEventsArgs{Done: &off}})
	s := state(r)
	if !s.Enabled || s.State != proto.NotifyReady || !s.Quiet || s.Events.Done || !s.Events.NeedsYou || !s.Tested {
		t.Fatalf("enabled state %+v", s)
	}
	updated := false
	for _, ev := range evs {
		updated = updated || ev.T == proto.EvNotifyUpdate
	}
	if !updated {
		t.Fatal("no notify.update before the ack")
	}
	// Kept across a restart of the service: the store has it.
	if st, ok, err := b.st.LoadNotifySettings(context.Background()); err != nil || !ok || !st.Enabled || !st.Quiet || st.Done {
		t.Fatalf("stored %+v %v %v", st, ok, err)
	}
	// The token is in no audit row and nowhere on the wire.
	rows, _ := b.st.AuditLog(context.Background())
	for _, row := range rows {
		if strings.Contains(row.Args, "AAHdq") || strings.Contains(row.Error, "AAHdq") || strings.Contains(row.Result, "AAHdq") {
			t.Fatalf("token in the audit log: %+v", row)
		}
	}
	if strings.Contains(c.heard.String(), "AAHdq") {
		t.Fatal("token on the wire")
	}
	if rows := notifyRows(t, b.st, proto.CmdNotifyTokenSet); len(rows) != 1 || rows[0].Args != `{"key_given":true}` {
		t.Fatalf("token.set audit %+v", rows)
	}
	_, r = c.command(proto.CmdNotifyTokenSet, "r8", proto.NotifyTokenSetArgs{Key: " "})
	if got := code(r); got != notify.CodeBadRequest {
		t.Fatalf("blank token: %s", got)
	}
	// H3D-1: the mode, everything until set, kept by the store; another
	// value is refused.
	if s.Mode != proto.NotifyModeEverything {
		t.Fatalf("mode %q", s.Mode)
	}
	questions, other := proto.NotifyModeQuestions, "digest"
	_, r = c.command(proto.CmdNotifySet, "r9", proto.NotifySetArgs{Mode: &questions})
	if s := state(r); s.Mode != proto.NotifyModeQuestions || !s.Events.NeedsYou {
		t.Fatalf("questions only %+v", s)
	}
	if st, _, _ := b.st.LoadNotifySettings(context.Background()); st.Mode != proto.NotifyModeQuestions {
		t.Fatalf("stored mode %q", st.Mode)
	}
	_, r = c.command(proto.CmdNotifySet, "r10", proto.NotifySetArgs{Mode: &other})
	if got := code(r); got != notify.CodeBadRequest {
		t.Fatalf("another mode: %s", got)
	}
}

// #12: notify.token.set args that do not decode (the token as a bare string,
// or under the right key with the wrong type) are refused, and their audit
// row is redacted() whole: a size, never the token's bytes.
func TestNotifyTokenSetAuditUnparsableArgs(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{NotifyChannel: notify.NewFakeChannel(false)})
	c := b.connect(proto.Hello{})
	c.snapshot()
	const tok = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
	cases := []json.RawMessage{
		json.RawMessage(`"` + tok + `"`),
		json.RawMessage(`{"key":["` + tok + `"]}`),
		json.RawMessage(`["` + tok + `"]`),
	}
	for i, args := range cases {
		_, r := c.command(proto.CmdNotifyTokenSet, fmt.Sprintf("r%d", i), args)
		if r.env.T != proto.TError || strings.Contains(string(r.raw), "AAHdq") {
			t.Fatalf("args %s: %s", args, r.raw)
		}
	}
	rows := notifyRows(t, b.st, proto.CmdNotifyTokenSet)
	if len(rows) != len(cases) {
		t.Fatalf("%d token.set rows, want %d: %+v", len(rows), len(cases), rows)
	}
	for _, row := range rows {
		if strings.Contains(row.Args, "AAHdq") || strings.Contains(row.Error, "AAHdq") || strings.Contains(row.Result, "AAHdq") {
			t.Fatalf("token in the audit log: %+v", row)
		}
		var a struct {
			Redacted bool `json:"redacted"`
			Bytes    int  `json:"bytes"`
		}
		if err := json.Unmarshal([]byte(row.Args), &a); err != nil || !a.Redacted || a.Bytes == 0 {
			t.Fatalf("not redacted: %+v", row)
		}
	}
}

func TestNotifyEnvLocked(t *testing.T) {
	t.Parallel()
	on, off := true, false
	b := startBridge(t, "", server.Options{NotifyChannel: notify.NewFakeChannel(true), NotifyEnabled: &on})
	c := b.connect(proto.Hello{})
	s := c.snapshot()
	if n := s.World.Notify; n == nil || !n.Enabled || len(n.Env) != 1 || n.Env[0] != "enabled" {
		t.Fatalf("snapshot %+v", s.World.Notify)
	}
	_, r := c.command(proto.CmdNotifySet, "r1", proto.NotifySetArgs{Enabled: &off})
	var e proto.Error
	if err := json.Unmarshal(r.raw, &e); err != nil || e.Code != notify.CodeEnvLocked {
		t.Fatalf("env locked: %s", r.raw)
	}
}

func TestNotifyUnsupportedWithoutAChannel(t *testing.T) {
	t.Parallel()
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	if s := c.snapshot(); s.World.Notify != nil {
		t.Fatal("notify in the snapshot without a channel")
	}
	_, r := c.command(proto.CmdNotifyGet, "r1", nil)
	var e proto.Error
	if err := json.Unmarshal(r.raw, &e); err != nil || e.Code != proto.ErrUnsupported {
		t.Fatalf("no channel: %s", r.raw)
	}
}

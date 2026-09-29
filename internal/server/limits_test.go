package server_test

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/limits"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// limitsRunner answers the two probes from fixed text and counts starts.
type limitsRunner struct{ started atomic.Int32 }

type limitsProc struct {
	in, inW, out, outR *os.File
	wg                 sync.WaitGroup
}

func (p *limitsProc) Stdin() io.WriteCloser { return p.inW }
func (p *limitsProc) Stdout() io.Reader     { return p.outR }
func (p *limitsProc) Kill()                 { p.in.Close(); p.out.Close() }
func (p *limitsProc) Wait() error           { p.wg.Wait(); return nil }

func (r *limitsRunner) Start(c limits.Cmd) (limits.Process, error) {
	r.started.Add(1)
	p := &limitsProc{}
	var err error
	if p.in, p.inW, err = os.Pipe(); err != nil {
		return nil, err
	}
	if p.outR, p.out, err = os.Pipe(); err != nil {
		return nil, err
	}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer p.out.Close()
		defer p.in.Close()
		sc := bufio.NewScanner(p.in)
		claude := c.Path == "claude"
		for sc.Scan() {
			switch {
			case claude:
				io.WriteString(p.out, `{"type":"control_response","response":{"subtype":"success","request_id":"usage","response":{"subscription_type":"team","rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":11,"resets_at":"2026-09-29T20:00:00+00:00"},"seven_day":{"utilization":61,"resets_at":"2026-09-30T20:00:00+00:00"},"model_scoped":[{"display_name":"Fable","utilization":3,"resets_at":null}]}}}}`+"\n")
			case strings.Contains(sc.Text(), `"id":1`):
				io.WriteString(p.out, `{"id":1,"result":{}}`+"\n")
			case strings.Contains(sc.Text(), `"id":2`):
				io.WriteString(p.out, `{"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":19,"windowDurationMins":10080,"resetsAt":1791053830},"credits":{"hasCredits":true,"unlimited":false,"balance":"5"},"planType":"prolite","rateLimitReachedType":null}}}`+"\n")
			}
		}
	}()
	return p, nil
}

func limitsOptions(r *limitsRunner) server.Options {
	return server.Options{Limits: &limits.Config{Runner: r, ClaudeBin: "claude", CodexBin: "codex", Tick: 10 * time.Millisecond,
		Env: func() []string { return nil }, Log: quietLog()}}
}

// Nothing is read while nobody is connected; then a client gets a
// limits.update per provider, flat on the wire, and later clients get them
// in the snapshot.
func TestLimitsUpdatesAndSnapshot(t *testing.T) {
	r := &limitsRunner{}
	b := startBridge(t, "", limitsOptions(r))
	time.Sleep(100 * time.Millisecond)
	if n := r.started.Load(); n != 0 {
		t.Fatalf("%d probes with no client connected", n)
	}
	c := b.connect(proto.Hello{})
	first := c.snapshot()
	if first.World.Limits == nil || len(first.World.Limits) != 0 {
		t.Fatalf("first snapshot limits = %#v, want []", first.World.Limits)
	}
	if raw, _ := json.Marshal(first.World); !strings.Contains(string(raw), `"limits":[]`) {
		t.Errorf("an enabled bridge without a reading yet must say limits:[] on the wire: %s", raw)
	}
	got := map[string]proto.Event{}
	for len(got) < 2 {
		ev := c.until(proto.EvLimitsUpdate)
		got[ev.Provider] = ev
	}
	cl, cx := got["claude"], got["codex"]
	if cl.Limits == nil || cl.Plan != "team" || len(cl.Windows) != 3 || cl.Windows[0].Label != "5h" || cl.Windows[0].Pct != 11 || cl.Stale || cl.At == 0 {
		t.Fatalf("claude = %+v", cl.Limits)
	}
	if cl.Windows[2].Model != "Fable" || cl.Windows[2].ResetsAt != 0 {
		t.Errorf("claude model window = %+v", cl.Windows[2])
	}
	if cx.Plan != "prolite" || len(cx.Windows) != 1 || cx.Windows[0].Label != "week" || cx.Credits == nil || cx.Credits.Balance != "5" {
		t.Fatalf("codex = %+v", cx.Limits)
	}

	c2 := b.connect(proto.Hello{})
	snap := c2.snapshot()
	if len(snap.World.Limits) != 2 || snap.World.Limits[0].Provider != "claude" || snap.World.Limits[1].Provider != "codex" {
		t.Fatalf("snapshot limits = %+v", snap.World.Limits)
	}
	// The wire shape: fields flat in the event, windows spelled as documented.
	raw, _ := json.Marshal(cl)
	var flat map[string]any
	_ = json.Unmarshal(raw, &flat)
	for _, k := range []string{"t", "seq", "provider", "plan", "windows", "at", "stale"} {
		if _, ok := flat[k]; !ok {
			t.Errorf("limits.update lacks %q: %s", k, raw)
		}
	}
	if w := flat["windows"].([]any)[0].(map[string]any); w["label"] != "5h" || w["window_mins"] != float64(300) || w["resets_at"] == nil {
		t.Errorf("window = %v", w)
	}
}

// limits.refresh reads at once, and at most every 20 s.
func TestLimitsRefresh(t *testing.T) {
	r := &limitsRunner{}
	opts := limitsOptions(r)
	opts.Limits.Interval = time.Hour
	b := startBridge(t, "", opts)
	c := b.connect(proto.Hello{})
	c.snapshot()
	seen := map[string]bool{}
	for len(seen) < 2 {
		seen[c.until(proto.EvLimitsUpdate).Provider] = true
	}
	_, m := c.command(proto.CmdLimitsRefresh, "r1", nil)
	if !ackData[proto.LimitsRefreshResult](t, m).Queued {
		t.Fatal("refresh not queued")
	}
	for range 2 { // one more reading each
		c.until(proto.EvLimitsUpdate)
	}
	_, m = c.command(proto.CmdLimitsRefresh, "r2", nil)
	if ackData[proto.LimitsRefreshResult](t, m).Queued {
		t.Fatal("second refresh right after the first was queued")
	}
	if n := r.started.Load(); n != 4 {
		t.Errorf("%d probes, want 4 (two providers, twice)", n)
	}
}

func TestLimitsRefreshUnsupportedWithoutPoller(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	// --no-limits: the snapshot leaves `limits` out (a bridge that reads them says `[]` before its first reading).
	snap := c.snapshot()
	raw, _ := json.Marshal(snap.World)
	var world map[string]json.RawMessage
	if err := json.Unmarshal(raw, &world); err != nil {
		t.Fatal(err)
	}
	if v, ok := world["limits"]; ok || snap.World.Limits != nil {
		t.Fatalf("snapshot of a bridge without limits has limits = %s", v)
	}
	if _, ok := world["presets"]; !ok {
		t.Fatal("marshalled world lost presets: the test reads the wrong shape")
	}
	c.mustError(proto.CmdLimitsRefresh, nil, proto.ErrUnsupported)
}

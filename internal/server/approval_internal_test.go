package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// #106: the incidental lines are only what says how long something has run
// or that it still runs; a command or a dialog's line is none.
func TestIncidentalLines(t *testing.T) {
	t.Parallel()
	for _, l := range []string{
		"Background task running 0s", "Background task running 12s", "background tasks running 1m 5s", "2 background tasks running",
		"Background shell running for 3.5s", "✻ Thinking… (12s · ↓ 300 tokens · esc to interrupt)", "✶ Brewing… (4s)",
		"(esc to interrupt)", "12s", "(3.2s)", "1m 5s", "1:59", "Auto-deny in 1:59", "Denied in 30s", "Times out in 2 minutes",
	} {
		if !isIncidental(l) {
			t.Errorf("%q is not incidental", l)
		}
	}
	for _, l := range []string{
		"rm -f $D/*", "Bash command", "sleep 12s", "timeout 30s make test", "echo running 5s", "Do you want to proceed?",
		"Create empty file h3d-perm-probe.txt", "Reason: May I create it outside the sandbox?", "$ touch a", "1. Yes",
		"/tmp/h3d-m5term/claude-a2be86", "deny in tests: rm -rf build",
		// Command lines that read like a status line.
		"echo 'esc to interrupt'; touch /tmp/a", "esc to interrupt && rm -rf /tmp/b", "* rm -rf /tmp/b (5s)",
		"✻ rm -rf /tmp/b (5s)", "cancel /tmp/job in 5s", "Denied in 30s; rm -rf /tmp/b", "background task running 5s; rm -rf /tmp/b",
	} {
		if isIncidental(l) {
			t.Errorf("%q is incidental", l)
		}
	}
}

// #106: a command line that reads like a status line is the operation's,
// on the card and in the hash: approving one never approves another.
func TestMenuOpCommandLikeIncidental(t *testing.T) {
	t.Parallel()
	const cmd = "echo 'esc to interrupt'; touch /tmp/a"
	a := parseQuestionOf("claude", claudeBash("", cmd), 1)
	b := parseQuestionOf("claude", claudeBash("", "echo 'esc to interrupt'; rm -rf /tmp/b"), 1)
	if a.q.Hash == b.q.Hash || a.op.key == b.op.key || !slices.Contains(a.op.lines, cmd) {
		t.Fatalf("A %s %q, B %s %q", a.q.Hash, a.op.lines, b.q.Hash, b.op.lines)
	}
}

// #106: what each captured permission and trust dialog is about: its own
// lines from its top (Claude's rule, Codex's first line), whole, never the
// conversation above, nor Claude's question and the choices below them.
func TestMenuOpOnCapturedScreens(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		screen, harness string
		lines           []string
	}{
		{"claude-permission-bash", "claude", []string{"Bash command", "touch h3d-perm-probe.txt", "Create empty file h3d-perm-probe.txt"}},
		{"claude-permission-write", "claude", []string{"Create file", "notes-h3d.txt", "1 hello"}},
		{"claude-trust", "claude", []string{"Accessing workspace:", "/tmp/h3d-m5term/claude-a2be86",
			"Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
			"project, or work from your team). If not, take a moment to review what's in this folder first.",
			"Claude Code'll be able to read, edit, and execute files here.", "Security guide"}},
		{"codex-approval", "codex", []string{"Would you like to run the following command?", "Environment: local",
			"Reason: May I create h3d-codex-probe.txt by rerunning the requested touch command outside the read-only sandbox?",
			"$ touch h3d-codex-probe.txt"}},
		{"codex-trust", "codex", []string{"Folder access", "/tmp/h3d-m5term/codex-f3e4dd",
			"Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings",
			"can run code automatically, even without a model request. Continue only if you trust these files. Your trust",
			"decision will be saved."}},
	} {
		for _, harness := range []string{tc.harness, ""} {
			sq := parseQuestionOf(harness, screen(t, tc.screen), 1)
			if sq.op == nil || !sq.op.complete || !slices.Equal(sq.op.lines, tc.lines) {
				t.Errorf("%s (%q): op %+v", tc.screen, harness, sq.op)
			}
		}
	}
	if sq := parseQuestion(screen(t, "claude-question"), 1); sq.op != nil {
		t.Errorf("a choice menu has an op: %+v", sq.op)
	}
}

// claudeBash is Claude Code's Bash permission dialog for command (its
// lines), as the captured screen draws it, under history.
func claudeBash(history string, command ...string) string {
	var b strings.Builder
	b.WriteString(history)
	b.WriteString(strings.Repeat("─", 120) + "\n Bash command\n\n")
	for _, l := range command {
		b.WriteString("   " + l + "\n")
	}
	b.WriteString("   Clean the scratch directory\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for rm commands\n   3. No\n\n Esc to cancel · Tab to amend\n")
	return b.String()
}

// The incident's fixture (#106, the issue's reproduction): a counter in
// the dialog ticks, nothing else: the same hash, operation and excerpt
// every read (no worker.upsert, one card); another command is another hash
// and operation, and so is another blocked spell.
func TestMenuOpTickingContext(t *testing.T) {
	t.Parallel()
	ticket := "Bash command\n rm -f $D/*\n Background task running %ds\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel"
	real := claudeBash("● Running the cleanup\n", "S=/tmp/run; D=$S/scratch; rm -f $D/*") + "  Background task running %ds\n"
	real = strings.Replace(real, " Do you want to proceed?", " Background task running %ds\n Do you want to proceed?", 1)
	for name, s := range map[string]string{"ticket": ticket, "claude": real} {
		base := parseQuestionOf("claude", strings.ReplaceAll(s, "%d", "0"), 100)
		for i := 1; i < 10; i++ {
			sq := parseQuestionOf("claude", strings.ReplaceAll(s, "%d", fmt.Sprint(i)), 100)
			if sq.q.Hash != base.q.Hash || sq.op.key != base.op.key || !slices.Equal(sq.q.Excerpt, base.q.Excerpt) {
				t.Fatalf("%s: frame %d: %+v / %+v, want %+v / %+v", name, i, sq.q, sq.op, base.q, base.op)
			}
		}
		other := parseQuestionOf("claude", strings.ReplaceAll(strings.Replace(s, "rm -f $D/*", "rm -f /tmp/other/*", 1), "%d", "0"), 100)
		if other.q.Hash == base.q.Hash || other.op.key == base.op.key {
			t.Errorf("%s: another command, same identity", name)
		}
		if again := parseQuestionOf("claude", strings.ReplaceAll(s, "%d", "0"), 101); again.q.Hash == base.q.Hash || again.op.key == base.op.key {
			t.Errorf("%s: another blocked spell, same identity", name)
		}
		for _, l := range base.q.Excerpt {
			if strings.Contains(l, "Background task") {
				t.Errorf("%s: excerpt %q", name, base.q.Excerpt)
			}
		}
	}
	if sq := parseQuestionOf("claude", strings.ReplaceAll(ticket, "%d", "0"), 100); sq.op.complete {
		t.Error("the ticket's fixture has no dialog top: it is not complete")
	}
	if sq := parseQuestionOf("claude", strings.ReplaceAll(real, "%d", "0"), 100); !sq.op.complete ||
		!slices.Equal(sq.op.lines, []string{"Bash command", "S=/tmp/run; D=$S/scratch; rm -f $D/*", "Clean the scratch directory"}) {
		t.Errorf("op %+v", sq.op)
	}
}

// #106: what the old 12-line window and 200-rune clip hid is in the hash
// now: a change at the top of a tall command, or past a long line's 200th
// rune, is another hash and operation; above the dialog's top is nothing
// of it.
func TestMenuOpBeyondTheWindow(t *testing.T) {
	t.Parallel()
	var tall []string
	for i := range 20 {
		tall = append(tall, fmt.Sprintf("echo step %d", i))
	}
	base := parseQuestionOf("claude", claudeBash("", tall...), 1)
	changed := slices.Clone(tall)
	changed[0] = "rm -rf ~/important"
	if sq := parseQuestionOf("claude", claudeBash("", changed...), 1); sq.q.Hash == base.q.Hash || sq.op.key == base.op.key {
		t.Error("a change 20 lines up: same identity")
	}
	long := "cp a.txt " + strings.Repeat("x", 250) + " /safe/target"
	lb := parseQuestionOf("claude", claudeBash("", long), 1)
	if sq := parseQuestionOf("claude", claudeBash("", strings.Replace(long, "/safe/target", "/etc/passwd", 1)), 1); sq.q.Hash == lb.q.Hash ||
		sq.op.key == lb.op.key {
		t.Error("a change past the 200th rune: same identity")
	}
	if sq := parseQuestionOf("claude", claudeBash("● Something else ran\n  ⎿ 12s\n", tall...), 1); sq.q.Hash != base.q.Hash {
		t.Error("history above the dialog changed its hash")
	}
}

// #106: a rewrap (a resize) of the same command keeps its operation (one
// card) but not its hash (worker.answer checks what the screen shows); a
// command whose words are joined otherwise is another hash.
func TestMenuOpRewrap(t *testing.T) {
	t.Parallel()
	wide := parseQuestionOf("claude", claudeBash("", "rm -f /tmp/scratch/a.png /tmp/scratch/b.png"), 1)
	narrow := parseQuestionOf("claude", claudeBash("", "rm -f /tmp/scratch/a.png", "/tmp/scratch/b.png"), 1)
	if wide.op.key != narrow.op.key || wide.q.Hash == narrow.q.Hash {
		t.Errorf("rewrap: key %s/%s hash %s/%s", wide.op.key, narrow.op.key, wide.q.Hash, narrow.q.Hash)
	}
	a := parseQuestionOf("claude", claudeBash("", "touch a b"), 1)
	b := parseQuestionOf("claude", claudeBash("", "touch ab"), 1)
	if a.q.Hash == b.q.Hash {
		t.Error("touch a b and touch ab: same hash")
	}
}

// #106: a dialog taller than the screen (its top not on it) is not
// complete: its card shows its end, says so, and withholds the choices
// that approve; a trust menu's are kept (no command to hide).
func TestMenuOpPartial(t *testing.T) {
	t.Parallel()
	full := claudeBash("", "S=/tmp/run", "D=$S/scratch", "rm -f $D/*")
	cut := full[strings.Index(full, "   D=$S"):]
	sq := parseQuestionOf("claude", cut, 1)
	if sq.op == nil || sq.op.complete || sq.q.Kind != proto.QuestionPermission {
		t.Fatalf("op %+v (%s)", sq.op, sq.q.Kind)
	}
	if whole := parseQuestionOf("claude", full, 1); whole.q.Hash == sq.q.Hash || whole.op.key == sq.op.key {
		t.Error("the whole dialog and its end: same identity")
	}
	m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: &sq.q}, false).Menu
	menuFacts(m, sq.op, nil)
	if m.About[0] != aboutPartial || !slices.Contains(m.About, "rm -f $D/*") {
		t.Fatalf("about %q", m.About)
	}
	var kept []int
	for _, c := range m.Choices {
		if !c.Withheld {
			kept = append(kept, c.N)
		}
	}
	if !slices.Equal(kept, []int{3}) {
		t.Fatalf("buttons for %v", kept)
	}
	trust := screen(t, "claude-trust")
	tq := parseQuestionOf("claude", trust[strings.Index(trust, " /tmp/h3d"):], 1)
	tm := notifyFacts(&proto.Worker{Status: statusBlocked, Question: &tq.q}, false).Menu
	menuFacts(tm, tq.op, nil)
	if tq.op.complete || slices.ContainsFunc(tm.Choices, func(c notify.MenuChoice) bool { return c.Withheld }) {
		t.Fatalf("trust %+v %+v", tq.op, tm.Choices)
	}
}

// #106: a dialog whose top is off the screen hashes all it shows of
// itself, not the 12 lines above its menu: a change far up the screen is
// another hash.
func TestMenuOpPartialHashesAllShown(t *testing.T) {
	t.Parallel()
	lines := []string{"D=/tmp/safe"}
	for range 15 {
		lines = append(lines, "echo step")
	}
	full := claudeBash("", append(lines, "rm -f $D/*")...)
	cut := full[strings.Index(full, "   D="):]
	a := parseQuestionOf("claude", cut, 1)
	b := parseQuestionOf("claude", strings.Replace(cut, "D=/tmp/safe", "D=/tmp/important", 1), 1)
	if a.op.complete || a.q.Hash == b.q.Hash || !slices.Contains(a.op.lines, "D=/tmp/safe") {
		t.Fatalf("hash %s / %s, op %+v", a.q.Hash, b.q.Hash, a.op)
	}
}

// #106: what a line of an operation keeps when it leaves the bridge.
func TestRedactLine(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"curl -u admin:hunter2 https://example.test":           "curl -u admin:[key] https://example.test",
		"curl --user 'bob:s3cr3t pass' https://x.test":         "curl --user 'bob:[key]' https://x.test",
		"curl https://bob:pw123@example.test/x":                "curl https://bob:[key]@example.test/x",
		`curl -H "Authorization: Bearer abc.def" https://x`:    `curl -H "Authorization: [key]" https://x`,
		`curl -H 'X-Api-Key: 1234abcd' https://x`:              `curl -H 'X-Api-Key: [key]' https://x`,
		"API_TOKEN=abc123 make deploy":                         "API_TOKEN=[key] make deploy",
		"export AWS_SECRET_ACCESS_KEY='zzz' && aws s3 ls":      "export AWS_SECRET_ACCESS_KEY=[key] && aws s3 ls",
		"PGPASSWORD=pw psql -h db":                             "PGPASSWORD=[key] psql -h db",
		"gh auth login --with-token --token ghx123":            "gh auth login --with-token --token [key]",
		"mysql -u root -phunter2 shop":                         "mysql -u root -p[key] shop",
		"sshpass -p hunter2 ssh host":                          "sshpass -p [key] ssh host",
		"git push https://ghp_abcdefghijklmnop@github.com/x/y": "git push https://[key]@github.com/x/y",
		"S=/tmp/run; D=$S/scratch; rm -f $D/*":                 "S=/tmp/run; D=$S/scratch; rm -f $D/*",
		"mkdir -p build && cp -r src build":                    "mkdir -p build && cp -r src build",
		"echo \x1b[31mred\x07":                                 "echo  [31mred ",
	} {
		if got := redactLine(in); got != want {
			t.Errorf("redactLine(%q) = %q, want %q", in, got, want)
		}
	}
}

// #106: a password in shell quotes goes whole, every word of it, however
// it is quoted; what follows it stays.
func TestRedactLineQuoted(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		`curl -u admin:"hunter2" https://example.test`:                    `curl -u admin:[key] https://example.test`,
		`curl -u admin:'hun ter2' https://example.test`:                   `curl -u admin:[key] https://example.test`,
		`curl -u 'admin:hun ter2' https://example.test`:                   `curl -u 'admin:[key]' https://example.test`,
		`curl -u 'bob:correct horse battery staple' https://example.test`: `curl -u 'bob:[key]' https://example.test`,
		`curl --user "admin:hunter2" https://example.test`:                `curl --user "admin:[key]" https://example.test`,
		`curl --user="admin:two words" https://example.test`:              `curl --user="admin:[key]" https://example.test`,
		`curl -u "admin":"two words" https://example.test`:                `curl -u "admin":[key] https://example.test`,
		`sshpass -p 'hunter2' ssh user@example.test`:                      `sshpass -p [key] ssh user@example.test`,
		`sshpass -p"two words" ssh host`:                                  `sshpass -p[key] ssh host`,
		`mysql -u root -p'hunter2' shop`:                                  `mysql -u root -p[key] shop`,
		`mysql -p'hunter2' -e 'select 1'`:                                 `mysql -p[key] -e 'select 1'`,
		`mysql -p"two words" -e 'select 1'`:                               `mysql -p[key] -e 'select 1'`,
		`gh auth login --token 'two words' --hostname x`:                  `gh auth login --token [key] --hostname x`,
		`DB_PASSWORD="two words" ./migrate`:                               `DB_PASSWORD=[key] ./migrate`,
		`DB_PASSWORD=pre'two words' ./migrate`:                            `DB_PASSWORD=[key] ./migrate`,
		`curl -H 'Authorization: Bearer' -H 'X-Other: value' https://x`:   `curl -H 'Authorization: [key]' -H 'X-Other: value' https://x`,
	} {
		got := redactLine(in)
		if got != want {
			t.Errorf("redactLine(%q) = %q, want %q", in, got, want)
		}
		for _, secret := range []string{"hunter2", "hun", "ter2", "horse", "staple", "two", "words"} {
			if strings.Contains(got, secret) {
				t.Errorf("redactLine(%q) = %q keeps %q", in, got, secret)
			}
		}
	}
}

// #106: a card's lines are bounded: each line, their number and their
// length in all, what is left out said.
func TestAboutLinesBounded(t *testing.T) {
	t.Parallel()
	var lines []string
	for i := range 40 {
		lines = append(lines, fmt.Sprintf("echo %d %s", i, strings.Repeat("y", 400)))
	}
	got := aboutLines(lines)
	if n := len(got); n > aboutLinesMax+1 || !strings.HasPrefix(got[n-1], "… (") {
		t.Fatalf("%d lines, last %q", n, got[len(got)-1])
	}
	total := 0
	for _, l := range got[:len(got)-1] {
		if n := len([]rune(l)); n > aboutLineMax {
			t.Fatalf("line of %d runes", n)
		} else {
			total += n
		}
	}
	if total > aboutMax {
		t.Fatalf("%d runes", total)
	}
	if got := aboutLines([]string{"a", "b"}); !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("short: %q", got)
	}
}

// floodRig is the issue's reproduction rig (#106): the real path from a
// screen to Telegram, parseQuestionOf → notifyFacts → menuFacts →
// notify.Service → FakeChannel, one worker, replies on, a fake clock.
type floodRig struct {
	svc   *notify.Service
	ch    *notify.FakeChannel
	clock *notify.FakeClock
	n     int
}

func newFloodRig(t *testing.T) *floodRig {
	t.Helper()
	ch, st := notify.NewFakeChannel(true), notify.NewFakeStore()
	settings := notify.DefaultSettings()
	settings.Enabled, settings.Replies = true, true
	if err := st.SaveNotifySettings(t.Context(), settings); err != nil {
		t.Fatal(err)
	}
	r := &floodRig{ch: ch, clock: notify.NewFakeClock(time.Date(2026, 10, 17, 22, 35, 40, 0, time.UTC))}
	var err error
	if r.svc, err = notify.New(t.Context(), notify.Options{Channel: ch, Store: st, Clock: r.clock}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.svc.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	if !ch.WaitFor(ch.Listening, 5*time.Second) {
		t.Fatal("not listening")
	}
	return r
}

// frame shows the service worker id (named name) blocked since since on
// screen.
func (r *floodRig) frame(id, name string, since int64, screen string) {
	sq := parseQuestionOf("claude", screen, since)
	w := &proto.Worker{ID: id, Status: statusBlocked, StatusSince: since, Question: &sq.q}
	nw := notifyFacts(w, false)
	menuFacts(nw.Menu, sq.op, nil)
	r.svc.Observe(notify.Observation{Worker: nw, Name: name})
}

// barrier waits until the service took everything observed before: a
// worker of its own turns blocked on a menu, and its card comes after
// every job queued before it.
func (r *floodRig) barrier(t *testing.T) {
	t.Helper()
	r.n++
	id, cards := fmt.Sprintf("barrier%d", r.n), len(r.ch.Cards())
	r.svc.Observe(notify.Observation{Worker: notify.Worker{ID: id, Status: statusWorking, StatusSince: 1}, Name: "Bar"})
	r.frame(id, "Bar", 50, claudeBash("", "true"))
	if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) > cards }, 5*time.Second) {
		t.Fatal("no barrier card")
	}
}

// cardsOf are the cards whose head is name's.
func (r *floodRig) cardsOf(name string) []notify.Card {
	var out []notify.Card
	for _, ref := range r.ch.Cards() {
		if c := r.ch.Card(ref); strings.HasPrefix(c.Text, name+" · ") {
			out = append(out, c)
		}
	}
	return out
}

// The issue's reproduction (#106), ported: the screen of an unchanged
// command and Yes/No choices whose only change is an elapsed counter, ten
// reads two seconds apart, no answer: one card, still actionable, never
// closed as answered, one alert. The issue's own screen (no dialog top: its
// Yes is withheld, its No stays) and Claude's real dialog alike; and the
// control, the counter frozen.
func TestPermissionCardStableThroughTickingContext(t *testing.T) {
	ticket := "Bash command\n rm -f $D/*\n Background task running %ds\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel"
	real := strings.Replace(claudeBash("", "S=/tmp/run; D=$S/scratch; rm -f $D/*"), " Do you want to proceed?",
		" Background task running %ds\n Do you want to proceed?", 1)
	for _, tc := range []struct {
		name, screen string
		frozen       bool
		buttons      int
	}{{"ticket", ticket, false, 1}, {"claude", real, false, 3}, {"frozen", ticket, true, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			r := newFloodRig(t)
			r.svc.Observe(notify.Observation{Worker: notify.Worker{ID: "w1", Status: statusWorking, StatusSince: 1}, Name: "Blip"})
			for i := range 10 {
				n := i
				if tc.frozen {
					n = 0
				}
				r.frame("w1", "Blip", 100, strings.ReplaceAll(tc.screen, "%d", fmt.Sprint(n)))
				if i == 0 && !r.ch.WaitFor(func() bool { return len(r.cardsOf("Blip")) == 1 }, 5*time.Second) {
					t.Fatal("no card")
				}
				r.clock.Advance(2 * time.Second)
			}
			r.barrier(t)
			cards := r.cardsOf("Blip")
			closed := 0
			for _, c := range cards {
				if strings.Contains(c.Text, notify.CardInGameText) || strings.Contains(c.Text, notify.CardReplacedText) || len(c.Buttons) == 0 {
					closed++
				}
			}
			alerts := 0
			for _, s := range r.ch.Sent() {
				if s.Name == "Blip" {
					alerts++
				}
			}
			t.Logf("%d cards, %d closed, %d alerts", len(cards), closed, alerts)
			if len(cards) != 1 || closed != 0 || alerts != 1 || len(cards[0].Buttons) != tc.buttons ||
				!strings.Contains(cards[0].Text, "rm -f $D/*") || strings.Contains(cards[0].Text, "Background task") {
				t.Fatalf("cards %+v", cards)
			}
		})
	}
}

// bashCall is a pending Bash call of command.
func bashCall(id, command, description string) transcript.PendingCall {
	in, _ := json.Marshal(map[string]string{"command": command, "description": description})
	sum := sha256.Sum256(in)
	return transcript.PendingCall{ID: id, Name: "Bash", Input: in, Sum: hex.EncodeToString(sum[:]), Cwd: "/home/u/w1"}
}

// #106: a menu's native call is the one pending call whose command the
// dialog shows whole (joined without whitespace: however it wraps), or
// whose end a dialog cut at the top shows; a file dialog's by its path.
// Two candidates, another command, another tool: none.
func TestNativeOf(t *testing.T) {
	t.Parallel()
	cmd := "S=/tmp/run; D=$S/scratch; rm -f $D/*"
	call := bashCall("toolu_a", cmd, "Clean the scratch directory")
	full := parseQuestionOf("claude", claudeBash("", cmd), 1)
	nc := nativeOf(full.op, []transcript.PendingCall{bashCall("toolu_x", "ls", "List"), call}, "")
	if nc == nil || nc.call.ID != "toolu_a" || nc.cmd != 1 || len(nc.id) != 16 {
		t.Fatalf("native %+v", nc)
	}
	wrapped := parseQuestionOf("claude", claudeBash("", "S=/tmp/run; D=$S/scr", "atch; rm -f $D/*"), 1)
	if n := nativeOf(wrapped.op, []transcript.PendingCall{call}, ""); n == nil || n.id != nc.id || n.cmd != 2 {
		t.Fatalf("wrapped %+v", n)
	}
	for name, calls := range map[string][]transcript.PendingCall{
		"two alike":       {call, bashCall("toolu_b", cmd, "Again")},
		"another command": {bashCall("toolu_c", "S=/tmp/run; D=$S/scratch; rm -rf $D", "x")},
		"a longer one":    {bashCall("toolu_d", cmd+"; ls", "x")},
		"another tool":    {{ID: "toolu_e", Name: "Agent", Input: json.RawMessage(`{"command":"` + cmd + `"}`), Sum: "x"}},
		"too big":         {{ID: "toolu_f", Name: "Bash", Sum: "x"}},
	} {
		if n := nativeOf(full.op, calls, ""); n != nil {
			t.Errorf("%s: %+v", name, n)
		}
	}
	// Cut at the top: its end matches, and makes it whole.
	tall := claudeBash("", "S=/tmp/run", "D=$S/scratch", "rm -f $D/*")
	cut := parseQuestionOf("claude", tall[strings.Index(tall, "   D=$S"):], 1)
	multi := bashCall("toolu_m", "S=/tmp/run\nD=$S/scratch\nrm -f $D/*", "Clean the scratch directory")
	n := nativeOf(cut.op, []transcript.PendingCall{multi}, "bypassPermissions")
	if cut.op.complete || n == nil {
		t.Fatalf("cut %+v / %+v", cut.op, n)
	}
	m := notifyFacts(&proto.Worker{Status: statusBlocked, Question: &cut.q}, false).Menu
	menuFacts(m, cut.op, n)
	if slices.ContainsFunc(m.Choices, func(c notify.MenuChoice) bool { return c.Withheld }) || m.Native != n.id || m.Source != "native" ||
		!slices.Equal(m.About, []string{"Bash command", "S=/tmp/run", "D=$S/scratch", "rm -f $D/*", "Clean the scratch directory",
			"In: /home/u/w1", nativeBypass}) {
		t.Fatalf("menu %+v", m)
	}
	short := parseQuestionOf("claude", tall[strings.Index(tall, "   Clean"):], 1)
	if n := nativeOf(short.op, []transcript.PendingCall{multi}, ""); n != nil {
		t.Errorf("only its description: %+v", n)
	}
	// What the dialog adds is why it asks.
	warned := strings.Replace(claudeBash("", cmd), "   Clean the scratch directory\n", "   Clean the scratch directory\n ⚠ rm with a variable target\n", 1)
	w := parseQuestionOf("claude", warned, 1)
	if about := nativeOf(w.op, []transcript.PendingCall{call}, "").about(w.op); !slices.Contains(about, nativeSays+"⚠ rm with a variable target") {
		t.Fatalf("about %q", about)
	}
	// A file dialog: by its path.
	wr := parseQuestion(screen(t, "claude-permission-write"), 1)
	in := json.RawMessage(`{"file_path":"/tmp/h3d-m5term/claude-a2be86/notes-h3d.txt","content":"hello"}`)
	write := transcript.PendingCall{ID: "toolu_w", Name: "Write", Input: in, Sum: "s", Cwd: "/tmp/h3d-m5term/claude-a2be86"}
	if n := nativeOf(wr.op, []transcript.PendingCall{write}, ""); n == nil || !slices.Contains(n.about(wr.op), "File: /tmp/h3d-m5term/claude-a2be86/notes-h3d.txt") {
		t.Fatalf("write %+v", n)
	}
	write.Name = "Edit"
	if n := nativeOf(wr.op, []transcript.PendingCall{write}, ""); n != nil {
		t.Fatalf("an Edit for a Create file dialog: %+v", n)
	}
}

// #106: a dialog's command is its call's word for word: a line break is
// a space of the command or none (a word cut by the wrap), and nothing
// else is; words joined or split otherwise are another command.
func TestNativeOfWords(t *testing.T) {
	t.Parallel()
	spaced, joined := bashCall("toolu_a", "touch /tmp/a /tmp/b", "Touch them"), bashCall("toolu_b", "touch /tmp/a/tmp/b", "Touch it")
	for name, tc := range map[string]struct {
		call  transcript.PendingCall
		lines []string
		want  bool
	}{
		"one line":           {spaced, []string{"touch /tmp/a /tmp/b"}, true},
		"wrapped at a space": {spaced, []string{"touch /tmp/a", "/tmp/b"}, true},
		"wrapped in a word":  {spaced, []string{"touch /tmp/a /tm", "p/b"}, true},
		"joined":             {spaced, []string{"touch /tmp/a/tmp/b"}, false},
		"split":              {spaced, []string{"touch /tmp/a /tmp/ b"}, false},
		"more spaces":        {spaced, []string{"touch  /tmp/a   /tmp/b"}, true},
		"its own":            {joined, []string{"touch /tmp/a/tmp/b"}, true},
		"spaced":             {joined, []string{"touch /tmp/a /tmp/b"}, false},
		"cut by the wrap":    {joined, []string{"touch /tmp/a", "/tmp/b"}, true}, // a wrap may cut a word: the screen cannot tell
	} {
		sq := parseQuestionOf("claude", claudeBash("", tc.lines...), 1)
		if got := nativeOf(sq.op, []transcript.PendingCall{tc.call}, "") != nil; got != tc.want {
			t.Errorf("%s: matched %t", name, got)
		}
	}
	// Cut at the top: its end, word for word.
	tall := bashCall("toolu_t", "S=/tmp/run\nD=$S/scratch\ntouch /tmp/a /tmp/b", "Touch them")
	for name, tc := range map[string]struct {
		lines []string
		want  bool
	}{
		"its end":        {[]string{"D=$S/scratch", "touch /tmp/a /tmp/b"}, true},
		"its end joined": {[]string{"D=$S/scratch", "touch /tmp/a/tmp/b"}, false},
		"cut in a word":  {[]string{"scratch", "touch /tmp/a /tmp/b"}, true},
	} {
		full := claudeBash("", append([]string{"S=/tmp/run"}, tc.lines...)...)
		sq := parseQuestionOf("claude", full[strings.Index(full, "   "+tc.lines[0]):], 1)
		if got := nativeOf(sq.op, []transcript.PendingCall{tall}, "") != nil; sq.op.complete || got != tc.want {
			t.Errorf("cut, %s: matched %t (%+v)", name, got, sq.op)
		}
	}
}

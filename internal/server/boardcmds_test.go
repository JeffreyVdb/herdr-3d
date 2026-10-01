package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// linked is a board bridge whose floor "s" is linked to JeffreyVdb/lab, with
// its first poll done.
func linked(t *testing.T) (*boardBridge, *fakeTracker, *fakeHost) {
	t.Helper()
	bb := startBoardBridge(t, nil)
	tr, host := bb.fb.repo("JeffreyVdb/lab")
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#9", "#9", "Boards", "todo")}
	closed := card("JeffreyVdb/lab#7", "#7", "Old", "done")
	closed.State = "closed"
	closed.Capabilities = &tracker.Capabilities{Comment: true, Close: false, SetStatus: true}
	tr.board.Cards = append(tr.board.Cards, closed)
	host.board.Requests = []codehost.Request{request("JeffreyVdb/lab#31", "#31", "M6", "feat/7-m6", "success")}
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	return bb, tr, host
}

func auditRows(t *testing.T, bb *boardBridge, cmd string) []store.AuditEntry {
	t.Helper()
	log, err := bb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []store.AuditEntry
	for _, e := range log {
		if e.Cmd == cmd {
			out = append(out, e)
		}
	}
	return out
}

func TestIssueGetCommentClose(t *testing.T) {
	bb, tr, _ := linked(t)
	c := bb.c
	tr.detail = tracker.Detail{Card: card("JeffreyVdb/lab#9", "#9", "Boards", "todo"), Body: "# Boards\n\n<script>alert(1)</script>",
		Author: provider.Person{Name: "dev", AvatarURL: "https://a/1"}, CreatedAt: 1790600000000,
		Comments: []provider.Comment{{ID: "c0", Author: provider.Person{Name: "rev"}, Body: "hm", CreatedAt: 1790600100000}}, CommentsTruncated: true}

	_, m := c.command(proto.CmdIssueGet, "g", proto.ItemArgs{Session: "s", ID: "JeffreyVdb/lab#9"})
	var got struct {
		Card              tracker.Card       `json:"card"`
		Body              string             `json:"body"`
		Author            provider.Person    `json:"author"`
		CreatedAt         int64              `json:"created_at"`
		Comments          []provider.Comment `json:"comments"`
		CommentsTruncated bool               `json:"comments_truncated"`
	}
	got = ackData[struct {
		Card              tracker.Card       `json:"card"`
		Body              string             `json:"body"`
		Author            provider.Person    `json:"author"`
		CreatedAt         int64              `json:"created_at"`
		Comments          []provider.Comment `json:"comments"`
		CommentsTruncated bool               `json:"comments_truncated"`
	}](t, m)
	if got.Card.ID != "JeffreyVdb/lab#9" || got.Body != tr.detail.Body || got.Author.Name != "dev" || got.CreatedAt != 1790600000000 ||
		len(got.Comments) != 1 || got.Comments[0].Body != "hm" || !got.CommentsTruncated {
		t.Fatalf("issue.get = %s", m.raw)
	}

	// A comment: the ack has it; the audit row has the target and the size, never the text.
	secret := "the deploy key is hunter2"
	_, m = c.command(proto.CmdIssueComment, "cm", proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#9", Body: secret})
	cm := ackData[proto.CommentResult](t, m)
	if cm.Comment.ID != "c1" || cm.Comment.Body != secret {
		t.Fatalf("comment ack = %s", m.raw)
	}
	if calls := tr.Calls(); calls[len(calls)-1] != "comment JeffreyVdb/lab#9 "+secret {
		t.Fatalf("calls = %q", calls)
	}
	rows := auditRows(t, bb, proto.CmdIssueComment)
	if len(rows) != 1 || !rows[0].OK || !rows[0].Done || strings.Contains(rows[0].Args, "hunter2") || strings.Contains(rows[0].Result, "hunter2") ||
		!strings.Contains(rows[0].Args, `"body_bytes":`+itoa(len(secret))) || !strings.Contains(rows[0].Args, `"id":"JeffreyVdb/lab#9"`) {
		t.Fatalf("audit = %+v", rows)
	}

	// A refresh follows a write; its boards come after the ack.
	w := bb.watcher()
	w.watch("s")
	w.pair()
	polls := tr.Polls()
	bb.clk.Advance(time.Minute)
	w.pair() // the watched period
	bb.clk.Advance(0)
	w2 := bb.watcher()
	w2.watch("s")
	w2.pair()
	before := tr.Polls()
	_, m = c.command(proto.CmdIssueComment, "cm2", proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#9", Body: "again"})
	ackData[proto.CommentResult](t, m)
	if is, _ := w2.pair(); is.Initial || tr.Polls() != before+1 || polls == 0 {
		t.Fatalf("after a write: polls %d → %d, %+v", before, tr.Polls(), is)
	}

	// Closing needs confirm: true, a known reason, and a card that can be closed.
	c.mustError(proto.CmdIssueClose, proto.IssueCloseArgs{Session: "s", ID: "JeffreyVdb/lab#9", Reason: "completed"}, proto.ErrConfirmationRequired)
	c.mustError(proto.CmdIssueClose, map[string]any{"session": "s", "id": "JeffreyVdb/lab#9", "reason": "completed", "confirm": false}, proto.ErrConfirmationRequired)
	c.mustError(proto.CmdIssueClose, proto.IssueCloseArgs{Session: "s", ID: "JeffreyVdb/lab#9", Reason: "wontfix", Confirm: true}, proto.ErrBadRequest)
	c.mustError(proto.CmdIssueClose, proto.IssueCloseArgs{Session: "s", ID: "JeffreyVdb/lab#7", Reason: "completed", Confirm: true}, proto.ErrUnsupported)
	for _, reason := range []string{"completed", "not_planned", "duplicate"} {
		c.mustAck(proto.CmdIssueClose, proto.IssueCloseArgs{Session: "s", ID: "JeffreyVdb/lab#9", Reason: reason, Confirm: true})
		if calls := tr.Calls(); calls[len(calls)-1] != "close JeffreyVdb/lab#9 "+reason {
			t.Fatalf("calls = %q", calls)
		}
	}
	for _, e := range auditRows(t, bb, proto.CmdIssueClose) {
		if e.OK && !strings.Contains(e.Result, `"reason":`) {
			t.Errorf("audit of a close = %+v", e)
		}
	}
	// Unconfirmed closes were rejected, and audited as rejected.
	rejected := 0
	for _, e := range auditRows(t, bb, proto.CmdIssueClose) {
		if !e.OK && strings.Contains(e.Error, "confirm") {
			rejected++
		}
	}
	if rejected != 2 {
		t.Fatalf("%d rejected closes audited", rejected)
	}

	// set_status.
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#9", Column: "done"})
	if calls := tr.Calls(); calls[len(calls)-1] != "set_status JeffreyVdb/lab#9 done" {
		t.Fatalf("calls = %q", calls)
	}
	c.mustError(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#9"}, proto.ErrBadRequest)
	tr.set(func(f *fakeTracker) { f.caps.SetStatus = false })
	bb.clk.Advance(0)
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// What a provider says goes out as the protocol's error codes.
func TestBoardErrorCodes(t *testing.T) {
	bb, tr, host := linked(t)
	c := bb.c
	for _, tc := range []struct {
		err  error
		code string
	}{
		{provider.Errorf(provider.ErrNotFound, "JeffreyVdb/lab#404 is not on JeffreyVdb/lab"), proto.ErrNotFound},
		{provider.Failed("GitHub auth"), proto.ErrProviderFailed},
		{&provider.RateLimitError{Msg: "GitHub rate limit"}, proto.ErrRateLimited},
		{provider.Errorf(provider.ErrStale, "the head branch moved"), proto.ErrStale},
		{provider.Errorf(provider.ErrBadInput, "not a column"), proto.ErrBadRequest},
		{provider.Errorf(provider.ErrUnsupported, "no"), proto.ErrUnsupported},
		{provider.Errorf(provider.ErrChecksNotGreen, "checks are failure"), proto.ErrChecksNotGreen},
		{provider.Errorf(provider.ErrNotMergeable, "conflicts"), proto.ErrNotMergeable},
	} {
		tr.set(func(f *fakeTracker) { f.failOn["comment"] = tc.err; f.failOn["get"] = tc.err })
		c.mustError(proto.CmdIssueComment, proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#9", Body: "x"}, tc.code)
		c.mustError(proto.CmdIssueGet, proto.ItemArgs{Session: "s", ID: "JeffreyVdb/lab#9"}, tc.code)
		host.set(func(f *fakeHost) { f.failOn["get"] = tc.err })
		c.mustError(proto.CmdPRGet, proto.ItemArgs{Session: "s", ID: "JeffreyVdb/lab#31"}, tc.code)
	}
	// A failed write is audited as failed, with the provider's short message.
	rows := auditRows(t, bb, proto.CmdIssueComment)
	last := rows[len(rows)-1]
	if last.OK || !last.Done || !strings.Contains(last.Error, "conflicts") {
		t.Fatalf("audit = %+v", last)
	}
	// A failed write queues no refresh.
	polls := tr.Polls()
	time.Sleep(50 * time.Millisecond)
	if tr.Polls() != polls {
		t.Fatalf("polled after failed commands: %d → %d", polls, tr.Polls())
	}
}

func TestBoardCommandValidation(t *testing.T) {
	bb, tr, host := linked(t)
	c := bb.c
	long := strings.Repeat("x", 65537)
	bad := []string{"", "   ", long, "a\x00b", "a\x1bb", "bell\a"}
	for _, body := range bad {
		c.mustError(proto.CmdIssueComment, proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#9", Body: body}, proto.ErrBadRequest)
		c.mustError(proto.CmdPRComment, proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#31", Body: body}, proto.ErrBadRequest)
	}
	// Newlines and tabs are fine, and so are exactly 65536 bytes.
	c.mustAck(proto.CmdIssueComment, proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#9", Body: "a\n\tb"})
	c.mustAck(proto.CmdIssueComment, proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#9", Body: strings.Repeat("x", 65536)})
	for _, id := range []string{"", strings.Repeat("i", 201), "a\nb"} {
		c.mustError(proto.CmdIssueGet, proto.ItemArgs{Session: "s", ID: id}, proto.ErrBadRequest)
	}
	c.mustError(proto.CmdIssueGet, map[string]any{"session": "s", "id": "x", "repo": "JeffreyVdb/herdr-3d"}, proto.ErrBadRequest) // no repo/number pairs
	c.mustError(proto.CmdIssueGet, proto.ItemArgs{Session: "nope", ID: "x"}, proto.ErrUnknownSession)
	if n := len(tr.Calls()); n != 2 {
		t.Fatalf("%d provider calls for the valid comments only: %q", n, tr.Calls())
	}
	_ = host
}

// A floor with no board, a provider without pull requests, and a capability
// that is off: refused as unsupported, whatever a client sends.
func TestBoardUnsupported(t *testing.T) {
	bb, tr, host := linked(t)
	c := bb.c
	bb.floorAt("u", true, nil)
	bb.world(func(w proto.World) bool { return len(w.Floors) == 2 })
	for _, err := range []struct {
		cmd  string
		args any
	}{
		{proto.CmdIssueGet, proto.ItemArgs{Session: "u", ID: "x#1"}},
		{proto.CmdIssueComment, proto.CommentArgs{Session: "u", ID: "x#1", Body: "b"}},
		{proto.CmdIssueClose, proto.IssueCloseArgs{Session: "u", ID: "x#1", Reason: "completed", Confirm: true}},
		{proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "u", ID: "x#1", Column: "c"}},
		{proto.CmdPRGet, proto.ItemArgs{Session: "u", ID: "x#1"}},
		{proto.CmdPRComment, proto.CommentArgs{Session: "u", ID: "x#1", Body: "b"}},
		{proto.CmdPRMerge, proto.PRMergeArgs{Session: "u", ID: "x#1", Method: "merge", Confirm: true}},
	} {
		c.mustError(err.cmd, err.args, proto.ErrUnsupported)
	}
	tr.set(func(f *fakeTracker) { f.caps = tracker.Capabilities{} })
	bb.clk.Advance(0)
	// The tracker's Info is read when the floor's link is set up: change the link to pick it up.
	tr2, host2 := bb.fb.repo("JeffreyVdb/limited")
	tr2.caps = tracker.Capabilities{}
	host2.caps = codehost.Capabilities{}
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "u", Repo: proto.Some("JeffreyVdb/limited")})
	c.mustError(proto.CmdIssueComment, proto.CommentArgs{Session: "u", ID: "x#1", Body: "b"}, proto.ErrUnsupported)
	c.mustError(proto.CmdIssueClose, proto.IssueCloseArgs{Session: "u", ID: "x#1", Reason: "completed", Confirm: true}, proto.ErrUnsupported)
	c.mustError(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "u", ID: "x#1", Column: "c"}, proto.ErrUnsupported)
	c.mustError(proto.CmdPRComment, proto.CommentArgs{Session: "u", ID: "x#1", Body: "b"}, proto.ErrUnsupported)
	c.mustError(proto.CmdPRMerge, proto.PRMergeArgs{Session: "u", ID: "x#1", Method: "merge", Confirm: true}, proto.ErrUnsupported)
	if len(tr2.Calls()) != 0 || len(host2.Calls()) != 0 {
		t.Fatalf("a refused command reached the provider: %q %q", tr2.Calls(), host2.Calls())
	}
	// No pull requests at all.
	bb.fb.noHost = true
	tr3, _ := bb.fb.repo("JeffreyVdb/nohost")
	_ = tr3
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "u", Repo: proto.Some("JeffreyVdb/nohost")})
	c.mustError(proto.CmdPRGet, proto.ItemArgs{Session: "u", ID: "x#1"}, proto.ErrUnsupported)
	c.mustError(proto.CmdPRMerge, proto.PRMergeArgs{Session: "u", ID: "x#1", Method: "merge", Confirm: true}, proto.ErrUnsupported)
	_ = host
}

func mergeArgs(id, method string, mods ...func(*proto.PRMergeArgs)) proto.PRMergeArgs {
	a := proto.PRMergeArgs{Session: "s", ID: id, Method: method, Confirm: true}
	for _, m := range mods {
		m(&a)
	}
	return a
}

// pr.merge: confirm, the fresh read, the gate and the override with its second confirmation.
func TestPRMerge(t *testing.T) {
	bb, _, host := linked(t)
	c := bb.c
	const id = "JeffreyVdb/lab#31"
	setPR := func(checks, mergeable, state string) {
		host.set(func(f *fakeHost) {
			r := request(id, "#31", "M6", "feat/7-m6", checks)
			r.Mergeable, r.State = mergeable, state
			f.detail = codehost.Detail{Request: r}
		})
	}
	merges := func() []string {
		var out []string
		for _, call := range host.Calls() {
			if strings.HasPrefix(call, "merge ") {
				out = append(out, call)
			}
		}
		return out
	}

	c.mustError(proto.CmdPRMerge, proto.PRMergeArgs{Session: "s", ID: id, Method: "merge"}, proto.ErrConfirmationRequired)
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "fast-forward"), proto.ErrBadRequest)
	c.mustError(proto.CmdPRMerge, mergeArgs(id, ""), proto.ErrBadRequest)
	if len(host.Calls()) != 0 {
		t.Fatalf("calls before a valid merge: %q", host.Calls())
	}

	// Green: merged, after a fresh read (whatever the board says).
	setPR("success", "mergeable", "open")
	_, m := c.command(proto.CmdPRMerge, "m1", mergeArgs(id, "squash"))
	if res := ackData[proto.PRMergeResult](t, m); !res.Merged {
		t.Fatalf("ack = %s", m.raw)
	}
	if got := host.Calls(); len(got) != 2 || got[0] != "get "+id || got[1] != "merge "+id+" squash override=false" {
		t.Fatalf("calls = %q", got)
	}

	// Failing checks: refused; an override alone is refused too; both confirmations go through.
	setPR("failure", "mergeable", "open")
	n := len(merges())
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge"), proto.ErrChecksNotGreen)
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge", func(a *proto.PRMergeArgs) { a.Override = true }), proto.ErrChecksNotGreen)
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge", func(a *proto.PRMergeArgs) { a.ConfirmOverride = true }), proto.ErrChecksNotGreen)
	if len(merges()) != n {
		t.Fatalf("merged past failing checks: %q", merges())
	}
	c.mustAck(proto.CmdPRMerge, mergeArgs(id, "rebase", func(a *proto.PRMergeArgs) { a.Override, a.ConfirmOverride = true, true }))
	if got := merges(); len(got) != n+1 || got[n] != "merge "+id+" rebase override=true" {
		t.Fatalf("merges = %q", got)
	}
	rows := auditRows(t, bb, proto.CmdPRMerge)
	last := rows[len(rows)-1]
	if !last.OK || !strings.Contains(last.Result, `"override":true`) || !strings.Contains(last.Result, `"gate":"checks of #31 are failure"`) ||
		!strings.Contains(last.Args, `"confirm_override":true`) {
		t.Fatalf("override audit = %+v", last)
	}
	// A plain merge audits no override.
	for _, r := range rows {
		if r.OK && strings.Contains(r.Args, `"method":"squash"`) && (strings.Contains(r.Result, "override") || !strings.Contains(r.Result, `"merged":true`)) {
			t.Fatalf("plain merge audit = %+v", r)
		}
	}

	// Unknown mergeability needs the override; a conflict is never merged; nor is a closed one.
	setPR("success", "unknown", "open")
	n = len(merges())
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge"), proto.ErrNotMergeable)
	c.mustAck(proto.CmdPRMerge, mergeArgs(id, "merge", func(a *proto.PRMergeArgs) { a.Override, a.ConfirmOverride = true, true }))
	setPR("success", "conflicting", "open")
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge"), proto.ErrNotMergeable)
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge", func(a *proto.PRMergeArgs) { a.Override, a.ConfirmOverride = true, true }), proto.ErrNotMergeable)
	setPR("success", "mergeable", "merged")
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge"), proto.ErrNotMergeable)
	if len(merges()) != n+1 {
		t.Fatalf("merges = %q", merges())
	}
	// No checks at all is not green.
	setPR("none", "mergeable", "open")
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge"), proto.ErrChecksNotGreen)
	// The provider's own refusal (a head that moved) is stale.
	setPR("success", "mergeable", "open")
	host.set(func(f *fakeHost) { f.failOn["merge"] = provider.Errorf(provider.ErrStale, "the head branch moved") })
	c.mustError(proto.CmdPRMerge, mergeArgs(id, "merge"), proto.ErrStale)
}

func TestPRGetComment(t *testing.T) {
	bb, _, host := linked(t)
	c := bb.c
	host.detail = codehost.Detail{Request: request("JeffreyVdb/lab#31", "#31", "M6", "feat/7-m6", "failure"), Body: "body",
		Files:  []codehost.File{{Path: "a.go", Additions: 3, Deletions: 1, Change: "modified"}},
		Checks: []codehost.Check{{Name: "test", State: "failure", URL: "https://ci/1"}}, FilesTruncated: true}
	_, m := c.command(proto.CmdPRGet, "g", proto.ItemArgs{Session: "s", ID: "JeffreyVdb/lab#31"})
	var d struct {
		PR             codehost.Request `json:"pr"`
		Body           string           `json:"body"`
		Files          []codehost.File  `json:"files"`
		FilesTruncated bool             `json:"files_truncated"`
		Checks         []codehost.Check `json:"checks"`
	}
	d = ackData[struct {
		PR             codehost.Request `json:"pr"`
		Body           string           `json:"body"`
		Files          []codehost.File  `json:"files"`
		FilesTruncated bool             `json:"files_truncated"`
		Checks         []codehost.Check `json:"checks"`
	}](t, m)
	if d.PR.Key != "#31" || d.PR.Checks != "failure" || d.Body != "body" || len(d.Files) != 1 || d.Files[0].Change != "modified" ||
		!d.FilesTruncated || len(d.Checks) != 1 || d.Checks[0].State != "failure" {
		t.Fatalf("pr.get = %s", m.raw)
	}
	_, m = c.command(proto.CmdPRComment, "c", proto.CommentArgs{Session: "s", ID: "JeffreyVdb/lab#31", Body: "please rebase"})
	if cm := ackData[proto.CommentResult](t, m); cm.Comment.Body != "please rebase" {
		t.Fatalf("pr.comment = %s", m.raw)
	}
	rows := auditRows(t, bb, proto.CmdPRComment)
	if len(rows) != 1 || strings.Contains(rows[0].Args, "rebase") || !strings.Contains(rows[0].Args, `"body_bytes":13`) {
		t.Fatalf("audit = %+v", rows)
	}
}

// issue.set_status's after: absent is the status only, null the top of the
// column, a card id right after that card of the column; anything else is
// refused before the provider is asked, and so is any after without the
// order capability.
func TestIssueSetStatusAfter(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	tr.caps.Order = true
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#9", "#9", "Boards", "todo"), card("JeffreyVdb/lab#5", "#5", "Five", "todo"),
		card("JeffreyVdb/lab#7", "#7", "Old", "done")}
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	c := bb.c
	last := func() string { calls := tr.Calls(); return calls[len(calls)-1] }
	// No poll lands meanwhile: what the board knows of a move is the write's.
	tr.set(func(f *fakeTracker) { f.gate = make(chan struct{}) })

	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#9", Column: "done"})
	if got := last(); got != "set_status JeffreyVdb/lab#9 done" {
		t.Fatalf("absent after: %q", got)
	}
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#9", Column: "done", After: proto.Null[string]()})
	if got := last(); got != `set_status JeffreyVdb/lab#9 done after=""` {
		t.Fatalf("null after: %q", got)
	}
	// #9 is in done now (the write said so, before any poll): #5 can land right after it.
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#5", Column: "done", After: proto.Some("JeffreyVdb/lab#9")})
	if got := last(); got != `set_status JeffreyVdb/lab#5 done after="JeffreyVdb/lab#9"` {
		t.Fatalf("after a card: %q", got)
	}
	// A reorder within the card's own column is a move too.
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#7", Column: "done", After: proto.Some("JeffreyVdb/lab#5")})
	n := len(tr.Calls())
	for name, after := range map[string]string{
		"unknown":      "JeffreyVdb/lab#404",
		"wrong column": "JeffreyVdb/lab#1",
		"self":         "JeffreyVdb/lab#7",
		"empty":        "",
		"control":      "a\nb",
	} {
		args := proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#7", Column: "done", After: proto.Some(after)}
		if name == "wrong column" {
			args = proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#7", Column: "todo", After: proto.Some("JeffreyVdb/lab#9")}
		}
		c.mustError(proto.CmdIssueSetStatus, args, proto.ErrBadRequest)
	}
	c.mustError(proto.CmdIssueSetStatus, map[string]any{"session": "s", "id": "JeffreyVdb/lab#7", "column": "done", "after": 3}, proto.ErrBadRequest)
	if len(tr.Calls()) != n {
		t.Fatalf("a refused after reached the provider: %q", tr.Calls()[n:])
	}
	rows := auditRows(t, bb, proto.CmdIssueSetStatus)
	if r := rows[2]; !r.OK || !strings.Contains(r.Result, `"after":"JeffreyVdb/lab#9"`) {
		t.Fatalf("audit = %+v", r)
	}

	tr.set(func(f *fakeTracker) { close(f.gate); f.gate = nil })

	// Without the order capability any after is unsupported; absent still works.
	tr2, _ := bb.fb.repo("JeffreyVdb/reorder")
	tr2.board.Cards = []tracker.Card{card("JeffreyVdb/reorder#1", "#1", "One", "todo"), card("JeffreyVdb/reorder#2", "#2", "Two", "todo")}
	bb.link("JeffreyVdb/reorder")
	eventually(t, "the poll of the new link", func() bool { return tr2.Polls() > 0 })
	eventually(t, "its cache", func() bool {
		cs, err := bb.st.BoardCaches(context.Background())
		return err == nil && strings.Contains(string(cs["s"].Issues), "reorder#2")
	})
	c.mustError(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/reorder#1", Column: "todo", After: proto.Null[string]()}, proto.ErrUnsupported)
	c.mustError(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/reorder#1", Column: "todo", After: proto.Some("JeffreyVdb/reorder#2")}, proto.ErrUnsupported)
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/reorder#1", Column: "done"})
	if len(tr2.Calls()) != 1 {
		t.Fatalf("calls = %q", tr2.Calls())
	}
}

// A poll that was in flight when a write landed read the board from before
// it: it never becomes the latest board, and the refresh the write asked for
// follows.
func TestBoardWriteDuringPoll(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#9", "#9", "Boards", "todo")}
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	w := bb.watcher()
	w.watch("s")
	w.pair()
	// The next poll reads the board as it is now, then waits.
	tr.set(func(f *fakeTracker) { f.gate, f.early = make(chan struct{}), true })
	before := tr.Polls()
	bb.clk.Advance(time.Minute)
	eventually(t, "the poll in flight", func() bool { return tr.Polls() == before+1 })
	// The write lands, and the provider has the card in done from now on.
	bb.c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "JeffreyVdb/lab#9", Column: "done"})
	tr.set(func(f *fakeTracker) {
		f.board.Cards = []tracker.Card{card("JeffreyVdb/lab#9", "#9", "Boards", "done")}
		close(f.gate)
		f.gate, f.early = nil, false
	})
	is, _ := w.pair()
	if len(is.Cards) != 1 || is.Cards[0].Column != "done" || is.Initial {
		t.Fatalf("the first board after the write = %+v", is.Cards)
	}
	if tr.Polls() != before+2 {
		t.Fatalf("%d polls after the write, want the one in flight and its refresh", tr.Polls()-before)
	}
}

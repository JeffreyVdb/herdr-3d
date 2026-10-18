package server

// #108 round 2: round 1's review gate (protectText) on every other route
// that takes typed text to an agent, a language model or storage
// (docs/protocol.md "Prompt secrets"). A command's texts go through it as
// fields (one review each: SecretsReviews keys a command with several); a
// command with no worker yet writes its files to a pending owner that the
// worker claims (a hire's own, or a preview's hand-over to the command
// that follows it: packup.detect's to worker.prompt, hire.interpret's to
// the next hire.interpret and to worker.hire); a stored prompt (a
// schedule's, a hire preset's) keeps no file at all: only a record that it
// was reviewed with every possible secret left as typed, which a
// schedule's fire checks before it sends the prompt.

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"maps"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
)

// secretField is one text of a command for the gate: its path in the args
// ("" for a command's only text, else its SecretsReviews key), the text as
// sent, and its review (nil: none).
type secretField struct {
	path   string
	text   string
	review *proto.SecretsReview
}

// gated reports whether a command's text goes through the gate: the switch
// is on, or it carries a review anyway (refused as stale while off).
func (h *Hub) gated(reviewed bool) bool { return h.ps.enabled || reviewed }

// stillOn refuses a review (or a hand-over) that came while the switch is
// off: a tab from before the switch went off. Hub goroutine.
func (h *Hub) stillOn() error {
	if !h.ps.enabled {
		return fmt.Errorf("%w: prompt secrets are no longer reviewed: send it again", errSecretsReviewStale)
	}
	return nil
}

// reviewFields pairs the texts a command sends (each with its path) with
// its reviews: each review must name one of them.
func reviewFields(reviews proto.SecretsReviews, fields []secretField) ([]secretField, error) {
	named := 0
	for i := range fields {
		if r, ok := reviews[fields[i].path]; ok {
			fields[i].review = r
			named++
		}
	}
	if named != len(reviews) {
		return nil, fmt.Errorf("%w: %d of the reviews name no text this command sends", errSecretsReviewRequired, len(reviews)-named)
	}
	return fields, nil
}

// protectFields is protectText for each of a command's texts, all to one
// owner (off the hub goroutine): what each became, in order. All or
// nothing: a field that fails removes the files the ones before it made.
// A field's error names its path, never its text.
func (h *Hub) protectFields(ctx context.Context, rev *promptsecret.Reviewer, owner secretfiles.Owner, expires time.Time,
	fields []secretField) ([]protected, error) {
	out := make([]protected, 0, len(fields))
	for _, f := range fields {
		p, err := h.protectText(ctx, rev, owner, expires, f.text, f.review)
		if err != nil {
			h.unprotectAll(ctx, out)
			if f.path != "" {
				err = fmt.Errorf("%s: %w", f.path, err)
			}
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// unprotectAll removes the files the fields made (a failure).
func (h *Hub) unprotectAll(ctx context.Context, ps []protected) {
	for _, p := range ps {
		h.unprotect(ctx, p)
	}
}

// sentAll remembers the fields' files for their identical retry (sent).
func (h *Hub) sentAll(ps []protected, owner secretfiles.Owner) {
	for _, p := range ps {
		h.sentReview(p, owner)
	}
}

// protectedCount is how many ranges of the fields went to files.
func protectedCount(ps []protected) int {
	n := 0
	for _, p := range ps {
		n += len(p.files)
	}
	return n
}

// fieldsText is a field's text after the gate.
func fieldsText(fields []secretField, ps []protected, path string) string {
	for i, f := range fields {
		if f.path == path {
			return ps[i].text
		}
	}
	return ""
}

// startGated is a command whose gate (the scan and the files, off the hub
// goroutine) must end before anything else sees its text: next goes on
// with what the gate made on the hub goroutine, unless the switch changed
// meanwhile (stale). An error of either is the command's (audited and
// answered here); undo removes what the gate made when next fails or does
// not run (off the hub goroutine). A next that returns nil owns it.
func startGated[T any](h *Hub, ctx context.Context, c *Client, cmd proto.Command, rev *promptsecret.Reviewer,
	gate func(context.Context) (T, error), undo func(context.Context, T), next func(context.Context, T) error) {
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		out, gerr := gate(ctx)
		owned := false
		derr := h.doWait(ctx, func() {
			err := gerr
			if err == nil && h.ps.rev != rev {
				err = fmt.Errorf("%w: the setting changed: review again", errSecretsReviewStale)
			}
			if err == nil {
				err = next(ctx, out)
				owned = err == nil
			}
			if err != nil {
				h.audit(ctx, c, cmd, err)
				h.reply(c, cmd, nil, err)
			}
		})
		if derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
		if gerr == nil && !owned {
			undo(context.WithoutCancel(ctx), out)
		}
	}()
}

// secretPending is a preview's hand-over (packup.detect, hire.interpret) to
// the command that follows it: the pending owner of the files its reviews
// made (files: it has some), the texts the bridge answered as reviewed
// (sent again exactly, they need no review), the worker it is for
// (packup.detect's; "" for a hire's), its expiry, the reviewer it was made
// under (a switch change makes it stale), and where it went: the worker
// that claimed its files, or a hire under way that will (hiring).
type secretPending struct {
	rev     *promptsecret.Reviewer
	owner   secretfiles.Owner
	files   bool
	worker  string
	texts   map[string]bool
	expires time.Time
	claimed string
	hiring  bool
}

// reviewed reports a text the bridge answered as reviewed, exactly.
func (p *secretPending) reviewed(text string) bool { return p != nil && p.texts[text] }

// newPending registers a new hand-over for worker ("": a hire's) under rev,
// with a fresh pending owner: its token (random; never the owner's id,
// which the database keeps).
func (h *Hub) newPending(rev *promptsecret.Reviewer, worker string) (string, secretPending) {
	now := h.opts.Now()
	p := &secretPending{rev: rev, owner: secretfiles.NewPending(), worker: worker, texts: map[string]bool{},
		expires: now.Add(h.opts.SecretPendingTTL)}
	token := rand.Text()
	h.ps.mu.Lock()
	defer h.ps.mu.Unlock()
	for k, x := range h.ps.pending {
		if !now.Before(x.expires) {
			delete(h.ps.pending, k)
		}
	}
	h.ps.pending[token] = p
	return token, *p
}

var errPendingStale = fmt.Errorf("%w: the review of the text before (secrets_pending) no longer holds: review it again", errSecretsReviewStale)

// pendingFor is token's hand-over (a copy) for a command for worker under
// rev; hire: a hire's, whose worker is not known yet. Unknown, expired,
// made under another reviewer, for another worker, its files another
// worker's, or (for a hire) packup's: stale; taken by a hire under way:
// busy.
func (h *Hub) pendingFor(token string, rev *promptsecret.Reviewer, worker string, hire bool) (secretPending, error) {
	h.ps.mu.Lock()
	defer h.ps.mu.Unlock()
	p, ok := h.ps.pending[token]
	switch {
	case !ok || !h.opts.Now().Before(p.expires) || p.rev != rev:
		return secretPending{}, errPendingStale
	case hire && (p.worker != "" || p.claimed != ""):
		return secretPending{}, errPendingStale
	case !hire && (p.worker != worker || (p.claimed != "" && p.claimed != worker)):
		return secretPending{}, errPendingStale
	case p.hiring:
		return secretPending{}, fmt.Errorf("%w: another hire is using the review of this text", errBusy)
	}
	c := *p
	c.texts = maps.Clone(p.texts)
	return c, nil
}

// pendingAdd records what a preview answered on token: the texts it gave as
// reviewed, and whether its owner now has files.
func (h *Hub) pendingAdd(token string, files bool, texts ...string) {
	h.ps.mu.Lock()
	defer h.ps.mu.Unlock()
	p := h.ps.pending[token]
	if p == nil {
		return
	}
	p.files = p.files || files
	for _, t := range texts {
		if t != "" {
			p.texts[t] = true
		}
	}
}

// pendingHiring marks token taken by a hire under way (on), or no longer
// (off: the hire failed; its files stay pending until they expire, for
// another hire to claim).
func (h *Hub) pendingHiring(token string, on bool) error {
	h.ps.mu.Lock()
	defer h.ps.mu.Unlock()
	p := h.ps.pending[token]
	switch {
	case !on:
		if p != nil {
			p.hiring = false
		}
		return nil
	case p == nil || p.claimed != "":
		return errPendingStale
	case p.hiring:
		return fmt.Errorf("%w: another hire is using the review of this text", errBusy)
	}
	p.hiring = true
	return nil
}

// claimPending gives token's files to worker (off the hub goroutine): once
// only; a token whose files are this worker's already is done. A token
// with no files is only marked.
func (h *Hub) claimPending(ctx context.Context, token, worker string) error {
	h.ps.mu.Lock()
	p := h.ps.pending[token]
	if p == nil {
		h.ps.mu.Unlock()
		return errPendingStale
	}
	if p.claimed == worker {
		h.ps.mu.Unlock()
		return nil
	}
	owner, files := p.owner, p.files
	h.ps.mu.Unlock()
	if files {
		if h.ps.files == nil {
			return fmt.Errorf("%w: %v", errSecretsUnavailable, h.ps.err)
		}
		if err := h.ps.files.Claim(context.WithoutCancel(ctx), owner.ID, worker); err != nil {
			if errors.Is(err, secretfiles.ErrNotPending) {
				return errPendingStale // expired meanwhile
			}
			return fmt.Errorf("%w: %v", errSecretsUnavailable, err)
		}
	}
	h.ps.mu.Lock()
	p.claimed, p.hiring = worker, false
	h.ps.mu.Unlock()
	return nil
}

// releaseOwner removes a pending owner's files now (a hire that failed, a
// preview that wrote files and then failed), off the hub goroutine.
func (h *Hub) releaseOwner(ctx context.Context, owner secretfiles.Owner) {
	if h.ps.files == nil {
		return
	}
	if err := h.ps.files.Release(context.WithoutCancel(ctx), owner); err != nil {
		h.log.Warn("removing a pending owner's protected files failed (the janitor removes them once they expire)", "err", err)
	}
}

// storedReview checks a stored prompt's review (schedule.create/update,
// hire_preset.create/update/check; off the hub goroutine): the prompt's
// record when nothing was found, or when its review leaves every candidate
// as typed. No review with candidates is secrets_review_required; a review
// that protects anything secrets_review_stored (a stored prompt keeps no
// file: its files would outlive every agent).
func (h *Hub) storedReview(ctx context.Context, rev *promptsecret.Reviewer, text string, review *proto.SecretsReview) (string, error) {
	scan, err := h.scanSecrets(ctx, rev, text)
	if err != nil {
		return "", err
	}
	plan, err := reviewPlan(rev, text, scan, review)
	if err != nil {
		return "", err
	}
	if n := len(plan.Protect); n > 0 {
		return "", fmt.Errorf("%w: the review protects %d ranges, and a saved prompt keeps no protected file: remove those values from it "+
			"(or protect them when you hire with it)", errSecretsReviewStored, n)
	}
	return promptsecret.StoredDigest(text, scan), nil
}

// errStoredUnreviewed is a stored prompt's fire refused: its possible
// secrets were not all left as typed by a review of this text under these
// rules.
var errStoredUnreviewed = errors.New("its prompt was not reviewed for secrets")

// checkStored checks a stored prompt before its fire sends it (off the hub
// goroutine): nothing found, or exactly what its record says a review left
// as typed (saved before the switch, edited since, or the rules changed:
// refused, never sent raw).
func (h *Hub) checkStored(ctx context.Context, rev *promptsecret.Reviewer, text, record string) error {
	scan, err := h.scanSecrets(ctx, rev, text)
	if err != nil {
		return err
	}
	if len(scan.Found) == 0 || promptsecret.StoredDigest(text, scan) == record {
		return nil
	}
	return fmt.Errorf("%w: it has %d possible secrets that “Review prompt secrets before sending” has not seen left as typed "+
		"(saved before the switch was on, or the rules changed): open the schedule, review them and save it; nothing was sent",
		errStoredUnreviewed, len(scan.Found))
}

// reviewCounts are how many decisions of a review protect and ignore.
func reviewCounts(rs ...*proto.SecretsReview) (protect, ignore int) {
	for _, r := range rs {
		if r == nil {
			continue
		}
		for _, d := range r.Decisions {
			if d.Action == proto.SecretIgnore {
				ignore++
			} else {
				protect++
			}
		}
	}
	return protect, ignore
}

// secretsAudit is what an audit row keeps of a command's reviews: the
// decisions' counts, never a range (nil: no review).
type secretsAudit struct {
	Protect int `json:"protect"`
	Ignore  int `json:"ignore"`
}

func auditReviews(rs ...*proto.SecretsReview) *secretsAudit {
	some := false
	for _, r := range rs {
		some = some || r != nil
	}
	if !some {
		return nil
	}
	p, i := reviewCounts(rs...)
	return &secretsAudit{p, i}
}

func auditReviewMap(rs proto.SecretsReviews) *secretsAudit {
	if rs == nil {
		return nil
	}
	return auditReviews(slicesOf(rs)...)
}

func slicesOf(rs proto.SecretsReviews) []*proto.SecretsReview {
	out := make([]*proto.SecretsReview, 0, len(rs))
	for _, r := range rs {
		out = append(out, r)
	}
	return out
}

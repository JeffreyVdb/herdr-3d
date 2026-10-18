package server

// #108 prompt secrets (docs/protocol.md "Prompt secrets"): the shared
// switch "Review prompt secrets before sending" (off by default, persisted
// and published as repo_refs is), prompt_secrets.scan, and the review gate
// of worker.prompt. With the switch off nothing here runs for a prompt.
// With it on, a prompt is scanned on its worker's input lane (never on the
// hub goroutine, bounded and timed), before anything else happens to it:
// with candidates and no review it is refused (secrets_review_required),
// nothing sent, stored or written; with a review, the decisions are checked
// against that scan, each protected range is written to a private file of
// the worker (secretfiles) and replaced by a reference to it, and only then
// do the prompt's usual checks, /handoff and sending see the text. A failed
// send removes the files it made; the identical submission retried soon
// after reuses them. A worker's files go when it really ends (closed in
// herdr, or sent home), never when its floor sleeps or its herdr session
// goes; a janitor sweeps what a crash left.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
)

// Defaults of the feature's Options.
const (
	// DefaultSecretScanTimeout bounds one scan (and one write of a
	// review's files): past it the command fails, never sends raw text.
	DefaultSecretScanTimeout = 10 * time.Second
	// DefaultSecretsSweep is how often the janitor reconciles the files
	// with the workers.
	DefaultSecretsSweep = 5 * time.Minute
	// DefaultSecretReuseTTL is how long a sent review's files are reused by
	// the identical submission.
	DefaultSecretReuseTTL = 5 * time.Minute
	// DefaultSecretPendingTTL is how long a pending owner's files (a hire's,
	// a preview's: packup.detect, hire.interpret) wait for the worker that
	// claims them; unclaimed, the janitor removes them after it.
	DefaultSecretPendingTTL = 30 * time.Minute
	// maxSecretScans bounds the scans and writes running at once.
	maxSecretScans = 4
)

var (
	errSecretsReviewRequired = errors.New("secrets review required")
	errSecretsReviewStale    = errors.New("secrets review stale")
	errSecretsReviewOff      = errors.New("prompt secrets are not reviewed")
	errSecretsUnavailable    = errors.New("prompt secrets cannot be protected")
	errSecretsReviewStored   = errors.New("a stored prompt keeps no protected secret")
)

// promptSecretsErrorCode maps the feature's errors to their codes ("": none).
func promptSecretsErrorCode(err error) string {
	switch {
	case errors.Is(err, errSecretsReviewRequired):
		return proto.ErrSecretsReviewRequired
	case errors.Is(err, errSecretsReviewStale):
		return proto.ErrSecretsReviewStale
	case errors.Is(err, errSecretsReviewOff):
		return proto.ErrSecretsReviewOff
	case errors.Is(err, errSecretsUnavailable):
		return proto.ErrSecretsUnavailable
	case errors.Is(err, errSecretsReviewStored):
		return proto.ErrSecretsReviewStored
	}
	return ""
}

// promptSecretsState is the hub's part: the switch and the reviewer (hub
// goroutine; cur is the reviewer too, for any goroutine), the files (nil:
// unavailable, err says why), the scan slots, and the reviews sent lately
// (any goroutine, under mu).
type promptSecretsState struct {
	enabled bool
	rev     *promptsecret.Reviewer
	cur     atomic.Pointer[promptsecret.Reviewer]
	files   *secretfiles.Files
	err     error
	slots   chan struct{}

	mu      sync.Mutex
	reuse   map[string]secretReuse    // reuseKey → the files a sent review made
	pending map[string]*secretPending // round 2: a preview's hand-over token → it
}

// secretReuse is a sent review's files, for its identical retry.
type secretReuse struct {
	owner secretfiles.Owner
	files []secretfiles.File
	at    time.Time
}

// initPromptSecrets loads the switch and opens the files' directory
// (NewHub). A directory that cannot be used is logged: the scan works, a
// review that protects anything is refused.
func (h *Hub) initPromptSecrets(ctx context.Context) error {
	on, err := h.st.LoadPromptSecrets(ctx)
	if err != nil {
		return err
	}
	if h.opts.SecretScanTimeout <= 0 {
		h.opts.SecretScanTimeout = DefaultSecretScanTimeout
	}
	if h.opts.SecretsSweep <= 0 {
		h.opts.SecretsSweep = DefaultSecretsSweep
	}
	if h.opts.SecretReuseTTL <= 0 {
		h.opts.SecretReuseTTL = DefaultSecretReuseTTL
	}
	if h.opts.SecretPendingTTL <= 0 {
		h.opts.SecretPendingTTL = DefaultSecretPendingTTL
	}
	h.ps = promptSecretsState{enabled: on, slots: make(chan struct{}, maxSecretScans), reuse: map[string]secretReuse{},
		pending: map[string]*secretPending{}}
	if h.opts.SecretsDir == "" {
		h.ps.err = secretfiles.ErrUnavailable
	} else if f, err := secretfiles.Open(secretfiles.Options{Dir: h.opts.SecretsDir, Store: h.st, Now: h.opts.Now, Log: h.log}); err != nil {
		h.log.Warn("no directory for protected prompt secrets: a review that protects one will be refused",
			"dir", h.opts.SecretsDir, "err", err)
		h.ps.err = err
	} else {
		h.ps.files = f
	}
	h.setReviewer()
	return nil
}

// setReviewer makes a new reviewer current (hub goroutine): every review
// made before it is stale.
func (h *Hub) setReviewer() {
	h.ps.rev = h.newReviewer()
	h.ps.cur.Store(h.ps.rev)
}

// errSettingChanged refuses a review made before the switch last changed.
var errSettingChanged = fmt.Errorf("%w: the setting changed: review again", errSecretsReviewStale)

// reviewCurrent refuses a review made under rev once the switch changed
// (any goroutine): checked last before what it reviewed goes on to an
// agent or a language model, after any wait (#108 round 2).
func (h *Hub) reviewCurrent(rev *promptsecret.Reviewer) error {
	if h.ps.cur.Load() != rev {
		return errSettingChanged
	}
	return nil
}

// reviewHolds is reviewCurrent for a text that goes with or without a
// review (rev nil: none, nothing to check), where it goes to the terminal:
// right before its first byte, after any wait (review B2, pass 2).
func (h *Hub) reviewHolds(rev *promptsecret.Reviewer) error {
	if rev == nil {
		return nil
	}
	return h.reviewCurrent(rev)
}

// newReviewer is a reviewer with a fresh random key (every review made
// before it is stale) that leaves the references to the bridge's own files
// alone: only those, exactly (a text that only looks like one is scanned).
func (h *Hub) newReviewer() *promptsecret.Reviewer {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	var own func(path string) bool
	if h.ps.files != nil {
		own = h.ps.files.IsFilePath
	}
	return promptsecret.NewReviewer(key, own)
}

// closePromptSecrets lets the directory's lock go (Run, once every
// goroutine is done).
func (h *Hub) closePromptSecrets() {
	if h.ps.files != nil {
		if err := h.ps.files.Close(); err != nil {
			h.log.Warn("closing the protected secrets directory failed", "err", err)
		}
	}
}

// promptSecretsView is the switch for the snapshot and the acks.
func (h *Hub) promptSecretsView() *proto.PromptSecrets {
	return &proto.PromptSecrets{Enabled: h.ps.enabled, Available: h.ps.files != nil}
}

// startPromptSecrets answers prompt_secrets.get, .set (hub goroutine: one
// row; a change is published before the ack, and makes every review made
// before it stale) and .scan (off the hub goroutine).
func (h *Hub) startPromptSecrets(ctx context.Context, c *Client, cmd proto.Command) error {
	switch cmd.T {
	case proto.CmdPromptSecretsScan:
		var a proto.PromptSecretsScanArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if !h.ps.enabled {
			return fmt.Errorf("%w: turn on \"Review prompt secrets before sending\" first", errSecretsReviewOff)
		}
		if err := scannable(a.Text, "text"); err != nil {
			return err
		}
		rev := h.ps.rev
		h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
			r, err := h.scanSecrets(ctx, rev, a.Text)
			if err != nil {
				return nil, err
			}
			out := proto.PromptSecretsScan{Revision: r.Revision, Candidates: make([]proto.SecretCandidate, 0, len(r.Found))}
			for _, f := range r.Found {
				out.Candidates = append(out.Candidates, proto.SecretCandidate{ID: f.ID, Start: f.Start16, End: f.End16,
					Kinds: f.Kinds, Encoded: f.Encoded})
			}
			return out, nil
		})
		return nil
	case proto.CmdPromptSecretsSet:
		var a proto.PromptSecretsSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if a.Enabled == nil {
			return bad("enabled is required")
		}
		if err := h.st.SavePromptSecrets(ctx, *a.Enabled); err != nil {
			return err
		}
		if *a.Enabled != h.ps.enabled {
			h.ps.enabled = *a.Enabled
			h.setReviewer()
			h.seq++
			msg := mustJSON(proto.PromptSecretsUpdate{T: proto.EvPromptSecretsUpdate, Seq: h.seq, PromptSecrets: *h.promptSecretsView()})
			h.ring.add(h.seq, msg)
			for cl := range h.clients {
				h.deliver(cl, msg)
			}
		}
	default:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, *h.promptSecretsView(), nil)
	return nil
}

// scannable refuses a text the scan does not take whole: over 32 KiB
// (herdr.MaxPrompt; never cut) or not UTF-8. what names the argument.
func scannable(text, what string) error {
	switch {
	case len(text) > herdr.MaxPrompt:
		return bad("%s is scanned for secrets whole: at most %d bytes, got %d", what, herdr.MaxPrompt, len(text))
	case !utf8.ValidString(text):
		return bad("%s must be UTF-8 (%d bytes)", what, len(text))
	}
	return nil
}

// scanSecrets scans text with rev, off the hub goroutine: at most
// maxSecretScans at once, within SecretScanTimeout (a scan past it goes on
// in its slot, and the caller fails: what it still writes is never read).
func (h *Hub) scanSecrets(ctx context.Context, rev *promptsecret.Reviewer, text string) (promptsecret.Review, error) {
	var out promptsecret.Review
	if err := h.withSecretSlot(ctx, func() { out = rev.Scan(text) }); err != nil {
		return promptsecret.Review{}, err
	}
	return out, nil
}

// withSecretSlot runs work in a scan slot within SecretScanTimeout.
func (h *Hub) withSecretSlot(ctx context.Context, work func()) error {
	ctx, cancel := context.WithTimeout(ctx, h.opts.SecretScanTimeout)
	defer cancel()
	select {
	case h.ps.slots <- struct{}{}:
	case <-ctx.Done():
		return fmt.Errorf("%w: the bridge is busy scanning other prompts", errSecretsUnavailable)
	}
	done := make(chan struct{})
	h.wg.Add(1) // a scan or write past the timeout still ends before the hub does
	go func() {
		defer h.wg.Done()
		defer func() { <-h.ps.slots }()
		defer close(done)
		work()
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("%w: the scan took longer than %s", errSecretsUnavailable, h.opts.SecretScanTimeout)
	}
}

// decisions are a review's decisions for promptsecret, checked for their
// shape.
func decisions(r *proto.SecretsReview) ([]promptsecret.Decision, error) {
	if len(r.Decisions) > promptsecret.MaxDecisions {
		return nil, fmt.Errorf("%w: at most %d decisions, got %d", errSecretsReviewRequired, promptsecret.MaxDecisions, len(r.Decisions))
	}
	out := make([]promptsecret.Decision, len(r.Decisions))
	for i, d := range r.Decisions {
		var protect bool
		switch d.Action {
		case proto.SecretProtect:
			protect = true
		case proto.SecretIgnore:
		default:
			return nil, fmt.Errorf("%w: decision %d: action must be %q or %q", errSecretsReviewRequired, i, proto.SecretProtect, proto.SecretIgnore)
		}
		out[i] = promptsecret.Decision{Candidate: d.Candidate, Protect: protect}
		switch {
		case d.Start != nil && d.End != nil:
			out[i].Range = &promptsecret.Range{Start: *d.Start, End: *d.End}
		case d.Start != nil || d.End != nil:
			return nil, fmt.Errorf("%w: decision %d: start and end go together", errSecretsReviewRequired, i)
		}
	}
	return out, nil
}

// protected is a prompt's text after the review: what is sent instead, the
// files this submission made (a failure removes them), every file it
// references, and the review's retry key ("": nothing protected).
type protected struct {
	text    string
	created []secretfiles.File
	files   []secretfiles.File
	key     string
}

// protectText is the gate of a text-carrying command (off the hub
// goroutine; worker.prompt's on its worker's lane): the text scanned with
// rev; with no review, the text as typed when there is nothing to review,
// else secrets_review_required; with a review, checked and each protected
// range written to a file of owner (a worker, or a pending owner that
// expires) and replaced by its reference. Its errors never quote the text.
func (h *Hub) protectText(ctx context.Context, rev *promptsecret.Reviewer, owner secretfiles.Owner, expires time.Time, text string,
	review *proto.SecretsReview) (protected, error) {
	scan, err := h.scanSecrets(ctx, rev, text)
	if err != nil {
		return protected{}, err
	}
	plan, err := reviewPlan(rev, text, scan, review)
	switch {
	case err != nil:
		return protected{}, err
	case len(plan.Protect) == 0:
		return protected{text: text}, nil // nothing found, or everything ignored: sent as typed
	}
	if h.ps.files == nil {
		return protected{}, fmt.Errorf("%w: %v", errSecretsUnavailable, h.ps.err)
	}
	key := reuseKey(owner, plan.Key)
	p := protected{key: key}
	if p.files = h.reusable(key, owner); p.files == nil {
		secrets := make([][]byte, len(plan.Protect))
		for i, r := range plan.Protect {
			secrets[i] = []byte(text[r.Start:r.End])
		}
		created, err := h.writeSecrets(ctx, owner, expires, secrets)
		if err != nil {
			return protected{}, err
		}
		p.created, p.files = created, created
	}
	refs := make([]string, len(p.files))
	for i, f := range p.files {
		refs[i] = promptsecret.Reference(f.Path)
	}
	p.text = promptsecret.Replace(text, plan.Protect, refs)
	return p, nil
}

// reviewPlan checks a text's review against the bridge's scan of it: an
// empty plan when nothing was found and there is no review; no review with
// candidates is secrets_review_required, a review of another scan stale.
func reviewPlan(rev *promptsecret.Reviewer, text string, scan promptsecret.Review, review *proto.SecretsReview) (promptsecret.Plan, error) {
	if review == nil {
		if len(scan.Found) == 0 {
			return promptsecret.Plan{}, nil
		}
		return promptsecret.Plan{}, fmt.Errorf("%w: %d possible secrets: review them (prompt_secrets.scan) and send again with secrets",
			errSecretsReviewRequired, len(scan.Found))
	}
	ds, err := decisions(review)
	if err != nil {
		return promptsecret.Plan{}, err
	}
	plan, err := rev.CheckScan(text, scan, review.Revision, ds)
	var re *promptsecret.ReviewError
	switch {
	case errors.As(err, &re) && re.Stale:
		return promptsecret.Plan{}, fmt.Errorf("%w: %s", errSecretsReviewStale, re.Reason)
	case err != nil:
		return promptsecret.Plan{}, fmt.Errorf("%w: %v", errSecretsReviewRequired, err)
	}
	return plan, nil
}

// writeSecrets writes a review's secrets to files of owner, in a scan slot
// within SecretScanTimeout. A write that ends after the caller gave up
// removes its files itself.
func (h *Hub) writeSecrets(ctx context.Context, owner secretfiles.Owner, expires time.Time, secrets [][]byte) ([]secretfiles.File, error) {
	var (
		mu        sync.Mutex
		abandoned bool
		created   []secretfiles.File
		werr      error
	)
	bg := context.WithoutCancel(ctx)
	err := h.withSecretSlot(ctx, func() {
		files, err := h.ps.files.Write(bg, owner, expires, secrets)
		mu.Lock()
		defer mu.Unlock()
		if abandoned {
			if err == nil {
				h.unprotect(bg, protected{created: files})
			}
			return
		}
		created, werr = files, err
	})
	if err != nil {
		mu.Lock()
		abandoned = true
		late := created
		mu.Unlock()
		h.unprotect(bg, protected{created: late})
		return nil, err
	}
	if werr != nil {
		return nil, fmt.Errorf("%w: %v", errSecretsUnavailable, werr)
	}
	return created, nil
}

// reuseKey is a sent review's identity: its owner and the plan's key (the
// revision and the decisions).
func reuseKey(owner secretfiles.Owner, planKey string) string {
	s := sha256.Sum256([]byte(owner.Kind + "\x00" + owner.ID + "\x00" + planKey))
	return hex.EncodeToString(s[:])
}

// reusable is the files of the identical review sent lately for owner,
// when they are all still there (nil: none).
func (h *Hub) reusable(key string, owner secretfiles.Owner) []secretfiles.File {
	h.ps.mu.Lock()
	r, ok := h.ps.reuse[key]
	h.ps.mu.Unlock()
	if !ok || r.owner != owner || h.opts.Now().Sub(r.at) > h.opts.SecretReuseTTL || !h.ps.files.Exists(r.files) {
		return nil
	}
	return r.files
}

// sentReview remembers a sent review's files for its retry.
func (h *Hub) sentReview(p protected, owner secretfiles.Owner) {
	if p.key == "" {
		return
	}
	h.ps.mu.Lock()
	defer h.ps.mu.Unlock()
	now := h.opts.Now()
	for k, r := range h.ps.reuse {
		if now.Sub(r.at) > h.opts.SecretReuseTTL {
			delete(h.ps.reuse, k)
		}
	}
	h.ps.reuse[p.key] = secretReuse{owner: owner, files: p.files, at: now}
}

// unprotect removes the files a failed submission made (never those it
// reused from one sent before).
func (h *Hub) unprotect(ctx context.Context, p protected) {
	if len(p.created) == 0 {
		return
	}
	if err := h.ps.files.Remove(context.WithoutCancel(ctx), p.created); err != nil {
		h.log.Warn("removing a failed prompt's protected files failed (the janitor retries)", "files", len(p.created), "err", err)
	}
}

// settleHandoff is a reviewed /handoff's settle (agentAsk.settle, hub
// goroutine): its files follow its request's prompt. The request's end
// decides until the lane begins to send the prompt, the send's result from
// then on, whatever ended the request meanwhile. Sent, or failed without
// knowing whether any of it reached the terminal, they stay the worker's
// and serve the submission's retry; the request failed before the send (the
// skill, the limits with the references, its transcript, a takeover, the
// worker gone, a cancel), the send refused before any of it reached the
// terminal, or another request answered it (this text unused), the files
// the submission made go, off the hub goroutine (never those it reused).
func (h *Hub) settleHandoff(p protected, owner secretfiles.Owner) func(err error, existing bool) {
	return func(err error, existing bool) {
		if err == nil && !existing {
			h.sentReview(p, owner)
			return
		}
		if len(p.created) == 0 {
			return
		}
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			h.unprotect(context.Background(), p)
		}()
	}
}

// queueReviewedPrompt is queuePrompt with the switch on, or with a review
// (hub goroutine): the cheap refusals now, then on the worker's lane, in
// order with its other input, the gate, then (back on the hub goroutine)
// the prompt's own checks and side effects on the protected text, then the
// send. Round 2: a text packup.detect answered as reviewed for this worker
// (secrets_pending) needs no review again; on the lane, that hand-over is
// checked again and its files become the worker's before anything is
// sent (expired while the prompt waited: stale, nothing sent).
func (h *Hub) queueReviewedPrompt(ctx context.Context, a proto.WorkerPromptArgs, handoff func(promptHandoff) error, end inputEnd) error {
	if !h.ps.enabled { // a tab from before the switch went off
		return fmt.Errorf("%w: prompt secrets are no longer reviewed: send the prompt again", errSecretsReviewStale)
	}
	var tok secretPending
	if a.SecretsPending != "" {
		var err error
		if tok, err = h.pendingFor(a.SecretsPending, h.ps.rev, a.ID, false); err != nil {
			return err
		}
	}
	if err := scannable(a.Text, "text"); err != nil {
		return err
	}
	if !h.promptSourceOK(a.Text) {
		return badPromptText("text", len(a.Text))
	}
	w, _, err := h.termWorker(a.ID)
	if err != nil {
		return err
	}
	if w.AgentKind == "" {
		return fmt.Errorf("%w: %s runs no agent (a plain shell: use worker.keys)", errInvalidState, w.Name)
	}
	if err := h.laneRoom(a.ID); err != nil {
		return err
	}
	rev, typed, owner := h.ps.rev, a.Text, secretfiles.Worker(a.ID)
	h.queueLane(ctx, a.ID, func(ctx context.Context) {
		p := protected{text: a.Text}
		var err error
		if a.Secrets != nil || !tok.reviewed(a.Text) {
			p, err = h.protectText(ctx, rev, owner, time.Time{}, a.Text, a.Secrets)
		}
		if err == nil && a.SecretsPending != "" { // the worker's from now on, sent or not
			if err = h.claimPending(ctx, a.SecretsPending, a.ID, rev); err != nil {
				h.unprotect(ctx, p)
			}
		}
		if err != nil {
			end(ctx, nil, err)
			return
		}
		sent := a
		sent.Text, sent.Secrets, sent.SecretsPending = p.text, nil, ""
		r := promptReview{typed: typed, protected: len(p.files), rev: rev}
		if len(p.files) > 0 {
			r.settle = h.settleHandoff(p, owner)
		}
		type planned struct {
			work inputWork
			t    laneTarget
			err  error
		}
		pl, err := query(ctx, h, func() planned {
			if h.ps.rev != rev { // the switch changed meanwhile: the review is stale
				return planned{err: errSettingChanged}
			}
			work, err := h.planPrompt(ctx, sent, r, handoff)
			if err != nil || work == nil {
				return planned{err: err}
			}
			w, _, err := h.termWorker(a.ID)
			if err != nil {
				return planned{err: err}
			}
			return planned{work: work, t: laneTarget{session: w.Session, pane: w.PaneID}}
		})
		if err == nil {
			err = pl.err
		}
		if err == nil && pl.work == nil { // a /handoff: its request answers the command, and settles the files
			return
		}
		var data any
		if err == nil {
			data, err = pl.work(ctx, pl.t.session, pl.t.pane)
		}
		if err != nil {
			h.unprotect(ctx, p)
		} else {
			h.sentReview(p, owner)
		}
		end(ctx, data, err)
	})
	return nil
}

// releaseSecrets removes worker id's protected files (hub goroutine): the
// worker really ended. The files go off the hub goroutine.
func (h *Hub) releaseSecrets(id string) {
	h.ps.mu.Lock()
	for k, r := range h.ps.reuse {
		if r.owner == secretfiles.Worker(id) {
			delete(h.ps.reuse, k)
		}
	}
	h.ps.mu.Unlock()
	f := h.ps.files
	if f == nil {
		return
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := f.Release(ctx, secretfiles.Worker(id)); err != nil {
			h.log.Warn("removing an ended worker's protected files failed (the janitor retries)", "worker", id, "err", err)
		}
	}()
}

// runSecretsJanitor sweeps the files at start and every SecretsSweep (Run):
// a worker known to the hub or open in the store keeps its files (an asleep
// floor's, a gone herdr session's); a closed or unknown worker's go, and
// expired pending owners' and what has no row.
func (h *Hub) runSecretsJanitor(ctx context.Context) {
	defer h.wg.Done()
	t := time.NewTicker(h.opts.SecretsSweep)
	defer t.Stop()
	for {
		h.sweepSecrets(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (h *Hub) sweepSecrets(ctx context.Context) {
	n, err := h.ps.files.Sweep(ctx, h.liveWorkers)
	if err != nil && ctx.Err() == nil {
		h.log.Warn("protected secrets sweep failed", "err", err)
	}
	if n > 0 {
		h.log.Info("protected secrets sweep removed owners' files", "owners", n)
	}
}

// liveWorkers reads the workers that keep their files: the hub's and those
// open in the store. Sweep reads it with the files locked (review S2: read
// before, a worker that started and wrote in between lost its files).
func (h *Hub) liveWorkers(ctx context.Context) (func(id string) bool, error) {
	known, err := query(ctx, h, func() map[string]bool {
		ids := make(map[string]bool, len(h.workers))
		for id := range h.workers {
			ids[id] = true
		}
		return ids
	})
	if err != nil {
		return nil, err
	}
	open, err := h.st.OpenWorkers(ctx)
	if err != nil {
		return nil, fmt.Errorf("the workers could not be read: %w", err)
	}
	return func(id string) bool { return known[id] || open[id] }, nil
}

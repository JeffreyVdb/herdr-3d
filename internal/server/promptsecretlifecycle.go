package server

// #108 round 5: the protected files' lifecycle (docs/protocol.md "Prompt
// secrets" → "Round 5: revoke, leases and the lifecycle"): the explicit
// revoke (prompt_secrets.revoke), Worker.secret_files, and the lease of a
// handoff's files to its successor. A filed handoff records the protected
// files its text names (the document and the instruction it was written
// from); a worker hired with a first prompt that names that handoff (the
// cabinet's Hire from handoff, a schedule's handoff_path) or the files
// themselves holds them too, once herdr shows it: each lives until the last
// of its holders ends (secretfiles.Lease). A revoke removes every file the
// worker holds, for every holder; a text that refers to one of them is not
// sent once its last check comes after that (reviewHolds).

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// ownRefRe is the shape of a reference (promptsecret.Reference).
var ownRefRe = regexp.MustCompile(regexp.QuoteMeta(strings.TrimSuffix(promptsecret.Reference(""), "]")) + `(/[^\]\s]+)\]`)

// refsIn are the files the bridge's own references in texts name, in order,
// each once (any goroutine; nothing is read).
func (h *Hub) refsIn(texts ...string) []secretfiles.File {
	if h.ps.files == nil {
		return nil
	}
	var out []secretfiles.File
	for _, t := range texts {
		for _, m := range ownRefRe.FindAllStringSubmatch(t, -1) {
			if f, ok := h.ps.files.FileAt(m[1]); ok && !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

// errRevokedFile refuses a text that refers to a protected file a revoke
// removed (round 5): its references point at nothing. Its files are made
// again from the text as typed.
var errRevokedFile = fmt.Errorf("%w: a protected file it refers to was revoked: review it again", errSecretsReviewStale)

// referencesHold refuses texts that refer to a protected file a revoke
// removed (any goroutine, the hub's too: memory only).
func (h *Hub) referencesHold(texts ...string) error {
	for _, f := range h.refsIn(texts...) {
		if h.ps.files.Revoked(f.Path) {
			return errRevokedFile
		}
	}
	return nil
}

// secretsChanged is the files' Options.Changed: which files a worker holds
// may have changed, so the counts are read again (any goroutine; never
// blocks: one recount covers every change before it).
func (h *Hub) secretsChanged() {
	select {
	case h.ps.recount <- struct{}{}:
	default:
	}
}

// runSecretCounts keeps Worker.secret_files (Run): at start and after each
// change, the counts are read from the store and published.
func (h *Hub) runSecretCounts(ctx context.Context) {
	defer h.wg.Done()
	h.secretsChanged()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.ps.recount:
		}
		counts, err := h.st.SecretFileCounts(ctx)
		if err != nil {
			if ctx.Err() == nil {
				h.log.Warn("counting the workers' protected files failed", "err", err)
			}
			continue
		}
		if err := h.doWait(ctx, func() { h.setSecretCounts(counts) }); err != nil {
			return
		}
	}
}

// setSecretCounts takes the workers' file counts (hub goroutine): each
// worker whose count changed is published.
func (h *Hub) setSecretCounts(counts map[string]int) {
	h.ps.counts = counts
	for id, w := range h.workers {
		if n := counts[id]; n != w.SecretFiles {
			next := *w
			next.SecretFiles = n
			h.workers[id] = &next
			h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
		}
	}
}

// revokeReport is the audit-log result of a prompt_secrets.revoke: how many
// files went, never a path.
type revokeReport struct {
	Removed int `json:"removed"`
}

// startRevokeSecrets answers prompt_secrets.revoke (hub goroutine): a worker
// the bridge shows (an asleep floor's too), with the switch on or off; the
// files go off the hub goroutine, then the counts are published and the
// command answered. The worker is not touched.
func (h *Hub) startRevokeSecrets(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.PromptSecretsRevokeArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Worker == "" {
		return bad("worker is required")
	}
	if h.workers[a.Worker] == nil {
		return fmt.Errorf("%w: no worker %q", store.ErrNotFound, clip(a.Worker))
	}
	if h.ps.files == nil {
		return fmt.Errorf("%w: %v", errSecretsUnavailable, h.ps.err)
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	h.dropReuse(a.Worker) // a retry writes its files again
	files := h.ps.files
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		n, err := files.Revoke(rctx, a.Worker, h.liveWorkers)
		if err != nil {
			h.log.Warn("revoking a worker's protected files failed", "worker", a.Worker, "files", n, "err", err)
			err = fmt.Errorf("%w: %v", errSecretsUnavailable, err)
		} else {
			h.log.Info("protected files revoked", "worker", a.Worker, "files", n)
		}
		counts, cerr := h.st.SecretFileCounts(rctx)
		if derr := h.doWait(ctx, func() {
			if cerr == nil {
				h.setSecretCounts(counts) // before the ack
			}
			if aerr := h.st.AuditEnd(ctx, auditID, err, revokeReport{Removed: n}); aerr != nil {
				h.log.Error("audit log write failed", "err", aerr)
			}
			if err != nil {
				h.reply(c, cmd, nil, err)
				return
			}
			h.reply(c, cmd, proto.PromptSecretsRevoke{Removed: n}, nil)
		}); derr != nil {
			h.log.Warn("revoke abandoned", "worker", a.Worker, "err", derr)
		}
	}()
	return nil
}

// dropReuse forgets the files a worker's sent reviews made, for their
// retries (it ended, or they were revoked).
func (h *Hub) dropReuse(id string) {
	h.ps.mu.Lock()
	defer h.ps.mu.Unlock()
	for k, r := range h.ps.reuse {
		if r.owner == secretfiles.Worker(id) {
			delete(h.ps.reuse, k)
		}
	}
}

// hireText is a hire's first prompt as composed, untranslated (references
// and paths are left alone by a translation).
func (op *hireOp) hireText() string {
	if op.compose != nil {
		return op.compose(func(s string) string { return s })
	}
	return op.prompt
}

// leaseSuccessor lets a new worker hold the protected files its first
// prompt names (off the hub goroutine, once it is seen, after its own are
// claimed; with the switch on or off): those it refers to, and those of
// each filed handoff whose path it holds (the cabinet's Hire from handoff,
// a schedule's handoff_path). A file that went meanwhile is not held.
func (h *Hub) leaseSuccessor(ctx context.Context, op *hireOp) {
	f := h.ps.files
	text := op.hireText()
	if f == nil || text == "" {
		return
	}
	files := h.refsIn(text)
	if svc := h.opts.Handoffs; svc != nil {
		for _, path := range handoffPathsIn(svc.Dir(), text) {
			named, err := h.st.HandoffSecretsAt(ctx, path)
			if err != nil {
				h.log.Warn("reading a handoff's protected files failed", "worker", op.id, "err", err)
				continue
			}
			for _, x := range named {
				if file := (secretfiles.File{Dir: x.Dir, Name: x.Name, Path: f.Dir() + "/" + x.Dir + "/" + x.Name}); !slices.Contains(files, file) {
					files = append(files, file)
				}
			}
		}
	}
	if len(files) == 0 {
		return
	}
	n, err := f.Lease(context.WithoutCancel(ctx), op.id, files)
	if err != nil {
		h.log.Warn("the new worker could not hold every protected file its prompt names", "worker", op.id, "err", err)
	}
	if n > 0 {
		h.log.Info("the new worker holds protected files its prompt names", "worker", op.id, "files", n)
	}
}

// handoffPathsIn are the paths under the handoff directory dir that text
// names, each up to the next blank (trailing punctuation off), once.
func handoffPathsIn(dir, text string) []string {
	if dir == "" {
		return nil
	}
	var out []string
	prefix := strings.TrimSuffix(dir, "/") + "/"
	for rest := text; ; {
		i := strings.Index(rest, prefix)
		if i < 0 {
			return out
		}
		rest = rest[i:]
		end := strings.IndexFunc(rest, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' })
		if end < 0 {
			end = len(rest)
		}
		p := strings.TrimRight(rest[:end], ".,;:!?)]}\"'`")
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
		rest = rest[end:]
	}
}

// noteHandoffSecrets records the protected files a filed handoff's texts
// name (off the hub goroutine: its document, and the instruction it was
// written from), for a worker hired from it to hold. A failure is logged:
// the handoff is filed whatever comes.
func (h *Hub) noteHandoffSecrets(ctx context.Context, id int64, texts ...string) {
	files := h.refsIn(texts...)
	if len(files) == 0 {
		return
	}
	named := make([]store.SecretFile, len(files))
	for i, f := range files {
		named[i] = store.SecretFile{Dir: f.Dir, Name: f.Name}
	}
	n, err := h.st.AddHandoffSecrets(context.WithoutCancel(ctx), id, named)
	if err != nil && !errors.Is(err, context.Canceled) {
		h.log.Warn("recording a handoff's protected files failed", "handoff", id, "err", err)
	}
	if n > 0 {
		h.log.Info("a handoff names protected files", "handoff", id, "files", n)
	}
}

package server

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// #138: the composer keeps harness-neutral text (/skill, @path); a prompt
// is rewritten for its worker's harness (Codex: $skill, bare paths) on its
// input lane, just before it is sent. The rules live behind
// PromptTranslator (*harness.Prompts), not here.
//
// Which routes translate (what the person typed in the composer) and which
// do not (what the bridge wrote itself):
//
//	worker.prompt                      translated: the composer's text
//	worker.answer_ask  prompt          translated: the composer's text, sent once the dialog is gone
//	worker.answer_followup             not: the bridge builds it from the answers' fields
//	worker.wrap_up                     not: the bridge's own instruction
//	hire's first prompt, run prompts   not: the bridge builds or launches them
//
// h.prompt itself never translates, so a route that calls it sends its
// text as it is.

// PromptTranslator rewrites a prompt for a worker's harness (the agent kind
// of the worker) in its checkout. Rewrites says whether the harness has any
// rules, so a prompt to one without is not held for lookups. Translate may
// do I/O; on an error the bridge sends the text as typed. A harness with no
// rules (or no translator) retries with a lone Enter.
type PromptTranslator interface {
	Rewrites(harness string) bool
	// RetryKeys are the keys that submit a prompt again when its Enter was
	// dropped (a lone "enter", or more: a popup to close first).
	RetryKeys(harness, text string) []string
	Translate(ctx context.Context, harness, dir, text string) (string, error)
}

// maxShrink is how many times shorter a rewrite can make a prompt: the
// shortest thing a rule shortens is a quoted one-byte path, @"p" (4 bytes)
// becoming p (1 byte); a "/name" never gets shorter. A harness's rules must
// stay within it (harness's TestTranslateNeverShrinksPastAQuarter).
const maxShrink = 4

// maxPromptSource bounds a prompt before it is translated, for a harness
// that rewrites it. The limit (herdr.MaxMessage) applies to the translated
// text, so this is the source that can still fit: nothing a rewrite shrinks
// under the limit is refused, and a text beyond it is never translated.
const maxPromptSource = maxShrink * herdr.MaxMessage

// validPromptSource is herdr.ValidMessage with the larger bound.
func validPromptSource(text string) bool {
	return text != "" && len(text) <= maxPromptSource && utf8.ValidString(text) && !strings.ContainsRune(text, 0)
}

// promptSourceOK reports whether text may be queued for a prompt route,
// before translating: the 16 KiB limit, or for a harness that rewrites (the
// worker's kind) the source bound. Worker.prompt and worker.answer_ask both
// ask this.
func (h *Hub) promptSourceOK(text string) bool {
	return herdr.ValidMessage(text) || (h.opts.Prompts != nil && validPromptSource(text))
}

// rewrites reports whether a prompt to w is translated (hub goroutine).
func (h *Hub) rewrites(kind string) bool {
	return h.opts.Prompts != nil && h.opts.Prompts.Rewrites(kind)
}

// promptSite is where a worker's prompt is translated for.
type promptSite struct{ kind, dir string }

// translatePrompt is text as worker id's harness takes it, on the worker's
// lane (off the hub goroutine). It fails open: a lookup that fails, or a
// worker that went away, sends the text as typed.
func (h *Hub) translatePrompt(ctx context.Context, id, text string) string {
	if h.opts.Prompts == nil {
		return text
	}
	site, err := query(ctx, h, func() promptSite {
		if w := h.workers[id]; w != nil {
			return promptSite{w.AgentKind, checkoutOf(w)}
		}
		return promptSite{}
	})
	if err != nil || !h.rewrites(site.kind) || !herdr.ValidDir(site.dir) {
		return text
	}
	out, err := h.opts.Prompts.Translate(ctx, site.kind, site.dir, text)
	if err != nil {
		// Never the text: it is what a person typed.
		h.log.Warn("prompt not translated, sent as typed", "worker", id, "harness", site.kind, "err", err)
		return text
	}
	if !validPromptSource(out) {
		return text
	}
	return out
}

// badPromptText is the refusal of a prompt whose text is not 1 byte to
// 16 KiB of UTF-8 without NUL. what names the argument.
func badPromptText(what string, n int) error {
	return bad("%s must be 1-%d bytes of UTF-8 without NUL, got %d bytes", what, herdr.MaxMessage, n)
}

// composerPrompt is a composer's text as worker id's harness (kind) takes
// it, checked: the limit and the typing rules apply to the translated text,
// for worker.prompt and worker.answer_ask alike. what names the argument.
func (h *Hub) composerPrompt(ctx context.Context, id, kind, text, what string) (string, error) {
	text = h.translatePrompt(ctx, id, text)
	if !herdr.ValidMessage(text) {
		return "", badPromptText(what, len(text))
	}
	if err := checkTyped(kind, text, herdr.MaxMessage, what); err != nil {
		return "", err
	}
	return text, nil
}

// retryKeys are the keys that press submit again for a stalled prompt of
// text to an agent of this kind.
func (h *Hub) retryKeys(kind, text string) []string {
	if h.opts.Prompts == nil {
		return []string{"enter"}
	}
	return h.opts.Prompts.RetryKeys(kind, text)
}

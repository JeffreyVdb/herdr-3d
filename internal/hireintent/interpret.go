package hireintent

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Prompt is the system prompt: the research's revised prompt, verbatim
// (docs/research/dictation-hiring-bench/prompt.txt, 50 of 50 live).
//
//go:embed prompt.txt
var Prompt string

// Bounds.
const (
	// MaxTextBytes bounds one dictated sentence (and each source).
	MaxTextBytes = 8 << 10
	// MaxSources bounds the sentences of one proposal: the first and its
	// follow-up replies.
	MaxSources = 6
	// MaxTokens is the LLM's completion budget (the research's).
	MaxTokens = 1400
	// DefaultTimeout bounds one interpretation on the bridge: room for the
	// AI integration's two attempts of ai.DefaultLLMTimeout each (the
	// research measured a median of 2 s, p95 under 3 s).
	DefaultTimeout = 2*ai.DefaultLLMTimeout + 5*time.Second
)

// ValidText reports whether s may be interpreted: at most MaxTextBytes of
// UTF-8 without NUL.
func ValidText(s string) bool {
	return len(s) <= MaxTextBytes && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// Request is one interpretation.
type Request struct {
	// Text is the sentence dictated now (ValidText).
	Text string
	// Pending is the proposal Text replies to (a follow-up), as the last
	// Result gave it; nil for a new request. Checked again in full.
	Pending *Interpretation
	// Catalog is the bridge's current hire catalog.
	Catalog Catalog
	// Hidden are the models the user hides (#190, CheckHidden): the LLM and
	// the rules read Catalog without them. nil: none.
	Hidden Hidden
	// Classifier is asked about near misses (Select); nil: never, they are
	// asked of the user.
	Classifier ai.Classifier
}

// Roles is what the package needs of the AI integration: *ai.Service.
type Roles interface {
	State(r ai.Role) ai.State
	LLM() ai.LLM
	Classifier() ai.Classifier
}

// Run interprets req with the roles' LLM within timeout (0: none), and
// their classifier when it is ready (#190). An LLM that is not ready is a
// not_ready failure, and no call is made.
func Run(ctx context.Context, roles Roles, timeout time.Duration, req Request) Result {
	if roles == nil || roles.State(ai.RoleLLM) != ai.StateReady {
		return Result{Text: req.Text, Error: failure(ai.ErrNotReady)}
	}
	if req.Classifier == nil && roles.State(ai.RoleClassifier) == ai.StateReady {
		req.Classifier = roles.Classifier()
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	return Interpret(ctx, roles.LLM(), req)
}

// Interpret makes one call to l and resolves its answer against the
// catalog without the hidden models, asking req.Classifier about near
// misses. Every failure is a Result with Error and no proposal; Text is
// always kept. A classifier failing is not one: its field is asked.
func Interpret(ctx context.Context, l ai.LLM, req Request) Result {
	res := Result{Text: req.Text}
	var sources []string
	if p := req.Pending; p != nil {
		if err := checkPending(p); err != nil {
			res.Error = &Failure{Code: CodeBadPending, Message: "the pending hire does not hold: " + err.Error()}
			return res
		}
		sources = p.Sources
	}
	if strings.TrimSpace(req.Text) == "" {
		res.Intent = IntentUnclear // nothing said: no call
		return res
	}
	if l == nil {
		res.Error = failure(ai.ErrNotReady)
		return res
	}
	vis := req.Catalog.Without(req.Hidden)
	state := map[string]any{"command": req.Text, "hire_options": vis}
	if len(sources) > 0 {
		state["pending_hire"] = sources
	}
	payload, err := json.Marshal(state)
	if err != nil {
		res.Error = failure(err)
		return res
	}
	answer, err := l.Complete(ctx, ai.Request{
		Messages:  []ai.Message{{Role: "system", Content: Prompt}, {Role: "user", Content: string(payload)}},
		JSON:      true,
		MaxTokens: MaxTokens,
		NoPartial: true,
	})
	if err == nil && ctx.Err() != nil {
		err = ctx.Err() // the answer came after the bound: not waited on
	}
	if err != nil {
		res.Error = failure(err)
		return res
	}
	a, err := Parse(answer)
	if err != nil {
		res.Error = &Failure{Code: CodeBadAnswer, Message: "the language model's answer is not a valid interpretation: " + err.Error()}
		return res
	}
	sc := scope{full: req.Catalog, vis: vis, cls: req.Classifier}
	return resolve(ctx, a, req.Pending, append(append([]string(nil), sources...), req.Text), sc)
}

// failure is the Failure of an error of the LLM's call: its ai.Kind, a
// context's end as a timeout. The message is fixed: a provider's words may
// echo the dictation.
func failure(err error) *Failure {
	k := ai.KindOf(err)
	if k == "" {
		k = ai.KindFailed
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			k = ai.KindTimeout
		}
	}
	msg := "the language model failed (" + string(k) + ")"
	switch k {
	case ai.KindNotReady:
		msg = "the language model is not ready: set it up in the AI settings"
	case ai.KindTimeout:
		msg = "the language model took too long"
	}
	return &Failure{Code: string(k), Message: msg}
}

// checkPending checks a pending proposal sent back by a client: its
// sources, its task's span against them, the shape of its fields (a valid
// harness is claude or codex). Its values are resolved again against the
// current catalog by Resolve.
func checkPending(p *Interpretation) error {
	if n := len(p.Sources); n == 0 || n >= MaxSources {
		return fmt.Errorf("it must have 1-%d sources", MaxSources-1)
	}
	for _, s := range p.Sources {
		if strings.TrimSpace(s) == "" || !ValidText(s) {
			return fmt.Errorf("a source is empty or not valid text")
		}
	}
	for name, f := range map[string]Field{"harness": p.Harness, "model": p.Model, "effort": p.Effort} {
		ok := false
		switch f.Provenance {
		case Dictated, Resolved:
			ok = f.Value != "" && utf8.RuneCountInString(f.Value) <= maxWords
		case Invalid:
			ok = f.Value == "" && f.Said != "" && utf8.RuneCountInString(f.Said) <= maxWords
		case Missing:
			ok = f.Value == ""
		}
		if !ok || utf8.RuneCountInString(f.Said) > maxWords {
			return fmt.Errorf("its %s is not a field", name)
		}
	}
	if p.Harness.Valid() && !slices.Contains(Harnesses, p.Harness.Value) {
		return fmt.Errorf("its harness is not claude or codex")
	}
	switch t := p.Task; t.Provenance {
	case Missing:
		if t.Value != "" || t.Span != nil {
			return fmt.Errorf("a missing task has a value")
		}
	case Dictated:
		sp := t.Span
		if sp == nil || sp.Source < 0 || sp.Source >= len(p.Sources) {
			return fmt.Errorf("its task has no span in its sources")
		}
		s, e, ok := byteRange(p.Sources[sp.Source], sp.Start, sp.End)
		if !ok || s == e || p.Sources[sp.Source][s:e] != t.Value {
			return fmt.Errorf("its task is not its span of its sources")
		}
	default:
		return fmt.Errorf("its task is not a field")
	}
	return nil
}

// utf16Len is how many UTF-16 code units s is (an invalid byte one, as
// U+FFFD), packup's count.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// byteRange is the byte range of s at UTF-16 offsets [start, end); ok false
// when they are out of order, past s or inside a character.
func byteRange(s string, start, end int) (int, int, bool) {
	if start < 0 || end < start {
		return 0, 0, false
	}
	bs, be := -1, -1
	u := 0
	for i, r := range s {
		if u == start {
			bs = i
		}
		if u == end {
			be = i
		}
		if r >= 0x10000 {
			u += 2
		} else {
			u++
		}
	}
	if u == start {
		bs = len(s)
	}
	if u == end {
		be = len(s)
	}
	return bs, be, bs >= 0 && be >= 0
}

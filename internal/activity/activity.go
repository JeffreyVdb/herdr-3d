// Package activity says what an agent is doing right now, in one word, from
// its tool calls (#98): the rules (Classify) that place a Claude or Codex
// tool call, its shell commands first among them, under one of a fixed set of
// kinds, with a short and safe detail; and, opt-in, the classification model
// (#92) for the commands the rules cannot place (Service), behind a
// normalised, persisted cache and a budget.
//
// The rules are pure and send nothing. The model is asked only when switched
// on ("Classify unknown commands"), only while its role is ready, only about
// a command's text (normalised, scrubbed, its heredoc bodies dropped, clipped),
// never about a tool's output. The package takes only internal/ai's
// interfaces (TestActivityUsesOnlyAIInterfaces).
package activity

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Kind is what the agent is doing: the monitor's word.
type Kind string

// The kinds (docs/protocol.md "Activity"). Clients treat one they do not
// know as KindWorking.
const (
	KindThinking      Kind = "thinking"
	KindReplying      Kind = "replying"
	KindWriting       Kind = "writing"
	KindInvestigating Kind = "investigating"
	KindTesting       Kind = "testing"
	KindBuilding      Kind = "building"
	KindShipping      Kind = "shipping"
	KindResearching   Kind = "researching"
	KindDelegating    Kind = "delegating"
	KindPlanning      Kind = "planning"
	KindWaiting       Kind = "waiting"
	KindImage         Kind = "image"
	KindWorking       Kind = "working"
)

// Kinds lists every kind.
var Kinds = []Kind{KindThinking, KindReplying, KindWriting, KindInvestigating, KindTesting, KindBuilding, KindShipping,
	KindResearching, KindDelegating, KindPlanning, KindWaiting, KindImage, KindWorking}

// Word is the kind's word on the monitor ("" for an image).
func (k Kind) Word() string {
	switch k {
	case KindImage:
		return ""
	case "":
		return "Working"
	}
	return strings.ToUpper(string(k[:1])) + string(k[1:])
}

// Where an activity's label came from (Activity.Source).
const (
	SourceRule    = "rule"    // the rules placed the tool call
	SourceModel   = "model"   // the classification model placed its command
	SourceDerived = "derived" // the turn's state: thinking, replying, waiting on background tasks
)

// Activity is what a worker's agent is doing (Worker.activity).
type Activity struct {
	Kind Kind `json:"kind"`
	// Detail is short and safe: a file's basename (+N), a test runner, a
	// command's head; never a whole command line. Waiting while idle says
	// what is awaited ("Testing in the background", "Wakes at 14:05").
	Detail string `json:"detail,omitempty"`
	// Since is when this label started, unix ms (bridge clock); waiting
	// while idle: when the turn ended.
	Since  int64  `json:"since"`
	Source string `json:"source"`
	// Image is the image the agent looks at (KindImage only).
	Image *Image `json:"image,omitempty"`
	// Tasks is how many background tasks are open (waiting while idle only).
	Tasks int `json:"tasks,omitempty"`
}

// Image is an image the agent looked at or generated: transcript.image
// serves its thumbnail by hash.
type Image struct {
	Hash string `json:"hash"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// MaxDetail bounds a detail, in runes; a waiting-while-idle detail may take
// MaxWaitDetail.
const (
	MaxDetail     = 32
	MaxWaitDetail = 40
)

// Clip shortens s to at most n runes, at a word when it can, with "…".
func Clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)[:n-1]
	if i := lastSpace(r); i > n/2 {
		r = r[:i]
	}
	return strings.TrimRight(string(r), " ") + "…"
}

func lastSpace(r []rune) int {
	for i := len(r) - 1; i >= 0; i-- {
		if r[i] == ' ' {
			return i
		}
	}
	return -1
}

// tokenRe is what looks like a token or key besides ai.Scrub's patterns: a
// GitHub token (the gh scrubber's), an AWS key id, a JWT, a URL's password.
var tokenRe = regexp.MustCompile(`\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)|(://[^/\s:@]+:)[^/\s@]+@`)

// Scrub removes what looks like a secret from s: keys, bearer tokens, GitHub
// tokens, a URL's password.
func Scrub(s string) string {
	s = tokenRe.ReplaceAllStringFunc(s, func(m string) string {
		if strings.HasPrefix(m, "://") {
			return m[:strings.Index(m[3:], ":")+4] + "[key]@"
		}
		return "[key]"
	})
	return ai.Scrub(s)
}

// safeDetail is a detail as shown: scrubbed and clipped.
func safeDetail(s string, n int) string { return Clip(Scrub(s), n) }

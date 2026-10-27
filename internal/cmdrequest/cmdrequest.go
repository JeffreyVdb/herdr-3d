// Package cmdrequest extracts reviewed commands from final agent replies.
package cmdrequest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/manual/tsserve"
)

const GateQuestion = "Does this final reply explicitly ask the human to run a shell command themselves (not something the agent already ran, not documentation, not an example or alternative)?"
const Threshold = 0.7

type Variant struct {
	Label   string `json:"label"`
	Command string `json:"command"`
	Note    string `json:"note"`
}
type Command struct {
	Command  string    `json:"command"`
	Cwd      string    `json:"cwd"`
	CwdNamed bool      `json:"cwd_named"`
	Host     string    `json:"host"`
	HostText string    `json:"host_text,omitempty"`
	Why      string    `json:"why,omitempty"`
	Variants []Variant `json:"variants,omitempty"`
}
type Request struct {
	Key      string    `json:"key"`
	At       int64     `json:"at"`
	Commands []Command `json:"commands"`
}

const prompt = `Extract only shell commands this final reply explicitly asks the human to run themselves. Exclude commands already run, documentation, examples, alternatives and quoted errors. Return only JSON {"commands":[{"command":"...","cwd":"...","host":"bridge|other|unknown","host_text":"...","why":"..."}]}. Return an empty array if none. command, cwd and host_text must be exact substrings of the reply, preserving all whitespace, quoting and newlines. Use bridge for the agent's machine or when no machine is named, other for a named different machine (host_text must quote that machine's name), unknown for ambiguity. An account, user or privilege ("as your user", "under your account", "as root", "with sudo") is not a machine: never put it in host_text; such a command is bridge unless a different machine is named. cwd and why are optional. Never invent a command.`

// Decision is the gate's verdict on a reply (#213).
type Decision struct {
	Extract bool
	// Gate is why: "threshold" (score at least Threshold), "candidate"
	// (Candidate's rule and a score at least Band) or "below".
	Gate string
	Rule string // Candidate's rule ("": none)
}

// Gate decides whether a reply with the classifier's command score reaches
// extraction.
func Gate(score float64, reply string) Decision {
	d := Decision{Gate: "below", Rule: Candidate(reply)}
	switch {
	case score >= Threshold:
		d.Extract, d.Gate = true, "threshold"
	case score >= Band && d.Rule != "":
		d.Extract, d.Gate = true, "candidate"
	}
	return d
}

// ErrMalformed is an extraction answer that is not the JSON asked for.
var ErrMalformed = errors.New("malformed extraction answer")

// Result is an extraction's validated commands and how many of the
// model's entries were dropped, by reason (Rejections' keys).
type Result struct {
	Commands []Command
	Rejected map[string]int
}

// Rejections renders r.Rejected as "reason:n,…" in order ("" none): a log
// value with no reply text in it.
func (r Result) Rejections() string {
	var parts []string
	for k, v := range r.Rejected {
		parts = append(parts, fmt.Sprintf("%s:%d", k, v))
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

func Extract(ctx context.Context, l ai.LLM, text string) ([]Command, error) {
	r, err := ExtractReport(ctx, l, text)
	return r.Commands, err
}

// ExtractReport is Extract with the rejected entries' reasons.
func ExtractReport(ctx context.Context, l ai.LLM, text string) (Result, error) {
	temp := 0.0
	out, err := l.Complete(ctx, ai.Request{Messages: []ai.Message{{Role: "system", Content: prompt}, {Role: "user", Content: text}}, Temperature: &temp, MaxTokens: 4096, NoPartial: true, JSON: true, Timeout: 45 * time.Second, NoUncertainRetry: true})
	if err != nil {
		return Result{}, err
	}
	return ParseReport(text, out)
}

// Parse validates every model-provided span against the original reply.
func Parse(reply, answer string) ([]Command, error) {
	r, err := ParseReport(reply, answer)
	return r.Commands, err
}

// ParseReport is Parse with the rejected entries' reasons.
func ParseReport(reply, answer string) (Result, error) {
	res := Result{Rejected: map[string]int{}}
	obj, ok := ai.FirstJSONObject(answer)
	if !ok {
		return res, fmt.Errorf("%w: no JSON object", ErrMalformed)
	}
	var raw struct {
		Commands []Command `json:"commands"`
	}
	if err := json.Unmarshal([]byte(obj), &raw); err != nil {
		return res, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	var out []Command
	type span struct{ start, end int }
	var used []span
	reject := func(reason string) { res.Rejected[reason]++ }
	for _, c := range raw.Commands {
		if len(out) >= 3 {
			reject("over_limit")
			continue
		}
		command := c.Command
		if strings.HasPrefix(command, "```") {
			if n := strings.IndexByte(command, '\n'); n >= 0 && strings.HasSuffix(command, "```") {
				inner := strings.TrimSuffix(command[n+1:], "```")
				inner = strings.TrimSuffix(inner, "\n")
				if strings.Contains(reply, inner) && inner != "" {
					command = inner
				}
			}
		}
		at := strings.Index(reply, command)
		if strings.TrimSpace(command) == "" || len(command) > 8192 || !utf8.ValidString(command) || strings.ContainsRune(command, 0) {
			reject("bad_command")
			continue
		}
		if at < 0 {
			reject("not_in_reply")
			continue
		}
		overlap := false
		for _, s := range used {
			if at < s.end && s.start < at+len(command) {
				overlap = true
				break
			}
		}
		if overlap {
			reject("overlap")
			continue
		}
		if c.Cwd != "" && (len(c.Cwd) > 8192 || strings.TrimSpace(c.Cwd) == "" || !strings.Contains(reply, c.Cwd)) {
			reject("cwd")
			continue
		}
		if c.HostText != "" && (len(c.HostText) > 8192 || strings.TrimSpace(c.HostText) == "" || !strings.Contains(reply, c.HostText)) {
			reject("host_text")
			continue
		}
		if c.Host != "bridge" && c.Host != "other" && c.Host != "unknown" {
			reject("host")
			continue
		}
		if c.Host == "other" && c.HostText == "" {
			reject("host_text")
			continue
		}
		// #220: an account or privilege is not a machine; the entry is kept,
		// on the bridge, and counted.
		if c.Host == "other" && accountHost(c.HostText) {
			c.Host, c.HostText = "bridge", ""
			reject("account_host")
		}
		if len(c.Why) > 120 || (c.Why != "" && !strings.Contains(reply, c.Why)) {
			c.Why = ""
		}
		c.Command = command
		c.CwdNamed = false
		c.Variants = nil
		if v, ok := tsserve.ForegroundVariant(command); ok {
			c.Variants = []Variant{{Label: "Temporary share (foreground)", Command: v, Note: "Ends when the process stops; --bg would keep serving after restarts."}}
		}
		used = append(used, span{at, at + len(command)})
		out = append(out, c)
	}
	res.Commands = out
	return res, nil
}

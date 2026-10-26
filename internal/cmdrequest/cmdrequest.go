// Package cmdrequest extracts reviewed commands from final agent replies.
package cmdrequest

import (
	"context"
	"encoding/json"
	"fmt"
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

const prompt = `Extract only shell commands this final reply explicitly asks the human to run themselves. Exclude commands already run, documentation, examples, alternatives and quoted errors. Return only JSON {"commands":[{"command":"...","cwd":"...","host":"bridge|other|unknown","host_text":"...","why":"..."}]}. Return an empty array if none. command, cwd and host_text must be exact substrings of the reply, preserving all whitespace, quoting and newlines. Use bridge for the agent's machine or when no machine is named, other for a named different machine (host_text must quote its name), unknown for ambiguity. cwd and why are optional. Never invent a command.`

func Extract(ctx context.Context, l ai.LLM, text string) ([]Command, error) {
	temp := 0.0
	out, err := l.Complete(ctx, ai.Request{Messages: []ai.Message{{Role: "system", Content: prompt}, {Role: "user", Content: text}}, Temperature: &temp, MaxTokens: 4096, NoPartial: true, JSON: true, Timeout: 45 * time.Second, NoUncertainRetry: true})
	if err != nil {
		return nil, err
	}
	return Parse(text, out)
}

// Parse validates every model-provided span against the original reply.
func Parse(reply, answer string) ([]Command, error) {
	obj, ok := ai.FirstJSONObject(answer)
	if !ok {
		return nil, fmt.Errorf("no JSON object")
	}
	var raw struct {
		Commands []Command `json:"commands"`
	}
	if err := json.Unmarshal([]byte(obj), &raw); err != nil {
		return nil, err
	}
	var out []Command
	type span struct{ start, end int }
	var used []span
	for _, c := range raw.Commands {
		if len(out) >= 3 {
			break
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
		if strings.TrimSpace(command) == "" || len(command) > 8192 || !utf8.ValidString(command) || strings.ContainsRune(command, 0) || at < 0 {
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
			continue
		}
		if c.Cwd != "" && (len(c.Cwd) > 8192 || strings.TrimSpace(c.Cwd) == "" || !strings.Contains(reply, c.Cwd)) {
			continue
		}
		if c.HostText != "" && (len(c.HostText) > 8192 || strings.TrimSpace(c.HostText) == "" || !strings.Contains(reply, c.HostText)) {
			continue
		}
		if c.Host != "bridge" && c.Host != "other" && c.Host != "unknown" {
			continue
		}
		if c.Host == "other" && c.HostText == "" {
			continue
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
	return out, nil
}

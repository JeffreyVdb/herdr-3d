package transcript

import (
	"encoding/json"
	"strings"
)

// #95: the bridge types its prompts into Claude Code, so none should reach
// the transcript as a paste. ClaudePasted finds the prompts that did, for
// the bridge's regression warning (Claude Code's paste threshold, an
// input burst of more than 800 characters in v2.1.287, may change).

type pastedLine struct {
	Type        string `json:"type"`
	IsMeta      bool   `json:"isMeta"`
	IsSidechain bool   `json:"isSidechain"`
	Message     *struct {
		Content strOr[claudeBlock] `json:"content"`
	} `json:"message"`
	Attachment json.RawMessage `json:"attachment"`
}

// ClaudePasted reads a Claude Code transcript line: a person's prompt (a
// user line, or a prompt queued while the agent worked) that holds pasted
// text returns its text without the paste wrapper and reminders, trimmed.
func ClaudePasted(b []byte) (string, bool) {
	if s := string(b); !strings.Contains(s, "<pasted_content ") && !strings.Contains(s, `\u003cpasted_content `) {
		return "", false // most lines: not decoded
	}
	var l pastedLine
	if json.Unmarshal(b, &l) != nil || l.IsSidechain || l.IsMeta {
		return "", false
	}
	var texts []string
	switch {
	case l.Type == "attachment":
		var a claudeAttach
		if json.Unmarshal(l.Attachment, &a) == nil && a.Type == "queued_command" && a.CommandMode == "prompt" {
			texts = append(texts, a.Prompt)
		}
	case l.Type == "user" && l.Message != nil && l.Message.Content.isStr:
		texts = append(texts, l.Message.Content.str)
	case l.Type == "user" && l.Message != nil:
		for _, bl := range l.Message.Content.list {
			if bl.Type == "text" {
				texts = append(texts, bl.Text)
			}
		}
	}
	for _, t := range texts {
		if strings.Contains(t, "<pasted_content ") && genuinePrompt(t) {
			return asking(t), true
		}
	}
	return "", false
}

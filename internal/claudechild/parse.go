package claudechild

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// The records of Claude Code's transcripts and hook input this package
// reads, as observed on 2.1.302 (docs/research/claude-subagents.md). They
// are no versioned schema: a field that is missing or of another type says
// nothing, a line that does not parse is skipped, an unknown record type is
// ignored.

// line is a transcript record (main or child).
type line struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	SessionID string `json:"sessionId"`
	AgentID   string `json:"agentId"`
	IsMeta    bool   `json:"isMeta"`
	Operation string `json:"operation"`
	// Content is a queue-operation's text.
	Content json.RawMessage `json:"content"`
	Message *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
	ToolUseResult json.RawMessage `json:"toolUseResult"`
}

// block is a message content block.
type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
}

// agentInput is an Agent (legacy Task) call's input.
type agentInput struct {
	SubagentType string `json:"subagent_type"`
	Description  string `json:"description"`
	Name         string `json:"name"`
	// TeamName makes the call an agent-team teammate's spawn (docs only,
	// unverified on 2.1.302): no subagent row.
	TeamName string `json:"team_name"`
}

// agentResult is an Agent call's structured result (toolUseResult, or a
// PostToolUse hook's tool_response): "async_launched" (a background child
// started), "completed" (a foreground child's hand-back).
type agentResult struct {
	Status     string `json:"status"`
	AgentID    string `json:"agentId"`
	TeammateID string `json:"teammate_id"`
}

func (r agentResult) teammate() bool {
	return r.TeammateID != "" || strings.HasPrefix(r.Status, "teammate")
}

// subagentTool is the Agent tool's name, and its legacy name.
func subagentTool(name string) bool { return name == "Agent" || name == "Task" }

// stamp reads a record's timestamp as unix ms (0: none).
func stamp(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// blocks reads message content as blocks; a string content is one text
// block.
func blocks(raw json.RawMessage) []block {
	raw = bytes.TrimSpace(raw)
	switch {
	case len(raw) == 0:
		return nil
	case raw[0] == '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil
		}
		return []block{{Type: "text", Text: s}}
	case raw[0] == '[':
		var bs []json.RawMessage
		if json.Unmarshal(raw, &bs) != nil {
			return nil
		}
		out := make([]block, 0, len(bs))
		for _, b := range bs {
			var x block
			if json.Unmarshal(b, &x) == nil {
				out = append(out, x)
			}
		}
		return out
	}
	return nil
}

// result reads a toolUseResult: an object (agentResult), else nothing (the
// string a rejected call carries says no more than its is_error).
func result(raw json.RawMessage) agentResult {
	var r agentResult
	if raw = bytes.TrimSpace(raw); len(raw) > 0 && raw[0] == '{' {
		_ = json.Unmarshal(raw, &r)
	}
	if !transcript.ValidAgentID(r.AgentID) {
		r.AgentID = ""
	}
	return r
}

// interrupted is the text of a user record that marks an interruption, not
// a prompt to the child.
const interrupted = "[Request interrupted"

// prompt reports whether a user record is a prompt to the agent (its task,
// a resume's message, a Stop-hook's feedback): text, no tool result, not an
// interruption marker and not a meta record.
func (l *line) prompt() bool {
	if l.Type != "user" || l.IsMeta || l.Message == nil {
		return false
	}
	text := false
	for _, b := range blocks(l.Message.Content) {
		switch b.Type {
		case "tool_result":
			return false
		case "text":
			if t := strings.TrimSpace(b.Text); t != "" && !strings.HasPrefix(t, interrupted) {
				text = true
			}
		}
	}
	return text
}

// notification is a <task-notification>: a background task's end.
type notification struct {
	taskID, toolUseID, status string
}

var (
	notifRe     = regexp.MustCompile(`(?s)<task-notification>(.*?)</task-notification>`)
	notifTaskRe = regexp.MustCompile(`<task-id>\s*([^<\s]+)\s*</task-id>`)
	notifToolRe = regexp.MustCompile(`<tool-use-id>\s*([^<\s]+)\s*</tool-use-id>`)
	notifStatRe = regexp.MustCompile(`<status>\s*([^<\s]+)\s*</status>`)
)

// notifications reads the task notifications of a text.
func notifications(text string) []notification {
	var out []notification
	for _, m := range notifRe.FindAllStringSubmatch(text, -1) {
		var n notification
		if v := notifTaskRe.FindStringSubmatch(m[1]); v != nil {
			n.taskID = v[1]
		}
		if v := notifToolRe.FindStringSubmatch(m[1]); v != nil {
			n.toolUseID = v[1]
		}
		if v := notifStatRe.FindStringSubmatch(m[1]); v != nil {
			n.status = v[1]
		}
		if (n.taskID != "" || n.toolUseID != "") && n.status != "" {
			out = append(out, n)
		}
	}
	return out
}

// meta is a child's agent-<id>.meta.json.
type meta struct {
	AgentType     string `json:"agentType"`
	Description   string `json:"description"`
	ToolUseID     string `json:"toolUseId"`
	ParentAgentID string `json:"parentAgentId"`
	SpawnDepth    int    `json:"spawnDepth"`
	Finished      bool   `json:"finished"`
	IsFork        bool   `json:"isFork"`
}

// parseMeta reads a meta file tolerantly: a field of another type is
// dropped, not the file.
func parseMeta(b []byte) (meta, bool) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(b, &raw) != nil {
		return meta{}, false
	}
	var m meta
	str := func(k string, dst *string) { _ = json.Unmarshal(raw[k], dst) }
	str("agentType", &m.AgentType)
	str("description", &m.Description)
	str("toolUseId", &m.ToolUseID)
	str("parentAgentId", &m.ParentAgentID)
	_ = json.Unmarshal(raw["spawnDepth"], &m.SpawnDepth)
	_ = json.Unmarshal(raw["finished"], &m.Finished)
	_ = json.Unmarshal(raw["isFork"], &m.IsFork)
	if !transcript.ValidAgentID(m.ParentAgentID) {
		m.ParentAgentID = ""
	}
	return m, true
}

// hookInput is one line of the bridge's hook log: a hook's stdin.
type hookInput struct {
	Event     string          `json:"hook_event_name"`
	SessionID string          `json:"session_id"`
	ToolName  string          `json:"tool_name"`
	ToolUseID string          `json:"tool_use_id"`
	ToolInput *agentInput     `json:"tool_input"`
	Response  json.RawMessage `json:"tool_response"`
	// AgentID is the subagent an event is of, or (a tool event) the
	// subagent that made the call; absent on the main thread's.
	AgentID   string  `json:"agent_id"`
	AgentType *string `json:"agent_type"`
}

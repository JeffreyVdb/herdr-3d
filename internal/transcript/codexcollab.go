package transcript

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #56: Codex's collaboration (multi-agent) calls and the messages agents
// send each other, read for the view. Multi-agent v2 encrypts each message
// (openai/codex#26210: the Responses API does, and only it can read it):
// what is plain is the call's other arguments, its output, the
// SubAgentActivity event Codex records for it and an inbound message's
// header. Codex 0.162.1.

// codexCollabKinds are the collaboration tools, by name.
var codexCollabKinds = map[string]string{
	"spawn_agent": proto.CollabSpawn, "send_message": proto.CollabSend, "followup_task": proto.CollabFollowup,
	"wait_agent": proto.CollabWait, "close_agent": proto.CollabClose,
}

// codexEncrypted is how a Fernet token, what Codex stores of an encrypted
// message, starts.
const codexEncrypted = "gAAAAA"

// collabKind is a call's collaboration kind: its name in the collaboration
// namespace, or with none (older builds); "" for any other call.
func collabKind(it *codexItem) string {
	if it.Namespace != "collaboration" && it.Namespace != "" {
		return ""
	}
	return codexCollabKinds[it.Name]
}

// collabCall is what a collaboration call's arguments say, and its row's
// summary: the task or target, never the message.
func collabCall(kind string, input json.RawMessage) (proto.TranscriptCollab, string) {
	var in map[string]json.RawMessage
	cut := json.Unmarshal(input, &in) != nil // arguments that are not JSON (cut short)
	str := func(k string) string {
		var s string
		if json.Unmarshal(in[k], &s) != nil {
			if n, ok := in[k]; ok && len(n) > 0 && n[0] >= '0' && n[0] <= '9' {
				return string(n) // fork_turns as a number of turns
			}
		}
		return strings.TrimSpace(s)
	}
	c := proto.TranscriptCollab{Kind: kind, TaskName: str("task_name"), Target: str("target"), AgentType: str("agent_type"),
		Model: str("model"), Effort: str("reasoning_effort"), ForkTurns: str("fork_turns")}
	if c.Target == "" && kind == proto.CollabClose {
		c.Target = str("id") // v1: close_agent {id}
	}
	if m := str("message"); strings.HasPrefix(m, codexEncrypted) || cut && bytes.Contains(input, []byte(codexEncrypted)) {
		c.Encrypted = true
	} else {
		c.Prompt = m
	}
	summary := c.Target
	if kind == proto.CollabSpawn {
		summary = c.TaskName
		if summary == "" {
			summary = c.AgentType
		}
	}
	return c, summary
}

// collabOutput fills what a call's output says: the agent's path
// ({"task_name": "/root/x"}), on v1 its nickname and id.
func collabOutput(c *proto.TranscriptCollab, text string) {
	var out struct {
		TaskName string `json:"task_name"`
		Nickname string `json:"nickname"`
		AgentID  string `json:"agent_id"`
	}
	if json.Unmarshal([]byte(text), &out) != nil {
		return
	}
	nick := out.Nickname
	if strings.HasPrefix(nick, "/") { // a path where some builds say nickname
		fill(&c.AgentPath, nick)
		nick = ""
	}
	fill(&c.AgentPath, out.TaskName)
	fill(&c.Nickname, nick)
	fill(&c.ThreadID, out.AgentID)
}

// fill sets *dst to v unless it has a value.
func fill(dst *string, v string) {
	if *dst == "" {
		*dst = strings.TrimSpace(v)
	}
}

// codexSubAgent is the SubAgentActivity item of an item_completed event:
// Codex's record of a collaboration call (its id is the call's) or of a
// subagent finishing (an id of its own). A CollabAgentToolCall item (the
// app-server's, seen for wait_agent) is read the same way, with the prompt
// it has "when available".
type codexSubAgent struct {
	Type              string   `json:"type"`
	ID                string   `json:"id"`
	Kind              string   `json:"kind"`
	Model             string   `json:"model"`
	ReasoningEffort   string   `json:"reasoning_effort"`
	AgentThreadID     string   `json:"agent_thread_id"`
	AgentPath         string   `json:"agent_path"`
	Prompt            string   `json:"prompt"`
	ReceiverThreadIDs []string `json:"receiver_thread_ids"`
}

// codexSubAgentEvent is such an event's part of its call's row: the model
// and effort the arguments may leave out, the child's path and thread,
// filling what the call did not say. Not ok for any other item, and for a
// subagent's completion, which is no call's.
func codexSubAgentEvent(ev *codexEvent, ts int64) (contrib, bool) {
	var a codexSubAgent
	if !bytes.Contains(ev.Item, []byte(`"SubAgentActivity"`)) && !bytes.Contains(ev.Item, []byte(`"CollabAgentToolCall"`)) ||
		json.Unmarshal(ev.Item, &a) != nil || (a.Type != "SubAgentActivity" && a.Type != "CollabAgentToolCall") ||
		a.ID == "" || a.Kind == "completed" || strings.HasPrefix(a.ID, "subagent-") {
		return contrib{}, false
	}
	thread := a.AgentThreadID
	if thread == "" && len(a.ReceiverThreadIDs) == 1 {
		thread = a.ReceiverThreadIDs[0]
	}
	prompt := a.Prompt
	if strings.HasPrefix(prompt, codexEncrypted) {
		prompt = ""
	}
	return contrib{link: linkMerge, id: a.ID, ts: ts, apply: func(b *builder) {
		c := b.it.Collab
		if c == nil {
			return
		}
		fill(&c.Model, a.Model)
		fill(&c.Effort, a.ReasoningEffort)
		fill(&c.AgentPath, a.AgentPath)
		fill(&c.ThreadID, thread)
		fill(&c.Prompt, prompt)
	}}, true
}

// collabInbound reads an inter-agent message: a header part ("Message
// Type: …\nTask name: …\nSender: …\nPayload:\n"), then the payload: plain
// text after the header or in the parts after it, or an encrypted_content
// part.
func collabInbound(it *codexItem) proto.TranscriptCollab {
	c := proto.TranscriptCollab{Kind: proto.CollabInbound, AgentPath: it.Author, Recipient: it.Recipient}
	var payload []string
	for i, p := range it.Content.list {
		if p.Type == "encrypted_content" {
			c.Encrypted = true
			continue
		}
		text := p.Text
		if i == 0 {
			text = collabHeader(&c, text)
		}
		if strings.TrimSpace(text) != "" {
			payload = append(payload, text)
		}
	}
	c.Prompt = strings.TrimSpace(strings.Join(payload, "\n"))
	return c
}

// collabHeader reads an inbound message's header into c and returns the
// rest of the part (the payload); a part with no header is all payload.
func collabHeader(c *proto.TranscriptCollab, text string) string {
	head, rest, ok := strings.Cut(text, "Payload:")
	if !ok || !strings.HasPrefix(head, "Message Type:") {
		return text
	}
	rest = strings.TrimPrefix(rest, "\n")
	for _, l := range strings.Split(head, "\n") {
		k, v, _ := strings.Cut(l, ":")
		v = strings.TrimSpace(v)
		switch k {
		case "Message Type":
			c.MessageType = v
		case "Sender":
			fill(&c.AgentPath, v)
		}
	}
	return rest
}

// collabNotice is an inbound message's notice text, for a view that does
// not read collab: sender → recipient, then a plain payload.
func collabNotice(c proto.TranscriptCollab) string {
	text := c.Prompt
	if c.AgentPath != "" || c.Recipient != "" {
		text = strings.TrimSpace(c.AgentPath + " → " + c.Recipient + "\n" + text)
	}
	return text
}

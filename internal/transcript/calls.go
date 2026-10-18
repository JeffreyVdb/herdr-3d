package transcript

// #106: the tool calls a Claude Code transcript's main conversation still
// waits on (CallTracker): what a permission menu on the worker's screen can
// be for, its native identity (the tool_use id) and its whole input,
// instead of the screen's lines. A call's assistant line is in the JSONL
// about 0.1 s after its dialog opens (docs/research/approval-identity.md);
// a call ends with its tool_result (run, refused or rejected alike), an
// interruption or a new prompt. Codex is not followed (its approvals are
// read off the screen only).

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// Bounds of the calls kept.
const (
	// MaxPendingCalls is how many calls wait at once, the newest kept (a
	// turn's parallel calls are a few).
	MaxPendingCalls = 16
	// MaxCallInput is the most bytes of a call's input kept; a larger one
	// keeps only its sum.
	MaxCallInput = 64 << 10
)

// PendingCall is a tool call with no result yet.
type PendingCall struct {
	ID   string // its tool_use id
	Name string // the tool
	// Input is its input, whole (nil: over MaxCallInput); Sum is the
	// SHA-256 of it (hex), whatever its size.
	Input json.RawMessage
	Sum   string
	// Cwd is the session's directory on its line.
	Cwd string
}

// CallTracker follows one Claude transcript's lines (all of them, from its
// start, as its tail reads them) and knows the tool calls of its main
// conversation with no result yet, and its permission mode (Claude Code's
// permission-mode lines). Sidechain (subagent) lines are not the worker's.
// Not safe for concurrent use.
type CallTracker struct {
	pending []PendingCall
	mode    string
}

// NewCallTracker follows a Claude transcript; nil for another harness.
func NewCallTracker(harness string) *CallTracker {
	if harness != Claude {
		return nil
	}
	return &CallTracker{}
}

// Reset forgets everything: the transcript is read again from its start.
func (t *CallTracker) Reset() { t.pending, t.mode = nil, "" }

// Pending is the calls waiting now, oldest first (a copy).
func (t *CallTracker) Pending() []PendingCall { return append([]PendingCall(nil), t.pending...) }

// Mode is the permission mode last recorded ("": none).
func (t *CallTracker) Mode() string { return t.mode }

type callLine struct {
	Type           string `json:"type"`
	IsSidechain    bool   `json:"isSidechain"`
	IsMeta         bool   `json:"isMeta"`
	Cwd            string `json:"cwd"`
	PermissionMode string `json:"permissionMode"`
	Message        *struct {
		Content strOr[claudeBlock] `json:"content"`
	} `json:"message"`
}

// Line reads one line.
func (t *CallTracker) Line(b []byte) {
	if len(t.pending) == 0 && !bytes.Contains(b, []byte(`"tool_use"`)) && !bytes.Contains(b, []byte(`"permission-mode"`)) {
		return // the common case: nothing to follow
	}
	var l callLine
	if json.Unmarshal(b, &l) != nil || l.IsSidechain {
		return
	}
	if l.Type == "permission-mode" {
		t.mode = l.PermissionMode
		return
	}
	if l.Message == nil {
		return
	}
	blocks := l.Message.Content.list
	if l.Message.Content.isStr {
		blocks = []claudeBlock{{Type: "text", Text: l.Message.Content.str}}
	}
	switch l.Type {
	case "assistant":
		for _, bl := range blocks {
			if bl.Type == "tool_use" && bl.ID != "" {
				t.add(bl, l.Cwd)
			}
		}
	case "user":
		for _, bl := range blocks {
			switch {
			case bl.Type == "tool_result":
				t.drop(bl.ToolUseID)
			case bl.Type == "text" && strings.HasPrefix(strings.TrimSpace(bl.Text), interruptedText),
				bl.Type == "text" && !l.IsMeta && genuinePrompt(bl.Text):
				t.pending = nil // the turn the calls were made in is over
				return
			}
		}
	}
}

func (t *CallTracker) add(bl claudeBlock, cwd string) {
	t.drop(bl.ID)
	sum := sha256.Sum256(bl.Input)
	c := PendingCall{ID: bl.ID, Name: bl.Name, Sum: hex.EncodeToString(sum[:]), Cwd: cwd}
	if len(bl.Input) <= MaxCallInput {
		c.Input = append(json.RawMessage(nil), bl.Input...)
	}
	t.pending = append(t.pending, c)
	if len(t.pending) > MaxPendingCalls {
		t.pending = t.pending[len(t.pending)-MaxPendingCalls:]
	}
}

func (t *CallTracker) drop(id string) {
	for i, c := range t.pending {
		if c.ID == id {
			t.pending = append(t.pending[:i], t.pending[i+1:]...)
			return
		}
	}
}

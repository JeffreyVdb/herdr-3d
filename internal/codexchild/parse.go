package codexchild

import (
	"encoding/json"
	"path"
	"strings"
	"time"
)

// record is a rollout line: {timestamp, ordinal, type, payload}.
type record struct {
	Timestamp string          `json:"timestamp"`
	Ordinal   *int64          `json:"ordinal"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// payload is the part of a record's payload the source reads: a
// response_item's function call, an event_msg's turn or item.
type payload struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	CallID    string `json:"call_id"`
	Arguments string `json:"arguments"`
	// task_started, task_complete, turn_aborted
	TurnID string `json:"turn_id"`
	// item_completed
	Item json.RawMessage `json:"item"`
	// sub_agent_activity (a legacy-history rollout's EventMsg::SubAgentActivity)
	EventID       string `json:"event_id"`
	OccurredAtMS  int64  `json:"occurred_at_ms"`
	AgentThreadID string `json:"agent_thread_id"`
	AgentPath     string `json:"agent_path"`
	Kind          string `json:"kind"`
}

// item is an item_completed's SubAgentActivity or CollabAgentToolCall, as
// persisted (snake_case; the app-server's camelCase is #27's).
type item struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	// SubAgentActivity
	Kind          string `json:"kind"`
	AgentThreadID string `json:"agent_thread_id"`
	AgentPath     string `json:"agent_path"`
	// CollabAgentToolCall
	Tool              string   `json:"tool"`
	Status            string   `json:"status"`
	ReceiverThreadIDs []string `json:"receiver_thread_ids"`
	ReceiverAgents    []struct {
		ThreadID      string `json:"thread_id"`
		AgentNickname string `json:"agent_nickname"`
	} `json:"receiver_agents"`
}

// spawnArgs are a spawn_agent call's plain arguments (its message is
// encrypted on v2).
type spawnArgs struct {
	TaskName string `json:"task_name"`
}

// stamp is a record's time in unix ms (0: none).
func stamp(s string) int64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// leaf is an agent path's last name (/root/a/b: b; a task name: itself).
func leaf(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || p == "/root" {
		return ""
	}
	return path.Base(p)
}

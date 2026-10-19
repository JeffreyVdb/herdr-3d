package codexapp

// #27 (phase 6 of #20): the child threads (subagents) of a shared worker's
// thread, as its own app-server shows them (docs/research/codex-subagents.md
// §9, codex-cli 0.160.1–0.163.0). This file decodes what names a child and
// reads the server observationally through the bridge's join: thread/read
// without turns, thread/turns/list of one turn without items, thread/list
// and thread/loaded/list. None of them subscribes, loads a thread or
// starts a turn, and none sends an override; the bridge never resumes a
// child (a resume emits thread/goal/cleared to every subscriber, the
// terminal included). Every decoder is tolerant: a value it does not know
// is kept as it is, never an error.

import (
	"context"
	"encoding/json"
	"errors"
)

// Thread statuses (Thread.Status.Type) besides ThreadActive.
const (
	ThreadIdle        = "idle"
	ThreadNotLoaded   = "notLoaded"
	ThreadSystemError = "systemError"
)

// Turn statuses besides TurnInProgress.
const (
	TurnCompleted   = "completed"
	TurnInterrupted = "interrupted"
	TurnFailed      = "failed"
)

// The items that name child threads, and their kinds and tools.
const (
	ItemSubAgentActivity = "subAgentActivity"
	ItemCollabToolCall   = "collabAgentToolCall"

	ActivityStarted     = "started"     // spawned (its id is the spawn call's)
	ActivityInteracted  = "interacted"  // sent a message or a follow-up
	ActivityInterrupted = "interrupted" // interrupt_agent
	ActivityCompleted   = "completed"   // one of its turns completed

	ToolSpawnAgent = "spawnAgent"
	ToolCloseAgent = "closeAgent"
	ToolWait       = "wait"
)

// Spawn is a spawned child's origin: its thread's
// source.subAgent.thread_spawn (snake_case inside, as in its rollout).
type Spawn struct {
	Parent   string `json:"parent_thread_id"`
	Depth    int    `json:"depth"`
	Path     string `json:"agent_path"`
	Nickname string `json:"agent_nickname"`
	Role     string `json:"agent_role"`
}

// Spawn is the thread's spawn source; false when it was not spawned by an
// agent (a root, a guardian review, a compaction, any other subagent
// source, or a source this version does not know).
func (t *Thread) Spawn() (Spawn, bool) {
	if t == nil || len(t.Source) == 0 {
		return Spawn{}, false
	}
	var src struct {
		SubAgent json.RawMessage `json:"subAgent"`
	}
	if json.Unmarshal(t.Source, &src) != nil || len(src.SubAgent) == 0 {
		return Spawn{}, false
	}
	var sub struct {
		Spawn *Spawn `json:"thread_spawn"`
	}
	if json.Unmarshal(src.SubAgent, &sub) != nil || sub.Spawn == nil {
		return Spawn{}, false
	}
	return *sub.Spawn, true
}

// ParentID is the thread's parent thread: parentThreadId, else its spawn
// source's ("": none shown).
func (t *Thread) ParentID() string {
	if t == nil {
		return ""
	}
	if t.ParentThreadID != "" {
		return t.ParentThreadID
	}
	s, _ := t.Spawn()
	return s.Parent
}

// AgentItem is the part of a ThreadItem that names child threads: a
// subAgentActivity (Kind, AgentThreadID, AgentPath; a started one's ID is
// the spawn call's) or a collabAgentToolCall (Tool, Status, SenderThreadID,
// ReceiverThreadIDs). Any other item has only Type and ID.
type AgentItem struct {
	Type string `json:"type"`
	ID   string `json:"id"`

	Kind          string `json:"kind"`
	AgentThreadID string `json:"agentThreadId"`
	AgentPath     string `json:"agentPath"`

	Tool              string   `json:"tool"`
	Status            string   `json:"status"`
	SenderThreadID    string   `json:"senderThreadId"`
	ReceiverThreadIDs []string `json:"receiverThreadIds"`
}

// Children are the child threads the item names: a subAgentActivity's
// agent, a collaboration call's receivers.
func (it AgentItem) Children() []string {
	switch it.Type {
	case ItemSubAgentActivity:
		if it.AgentThreadID != "" {
			return []string{it.AgentThreadID}
		}
	case ItemCollabToolCall:
		return it.ReceiverThreadIDs
	}
	return nil
}

// ChildNote is the part of a notification the child observer reads:
// item/started and item/completed (Item, StartedAtMs, CompletedAtMs),
// turn/started and turn/completed (Turn), thread/status/changed (Status),
// thread/closed (ThreadID only). ThreadID is always the thread the
// notification is about.
type ChildNote struct {
	ThreadID      string    `json:"threadId"`
	Item          AgentItem `json:"item"`
	StartedAtMs   int64     `json:"startedAtMs"`
	CompletedAtMs int64     `json:"completedAtMs"`
	Turn          struct {
		ID          string `json:"id"`
		Status      string `json:"status"`
		StartedAt   int64  `json:"startedAt"`   // unix seconds
		CompletedAt int64  `json:"completedAt"` // unix seconds
	} `json:"turn"`
	Status struct {
		Type string `json:"type"`
	} `json:"status"`
}

// DecodeChildNote decodes a notification's params; false when they are not
// an object with a threadId.
func DecodeChildNote(params json.RawMessage) (ChildNote, bool) {
	var n ChildNote
	if json.Unmarshal(params, &n) != nil || n.ThreadID == "" {
		return ChildNote{}, false
	}
	return n, true
}

// ChildMethods are the notifications the child observer reads.
var ChildMethods = []string{"item/started", "item/completed", "turn/started", "turn/completed", "thread/status/changed", "thread/closed"}

// ChildReader reads a shared server's child threads observationally
// through the bridge's join (a Watcher): none of its calls subscribes,
// loads or resumes a thread, starts a turn or sends an override.
type ChildReader interface {
	// ReadThread is thread/read {threadId} without turns.
	ReadThread(ctx context.Context, id string) (*Thread, error)
	// LastTurn is the thread's newest turn, without its items
	// (thread/turns/list); nil when it has none.
	LastTurn(ctx context.Context, id string) (*Turn, error)
	// Descendants are the threads spawned under root at any depth.
	Descendants(ctx context.Context, root string) (Descendants, error)
}

// Descendants is what Descendants found.
type Descendants struct {
	Threads []Thread
	// Filtered: the server listed root's descendants itself (thread/list
	// ancestorThreadId, experimental). Without it (a server or a
	// connection that refuses the filter) they are the loaded threads and
	// the newest listed subagent threads whose parent chain reaches root:
	// an unloaded child that is not among them is not found.
	Filtered bool
}

// Bounds of Descendants.
const (
	DescendantsPage     = 100 // threads per thread/list page
	MaxDescendantPages  = 5   // pages of root's descendants
	MaxFallbackPages    = 3   // pages of all subagent threads, without the filter
	MaxLoadedReads      = 64  // loaded threads read, without the filter
	maxParentChainDepth = 16
)

var _ ChildReader = (*Watcher)(nil)

// ReadThread implements ChildReader.
func (w *Watcher) ReadThread(ctx context.Context, id string) (*Thread, error) {
	var res struct {
		Thread *Thread `json:"thread"`
	}
	if err := w.send(ctx, "thread/read", map[string]any{"threadId": id}, &res); err != nil {
		return nil, err
	}
	if res.Thread == nil || res.Thread.ID != id {
		return nil, errors.New("thread/read: another thread")
	}
	return res.Thread, nil
}

// LastTurn implements ChildReader: on a thread that is not loaded it
// reads the server's store (paginated history) or is refused (legacy
// history: "thread not loaded"); an ephemeral thread refuses it.
func (w *Watcher) LastTurn(ctx context.Context, id string) (*Turn, error) {
	var page struct {
		Data []Turn `json:"data"`
	}
	if err := w.send(ctx, "thread/turns/list", map[string]any{"threadId": id, "limit": 1, "sortDirection": "desc",
		"itemsView": "notLoaded"}, &page); err != nil {
		return nil, err
	}
	if len(page.Data) == 0 {
		return nil, nil
	}
	return &page.Data[0], nil
}

// threadPage is one page of thread/list.
type threadPage struct {
	Data []Thread `json:"data"`
	Next *string  `json:"nextCursor"`
}

// Descendants implements ChildReader: thread/list {ancestorThreadId}
// (its rows carry the live status of a loaded child); when the server
// refuses it, the fallback.
func (w *Watcher) Descendants(ctx context.Context, root string) (Descendants, error) {
	var out Descendants
	var cursor any
	for range MaxDescendantPages {
		var page threadPage
		err := w.send(ctx, "thread/list", map[string]any{"ancestorThreadId": root, "limit": DescendantsPage, "cursor": cursor}, &page)
		if err != nil {
			if Refused(err) {
				return w.descendantsUnfiltered(ctx, root)
			}
			return Descendants{}, err
		}
		out.Threads = append(out.Threads, page.Data...)
		if page.Next == nil || *page.Next == "" {
			break
		}
		cursor = *page.Next
	}
	out.Filtered = true
	return out, nil
}

// descendantsUnfiltered finds root's descendants without the experimental
// filter: the loaded threads read one by one (live ones: thread/list never
// lists a thread the store has no row of), and the newest subagent threads
// listed (sourceKinds subAgentThreadSpawn: an omitted sourceKinds lists
// interactive threads only), each kept when its parent chain reaches root.
// Not by sessionId: a child's is its own thread id on 0.163.0, not the
// root's (the live probe).
func (w *Watcher) descendantsUnfiltered(ctx context.Context, root string) (Descendants, error) {
	byID := map[string]Thread{}
	var order []string
	add := func(t Thread) {
		if _, ok := byID[t.ID]; !ok && t.ID != root {
			order = append(order, t.ID)
		}
		if _, ok := byID[t.ID]; !ok || t.Status.Type != "" {
			byID[t.ID] = t
		}
	}
	var loaded []string
	var cursor any
	for range MaxDescendantPages {
		var page struct {
			Data []string `json:"data"`
			Next *string  `json:"nextCursor"`
		}
		if err := w.send(ctx, "thread/loaded/list", map[string]any{"cursor": cursor}, &page); err != nil {
			return Descendants{}, err
		}
		loaded = append(loaded, page.Data...)
		if page.Next == nil || *page.Next == "" {
			break
		}
		cursor = *page.Next
	}
	for i, id := range loaded {
		if i >= MaxLoadedReads {
			break
		}
		if id == root {
			continue
		}
		if t, err := w.ReadThread(ctx, id); err == nil {
			add(*t)
		}
	}
	cursor = nil
	for range MaxFallbackPages {
		var page threadPage
		if err := w.send(ctx, "thread/list", map[string]any{"sourceKinds": []string{"subAgentThreadSpawn"},
			"limit": DescendantsPage, "cursor": cursor}, &page); err != nil {
			break // the loaded ones stand
		}
		for _, t := range page.Data {
			if _, ok := byID[t.ID]; !ok {
				add(t)
			}
		}
		if page.Next == nil || *page.Next == "" {
			break
		}
		cursor = *page.Next
	}
	var out Descendants
	for _, id := range order {
		if descendsFrom(byID, id, root) {
			out.Threads = append(out.Threads, byID[id])
		}
	}
	return out, nil
}

// descendsFrom reports whether id's parent chain in byID reaches root.
func descendsFrom(byID map[string]Thread, id, root string) bool {
	for range maxParentChainDepth {
		t, ok := byID[id]
		if !ok {
			return false
		}
		p := t.ParentID()
		if p == root {
			return true
		}
		if p == "" {
			return false
		}
		id = p
	}
	return false
}

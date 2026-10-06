//go:build integration

package codexshare

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// threadItem is the part of an app-server ThreadItem the tests read.
type threadItem struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Text      string `json:"text"`
	Delivery  string `json:"delivery"`
	Questions []struct {
		Title   string   `json:"title"`
		Options []string `json:"options"`
	} `json:"questions"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func (it threadItem) userText() string {
	var b strings.Builder
	for _, c := range it.Content {
		b.WriteString(c.Text)
	}
	return b.String()
}

type turn struct {
	ID     string       `json:"id"`
	Status string       `json:"status"`
	Items  []threadItem `json:"items"`
}

type thread struct {
	ID         string `json:"id"`
	Cwd        string `json:"cwd"`
	Path       string `json:"path"`
	Ephemeral  bool   `json:"ephemeral"`
	Originator string `json:"originator"`
	Parent     string `json:"parentThreadId"`
	Status     struct {
		Type string `json:"type"`
	} `json:"status"`
	Turns []turn `json:"turns"`
}

// itemEvent is an item/started or item/completed notification.
type itemEvent struct {
	ThreadID string     `json:"threadId"`
	TurnID   string     `json:"turnId"`
	Item     threadItem `json:"item"`
}

func decodeItem(m Message) itemEvent {
	var e itemEvent
	_ = json.Unmarshal(m.Params, &e)
	return e
}

// mark makes later waits on c ignore what it already received.
func (f *fx) mark(c *Client) {
	if f.marks == nil {
		f.marks = map[*Client]int{}
	}
	f.marks[c] = c.Mark()
}

// loaded lists the server's loaded thread ids.
func (f *fx) loaded(c *Client) []string {
	f.t.Helper()
	var list struct {
		Data []string `json:"data"`
	}
	if err := c.Call(f.ctx, "thread/loaded/list", map[string]any{}, &list); err != nil {
		f.t.Fatal(err)
	}
	return list.Data
}

// read returns a thread with its turns (without them for an ephemeral
// thread, which does not support includeTurns).
func (f *fx) read(c *Client, id string) thread {
	f.t.Helper()
	var res struct {
		Thread thread `json:"thread"`
	}
	if err := c.Call(f.ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": true}, &res); err != nil {
		if err := c.Call(f.ctx, "thread/read", map[string]any{"threadId": id}, &res); err != nil {
			f.t.Fatal(err)
		}
	}
	return res.Thread
}

// tuiThread finds the TUI's own thread among the loaded ones: a persistent
// root thread (Codex also loads ephemeral side threads).
func (f *fx) tuiThread(c *Client) thread {
	f.t.Helper()
	var all []thread
	for _, id := range f.loaded(c) {
		th := f.read(c, id)
		all = append(all, th)
		if !th.Ephemeral && th.Parent == "" && th.Path != "" {
			return th
		}
	}
	f.recordJSON("loaded-threads", all)
	f.t.Fatal("no persistent root thread is loaded")
	return thread{}
}

// resume subscribes c to a loaded thread and returns the full response.
func (f *fx) resume(c *Client, id string) map[string]any {
	f.t.Helper()
	var res map[string]any
	if err := c.Call(f.ctx, "thread/resume", map[string]any{"threadId": id}, &res); err != nil {
		f.t.Fatal(err)
	}
	return res
}

// waitItem waits for an item/completed on c matching ok.
func (f *fx) waitItem(c *Client, d time.Duration, ok func(itemEvent) bool) itemEvent {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, d)
	defer cancel()
	m, err := c.WaitNotificationFrom(ctx, f.marks[c], "item/completed", func(m Message) bool { return ok(decodeItem(m)) })
	if err != nil {
		f.t.Fatal(err)
	}
	return decodeItem(m)
}

// questionItem waits for the async question message that carries title.
func (f *fx) questionItem(c *Client, title string) itemEvent {
	f.t.Helper()
	return f.waitItem(c, 30*time.Second, func(e itemEvent) bool {
		return e.Item.Type == "agentMessage" && e.Item.Delivery == "async" && len(e.Item.Questions) > 0 && e.Item.Questions[0].Title == title
	})
}

// waitTurnCompleted waits for turn/completed of turnID ("" for any after n earlier ones).
func (f *fx) waitTurnCompleted(c *Client, turnID string, d time.Duration) Message {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, d)
	defer cancel()
	m, err := c.WaitNotificationFrom(ctx, f.marks[c], "turn/completed", func(m Message) bool {
		var p struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(m.Params, &p)
		return p.Turn.ID == turnID
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return m
}

// startTurn sends turn/start with text on thread and returns the turn id.
func (f *fx) startTurn(c *Client, threadID, text string) string {
	f.t.Helper()
	var res struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.Call(f.ctx, "turn/start", map[string]any{"threadId": threadID, "input": []any{
		map[string]any{"type": "text", "text": text},
	}}, &res); err != nil {
		f.t.Fatal(err)
	}
	return res.Turn.ID
}

// steer sends turn/steer with text to the active turn.
func (f *fx) steer(c *Client, threadID, turnID, text string) error {
	return c.Call(f.ctx, "turn/steer", map[string]any{"threadId": threadID, "expectedTurnId": turnID, "input": []any{
		map[string]any{"type": "text", "text": text},
	}}, nil)
}

package server

// #118: a run's ticket on the wire with its title and URL, so the floor
// overview reads "#123 · <title>" for every worker of a run, not only the
// cards of the floor you stand on. Both come from the floor's issue
// provider, never from the game: the card in the board cache, else (a board
// not polled yet, a card no longer on it) one Tracker.Get of the item,
// remembered for the bridge's life, hit or miss, so it is never asked again.
// A poll that changes a card's title moves its workers' too.

import (
	"context"
	"reflect"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// titleTimeout bounds one Tracker.Get of a ticket's title.
const titleTimeout = 15 * time.Second

// itemTitle is what the bridge read of an item off its board (hub goroutine).
type itemTitle struct {
	session    string
	fetching   bool
	done       bool // read (or given up): never asked again
	title, url string
}

// ticketRefs is a worker's issue and work item for its run's issue on a
// floor (nil, nil without one): copies, the title and URL filled in when
// the floor's provider has them. A miss is asked about once (fetchTitles).
func (h *Hub) ticketRefs(session string, issue *proto.IssueRef) (*proto.IssueRef, *proto.WorkItemRef) {
	if issue == nil {
		return nil, nil
	}
	out := &proto.IssueRef{Repo: issue.Repo, Number: issue.Number}
	item := h.workItemOf(session, out)
	if item != nil {
		item.Title, item.URL = h.titleOf(session, item.ID)
		out.Title, out.URL = item.Title, item.URL
	}
	return out, item
}

func titleKey(provider, id string) string { return provider + "\x00" + id }

// titleOf is an item's title and URL: its card on the floor's board, else
// what one Get found (an item not read yet is queued for it). The URL
// falls back to the provider's own link of the item.
func (h *Hub) titleOf(session, id string) (string, string) {
	bf := h.boardOf(session)
	if bf == nil {
		return "", ""
	}
	title, url, ok := cardTitle(bf, id)
	if !ok {
		key := titleKey(bf.info.ID, id)
		e := h.boards.titles[key]
		if e == nil {
			e = &itemTitle{session: session}
			h.boards.titles[key] = e
		}
		title, url = e.title, e.url
	}
	if url == "" {
		if rl, ok := bf.set.Tracker.(tracker.RunLinker); ok {
			_, _, url, _ = rl.RunFromItem(id)
		}
	}
	return title, url
}

// cardTitle is an item's card on the floor's last good board.
func cardTitle(bf *boardFloor, id string) (string, string, bool) {
	if bf.issues == nil {
		return "", "", false
	}
	for _, c := range bf.issues.Cards {
		if c.ID == id {
			return c.Title, c.URL, true
		}
	}
	return "", "", false
}

// fetchTitles reads the items a worker's ticket needs that no board had,
// each once, off the hub goroutine (the board tick).
func (h *Hub) fetchTitles(ctx context.Context) {
	for key, e := range h.boards.titles {
		if e.done || e.fetching {
			continue
		}
		provider, id, _ := strings.Cut(key, "\x00")
		bf := h.boardOf(e.session)
		if bf == nil || bf.info.ID != provider {
			e.done = true
			continue
		}
		if _, _, ok := cardTitle(bf, id); ok {
			e.done = true // the board has it meanwhile
			continue
		}
		e.fetching = true
		tr := bf.set.Tracker
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			c, cancel := context.WithTimeout(ctx, titleTimeout)
			d, err := tr.Get(c, id)
			cancel()
			_ = h.do(ctx, func(context.Context) {
				e.fetching, e.done = false, true
				if err != nil {
					h.log.Info("reading a ticket's title failed", "session", e.session, "item", id, "err", briefError(err))
					return
				}
				e.title, e.url = d.Card.Title, d.Card.URL
				h.refreshTickets(e.session)
			})
		}()
	}
}

// refreshTickets puts the current title and URL on every worker of a floor
// whose run has an issue (a poll or a read changed them): a worker.upsert
// for each one that moved.
func (h *Hub) refreshTickets(session string) {
	f := h.floors[session]
	if f == nil {
		return
	}
	for _, id := range f.order {
		w := h.workers[id]
		if w == nil || w.Issue == nil {
			continue
		}
		issue, item := h.ticketRefs(session, w.Issue)
		if reflect.DeepEqual(issue, w.Issue) && reflect.DeepEqual(item, w.WorkItem) {
			continue
		}
		next := *w
		next.Issue, next.WorkItem = issue, item
		h.workers[id] = &next
		h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
	}
}

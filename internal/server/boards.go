package server

// M7 boards: a floor's issues and pull requests, polled from the provider
// its repo is linked to and sent to the connections that watch the floor.
// Everything here sits above the neutral interfaces (internal/tracker,
// internal/codehost): it never sees a provider's ids or types. The boards
// are connection-scoped messages like terminal.frame (no seq, not in the
// replay ring or the snapshot); the cache, the open pull requests and the
// announced merges are in SQLite (store/boards.go).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// Board timings.
const (
	// DefaultBoardWatchPoll is how often a floor somebody watches is polled,
	// DefaultBoardIdlePoll how often the others are (asleep floors too: the
	// repo is what matters).
	DefaultBoardWatchPoll = 60 * time.Second
	DefaultBoardIdlePoll  = 10 * time.Minute
	// DefaultBoardRefreshMin is the shortest time between two polls that
	// board.refresh starts on one floor.
	DefaultBoardRefreshMin = 10 * time.Second
	// DefaultBoardTick is how often the poller looks for a floor that is due.
	DefaultBoardTick = time.Second
	// boardReserve is what the rate policy keeps for interactions.
	boardReserve = 100
	// boardStop is the rate below which nothing is polled until the reset.
	boardStop = 50
	// boardDefaultCost is the guess of a poll's cost before one was read.
	boardDefaultCost = 12
	// secondaryWait is the first wait after a rate limit that named no reset;
	// it doubles up to secondaryMax.
	secondaryWait = 60 * time.Second
	secondaryMax  = 10 * time.Minute
	// maxBoardPolls bounds the polls in flight at once.
	maxBoardPolls = 4
)

// BoardSource is what a floor links, as its settings say: the provider
// factory reads it and decides which provider serves it.
type BoardSource struct {
	Session       string
	Repo          string // the floor's effective repo (settings, else the suggestion)
	ProjectOwner  string
	ProjectNumber int
	StatusField   string
}

// BoardSet is the providers of one floor. Key names the fetch: floors with
// the same key share it. Host may be nil (a provider with no change
// requests).
type BoardSet struct {
	Key     string
	Tracker tracker.Tracker
	Host    codehost.Host
}

// BoardFactory finds the providers of a floor's link (ok false: none).
type BoardFactory func(BoardSource) (BoardSet, bool)

func boardDefaults(o *Options) {
	if o.BoardWatchPoll <= 0 {
		o.BoardWatchPoll = DefaultBoardWatchPoll
	}
	if o.BoardIdlePoll <= 0 {
		o.BoardIdlePoll = DefaultBoardIdlePoll
	}
	if o.BoardRefreshMin <= 0 {
		o.BoardRefreshMin = DefaultBoardRefreshMin
	}
	if o.BoardTick <= 0 {
		o.BoardTick = DefaultBoardTick
	}
}

// boardsState is the hub's board bookkeeping (hub goroutine only).
type boardsState struct {
	floors   map[string]*boardFloor
	stored   map[string]store.BoardCache // what the store had at start, taken by the floors
	watchers map[*Client]string          // connection → the floor it watches
	gates    map[string]*rateGate        // provider id → its rate state
	polls    chan struct{}               // slots of the polls in flight
}

func (h *Hub) initBoards(ctx context.Context) error {
	h.boards = boardsState{floors: map[string]*boardFloor{}, watchers: map[*Client]string{}, gates: map[string]*rateGate{},
		polls: make(chan struct{}, maxBoardPolls)}
	stored, err := h.st.BoardCaches(ctx)
	if err != nil {
		return err
	}
	h.boards.stored = stored
	return nil
}

// boardFloor is one board-enabled floor.
type boardFloor struct {
	session string
	src     BoardSource
	set     BoardSet
	info    tracker.Info
	host    *codehost.Info

	issues    *proto.BoardIssues // the last good boards (never initial, stale or merged)
	prs       *proto.BoardPRs
	openIDs   []string        // ids of the requests open at the last good poll
	announced map[string]bool // merges already announced (store.MergeKey)
	fetchedAt time.Time       // of the last good poll (the provider's data time)
	stale     bool            // the last poll failed
	lastErr   string

	inflight  bool
	writes    int // successful writes so far: a poll that began before the last one is not shown
	lastStart time.Time
	nextAt    time.Time
}

// rateGate is what a provider's rate limit says about polling.
type rateGate struct {
	rate    *provider.Rate // the last reading
	until   time.Time      // no polling before (a rate limit's reset, a back-off)
	backoff time.Duration  // the current secondary-limit wait
}

// boardSource is a floor's link as its settings say (zero Repo: none).
func (h *Hub) boardSource(session string) BoardSource {
	s := h.settings[session]
	return BoardSource{Session: session, Repo: h.repoOf(session), ProjectOwner: s.ProjectOwner, ProjectNumber: s.ProjectNumber,
		StatusField: s.StatusField}
}

// boardOf returns the board state of a floor, made (or dropped, when its
// link changed) on the way; nil when the floor has no board: no repo, no
// provider for it, or no provider factory.
func (h *Hub) boardOf(session string) *boardFloor {
	bf := h.boards.floors[session]
	if h.opts.Boards == nil || h.floors[session] == nil {
		return nil // (a floor that is gone keeps its state: it may come back)
	}
	src := h.boardSource(session)
	if bf != nil && bf.src == src {
		return bf
	}
	var set BoardSet
	ok := false
	if src.Repo != "" {
		set, ok = h.opts.Boards(src)
		ok = ok && set.Tracker != nil
	}
	if !ok {
		if bf != nil {
			h.dropBoard(bf)
		}
		return nil
	}
	if bf != nil { // its link changed: what it had is of another repo
		if bf.set.Key == set.Key {
			bf.src, bf.set = src, set
			return bf
		}
		h.dropBoard(bf)
	}
	bf = &boardFloor{session: session, src: src, set: set, info: set.Tracker.Info(), announced: map[string]bool{}}
	if set.Host != nil {
		i := set.Host.Info()
		bf.host = &i
	}
	now := h.opts.Now()
	bf.nextAt = now
	if c, has := h.boards.stored[session]; has {
		delete(h.boards.stored, session)
		if c.Source == set.Key {
			bf.adopt(c, h.opts.BoardIdlePoll)
		} else if err := h.st.ClearBoard(context.Background(), session); err != nil {
			h.log.Error("clearing a floor's board failed", "session", session, "err", err)
		}
		bf.announced = c.Announced
		if bf.announced == nil {
			bf.announced = map[string]bool{}
		}
	}
	h.boards.floors[session] = bf
	// Connections that watched the floor when its link changed get the new
	// (empty) board, from the cache replay.
	for c, s := range h.boards.watchers {
		if s == session {
			h.sendBoards(c, bf, true)
		}
	}
	return bf
}

// adopt takes the stored cache of the same link, and schedules the next
// poll from its age.
func (bf *boardFloor) adopt(c store.BoardCache, idle time.Duration) {
	var is proto.BoardIssues
	if json.Unmarshal(c.Issues, &is) == nil && c.Issues != nil {
		bf.issues = &is
		bf.fetchedAt = time.UnixMilli(c.IssuesAt)
	}
	var ps proto.BoardPRs
	if json.Unmarshal(c.PRs, &ps) == nil && c.PRs != nil {
		bf.prs = &ps
	}
	bf.openIDs = c.OpenPRs
	if bf.issues != nil {
		bf.nextAt = bf.fetchedAt.Add(idle)
	}
}

// dropBoard forgets a floor's board (its link changed or went) and what
// the store kept of it.
func (h *Hub) dropBoard(bf *boardFloor) {
	delete(h.boards.floors, bf.session)
	if err := h.st.ClearBoard(context.Background(), bf.session); err != nil {
		h.log.Error("clearing a floor's board failed", "session", bf.session, "err", err)
	}
}

// watching counts the connections that watch a floor.
func (h *Hub) watching(session string) int {
	n := 0
	for _, s := range h.boards.watchers {
		if s == session {
			n++
		}
	}
	return n
}

func (h *Hub) boardInterval(session string) time.Duration {
	if h.watching(session) > 0 {
		return h.opts.BoardWatchPoll
	}
	return h.opts.BoardIdlePoll
}

// --- messages ---

func (bf *boardFloor) issuesMsg(initial bool) proto.BoardIssues {
	m := proto.BoardIssues{T: proto.TBoardIssues, Session: bf.session, Provider: bf.info.ID, ProviderName: bf.info.Name,
		Capabilities: bf.info.Capabilities, Columns: []tracker.Column{}, Cards: []tracker.Card{}}
	if bf.issues != nil {
		m = *bf.issues
	}
	m.Initial, m.Stale, m.Error = initial, bf.stale, ""
	if bf.stale {
		m.Error = bf.lastErr
	}
	return m
}

func (bf *boardFloor) prsMsg(initial bool) proto.BoardPRs {
	m := proto.BoardPRs{T: proto.TBoardPRs, Session: bf.session, Provider: bf.info.ID, ProviderName: bf.info.Name,
		PRs: []codehost.Request{}}
	if bf.host != nil {
		m.Provider, m.ProviderName, m.Capabilities = bf.host.ID, bf.host.Name, bf.host.Capabilities
	}
	if bf.prs != nil {
		m = *bf.prs
	}
	m.Initial, m.Stale, m.Error, m.Merged = initial, bf.stale, "", []codehost.Merged{}
	if bf.stale {
		m.Error = bf.lastErr
	}
	return m
}

// sendBoards sends a floor's boards to one connection: from the cache, the
// issues first. A floor with no code host sends no board.prs.
func (h *Hub) sendBoards(c *Client, bf *boardFloor, initial bool) {
	h.deliver(c, mustJSON(bf.issuesMsg(initial)))
	if bf.set.Host != nil {
		h.deliver(c, mustJSON(bf.prsMsg(initial)))
	}
}

// fanOut sends the two messages of a poll to every connection that watches
// the floor. Boards never push a connection into the slow-consumer
// disconnect: a connection whose queue is half full misses this poll.
func (h *Hub) fanOut(session string, is proto.BoardIssues, ps *proto.BoardPRs) {
	var im, pm []byte
	for c, s := range h.boards.watchers {
		if s != session {
			continue
		}
		if !roomy(c) {
			h.log.Debug("board skipped for a slow connection", "client", c.name, "session", session)
			continue
		}
		if im == nil {
			im = mustJSON(is)
			if ps != nil {
				pm = mustJSON(ps)
			}
		}
		h.deliver(c, im)
		if pm != nil {
			h.deliver(c, pm)
		}
	}
}

// --- polling ---

// boardTick starts the polls that are due (hub goroutine, each tick).
func (h *Hub) boardTick(ctx context.Context) {
	if h.opts.Boards == nil {
		return
	}
	now := h.opts.Now()
	var due []*boardFloor
	keys := map[string]bool{}
	for _, session := range sortedFloors(h.floors) {
		if bf := h.boardOf(session); bf != nil {
			keys[bf.set.Key] = true
			if !bf.inflight && !now.Before(bf.nextAt) {
				due = append(due, bf)
			}
		}
	}
	for _, bf := range due {
		h.tryPoll(ctx, bf, len(keys))
	}
}

// tryPoll starts a poll of bf unless the provider's rate says wait or the
// polls in flight fill their slots.
func (h *Hub) tryPoll(ctx context.Context, bf *boardFloor, keys int) bool {
	now := h.opts.Now()
	if !h.rateAllows(bf.info.ID, now, h.watching(bf.session) > 0, keys) {
		return false
	}
	select {
	case h.boards.polls <- struct{}{}:
	default:
		return false
	}
	bf.inflight, bf.lastStart = true, now
	prev := codehost.PrevState{OpenIDs: slices.Clone(bf.openIDs)}
	set, key, writes := bf.set, bf.set.Key, bf.writes
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		defer func() { <-h.boards.polls }()
		res := pollProviders(ctx, set, prev)
		if err := h.doWait(ctx, func() { h.finishPoll(ctx, bf, key, writes, res) }); err != nil {
			h.log.Debug("board poll abandoned", "session", bf.session, "err", err)
		}
	}()
	return true
}

// rateAllows applies the rate policy: below the stop mark, or after a rate
// limit, nothing is polled until the reset; below what one more cycle of every
// board plus the reserve needs, only floors somebody watches are.
func (h *Hub) rateAllows(providerID string, now time.Time, watched bool, keys int) bool {
	g := h.boards.gates[providerID]
	if g == nil {
		return true
	}
	if now.Before(g.until) {
		return false
	}
	r := g.rate
	if r == nil || !now.Before(time.UnixMilli(r.ResetAt)) {
		return true // no reading, or its window is over
	}
	cost := r.Cost
	if cost <= 0 {
		cost = boardDefaultCost
	}
	switch {
	case r.Remaining < boardStop:
		return false
	case !watched && r.Remaining < keys*cost+boardReserve:
		return false
	}
	return true
}

// pollResult is what one poll read.
type pollResult struct {
	issues tracker.Board
	prs    *codehost.Board
	err    error
}

// pollProviders reads a floor's boards (off the hub goroutine): the change
// requests first, then the issues, so a provider that serves both from one
// fetch has it warm.
func pollProviders(ctx context.Context, set BoardSet, prev codehost.PrevState) pollResult {
	var res pollResult
	if set.Host != nil {
		b, err := set.Host.Board(ctx, prev)
		if err != nil {
			return pollResult{err: err}
		}
		res.prs = &b
	}
	b, err := set.Tracker.Board(ctx)
	if err != nil {
		return pollResult{err: err}
	}
	res.issues = b
	return res
}

// finishPoll applies a poll on the hub goroutine. writes is the floor's
// count of writes when the poll began.
func (h *Hub) finishPoll(ctx context.Context, bf *boardFloor, key string, writes int, res pollResult) {
	bf.inflight = false
	if h.boards.floors[bf.session] != bf || bf.set.Key != key {
		return // the floor's link changed meanwhile
	}
	now := h.opts.Now()
	if writes != bf.writes {
		// A write landed while this poll was in flight: what it read may be
		// from before the write, and must not become the latest board (a
		// card would jump back). The refresh the write asked for runs now.
		bf.nextAt = now
		h.tryPoll(ctx, bf, h.boardKeys())
		return
	}
	g := h.boards.gates[bf.info.ID]
	if g == nil {
		g = &rateGate{}
		h.boards.gates[bf.info.ID] = g
	}
	if res.err != nil {
		bf.stale, bf.lastErr = true, briefError(res.err)
		var rl *provider.RateLimitError
		if errors.As(res.err, &rl) {
			if rl.ResetAt.After(now) {
				g.until = rl.ResetAt
			} else { // a secondary limit: no reset was named
				g.backoff = min(max(g.backoff*2, secondaryWait), secondaryMax)
				g.until = now.Add(g.backoff)
			}
			g.rate = &provider.Rate{Remaining: 0, ResetAt: max(rl.ResetAt.UnixMilli(), g.until.UnixMilli())}
		}
		bf.nextAt = now.Add(h.boardInterval(bf.session))
		h.log.Info("board poll failed", "session", bf.session, "err", res.err)
		is := bf.issuesMsg(false)
		is.Rate = g.rate
		var ps *proto.BoardPRs
		if bf.set.Host != nil {
			p := bf.prsMsg(false)
			p.Rate = g.rate
			ps = &p
		}
		h.fanOut(bf.session, is, ps)
		return
	}
	g.backoff, g.until = 0, time.Time{}
	rate := res.issues.Rate
	if rate == nil && res.prs != nil {
		rate = res.prs.Rate
	}
	g.rate = rate
	bf.stale, bf.lastErr = false, ""
	bf.fetchedAt = now
	bf.nextAt = now.Add(h.boardInterval(bf.session))
	is := proto.BoardIssues{T: proto.TBoardIssues, Session: bf.session, Provider: bf.info.ID, ProviderName: bf.info.Name,
		FetchedAt: now.UnixMilli(), Truncated: res.issues.Truncated, Rate: rate, Capabilities: bf.info.Capabilities,
		Columns: res.issues.Columns, Cards: res.issues.Cards}
	if is.Columns == nil {
		is.Columns = []tracker.Column{}
	}
	if is.Cards == nil {
		is.Cards = []tracker.Card{}
	}
	for i := range is.Cards { // the wire has lists, never null
		if is.Cards[i].Labels == nil {
			is.Cards[i].Labels = []tracker.Label{}
		}
		if is.Cards[i].Assignees == nil {
			is.Cards[i].Assignees = []provider.Person{}
		}
	}
	bf.issues = &is
	var ps *proto.BoardPRs
	var merges []store.BoardMerge
	var open []string
	var prPayload []byte
	if res.prs != nil {
		p := proto.BoardPRs{T: proto.TBoardPRs, Session: bf.session, Provider: bf.host.ID, ProviderName: bf.host.Name,
			FetchedAt: now.UnixMilli(), Truncated: res.prs.Truncated, Rate: rate, Capabilities: bf.host.Capabilities,
			PRs: res.prs.Requests, Merged: []codehost.Merged{}}
		if p.PRs == nil {
			p.PRs = []codehost.Request{}
		}
		for i := range p.PRs {
			if p.PRs[i].Closes == nil {
				p.PRs[i].Closes = []string{}
			}
		}
		for _, r := range p.PRs {
			open = append(open, r.ID)
		}
		for _, id := range res.prs.Watch { // still open, or unreadable: watched on
			if !slices.Contains(open, id) {
				open = append(open, id)
			}
		}
		// A merge rings once, ever: not the ones announced before (also across
		// a restart), and never on the replay of the cache.
		for _, m := range res.prs.Merged {
			k := store.MergeKey(m.ID, m.MergedAt)
			if bf.announced[k] {
				continue
			}
			bf.announced[k] = true
			merges = append(merges, store.BoardMerge{ID: m.ID, MergedAt: m.MergedAt})
			if m.Closes == nil {
				m.Closes = []string{}
			}
			p.Merged = append(p.Merged, m)
		}
		cached := p
		cached.Merged = []codehost.Merged{}
		bf.prs = &cached
		prPayload = mustJSON(cached)
		ps = &p
	}
	bf.openIDs = open
	if err := h.st.SaveBoardPoll(ctx, bf.session, bf.set.Key, mustJSON(is), prPayload, now.UnixMilli(), now.UnixMilli(), open, merges); err != nil {
		h.log.Error("saving a floor's board failed", "session", bf.session, "err", err)
	}
	h.fanOut(bf.session, is, ps)
}

// briefError is a short message for a failed poll: never a token, at most
// 200 bytes.
func briefError(err error) string {
	s := err.Error()
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

// queueBoard asks for a poll of a floor now (after a write), unless the rate
// says wait.
func (h *Hub) queueBoard(ctx context.Context, session string) {
	bf := h.boardOf(session)
	if bf == nil {
		return
	}
	bf.writes++
	bf.nextAt = h.opts.Now()
	if !bf.inflight {
		h.tryPoll(ctx, bf, h.boardKeys())
	}
}

func (h *Hub) boardKeys() int {
	keys := map[string]bool{}
	for _, s := range sortedFloors(h.floors) {
		if bf := h.boardOf(s); bf != nil {
			keys[bf.set.Key] = true
		}
	}
	return max(len(keys), 1)
}

// --- board.watch, board.unwatch, board.refresh ---

func (h *Hub) startBoardWatch(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.BoardArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if _, err := h.floorFor(a.Session); err != nil {
		return err
	}
	if prev, ok := h.boards.watchers[c]; ok { // one floor per connection
		delete(h.boards.watchers, c)
		h.unwatched(prev)
	}
	bf := h.boardOf(a.Session)
	if bf == nil {
		reason := "no repo linked"
		if h.opts.Boards == nil {
			reason = "boards are not configured"
		}
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, proto.BoardWatchResult{Enabled: false, Reason: reason}, nil)
		return nil
	}
	h.boards.watchers[c] = a.Session
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, proto.BoardWatchResult{Enabled: true}, nil)
	h.sendBoards(c, bf, true)
	// Nothing cached, or older than a watched floor's period: poll now.
	if bf.fetchedAt.IsZero() || bf.nextAt.After(bf.fetchedAt.Add(h.opts.BoardWatchPoll)) {
		if at := bf.fetchedAt.Add(h.opts.BoardWatchPoll); at.Before(bf.nextAt) {
			bf.nextAt = at
		}
		if !bf.inflight && !h.opts.Now().Before(bf.nextAt) {
			h.tryPoll(ctx, bf, h.boardKeys())
		}
	}
	return nil
}

func (h *Hub) startBoardUnwatch(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.BoardArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if h.boards.watchers[c] == a.Session {
		delete(h.boards.watchers, c)
		h.unwatched(a.Session)
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

func (h *Hub) startBoardRefresh(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.BoardArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if _, err := h.floorFor(a.Session); err != nil {
		return err
	}
	bf := h.boardOf(a.Session)
	if bf == nil {
		return fmt.Errorf("%w: the floor has no board (no repo linked)", errUnsupported)
	}
	now := h.opts.Now()
	queued := false
	switch {
	case bf.inflight:
		queued = true // joins the poll in flight
	case now.Sub(bf.lastStart) < h.opts.BoardRefreshMin && !now.Before(bf.lastStart):
		// Too soon after the last one: it just returns what there is.
	default:
		bf.nextAt = now
		queued = h.tryPoll(ctx, bf, h.boardKeys())
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, proto.BoardRefreshResult{Queued: queued}, nil)
	if !queued && h.boards.watchers[c] == a.Session {
		h.sendBoards(c, bf, true)
	}
	return nil
}

// dropBoardWatch ends a connection's watch (it went away).
func (h *Hub) dropBoardWatch(c *Client) {
	if session, ok := h.boards.watchers[c]; ok {
		delete(h.boards.watchers, c)
		h.unwatched(session)
	}
}

// unwatched puts a floor nobody watches any more back on the slow period,
// counted from its last good poll.
func (h *Hub) unwatched(session string) {
	bf := h.boards.floors[session]
	if bf == nil || bf.inflight || h.watching(session) > 0 || bf.fetchedAt.IsZero() {
		return
	}
	if at := bf.fetchedAt.Add(h.opts.BoardIdlePoll); at.After(bf.nextAt) {
		bf.nextAt = at
	}
}

// workItemTicket is the run ticket of a board card (run.prepare and
// run.start's work_item): the floor's issue provider must be the one the
// card names, and the card must be on its board. GitHub's item is an issue
// of the floor's repo, so it goes the M6 issue way, its URL in the prompt.
// A floor with no polled board yet has nothing to look the card up in: the
// returned check (nil once the board is known, or when verified) asks the
// provider for it, and must run off the hub goroutine before the ticket is
// used.
func (h *Hub) workItemTicket(session string, item *proto.WorkItemRef, verified bool) (*proto.RunTicket, func(context.Context) error, error) {
	nf := func(format string, args ...any) error {
		return fmt.Errorf("%w: %s", store.ErrNotFound, fmt.Sprintf(format, args...))
	}
	bf := h.boardOf(session)
	if bf == nil {
		return nil, nil, nf("work_item: the floor has no issue provider")
	}
	if item.Provider != bf.info.ID {
		return nil, nil, nf("work_item: the floor's issues are not from %q", item.Provider)
	}
	rl, ok := bf.set.Tracker.(tracker.RunLinker)
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s items cannot start a run", errUnsupported, bf.info.Name)
	}
	repo, n, url, ok := rl.RunFromItem(item.ID)
	if !ok {
		return nil, nil, nf("work_item %q is not an item of this floor", item.ID)
	}
	ticket := &proto.RunTicket{Kind: proto.TicketIssue, Repo: repo, Number: n, URL: url}
	if bf.issues != nil && !bf.fetchedAt.IsZero() {
		for _, c := range bf.issues.Cards {
			if c.ID == item.ID {
				return ticket, nil, nil
			}
		}
		return nil, nil, nf("work_item %q is not on the floor's board", item.ID)
	}
	if verified {
		return ticket, nil, nil
	}
	tr, id := bf.set.Tracker, item.ID
	return ticket, func(ctx context.Context) error {
		if _, err := tr.Get(ctx, id); err != nil {
			if errors.Is(err, provider.ErrNotFound) {
				return nf("work_item %q is not an item of this floor", id)
			}
			return err
		}
		return nil
	}, nil
}

package server

// M6 runs: write-code runs on the floors. Every worker's round, ticket
// and issue, a freelancer's orchestrator and report, an orchestrator's
// phase, pass and over-cap, and freelancers seated next to their
// orchestrator (contract §1).

import (
	"context"
	"log/slog"
	"reflect"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/runs"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// Run timings.
const (
	// DefaultReportPoll is how often the freelancers' reports are looked at.
	DefaultReportPoll = time.Second
	// ReseatWindow is how long after a newcomer took a desk it may move
	// once, next to an orchestrator it turned out to belong to.
	ReseatWindow = 10 * time.Second
	// launchRetry is how soon an orchestrator with no run_launch record is
	// looked up again (run.start records it just after the hire).
	launchRetry = 5 * time.Second
	// reviewPassCap is write-code's cap on review passes.
	reviewPassCap = 3
)

// Write-code phases the bridge looks at.
const phaseWaitingUser = "waiting_user"

// runsState is the hub's run bookkeeping (hub goroutine only).
type runsState struct {
	reports   map[string]reportState     // worker id → its report
	launches  map[string]launchLookup    // orchestrator id → its run_launch issue
	seats     map[string]seatState       // newcomer id → the desk it took, for the one re-seat
	savedRuns map[string]store.WorkerRun // worker id → the phase and pass the store last got
}

type reportState struct {
	key    string // role, run and report name: a new one starts over
	report proto.RunReport
}

type launchLookup struct {
	launch runs.Launch
	ok     bool
	at     time.Time
}

type seatState struct {
	at time.Time // when it took its first desk
}

func runsDefaults(o *Options) {
	if o.ReportPoll <= 0 {
		o.ReportPoll = DefaultReportPoll
	}
}

func (h *Hub) initRuns() {
	h.runs = runsState{reports: map[string]reportState{}, launches: map[string]launchLookup{}, seats: map[string]seatState{},
		savedRuns: map[string]store.WorkerRun{}}
}

// runMeta folds an orchestrator's phase and pass tokens into what the
// bridge remembers of it (nextMeta).
func runMeta(m workerMeta, w world.WorkerObs) workerMeta {
	if w.Role != "orch" {
		return m
	}
	if w.RunInfo.Phase != "" {
		m.phase = w.RunInfo.Phase
	}
	if p := w.RunInfo.Pass; p != nil {
		m.pass, m.passSet = *p, true
	}
	return m
}

// withRun fills a worker view's run fields.
func (h *Hub) withRun(next *proto.Worker, w world.WorkerObs, m workerMeta, l runs.Link) {
	next.Round, next.Ticket = w.RunInfo.Round, w.RunInfo.Ticket
	next.OrchID = l.OrchID
	next.Issue, next.WorkItem = h.ticketRefs(next.Session, l.Issue, l.Item) // M7 boards; #118: with the ticket's title
	if w.Role == "orch" {
		next.Phase = m.phase
		if m.passSet {
			p := m.pass
			next.Pass = &p
		}
		next.OverCap = m.passSet && (m.pass > reviewPassCap || (m.pass == reviewPassCap && m.phase == phaseWaitingUser))
	}
	next.Report = h.reportView(next.ID, w)
}

// persistRun stores an orchestrator's phase and pass when they changed.
func (h *Hub) persistRun(ctx context.Context, id string, m workerMeta) {
	if m.phase == "" && !m.passSet {
		return
	}
	r := store.WorkerRun{Phase: m.phase}
	if m.passSet {
		p := m.pass
		r.Pass = &p
	}
	if prev, ok := h.runs.savedRuns[id]; ok && reflect.DeepEqual(prev, r) {
		return
	}
	if err := h.st.SetWorkerRun(ctx, id, r); err != nil {
		h.log.Error("saving worker run failed", "worker", id, "err", err)
		return
	}
	h.runs.savedRuns[id] = r
}

// storedRuns seeds a reconciled worker's meta with its remembered phase
// and pass.
func (h *Hub) storedRuns(ctx context.Context, session string) map[string]store.WorkerRun {
	rs, err := h.st.WorkerRuns(ctx, session)
	if err != nil {
		h.log.Error("loading worker runs failed", "session", session, "err", err)
	}
	for id, r := range rs {
		h.runs.savedRuns[id] = r
	}
	return rs
}

func withStoredRun(m workerMeta, r store.WorkerRun) workerMeta {
	m.phase = r.Phase
	if r.Pass != nil {
		m.pass, m.passSet = *r.Pass, true
	}
	return m
}

// --- links ---

func memberOf(id, floor string, role, run string, tokens map[string]string, ticket string) runs.Member {
	return runs.Member{ID: id, Floor: floor, Role: role, Run: run, RunToken: tokens["h3d_run"] != "", Ticket: ticket}
}

// members lists every worker for the links, floors by id and workers in
// sidebar order; floor is taken from obs/ids instead of its views (#58:
// a worker in ids that its old floor still lists is only floor's).
func (h *Hub) members(floor string, obs []world.WorkerObs, ids []string) []runs.Member {
	var ms []runs.Member
	moving := make(map[string]bool, len(ids))
	for _, id := range ids {
		moving[id] = true
	}
	for _, s := range sortedFloors(h.floors) {
		if s == floor {
			for i, w := range obs {
				ms = append(ms, memberOf(ids[i], s, w.Role, w.Run, w.Tokens, w.RunInfo.Ticket))
			}
			continue
		}
		for _, id := range h.floors[s].order {
			if w := h.workers[id]; w != nil && !moving[id] {
				ms = append(ms, memberOf(id, s, w.Role, w.Run, w.Tokens, w.Ticket))
			}
		}
	}
	return ms
}

func (h *Hub) links(ms []runs.Member) map[string]runs.Link {
	return runs.Links(ms, h.issueRepoOf, h.launched)
}

// issueRepoOf is the repo a floor's numeric run tickets are issues of: its
// effective repo, unless its issues are not GitHub's (#184: a Kaneo floor's
// "12" is no GitHub issue, whatever repo it works on).
func (h *Hub) issueRepoOf(floor string) string {
	if h.settings[floor].Tracker == TrackerKaneo {
		return ""
	}
	return h.repoOf(floor)
}

// repoOf is a floor's effective repo: its setting, else the suggestion.
func (h *Hub) repoOf(floor string) string {
	if r := h.settings[floor].Repo; r != "" {
		return r
	}
	if f := h.floors[floor]; f != nil && f.suggested != nil {
		return f.suggested.Repo
	}
	return ""
}

// launched is the ticket of an orchestrator the game started (its
// run_launch record), looked up again a while after a miss.
func (h *Hub) launched(id string) (runs.Launch, bool) {
	now := h.opts.Now()
	if l, ok := h.runs.launches[id]; ok && (l.ok || (now.Sub(l.at) < launchRetry && !now.Before(l.at))) {
		return l.launch, l.ok
	}
	var l launchLookup
	if h.opts.RunLaunch != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		l.launch, l.ok = h.opts.RunLaunch(ctx, id)
		cancel()
	}
	l.at = now
	h.runs.launches[id] = l
	return l.launch, l.ok
}

// storeRunLaunch is the default Options.RunLaunch: the store's run_launch
// record of an orchestrator, when it names an issue or (#184) an item.
func storeRunLaunch(st *store.Store, log *slog.Logger) func(context.Context, string) (runs.Launch, bool) {
	return func(ctx context.Context, id string) (runs.Launch, bool) {
		l, ok, err := st.RunLaunchByWorker(ctx, id)
		if err != nil {
			log.Error("loading run launch failed", "worker", id, "err", err)
			return runs.Launch{}, false
		}
		switch {
		case !ok:
			return runs.Launch{}, false
		case l.ItemProvider != "" && l.ItemID != "":
			return runs.Launch{Item: &proto.WorkItemRef{Provider: l.ItemProvider, ID: l.ItemID, Key: l.ItemKey}}, true
		case l.Repo != "" && l.IssueNumber >= 1:
			return runs.Launch{Issue: &proto.IssueRef{Repo: l.Repo, Number: l.IssueNumber}}, true
		}
		return runs.Launch{}, false
	}
}

// relink recomputes every worker's orchestrator and issue (a floor, its
// repo or a launch record changed) and emits an upsert for each worker
// whose links moved.
func (h *Hub) relink() {
	for id := range h.runs.launches {
		if h.workers[id] == nil {
			delete(h.runs.launches, id)
		}
	}
	ms := h.members("", nil, nil)
	ls := h.links(ms)
	for _, m := range ms {
		w, l := h.workers[m.ID], ls[m.ID]
		issue, item := h.ticketRefs(workerFloor(w), l.Issue, l.Item) // M7 boards; #118: with the ticket's title
		if w.OrchID == l.OrchID && reflect.DeepEqual(w.Issue, issue) && reflect.DeepEqual(w.WorkItem, item) {
			continue
		}
		next := *w
		next.OrchID, next.Issue, next.WorkItem = l.OrchID, issue, item
		h.workers[m.ID] = &next
		h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
	}
}

// --- desks ---

// seatNearOrch seats the newcomers of a floor that belong to an
// orchestrator on it at the free desk nearest to it (an orchestrator that
// is new itself is seated first, at the lowest free desk), and moves, once, a
// newcomer whose orchestrator turned up within ReseatWindow of it taking
// a desk. Hired workers keep their hire's desk; everyone else is seated
// later at the lowest free desk. It returns the workers whose desk must
// be stored.
func (h *Hub) seatNearOrch(f *floorState, desks map[string]int, obs []world.WorkerObs, ids []string, ls map[string]runs.Link,
	at time.Time) map[string]bool {
	for id, s := range h.runs.seats {
		if at.Sub(s.at) > ReseatWindow || at.Before(s.at) {
			delete(h.runs.seats, id)
		}
	}
	onFloor := make(map[string]bool, len(ids))
	for _, id := range ids {
		onFloor[id] = true
	}
	used := map[int]bool{}
	for _, d := range desks {
		used[d] = true
	}
	for _, op := range f.hires {
		if op.floor == f.id {
			used[op.desk] = true
		}
	}
	moved := map[string]bool{}
	// An orchestrator with no desk yet, first seen together with its
	// freelancers, takes the lowest free desk before they are placed, so
	// they can sit next to it in this same observation.
	for i, id := range ids {
		if f.hires[id] != nil || !world.Freelancer(obs[i].Role) {
			continue
		}
		orch := ls[id].OrchID
		if _, ok := desks[orch]; ok || !onFloor[orch] || f.hires[orch] != nil {
			continue
		}
		d := 0
		for used[d] {
			d++
		}
		used[d] = true
		desks[orch] = d
		moved[orch] = true
	}
	for i, id := range ids {
		if f.hires[id] != nil || !world.Freelancer(obs[i].Role) {
			continue
		}
		orch := ls[id].OrchID
		orchDesk, ok := desks[orch]
		if !onFloor[orch] || !ok {
			continue
		}
		cur, seated := desks[id]
		if seated {
			if _, pending := h.runs.seats[id]; !pending {
				continue
			}
			delete(h.runs.seats, id)
			delete(used, cur)
			best := runs.NearestDesk(orchDesk, func(d int) bool { return used[d] })
			if !runs.Nearer(best, cur, orchDesk) {
				used[cur] = true
				continue
			}
			h.log.Debug("freelancer re-seated next to its orchestrator", "worker", id, "from", cur, "to", best)
			cur = best
		} else {
			cur = runs.NearestDesk(orchDesk, func(d int) bool { return used[d] })
		}
		used[cur] = true
		desks[id] = cur
		moved[id] = true
	}
	return moved
}

// seatedNew records that a newcomer took the lowest free desk: it may
// move once, should its orchestrator turn up.
func (h *Hub) seatedNew(id string, at time.Time) {
	h.runs.seats[id] = seatState{at: at}
}

// --- reports ---

// reportView is a freelancer's report as last read: pending until the
// poller has seen the file, and pending again for a new report path.
// Only freelancers with an h3d_run and an h3d_report token have one.
func (h *Hub) reportView(id string, w world.WorkerObs) *proto.RunReport {
	run, name := w.Tokens["h3d_run"], w.RunInfo.Report
	if h.opts.RunsDir == "" || !world.Freelancer(w.Role) || run == "" || name == "" {
		delete(h.runs.reports, id)
		return nil
	}
	key := w.Role + "\x00" + run + "\x00" + name
	st, ok := h.runs.reports[id]
	if !ok || st.key != key {
		st = reportState{key: key, report: runs.Initial(run, name)}
		h.runs.reports[id] = st
	}
	r := st.report
	return &r
}

// reportWorker is what the poller needs of a freelancer.
type reportWorker struct {
	id, key, role, run, name string
}

// reportWorkers lists the freelancers whose reports the poller watches
// (hub goroutine) and forgets those of workers that are gone.
func (h *Hub) reportWorkers() []reportWorker {
	var out []reportWorker
	for id, st := range h.runs.reports {
		w := h.workers[id]
		if w == nil {
			delete(h.runs.reports, id)
			continue
		}
		run, name := w.Tokens["h3d_run"], w.Tokens["h3d_report"]
		if !runs.ValidName(run) || !runs.ValidReport(name) {
			continue
		}
		out = append(out, reportWorker{id: id, key: st.key, role: w.Role, run: run, name: name})
	}
	return out
}

// setReport publishes a freelancer's report as read now (worker.upsert),
// unless its report path changed meanwhile.
func (h *Hub) setReport(id, key string, r proto.RunReport) {
	st, ok := h.runs.reports[id]
	w := h.workers[id]
	if !ok || st.key != key || w == nil || reflect.DeepEqual(st.report, r) {
		return
	}
	st.report = r
	h.runs.reports[id] = st
	next := *w
	next.Report = &r
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// reportTracker stats the watched reports and their resolution sidecars (off
// the hub goroutine) and reads one only when it is new or the size or mtime
// of either changed (#215: the orchestrator resolving a request touches only
// the sidecar).
type reportTracker struct {
	dir  string
	seen map[string]trackedReport // worker id →
}

type trackedReport struct {
	key    string
	exists bool
	stamp  runs.Stamp
	// side is the sidecar's stamp, sideOK whether there is one.
	side   runs.Stamp
	sideOK bool
	report proto.RunReport
}

type reportUpdate struct {
	id, key string
	report  proto.RunReport
}

// trackReports runs the poller until ctx is done.
func (h *Hub) trackReports(ctx context.Context) {
	defer h.wg.Done()
	tr := &reportTracker{dir: h.opts.RunsDir, seen: map[string]trackedReport{}}
	tick := time.NewTicker(h.opts.ReportPoll)
	defer tick.Stop()
	for {
		ws, err := query(ctx, h, h.reportWorkers)
		if err != nil {
			return
		}
		if ups := tr.poll(ws); len(ups) > 0 {
			_ = h.doWait(ctx, func() {
				for _, u := range ups {
					h.setReport(u.id, u.key, u.report)
				}
			})
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// poll looks at every watched report once and returns the changed ones.
func (tr *reportTracker) poll(ws []reportWorker) []reportUpdate {
	var ups []reportUpdate
	live := make(map[string]bool, len(ws))
	for _, w := range ws {
		live[w.id] = true
		t, ok := tr.seen[w.id]
		if !ok || t.key != w.key {
			t = trackedReport{key: w.key, report: proto.RunReport{State: proto.ReportPending}}
		}
		stamp, exists, err := runs.Stat(tr.dir, w.run, w.name)
		if err != nil {
			continue // unreadable for now: keep what was shown
		}
		side, sideOK, err := runs.StatResolved(tr.dir, w.run, w.name)
		if err != nil {
			continue
		}
		prev := t.report
		switch {
		case !exists:
			t.exists, t.stamp, t.side, t.sideOK, t.report = false, runs.Stamp{}, runs.Stamp{}, false, proto.RunReport{State: proto.ReportPending}
		case !t.exists || stamp != t.stamp || sideOK != t.sideOK || side != t.side:
			t.exists, t.stamp, t.side, t.sideOK = true, stamp, side, sideOK
			t.report = runs.Read(tr.dir, w.run, w.name, w.role)
		}
		tr.seen[w.id] = t
		if !ok || !reflect.DeepEqual(prev, t.report) {
			ups = append(ups, reportUpdate{id: w.id, key: w.key, report: t.report})
		}
	}
	for id := range tr.seen {
		if !live[id] {
			delete(tr.seen, id)
		}
	}
	return ups
}

// workItemOf is a run's issue link in the neutral form: the provider of the
// floor's issues and the item's opaque id, when that provider maps M6's
// repo and number onto its items (M7 boards).
func (h *Hub) workItemOf(session string, issue *proto.IssueRef) *proto.WorkItemRef {
	if issue == nil {
		return nil
	}
	bf := h.boardOf(session)
	if bf == nil {
		return nil
	}
	rl, ok := bf.set.Tracker.(tracker.RunLinker)
	if !ok {
		return nil
	}
	id, ok := rl.ItemFromRun(issue.Repo, issue.Number)
	if !ok {
		return nil
	}
	return &proto.WorkItemRef{Provider: bf.info.ID, ID: id}
}

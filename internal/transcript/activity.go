package transcript

// #98: what a worker's agent is doing right now (ActivityTracker), from the
// same lines as the ask, wrap-up and follow-up trackers, parsed by this
// package's parsers into the turn's items. It ports #58's policy (the
// laptop's transcriptActivity.ts and docs/research/transcript-activity-status.md
// § Q4) to the bridge, for every Claude and Codex worker:
//
//   - only the current turn's items count: a prompt or a turn's start opens
//     one, its end (Claude's system/turn_duration, Codex's task_complete)
//     closes it, and herdr reporting `working` after an idle or done that
//     began once the turn had opened is a watermark too (a turn with no
//     prompt line, one whose end line never came), so the previous turn's
//     last tool never shows;
//   - a running tool (the latest started: concurrent calls may be earlier
//     than the last item) is its rule label; a finished one keeps its label
//     for LabelHold, then Thinking; assistant text is Replying; a prompt, a
//     thinking or reasoning item, or nothing yet is Thinking;
//   - a label stays at least LabelHold; an image a tool result viewed (or
//     the agent generated) stays ImageHold, or until the next image or the
//     turn's end;
//   - Claude's background tasks (a Bash run_in_background, a Monitor, an
//     async subagent, a ScheduleWakeup) stay open across turns until their
//     <task-notification> says they ended, TaskStop stops them, they expire
//     (a Monitor's timeoutMs unless persistent, the wakeup's time) or
//     MaxTaskAge passes: while herdr says idle or done they are what the
//     agent waits on. Read from the whole file, they survive a restart.
//
// Shapes checked against Claude Code 2.1.285 and codex-cli 0.159.2
// (testdata/*/activity_*.jsonl).

import (
	"bytes"
	"encoding/json"
	"path"
	"regexp"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Activity timings.
const (
	// LabelHold is the least time a label shows, and how long a finished
	// tool keeps its own.
	LabelHold = 1500 * time.Millisecond
	// ImageHold is how long an image shows (the next image or the turn's
	// end replaces it sooner).
	ImageHold = 6 * time.Second
	// MaxTaskAge closes a background task nothing closed (the background
	// Bash limit).
	MaxTaskAge = 2 * time.Hour
)

// ActivityView is what a tracker says of its worker now.
type ActivityView struct {
	// Working is the activity while herdr says the worker is working.
	Working *activity.Activity
	// Idle is the activity while herdr says idle or done: waiting on open
	// background tasks (nil: none open).
	Idle *activity.Activity
	// Candidate is the command Working's label stands for when the rules
	// could not place it (nil: none): the model's to try.
	Candidate *ActivityCandidate
	// Image reads the bytes of Working's image (KindImage only).
	Image func() ([]byte, error)
	// TurnAt is when Working's turn opened (unix ms): herdr starting to
	// work after an idle or done that began later is a turn the tracker has
	// not seen yet, and Working is the previous one's.
	TurnAt int64
}

// ActivityCandidate is a tool call the rules could not place.
type ActivityCandidate struct {
	Item, Tool, Command string
}

// actItem is one of the current turn's items.
type actItem struct {
	id     string
	seq    int64
	kind   string // proto.Item*
	call   activity.Call
	status string
	done   time.Time // when its result was read
	bg     *bgSpec   // the background task its result starts
}

// bgSpec is a background task a call starts, until its result says its id.
type bgSpec struct {
	kind   string // bash, monitor, subagent, wakeup
	label  activity.Kind
	detail string
}

// bgTask is an open background task.
type bgTask struct {
	id      string
	spec    bgSpec
	started int64 // unix ms
	expires int64 // unix ms (0: none)
}

// actImage is an image a tool result of the turn has.
type actImage struct {
	ref      *proto.ImageRef
	src      *imgSrc
	name     string
	at       time.Time
	resolved bool
}

// ActivityTracker follows one transcript's lines (all of them, from its
// start) and knows what its agent is doing. Not safe for concurrent use.
type ActivityTracker struct {
	harness  string
	now      func() time.Time
	env      *imageEnv
	parse    func(int64, []byte) ([]contrib, string)
	seq      int64
	mark     int64 // the current turn's items come after it
	turn     int   // counts the turns: a label never holds across one
	turnAt   int64 // when the current turn opened (unix ms)
	items    map[string]*actItem
	views    map[string]string // Codex view_image calls' paths, by call id
	sessions activity.Sessions
	img      *actImage
	// What Working last said: its key (kind, detail and item), since when,
	// in which turn, and the candidate it stood for.
	shown     *activity.Activity
	shownKey  string
	shownAt   time.Time
	shownTurn int
	shownCand *ActivityCandidate
	tasks     map[string]*bgTask
	turnEnd   int64 // unix ms the last turn ended (0: none read)
}

// NewActivityTracker follows a harness's (claude or codex) transcript; nil
// for another harness. images and cwd resolve the images it shows (as a
// Log's: WithImages, WithCwd); now is the bridge's clock (nil: time.Now).
func NewActivityTracker(harness string, images *Images, cwd string, now func() time.Time) *ActivityTracker {
	if !Supported(harness) {
		return nil
	}
	if now == nil {
		now = time.Now
	}
	env := newImageEnv()
	env.images, env.cwd = images, cwd
	t := &ActivityTracker{harness: harness, now: now, env: env, parse: parserOf(harness)}
	t.Reset()
	return t
}

// Reset forgets everything: the transcript is read again from its start.
func (t *ActivityTracker) Reset() {
	t.seq, t.mark, t.turnAt, t.turnEnd = 0, 0, 0, 0
	t.turn++
	t.items, t.views, t.tasks = map[string]*actItem{}, map[string]string{}, map[string]*bgTask{}
	t.sessions, t.img = activity.Sessions{}, nil
	t.shown, t.shownKey, t.shownCand = nil, "", nil
}

// Status tells the tracker herdr's status before the round's lines, and
// when the worker's last idle or done began (unix ms, 0: none seen): a
// worker working after an idle that began once its turn had opened is in a
// turn whose prompt has not been read (or that has none): it starts there
// (the watermark).
func (t *ActivityTracker) Status(status string, idleAt int64) {
	if status == "working" && idleAt > t.turnAt {
		t.newTurn(t.now().UnixMilli())
	}
}

func (t *ActivityTracker) newTurn(at int64) {
	t.mark = t.seq
	t.turn++
	t.turnAt = max(t.turnAt, at)
	clear(t.items)
	clear(t.views)
	t.img = nil
}

func (t *ActivityTracker) endTurn(ts int64) {
	if ts == 0 {
		ts = t.now().UnixMilli()
	}
	t.newTurn(0)
	t.turnEnd = ts
}

// Line reads one line and its turn events (TurnEvents, read once for all
// the trackers).
func (t *ActivityTracker) Line(off int64, b []byte, evs []TurnEvent) {
	if t.harness == Claude && bytes.Contains(b, []byte(`"isSidechain":true`)) {
		return // a subagent's line: not the worker's turn
	}
	cs, _ := t.parse(off, b)
	var ts int64
	for k := range cs {
		ts = max(ts, cs[k].ts)
	}
	for _, ev := range evs {
		if ev.Kind == TurnPrompt || ev.Kind == TurnStarted {
			at := ts
			if at == 0 {
				at = t.now().UnixMilli()
			}
			t.newTurn(at)
		}
	}
	for k := range cs {
		t.contrib(&cs[k])
	}
	if t.harness == Claude {
		t.claudeTasks(b, ts)
	}
	for _, ev := range evs {
		if ev.Kind == TurnDone || ev.Kind == TurnComplete {
			t.endTurn(ts)
		}
	}
}

// meaningfulKind is an item that says what the agent does.
func meaningfulKind(k string) bool {
	return k == proto.ItemUser || k == proto.ItemAssistant || k == proto.ItemThinking || k == proto.ItemTool ||
		k == proto.ItemSubagent
}

func (t *ActivityTracker) contrib(c *contrib) {
	switch c.link {
	case linkOwn, linkBlock:
		if c.hidden || !meaningfulKind(c.kind) {
			return
		}
		if _, ok := t.items[c.id]; ok {
			return // a later block of an item read already
		}
		t.seq++
		it := &actItem{id: c.id, seq: t.seq, kind: c.kind}
		t.items[c.id] = it
		b := newBuilder(c.id, t.seq, c)
		b.add(c)
		switch c.kind {
		case proto.ItemTool, proto.ItemSubagent:
			tool := b.tool()
			it.status = proto.ToolRunning
			it.call = t.sessions.Resolve(activity.Analyze(t.harness, tool.Name, tool.Input))
			if b.viewPath != "" {
				t.views[c.id] = b.viewPath
			}
			if t.harness == Claude {
				it.bg = t.claudeCall(tool.Name, tool.Input, it.call)
			}
		case proto.ItemAssistant:
			t.viewed(c.imgs, "", proto.KindGenerated)
		}
	case linkResult:
		it := t.items[c.id]
		if it == nil {
			return // a call of a turn before
		}
		b := newBuilder(c.id, it.seq, c)
		b.add(c)
		tool := b.tool()
		it.status, it.done = tool.Status, t.now()
		if it.status == "" {
			it.status = proto.ToolOK
		}
		t.sessions.Started(it.call, tool.OutputText)
		imgs := c.imgs
		if p := t.views[c.id]; p != "" && len(imgs) == 0 && it.status == proto.ToolOK {
			imgs = []imgRef{(&parseCtx{}).path(p, proto.OriginAgent, proto.KindViewed, p)}
		}
		t.viewed(imgs, it.call.Image, proto.KindViewed)
	case linkAbort:
		for _, it := range t.items {
			if it.status == proto.ToolRunning {
				it.status, it.done = proto.ToolInterrupted, t.now()
			}
		}
	}
}

// viewed takes the last image the agent viewed or generated among imgs.
func (t *ActivityTracker) viewed(imgs []imgRef, file, kind string) {
	for i := len(imgs) - 1; i >= 0; i-- {
		ir := imgs[i]
		if ir.ref == nil || ir.ref.Origin != proto.OriginAgent || ir.src == nil || ir.src.external {
			continue
		}
		name := file
		if ir.ref.Source == proto.ImagePath && ir.ref.Path != "" {
			name = ir.ref.Path
		}
		if ir.ref.Kind == "" {
			ir.ref.Kind = kind
		}
		t.img = &actImage{ref: ir.ref, src: ir.src, name: name, at: t.now()}
		return
	}
}

// resolve fills the image's ref once; false when it cannot be shown.
func (t *ActivityTracker) resolve(im *actImage) bool {
	if !im.resolved {
		t.env.resolve(im.ref, im.src)
		im.resolved = true
	}
	r := im.ref
	return r.Hash != "" && !r.Unavailable && r.Mime != imgcache.Binary && r.Width > 0 && r.Height > 0
}

// load reads the bytes of a resolved image again: from the cache, else its
// file or the base64 the line had.
func (t *ActivityTracker) loader(im *actImage) func() ([]byte, error) {
	env, ref, src := t.env, im.ref, im.src
	return func() ([]byte, error) {
		if c := env.cache(); c != nil {
			if b, ok := c.Get(ref.Hash); ok {
				return b, nil
			}
		}
		var data []byte
		var err error
		if ref.Source == proto.ImagePath {
			_, data, _, err = imgcache.LoadPath(src.path, env.roots(src.roots))
		} else {
			data, err = decodeB64(src.b64)
		}
		if err != nil {
			return nil, err
		}
		if imgcache.Hash(data) != ref.Hash {
			return nil, ErrNoImage
		}
		return data, nil
	}
}

// View is what the agent is doing now.
func (t *ActivityTracker) View(now time.Time) ActivityView {
	var v ActivityView
	v.Working, v.Candidate, v.Image = t.workingView(now)
	v.Idle = t.idleView(now)
	v.TurnAt = t.turnAt
	return v
}

func (t *ActivityTracker) workingView(now time.Time) (*activity.Activity, *ActivityCandidate, func() ([]byte, error)) {
	if im := t.img; im != nil && now.Sub(im.at) < ImageHold && t.resolve(im) {
		a := &activity.Activity{Kind: activity.KindImage, Detail: imageDetail(im.name), Source: activity.SourceRule,
			Image: &activity.Image{Hash: im.ref.Hash, W: im.ref.Width, H: im.ref.Height}}
		a, c := t.show("image:"+im.ref.Hash, a, nil, now, true)
		return a, c, t.loader(im)
	}
	var run, last *actItem
	for _, it := range t.items {
		if it.seq <= t.mark {
			continue
		}
		if (it.kind == proto.ItemTool || it.kind == proto.ItemSubagent) && it.status == proto.ToolRunning &&
			(run == nil || it.seq > run.seq) {
			run = it
		}
		if last == nil || it.seq > last.seq {
			last = it
		}
	}
	thinking := &activity.Activity{Kind: activity.KindThinking, Source: activity.SourceDerived}
	switch {
	case run != nil:
		return t.tool(run, now)
	case last == nil:
	case last.kind == proto.ItemTool || last.kind == proto.ItemSubagent:
		if now.Sub(last.done) < LabelHold {
			return t.tool(last, now)
		}
	case last.kind == proto.ItemAssistant:
		a, c := t.show("replying", &activity.Activity{Kind: activity.KindReplying, Source: activity.SourceDerived}, nil, now, false)
		return a, c, nil
	}
	a, c := t.show("thinking", thinking, nil, now, false)
	return a, c, nil
}

// tool is a tool item's label: its rule's; a meta tool's is the current one.
func (t *ActivityTracker) tool(it *actItem, now time.Time) (*activity.Activity, *ActivityCandidate, func() ([]byte, error)) {
	c := it.call
	if c.Keep {
		if t.shown != nil && t.shownTurn == t.turn {
			return t.shown, t.shownCand, nil
		}
		a, cand := t.show("thinking", &activity.Activity{Kind: activity.KindThinking, Source: activity.SourceDerived}, nil, now, false)
		return a, cand, nil
	}
	kind, detail := c.Kind, c.Detail
	if kind == activity.KindImage { // a script viewing an image: until its result shows it
		kind = activity.KindInvestigating
	}
	if kind == "" {
		kind = activity.KindWorking
	}
	var cand *ActivityCandidate
	if !c.OK && c.Command != "" {
		cand = &ActivityCandidate{Item: it.id, Tool: c.Tool, Command: c.Command}
	}
	a, cand := t.show(string(kind)+"\x00"+detail+"\x00"+it.id, &activity.Activity{Kind: kind, Detail: detail,
		Source: activity.SourceRule}, cand, now, false)
	return a, cand, nil
}

// show applies the hold: a label younger than LabelHold stays (an image may
// replace it); a label that changed starts now.
func (t *ActivityTracker) show(key string, a *activity.Activity, cand *ActivityCandidate, now time.Time, image bool) (*activity.Activity, *ActivityCandidate) {
	same := t.shown != nil && t.shownTurn == t.turn
	if same && key != t.shownKey && !image && now.Sub(t.shownAt) < LabelHold {
		return t.shown, t.shownCand
	}
	if same && key == t.shownKey {
		a.Since = t.shown.Since
	} else {
		a.Since = now.UnixMilli()
		t.shownKey, t.shownAt, t.shownTurn = key, now, t.turn
	}
	t.shown, t.shownCand = a, cand
	return a, cand
}

func imageDetail(name string) string {
	if name == "" || name == "." {
		return ""
	}
	return activity.Clip(path.Base(name), activity.MaxDetail)
}

// ---------------------------------------------------------------------------------------------------------------
// Background tasks (Claude)

// claudeCall notes what a call does to the background tasks: the task its
// result will start (nil: none), or the task it stops.
func (t *ActivityTracker) claudeCall(name string, input json.RawMessage, call activity.Call) *bgSpec {
	var in struct {
		Command     string `json:"command"`
		Description string `json:"description"`
		TaskID      string `json:"task_id"`
		ShellID     string `json:"shell_id"`
		Stop        bool   `json:"stop"`
	}
	_ = json.Unmarshal(input, &in)
	switch name {
	case "Bash":
		if call.Background {
			return &bgSpec{kind: "bash", label: activity.Awaited(in.Command)}
		}
	case "Monitor":
		d := in.Description
		if d == "" {
			d = firstLine(in.Command)
		}
		return &bgSpec{kind: "monitor", label: activity.Awaited(in.Command), detail: d}
	case "Agent", "Task":
		return &bgSpec{kind: "subagent", label: activity.KindDelegating, detail: in.Description}
	case "ScheduleWakeup":
		if in.Stop {
			delete(t.tasks, wakeupTask)
			return nil
		}
		return &bgSpec{kind: "wakeup", label: activity.KindWaiting}
	case "TaskStop", "KillShell", "KillBash":
		for _, id := range []string{in.TaskID, in.ShellID} {
			delete(t.tasks, id)
		}
	}
	return nil
}

func firstLine(s string) string {
	if i := bytes.IndexByte([]byte(s), '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// wakeupTask is the id of the one ScheduleWakeup.
const wakeupTask = "wakeup"

var (
	taskIDRe     = regexp.MustCompile(`<task-id>\s*([A-Za-z0-9_-]{1,64})\s*</task-id>`)
	taskStatusRe = regexp.MustCompile(`<status>\s*(completed|failed|killed|stopped|cancelled|canceled|timeout|timed_out|expired|error)\s*</status>`)
)

type taskLine struct {
	Type      string          `json:"type"`
	Content   json.RawMessage `json:"content"` // queue-operation: the notification
	Timestamp string          `json:"timestamp"`
	Message   *struct {
		Content strOr[claudeBlock] `json:"content"`
	} `json:"message"`
	ToolUseResult json.RawMessage `json:"toolUseResult"`
	Attachment    *struct {
		Prompt string `json:"prompt"`
	} `json:"attachment"`
}

type taskResult struct {
	BackgroundTaskID string `json:"backgroundTaskId"`
	TaskID           string `json:"taskId"`
	TimeoutMs        int64  `json:"timeoutMs"`
	Persistent       bool   `json:"persistent"`
	IsAsync          bool   `json:"isAsync"`
	Status           string `json:"status"`
	AgentID          string `json:"agentId"`
	Description      string `json:"description"`
	ScheduledFor     int64  `json:"scheduledFor"`
}

// claudeTasks reads what a line says of the background tasks: a result
// that starts one, a <task-notification> that ends one.
func (t *ActivityTracker) claudeTasks(b []byte, ts int64) {
	note := bytes.Contains(b, []byte("task-notification"))
	if !note && !bytes.Contains(b, []byte(`"toolUseResult"`)) {
		return
	}
	var l taskLine
	if json.Unmarshal(b, &l) != nil {
		return
	}
	if ts == 0 {
		ts = parseTS(l.Timestamp)
	}
	if ts == 0 {
		ts = t.now().UnixMilli()
	}
	if note {
		var texts []string
		var s string
		if json.Unmarshal(l.Content, &s) == nil {
			texts = append(texts, s)
		}
		if l.Attachment != nil {
			texts = append(texts, l.Attachment.Prompt)
		}
		if l.Message != nil {
			if l.Message.Content.isStr {
				texts = append(texts, l.Message.Content.str)
			}
			for _, bl := range l.Message.Content.list {
				if bl.Type == "text" {
					texts = append(texts, bl.Text)
				}
			}
		}
		for _, s := range texts {
			t.notified(s)
		}
	}
	if l.Type != "user" || l.Message == nil || len(l.ToolUseResult) == 0 || l.ToolUseResult[0] != '{' {
		return
	}
	var r taskResult
	if json.Unmarshal(l.ToolUseResult, &r) != nil {
		return
	}
	// toolUseResult goes with the line's first tool_result.
	for _, bl := range l.Message.Content.list {
		if bl.Type != "tool_result" {
			continue
		}
		if it := t.items[bl.ToolUseID]; it != nil && it.bg != nil {
			t.open(*it.bg, r, ts)
		}
		break
	}
}

// notified closes the task a notification says ended (a Monitor's events
// carry no status: they close nothing).
func (t *ActivityTracker) notified(s string) {
	for len(s) > 0 {
		i := bytes.Index([]byte(s), []byte("<task-notification>"))
		if i < 0 {
			return
		}
		s = s[i+len("<task-notification>"):]
		body := s
		if j := bytes.Index([]byte(s), []byte("</task-notification>")); j >= 0 {
			body, s = s[:j], s[j:]
		} else {
			s = ""
		}
		id := taskIDRe.FindStringSubmatch(body)
		if id != nil && taskStatusRe.MatchString(body) {
			delete(t.tasks, id[1])
		}
	}
}

// open starts the task a call's result says it started.
func (t *ActivityTracker) open(spec bgSpec, r taskResult, ts int64) {
	task := &bgTask{spec: spec, started: ts}
	switch spec.kind {
	case "bash":
		task.id = r.BackgroundTaskID
	case "monitor":
		task.id = r.TaskID
		if r.TimeoutMs > 0 && !r.Persistent {
			task.expires = ts + r.TimeoutMs
		}
	case "subagent":
		if !r.IsAsync && r.Status != "async_launched" {
			return // it ran in the foreground
		}
		task.id = r.AgentID
		if r.Description != "" && spec.detail == "" {
			task.spec.detail = r.Description
		}
	case "wakeup":
		if r.ScheduledFor <= 0 {
			return
		}
		task.id, task.expires = wakeupTask, r.ScheduledFor
	}
	if task.id == "" {
		return
	}
	t.tasks[task.id] = task
}

// idleView is waiting on the open background tasks (nil: none).
func (t *ActivityTracker) idleView(now time.Time) *activity.Activity {
	ms := now.UnixMilli()
	var pick *bgTask
	latest := int64(0)
	for id, task := range t.tasks {
		if (task.expires > 0 && ms >= task.expires) || ms-task.started >= MaxTaskAge.Milliseconds() {
			delete(t.tasks, id)
			continue
		}
		latest = max(latest, task.started)
		if pick == nil || taskRank(task) > taskRank(pick) || (taskRank(task) == taskRank(pick) &&
			(task.started > pick.started || task.started == pick.started && task.id < pick.id)) {
			pick = task
		}
	}
	if pick == nil {
		return nil
	}
	since := t.turnEnd
	if since == 0 || since < latest {
		since = max(since, latest)
	}
	return &activity.Activity{Kind: activity.KindWaiting, Detail: taskDetail(pick), Since: since,
		Source: activity.SourceDerived, Tasks: len(t.tasks)}
}

// taskRank orders the tasks a detail may describe: a task's own label before
// a wakeup's time.
func taskRank(task *bgTask) int {
	switch task.spec.kind {
	case "wakeup":
		return 0
	case "subagent":
		return 2
	}
	if task.spec.label != activity.KindWaiting {
		return 3
	}
	return 1
}

func taskDetail(task *bgTask) string {
	clip := func(s string) string { return activity.Clip(activity.Scrub(s), activity.MaxWaitDetail) }
	switch task.spec.kind {
	case "monitor":
		if task.spec.detail != "" {
			return clip("Monitor: " + task.spec.detail)
		}
		return "Monitor"
	case "subagent":
		if task.spec.detail != "" {
			return clip("Subagent: " + task.spec.detail)
		}
		return "Subagent"
	case "wakeup":
		return "Wakes at " + time.UnixMilli(task.expires).Format("15:04")
	}
	if task.spec.label == activity.KindWaiting || task.spec.label == activity.KindWorking || task.spec.label == "" {
		return "Running in the background"
	}
	return task.spec.label.Word() + " in the background"
}

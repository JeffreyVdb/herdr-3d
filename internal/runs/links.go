package runs

import (
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// Member is one worker as the links see it.
type Member struct {
	ID, Floor string
	Role, Run string
	RunToken  bool // Run is the h3d_run token (not the label fallback)
	Ticket    string
}

// Link is what a worker's run links it to.
type Link struct {
	OrchID string          // freelancers: their orchestrator
	Issue  *proto.IssueRef // the run's GitHub issue, when a repo is known
	// Item (#184) is the run's item of a provider that numbers no GitHub
	// issues (a Kaneo task), from its launch record; never with Issue.
	Item *proto.WorkItemRef
}

// Launch is the ticket of an orchestrator the game started (its launch
// record): a GitHub issue, or a provider's item, and (#58) the floor it was
// started on.
type Launch struct {
	Issue *proto.IssueRef
	Item  *proto.WorkItemRef
	Floor string
}

// Links links every freelancer to its orchestrator and finds the issue of
// every run member. A freelancer's orchestrator has the same run, on its
// floor if one is there, else on another floor; with none and a run from
// the label (no h3d_run token), the only orchestrator of its floor. A
// freelancer's issue is its own numeric ticket with its floor's repo, else
// its orchestrator's. An orchestrator's is its launch record's (launched),
// else its own numeric ticket, else the most common numeric ticket of its
// freelancers (ties: the lowest), each with its floor's repo. A launch
// record's item (#184) is the orchestrator's, and its freelancers' when
// they have no issue of their own. Members come in a stable order (floors,
// then sidebar order), which breaks other ties. repoOf is the repo a
// numeric ticket is an issue of ("": none, also for a floor whose issues are
// not GitHub's).
func Links(ms []Member, repoOf func(floor string) string, launched func(orchID string) (Launch, bool)) map[string]Link {
	byRun := map[string][]int{}   // run → orchestrators
	byFloor := map[string][]int{} // floor → orchestrators
	for i, m := range ms {
		if m.Role == "orch" {
			if m.Run != "" {
				byRun[m.Run] = append(byRun[m.Run], i)
			}
			byFloor[m.Floor] = append(byFloor[m.Floor], i)
		}
	}
	out := make(map[string]Link, len(ms))
	crew := map[int][]int{} // orchestrator → its freelancers
	orchOf := map[int]int{}
	for i, m := range ms {
		if !world.Freelancer(m.Role) {
			continue
		}
		o := -1
		for _, j := range byRun[m.Run] {
			if ms[j].Floor == m.Floor {
				o = j
				break
			}
			if o < 0 {
				o = j
			}
		}
		if o < 0 && !m.RunToken && len(byFloor[m.Floor]) == 1 {
			o = byFloor[m.Floor][0]
		}
		if o >= 0 {
			orchOf[i] = o
			crew[o] = append(crew[o], i)
			out[m.ID] = Link{OrchID: ms[o].ID}
		}
	}
	own := func(m Member) *proto.IssueRef {
		n := world.IssueNumber(m.Ticket)
		repo := repoOf(m.Floor)
		if n == 0 || repo == "" {
			return nil
		}
		return &proto.IssueRef{Repo: repo, Number: n}
	}
	for i, m := range ms {
		if m.Role != "orch" {
			continue
		}
		var issue *proto.IssueRef
		if l, ok := launched(m.ID); ok && l.Item != nil {
			item := *l.Item
			out[m.ID] = Link{Item: &item}
			continue
		} else if ok && l.Issue != nil {
			c := *l.Issue
			issue = &c
		} else if issue = own(m); issue == nil {
			counts := map[int]int{}
			best := 0
			for _, c := range crew[i] {
				n := world.IssueNumber(ms[c].Ticket)
				if n == 0 {
					continue
				}
				counts[n]++
				if best == 0 || counts[n] > counts[best] || (counts[n] == counts[best] && n < best) {
					best = n
				}
			}
			if repo := repoOf(m.Floor); best != 0 && repo != "" {
				issue = &proto.IssueRef{Repo: repo, Number: best}
			}
		}
		if issue != nil {
			out[m.ID] = Link{Issue: issue}
		}
	}
	for i, m := range ms {
		if !world.Freelancer(m.Role) {
			continue
		}
		l := out[m.ID]
		if l.Issue = own(m); l.Issue == nil {
			if o, ok := orchOf[i]; ok {
				if oi := out[ms[o].ID].Issue; oi != nil {
					c := *oi
					l.Issue = &c
				} else if it := out[ms[o].ID].Item; it != nil {
					c := *it
					l.Item = &c
				}
			}
		}
		if l != (Link{}) {
			out[m.ID] = l
		}
	}
	return out
}

// PodSize is how many desks make a pod (the game's layout).
const PodSize = 4

// podDistance is how far desk is from the orchestrator's pod.
func podDistance(desk, orchDesk int) int {
	d := desk/PodSize - orchDesk/PodSize
	if d < 0 {
		return -d
	}
	return d
}

// Nearer reports whether desk a is a better seat than desk b next to the
// orchestrator at orchDesk: same pod first, then the other pods by their
// distance, then the lower index.
func Nearer(a, b, orchDesk int) bool {
	da, db := podDistance(a, orchDesk), podDistance(b, orchDesk)
	if da != db {
		return da < db
	}
	return a < b
}

// NearestDesk is the best free desk next to the orchestrator at orchDesk
// (used says which desks are taken); it may lie beyond the floor's desks.
func NearestDesk(orchDesk int, used func(desk int) bool) int {
	pod := orchDesk / PodSize
	for d := 0; ; d++ {
		pods := []int{pod - d, pod + d}
		if d == 0 {
			pods = pods[:1]
		}
		for _, p := range pods {
			if p < 0 {
				continue
			}
			for i := p * PodSize; i < (p+1)*PodSize; i++ {
				if !used(i) {
					return i
				}
			}
		}
	}
}

package world

import "strings"

// Candidate is a stored worker identity and the fingerprints recorded for it.
type Candidate struct {
	ID            string
	WorkspaceID   string
	Closed        bool // the bridge saw its workspace close
	Markers       []string
	AgentSessions []string
	LabelCwds     []string // LabelCwdKey values
}

// How an observed worker was matched to a stored identity.
const (
	ByMarker       = "marker"
	ByAgentSession = "agent_session"
	ByLabelCwd     = "label_cwd" // weak
)

// Match is the identity chosen for one observed workspace.
type Match struct {
	ID  string
	How string
}

// LabelCwdKey is the weak fingerprint value for a label and identity cwd.
func LabelCwdKey(label, cwd string) string { return label + "\x00" + cwd }

// Reconcile matches observed workers of one session to stored identities
// (herdr-followup.md §5), strongest evidence first across all workers so a
// weak match can never take an identity a stronger one needs:
//
//  1. a pane-label marker h3d-<short uuid> (read only, never written here);
//  2. the native agent session id;
//  3. label + identity cwd (weak), only for identities not seen closing.
//
// A workspace id alone is never trusted (herdr can reuse ids across a
// restart); it only breaks ties. Ambiguous evidence matches nothing, and
// unmatched workers are absent from the result (the caller mints new ids).
// Identities in taken are never assigned.
func Reconcile(obs []WorkerObs, cands []Candidate, taken map[string]bool) map[string]Match {
	used := map[string]bool{}
	for id := range taken {
		used[id] = true
	}
	res := map[string]Match{}
	tier := func(how string, keys func(WorkerObs) []string, has func(Candidate, string) bool) {
		for _, w := range obs {
			if _, done := res[w.WorkspaceID]; done {
				continue
			}
			for _, key := range keys(w) {
				var matches []Candidate
				for _, c := range cands {
					if !used[c.ID] && has(c, key) {
						matches = append(matches, c)
					}
				}
				if c, ok := choose(matches, w.WorkspaceID); ok {
					res[w.WorkspaceID] = Match{ID: c.ID, How: how}
					used[c.ID] = true
					break
				}
			}
		}
	}
	tier(ByMarker, func(w WorkerObs) []string { return w.Markers }, func(c Candidate, m string) bool {
		return contains(c.Markers, m) || strings.HasPrefix(strings.ReplaceAll(c.ID, "-", ""), markerHex(m))
	})
	tier(ByAgentSession, func(w WorkerObs) []string { return nonEmpty(w.AgentSession) }, func(c Candidate, id string) bool {
		return contains(c.AgentSessions, id)
	})
	tier(ByLabelCwd, func(w WorkerObs) []string {
		if w.Label == "" {
			return nil
		}
		return []string{LabelCwdKey(w.Label, w.IdentityCwd)}
	}, func(c Candidate, key string) bool {
		return !c.Closed && contains(c.LabelCwds, key)
	})
	return res
}

// choose picks the candidate on the same workspace id, else the only
// candidate, else the only one not seen closing.
func choose(matches []Candidate, workspaceID string) (Candidate, bool) {
	for _, c := range matches {
		if c.WorkspaceID == workspaceID {
			return c, true
		}
	}
	if len(matches) == 1 {
		return matches[0], true
	}
	var open []Candidate
	for _, c := range matches {
		if !c.Closed {
			open = append(open, c)
		}
	}
	if len(open) == 1 {
		return open[0], true
	}
	return Candidate{}, false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func nonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	return []string{s}
}

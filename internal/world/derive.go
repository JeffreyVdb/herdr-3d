package world

import (
	"path/filepath"
	"sort"
	"strconv"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// FromSnapshot derives one worker per workspace from a live snapshot, in
// herdr's sidebar order.
func FromSnapshot(snap *herdr.Snapshot) []WorkerObs {
	panes := map[string][]herdr.PaneInfo{}
	for _, p := range snap.Panes {
		panes[p.WorkspaceID] = append(panes[p.WorkspaceID], p)
	}
	agents := map[string]herdr.AgentInfo{}
	for _, a := range snap.Agents {
		agents[a.PaneID] = a
	}
	out := make([]WorkerObs, 0, len(snap.Workspaces))
	for _, ws := range snap.Workspaces {
		w := WorkerObs{
			WorkspaceID: ws.WorkspaceID,
			Label:       ws.Label,
			Status:      StatusUnknown,
			Tokens:      h3dTokens(ws.Tokens),
		}
		if wt := ws.Worktree; wt != nil {
			w.Worktree = &Worktree{RepoRoot: wt.RepoRoot, RepoName: wt.RepoName, CheckoutPath: wt.CheckoutPath, Linked: wt.IsLinkedWorktree}
		}
		wsPanes := panes[ws.WorkspaceID]
		for _, p := range wsPanes {
			if p.Label != nil && IsMarker(*p.Label) {
				w.Markers = append(w.Markers, *p.Label)
			}
		}
		if p, ok := primaryPane(wsPanes, agents, ws.ActiveTabID); ok {
			a, hasAgent := agents[p.PaneID]
			w.PaneID = p.PaneID
			w.PaneLabel = deref(p.Label)
			w.Cwd = deref(p.Cwd)
			w.AgentKind = deref(p.Agent)
			w.Status = p.AgentStatus
			w.Title = deref(p.TerminalTitleStripped)
			if p.AgentSession != nil {
				w.AgentSession = p.AgentSession.Value
			}
			if hasAgent {
				w.AgentName = deref(a.Name)
				w.Status = a.AgentStatus
				if a.Agent != nil {
					w.AgentKind = *a.Agent
				}
				if a.AgentSession != nil {
					w.AgentSession = a.AgentSession.Value
				}
				if w.Title == "" {
					w.Title = deref(a.TerminalTitleStripped)
				}
			}
		}
		if w.Status == "" {
			w.Status = StatusUnknown
		}
		w.IdentityCwd = w.Cwd
		if w.Worktree != nil && w.Worktree.CheckoutPath != "" {
			w.IdentityCwd = w.Worktree.CheckoutPath
		}
		w.Role, w.Run = RoleRun(w.Label, ws.Tokens)
		w.RunInfo = RunOf(w.Label, ws.Tokens) // M6 runs
		w.Harness, w.Model, w.Effort = HarnessOf(ws.Tokens, w.AgentKind)
		out = append(out, w)
	}
	return out
}

// primaryPane picks the pane that represents the worker: the first pane
// with an agent, else the first pane of the active tab, else the first pane.
func primaryPane(panes []herdr.PaneInfo, agents map[string]herdr.AgentInfo, activeTab string) (herdr.PaneInfo, bool) {
	for _, p := range panes {
		if _, ok := agents[p.PaneID]; ok || deref(p.Agent) != "" {
			return p, true
		}
	}
	for _, p := range panes {
		if p.TabID == activeTab {
			return p, true
		}
	}
	if len(panes) > 0 {
		return panes[0], true
	}
	return herdr.PaneInfo{}, false
}

// PaneIDs lists every pane of a snapshot, sorted.
func PaneIDs(snap *herdr.Snapshot) []string {
	ids := make([]string, 0, len(snap.Panes))
	for _, p := range snap.Panes {
		ids = append(ids, p.PaneID)
	}
	sort.Strings(ids)
	return ids
}

// ApplyStatus folds a `pane.agent_status_changed` event into a snapshot so
// the next FromSnapshot reflects it. It reports whether the pane was known.
func ApplyStatus(snap *herdr.Snapshot, ev herdr.StatusChanged) bool {
	found := false
	for i := range snap.Panes {
		if snap.Panes[i].PaneID == ev.PaneID {
			snap.Panes[i].AgentStatus = ev.AgentStatus
			// A release reports the old agent with status unknown; the
			// following pane_agent_detected re-snapshot clears it.
			if ev.Agent != nil && ev.AgentStatus != StatusUnknown && deref(snap.Panes[i].Agent) == "" {
				snap.Panes[i].Agent = ev.Agent
			}
			found = true
		}
	}
	for i := range snap.Agents {
		if snap.Agents[i].PaneID == ev.PaneID {
			snap.Agents[i].AgentStatus = ev.AgentStatus
		}
	}
	return found
}

// FromSessionFile derives the sleeping workers of a stopped session.
func FromSessionFile(sf *herdr.SessionFile) []WorkerObs {
	out := make([]WorkerObs, 0, len(sf.Workspaces))
	for _, ws := range sf.Workspaces {
		w := WorkerObs{
			WorkspaceID: ws.ID,
			Label:       deref(ws.CustomName),
			Cwd:         ws.IdentityCwd,
			IdentityCwd: ws.IdentityCwd,
			Status:      StatusUnknown,
		}
		if wt := ws.WorktreeSpace; wt != nil {
			w.Worktree = &Worktree{RepoRoot: wt.RepoRoot, RepoName: wt.Label, CheckoutPath: wt.CheckoutPath, Linked: wt.IsLinkedWorktree}
		}
		if w.Label == "" {
			// herdr shows an automatic label: the repo, else the cwd basename.
			switch {
			case w.Worktree != nil && w.Worktree.RepoName != "":
				w.Label = w.Worktree.RepoName
			case ws.IdentityCwd != "":
				w.Label = filepath.Base(ws.IdentityCwd)
			}
		}
		for _, tab := range ws.Tabs {
			for _, key := range sortedKeys(tab.Panes) {
				if l := deref(tab.Panes[key].Label); IsMarker(l) {
					w.Markers = append(w.Markers, l)
				}
			}
		}
		if key, pane, ok := savedPrimaryPane(ws); ok {
			if n, ok := ws.PublicPaneNumbers[key]; ok {
				w.PaneID = ws.ID + ":p" + strconv.Itoa(n)
			}
			w.PaneLabel = deref(pane.Label)
			if pane.Cwd != "" {
				w.Cwd = pane.Cwd
			}
			w.AgentName = deref(pane.AgentName)
			w.AgentKind = deref(pane.ManagedAgentKind)
			if pane.AgentSession != nil {
				w.AgentSession = pane.AgentSession.Value
				if w.AgentKind == "" {
					w.AgentKind = pane.AgentSession.Agent
				}
			}
		}
		w.Role, w.Run = RoleRun(w.Label, nil)
		w.RunInfo = RunOf(w.Label, nil) // M6 runs
		w.Harness, _, _ = HarnessOf(nil, w.AgentKind)
		out = append(out, w)
	}
	return out
}

// savedPrimaryPane mirrors primaryPane for session.json: the first pane with
// an agent (tab order, root pane first), else the first tab's root pane.
func savedPrimaryPane(ws herdr.SavedWorkspace) (string, herdr.SavedPane, bool) {
	for _, tab := range ws.Tabs {
		for _, key := range tabPaneOrder(tab) {
			p := tab.Panes[key]
			if p.AgentSession != nil || deref(p.ManagedAgentKind) != "" {
				return key, p, true
			}
		}
	}
	for _, tab := range ws.Tabs {
		if order := tabPaneOrder(tab); len(order) > 0 {
			return order[0], tab.Panes[order[0]], true
		}
	}
	return "", herdr.SavedPane{}, false
}

func tabPaneOrder(tab herdr.SavedTab) []string {
	keys := sortedKeys(tab.Panes)
	if tab.RootPane == nil {
		return keys
	}
	root := strconv.Itoa(*tab.RootPane)
	if _, ok := tab.Panes[root]; !ok {
		return keys
	}
	order := []string{root}
	for _, k := range keys {
		if k != root {
			order = append(order, k)
		}
	}
	return order
}

// sortedKeys orders pane map keys numerically (they are internal pane ids).
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, errA := strconv.Atoi(keys[i])
		b, errB := strconv.Atoi(keys[j])
		if errA == nil && errB == nil {
			return a < b
		}
		return keys[i] < keys[j]
	})
	return keys
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

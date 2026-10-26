package server

import "github.com/JeffreyVdb/herdr-3d/internal/proto"

// Replaced by the manual process core when its branch is merged.
func (h *Hub) manualProcess(id string) (proto.ManualProcess, bool) {
	p, ok := h.manualProcesses[id]
	return p, ok
}
func (h *Hub) manualPane(id string) (session, pane string, ok bool) {
	p, ok := h.manualProcess(id)
	return p.Session, p.PaneID, ok && p.Session != "" && p.PaneID != ""
}
func (h *Hub) setManualCredential(id string, c *proto.ManualCredential) {
	p, ok := h.manualProcess(id)
	if !ok {
		return
	}
	p.Credential = c
	if c != nil && (p.State == "running" || p.State == "starting") {
		p.State = "waiting"
	}
	if c == nil && p.State == "waiting" {
		p.State = "running"
	}
	h.manualProcesses[id] = p
	h.emit(proto.Event{T: proto.EvManualProcessUpsert, Process: &p})
}

func (h *Hub) manualProcessViews() []proto.ManualProcess {
	out := make([]proto.ManualProcess, 0, len(h.manualProcesses))
	for _, p := range h.manualProcesses {
		out = append(out, p)
	}
	return out
}

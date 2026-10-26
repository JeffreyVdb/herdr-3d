package server

import (
	"context"

	"github.com/JeffreyVdb/herdr-3d/internal/manual"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func (h *Hub) manualProcess(id string) (proto.ManualProcess, bool) {
	p, ok := h.manualProcesses[id]
	return p, ok
}

func (h *Hub) manualPane(id string) (session, pane string, ok bool) {
	p, ok := h.manualProcess(id)
	if !ok || p.Session == "" || p.PaneID == "" {
		return "", "", false
	}
	return p.Session, p.PaneID, true
}

func (h *Hub) setManualCredential(id string, c *proto.ManualCredential) {
	p, ok := h.manualProcess(id)
	if !ok {
		return
	}
	if c != nil && (manual.Terminal(p.State) || p.State == "stopping") {
		return
	}
	p.Credential = c
	if c != nil {
		p.State = "waiting"
	}
	if c == nil && p.State == "waiting" {
		p.State = "running"
	}
	if h.st == nil {
		h.manualProcesses[id] = p
		h.emit(proto.Event{T: proto.EvManualProcessUpsert, Process: &p})
		return
	}
	_ = h.saveManual(context.Background(), p)
}

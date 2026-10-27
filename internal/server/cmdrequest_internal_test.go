package server

import (
	"github.com/JeffreyVdb/herdr-3d/internal/cmdrequest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"testing"
)

func TestCommandRequestEntrySourceAndTurn(t *testing.T) {
	h := &Hub{workers: map[string]*proto.Worker{"w": {AgentSession: "session"}}}
	h.initCommandRequests()
	req := &proto.CommandRequest{Key: "key", Commands: []cmdrequest.Command{{Command: "pwd", Host: "bridge"}}}
	h.cr.shown["w"] = commandRequestShown{request: req, turn: "turn", source: commandRequestSource{Agent: "session", Session: "session"}}
	h.cr.latest["w"] = "turn"
	if _, _, _, ok := h.commandRequestEntry("w", "key", 0); !ok {
		t.Fatal("current request rejected")
	}
	h.workers["w"].AgentSession = "replacement"
	if _, _, _, ok := h.commandRequestEntry("w", "key", 0); ok {
		t.Fatal("replaced session accepted")
	}
	h.workers["w"].AgentSession = "session"
	h.cr.latest["w"] = "next turn"
	if _, _, _, ok := h.commandRequestEntry("w", "key", 0); ok {
		t.Fatal("old turn accepted")
	}
	delete(h.cr.latest, "w")
	if _, _, _, ok := h.commandRequestEntry("w", "key", 0); ok {
		t.Fatal("prompted turn accepted")
	}
}

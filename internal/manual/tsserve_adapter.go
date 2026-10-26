package manual

import (
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/manual/tsserve"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

type serveAdapter struct{}

func (serveAdapter) Parse(command string) (proto.ManualEffect, bool) {
	serve, ok := tsserve.Parse(command)
	if !ok {
		return proto.ManualEffect{}, false
	}
	if _, ok := tsserve.ForegroundVariant(command); !ok {
		return proto.ManualEffect{}, false
	}
	return proto.ManualEffect{Kind: "tailscale_serve", Endpoint: tsserve.Endpoint(serve), CleanupCommand: tsserve.CleanupCommand(serve)}, true
}

func (serveAdapter) Conflict(status []byte, effect proto.ManualEffect) (bool, error) {
	serve, ok := tsserve.Parse(effect.CleanupCommand)
	if !ok {
		return false, fmt.Errorf("invalid Tailscale cleanup command")
	}
	return tsserve.Conflict(status, serve)
}

func (serveAdapter) CleanupCommand(effect proto.ManualEffect) string { return effect.CleanupCommand }

func init() { Effects = serveAdapter{} }

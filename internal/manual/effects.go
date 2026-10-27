package manual

import "github.com/JeffreyVdb/herdr-3d/internal/proto"

// EffectAdapter identifies owned external effects and checks existing status.
type EffectAdapter interface {
	// Parse recognizes supported persistent background effects; foreground commands are not effects.
	Parse(command string) (proto.ManualEffect, bool)
	Conflict(status []byte, effect proto.ManualEffect) (bool, error)
	CleanupCommand(effect proto.ManualEffect) string
}

// Effects is supplied by the Tailscale Serve adapter when it is available.
var Effects EffectAdapter

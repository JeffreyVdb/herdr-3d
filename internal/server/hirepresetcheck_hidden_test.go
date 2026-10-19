package server_test

import (
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// hiddenOf is text as the game's Hire sends it to hire_preset.check when its
// review protects something (#117): every marked range, protected or left as
// typed, replaced by [redacted], no `secrets`.
func hiddenOf(t *testing.T, c *client, text string) string {
	t.Helper()
	_, m := c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
	s := ackData[proto.PromptSecretsScan](t, m)
	u := utf16.Encode([]rune(text))
	var out []uint16
	at := 0
	for _, cand := range s.Candidates {
		out = append(out, u[at:cand.Start]...)
		out = append(out, utf16.Encode([]rune("[redacted]"))...)
		at = cand.End
	}
	return string(utf16.Decode(append(out, u[at:]...)))
}

// The game asks the classifier about a task whose review protects values by
// sending it with each marked range as [redacted] and no review: the bridge
// scans that text, finds nothing, and takes it as a plain prompt. A review that
// protects anything is refused (secrets_review_stored), so this is the only
// way a protected task reaches the check.
func TestPromptSecretsHirePresetCheckHidden(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	hb, _ := startSecretsHireBridge(t, true, func(o *server.Options) { o.HirePresetRoles = roles })
	texts := []string{
		routeText,
		previewText,
		"Rotate it, then start an agent for the docs.\nAuthorization: Bearer abcdef0123456789abcdef0123456789\ndb: postgres://app:Hunter2-Pass-91@db.internal/app?sslmode=disable",
		// Split so GitHub push protection does not take the synthetic key for a real one.
		"héllo 🙂 start agents.\npassword: Correct-Horse-Battery-3\napi_key = \"sk_" + "live_abcdefghijklmnopqrstuv12345\"",
		"The password is Tr0ub4dor&3-xyz. Then start another agent.\nHere is the token:\n```\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n```",
		"-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==\n-----END RSA PRIVATE KEY-----\nstart an agent",
	}
	for i, text := range texts {
		hidden := hiddenOf(t, hb.c, text)
		if hidden == text || !strings.Contains(hidden, "[redacted]") {
			t.Fatalf("text %d: nothing was found: %q", i, text)
		}
		before := len(roles.cls.Calls())
		_, m := hb.c.command(proto.CmdHirePresetCheck, "k", proto.HirePresetCheckArgs{Prompt: hidden})
		if m.env.T != proto.TAck {
			t.Fatalf("text %d: %q refused: %s", i, hidden, m.raw)
		}
		calls := roles.cls.Calls()
		if len(calls) != before+1 || calls[before].State["prompt"] != hidden {
			t.Fatalf("text %d: classifier calls %+v", i, calls)
		}
	}
}

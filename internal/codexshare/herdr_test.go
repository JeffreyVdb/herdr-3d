package codexshare

import (
	"context"
	"testing"
)

// The driver never runs herdr against a session that is not its own.
func TestHerdrRefusesOtherSessions(t *testing.T) {
	cases := map[string]func(){
		"foreign name": func() { (&Herdr{Name: "default"}).Run(context.Background(), "workspace", "list") },
		"retargeted session": func() {
			(&Herdr{Name: SessionPrefix + "x"}).Run(context.Background(), "--session", "default", "pane", "list")
		},
		"lifecycle elsewhere": func() {
			(&Herdr{Name: SessionPrefix + "x"}).cli("session", "stop", "default")
		},
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("did not refuse")
				}
			}()
			call()
		})
	}
}

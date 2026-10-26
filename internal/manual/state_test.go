package manual

import "testing"

func TestTransitions(t *testing.T) {
	for _, tt := range []struct {
		from, to string
		ok       bool
	}{
		{"starting", "running", true}, {"starting", "waiting", true}, {"unknown", "failed", true}, {"unknown", "waiting", true}, {"starting", "failed", true}, {"running", "waiting", true},
		{"waiting", "running", true}, {"running", "stopping", true}, {"stopping", "stopped", true},
		{"running", "exited", true}, {"unknown", "stopping", true}, {"exited", "running", false},
		{"failed", "stopping", false}, {"starting", "exited", true}, {"bogus", "running", false},
	} {
		if got := CanTransition(tt.from, tt.to); got != tt.ok {
			t.Errorf("%s -> %s: %v", tt.from, tt.to, got)
		}
	}
}

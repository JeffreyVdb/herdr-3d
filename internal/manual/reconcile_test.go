package manual

import "testing"

func TestReconcile(t *testing.T) {
	exit := 3
	for _, tt := range []struct {
		name       string
		status     *Status
		tab, alive bool
		state      string
	}{
		{"live and tab", &Status{PID: 10}, true, true, "running"},
		{"live and tab gone", &Status{PID: 10}, false, true, "unknown"},
		{"identity mismatch and tab", &Status{PID: 10}, true, false, "unknown"},
		{"identity mismatch and tab gone", &Status{PID: 10}, false, false, "stopped"},
		{"no status and tab", nil, true, false, "unknown"},
		{"no status or tab", nil, false, false, "stopped"},
		{"exit", &Status{ExitCode: &exit}, true, false, "exited"},
		{"failed to start", &Status{ExitCode: &exit, Error: "shell missing"}, true, false, "failed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := Reconcile(tt.status, tt.tab, tt.alive); got != tt.state {
				t.Fatalf("got %s", got)
			}
		})
	}
}

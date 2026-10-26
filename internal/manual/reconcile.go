package manual

// Reconcile derives a conservative state from durable status, tab presence,
// and whether the status PID still has the recorded start ticks.
func Reconcile(status *Status, tab, alive bool) string {
	if status != nil && status.ExitCode != nil {
		return "exited"
	}
	if alive {
		if tab {
			return "running"
		}
		return "unknown"
	}
	if !tab {
		return "stopped"
	}
	return "unknown"
}

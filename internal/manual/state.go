package manual

// Terminal reports whether a process has reached a terminal state.
func Terminal(state string) bool { return state == "exited" || state == "stopped" || state == "failed" }

// CanTransition permits only lifecycle changes that preserve terminal states.
func CanTransition(from, to string) bool {
	switch from {
	case "starting":
		return to == "running" || to == "waiting" || to == "stopping" || to == "exited" || to == "stopped" || to == "failed" || to == "unknown"
	case "running":
		return to == "waiting" || to == "stopping" || to == "exited" || to == "stopped" || to == "unknown"
	case "waiting":
		return to == "running" || to == "stopping" || to == "exited" || to == "stopped" || to == "unknown"
	case "stopping":
		return to == "stopped" || to == "unknown" || to == "exited"
	case "unknown":
		return to == "running" || to == "waiting" || to == "stopping" || to == "exited" || to == "stopped" || to == "failed"
	}
	return false
}

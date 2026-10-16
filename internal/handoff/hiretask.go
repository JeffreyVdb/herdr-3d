package handoff

// HireTask is the task a hire from the handoff at path is given: the
// cabinet's Hire from handoff (game/src/world/handoff.ts hireTask, word for
// word) and a scheduled agent's handoff line (#62).
func HireTask(path string) string {
	return "Read " + path + " and continue the work. Invoke the skills it suggests."
}

// GoneTask is a scheduled agent's handoff line when the handoff at path was
// deleted before it fired (#62).
func GoneTask(path string) string {
	return "The handoff " + path + " this task referenced was deleted; continue without it."
}

package server

import "testing"

// #219: the bridge's first prompt of a handoff's hire is #198's, to the
// byte: the vectors of game/src/world/handoff.test.ts.
func TestHireWithHandoffTask(t *testing.T) {
	task := "  Fix the issue\n\n- keep   the spacing\n\t- and tabs\n\nThen open a PR.  "
	for _, tc := range []struct{ path, task, want string }{
		{"/h/f/a.md", "Fix the issue", "First read the handoff here: /h/f/a.md and then follow these instructions:\n\nFix the issue"},
		// A path with spaces is not quoted or escaped; the task's lines,
		// indentation and inner blank lines stay.
		{"/home/u/my handoffs/f 1/a b.md", "\n \n" + task + "\n\n  \n",
			"First read the handoff here: /home/u/my handoffs/f 1/a b.md and then follow these instructions:\n\n" + task},
		{"/p.md", "a\r\nb", "First read the handoff here: /p.md and then follow these instructions:\n\na\r\nb"},
		{"/p.md", "\r\n\t\r\nx\r\n \r\n", "First read the handoff here: /p.md and then follow these instructions:\n\nx"},
		{"/p.md", "x \n", "First read the handoff here: /p.md and then follow these instructions:\n\nx "},
	} {
		if got := hireWithHandoffTask(tc.path, tc.task); got != tc.want {
			t.Errorf("hireWithHandoffTask(%q, %q) =\n%q, want\n%q", tc.path, tc.task, got, tc.want)
		}
	}
}

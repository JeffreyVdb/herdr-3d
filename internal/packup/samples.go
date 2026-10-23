package packup

// LabelledPrompt is one prompt of the test's samples: whether it asks the
// worker to leave once the task is done (Match) and, for a core one that
// does, the task left once that part is cut.
type LabelledPrompt struct {
	Text  string
	Match bool
	Core  bool
	Task  string
}

// Samples are the labelled prompts packup.test runs (and the unit tests,
// with fakes): first the ticket's four examples (core: the test must get
// them right, the cut included), then more of both kinds, paraphrases and
// another language among them, and prompts that stop, end, clean up or
// leave something inside the task, for choosing the threshold.
var Samples = []LabelledPrompt{
	{Text: "Please make a PR and end your turn", Match: true, Core: true, Task: "Please make a PR"},
	{Text: "Please make a PR and stop working", Match: true, Core: true, Task: "Please make a PR"},
	{Text: "Do the action, leave the office and clean up the worktree", Match: true, Core: true, Task: "Do the action"},
	{Text: "Please make a PR", Core: true},

	{Text: "Fix the flaky login test, open a PR, then go home.", Match: true, Task: "Fix the flaky login test, open a PR"},
	{Text: "Rebase on main and push. After that you can go home and clean up your worktree.", Match: true},
	{Text: "Once the PR is merged, pack up and head home.", Match: true},
	{Text: "Update the changelog for 1.4 and commit it, then you're done for the day: clean up and leave.", Match: true},
	{Text: "Finish the migration script, push it, and then end the session.", Match: true},
	{Text: "Write the release notes. When you are finished, wrap up and go home.", Match: true},
	{Text: "Run the e2e suite and fix whatever fails, then call it a day and remove your worktree.", Match: true},
	{Text: "Address the review comments on #42 and push; after that, clock out.", Match: true},
	{Text: "Bump the Go version in go.mod, make a PR, and then you can leave.", Match: true},
	{Text: "Mach einen PR und geh dann nach Hause.", Match: true, Task: "Mach einen PR"},
	{Text: "Squash the commits and push. Then shut down and go home, you're done.", Match: true},
	{Text: "Close the issue once CI is green and sign off for today.", Match: true},
	{Text: "Merge the dependabot PRs that pass, then you are free to go: clean up after yourself.", Match: true, Task: "Merge the dependabot PRs that pass"},

	{Text: "Stop the dev server and restart it with --verbose."},
	{Text: "Clean up the stale build artifacts in the worktree, then run the tests again."},
	{Text: "End the function with an early return instead of the nested if."},
	{Text: "Add a 'Go home' button to the elevator panel."},
	{Text: "When the job finishes, stop polling and log the result."},
	{Text: "Make a PR, then wait for my review before you merge."},
	{Text: "Kill the background watcher you started earlier."},
	{Text: "Delete the old feature branch on origin, it's merged."},
	{Text: "Why did the build stop working after the last commit?"},
	{Text: "Leave a comment on the PR explaining the change."},
	{Text: "Remove the worktree helper script, we don't use it anymore."},
	{Text: "Write a test that checks the session ends when the user logs out."},
	{Text: "Finish the refactor and push; I'll check it tomorrow."},
	{Text: "Go through the home page copy and fix the typos."},
}

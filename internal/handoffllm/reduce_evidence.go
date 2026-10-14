package handoffllm

import (
	"regexp"
	"strconv"
	"strings"
)

// What a tool's result keeps: never the log, only bounded evidence lines —
// the exit status, test outcomes and failure lines, error headers, the
// files a patch changed, commits made and pull request / issue URLs.
//
// A result's outcome is one of three: failed (a non-zero exit, the harness
// flagged an error, a failure line), succeeded (an exit 0, a pass line, an
// edit's success line, a commit or URL it made, and no failure) or unknown
// (still running in the background, no output, nothing that says either).
// The absence of a failure is never a success.

const (
	evidenceWindow   = 64 << 10 // a result is read in its first and last 64 KiB
	maxEvidenceLines = 8        // lines kept from one result: the first 3 and the last 5
)

var (
	exitLine = regexp.MustCompile(`^(?:Exit code:? (-?\d+)|exit status (-?\d+)|Process exited with code (-?\d+))\b`)
	failLine = regexp.MustCompile(`(?:^--- FAIL|^FAIL\b|\bpanic:|^\s*(?i:error|fatal)(?:\[[^\]]{0,40}\])?:|:\d+(?::\d+)?: (?i:error|fatal error)\b|\bFAILED\b|\b[1-9]\d* (?:failed|failing|errors?)\b|^Traceback \(|npm ERR!|^ERROR\b|BUILD FAILED|\bError \d+$|apply_patch verification failed)`)
	passLine = regexp.MustCompile(`(?:^--- PASS|^ok\s+\S|^PASS\b|\b\d+ (?:passed|passing)\b|^\s*Tests?:\s|BUILD SUCCESS|^Success\. Updated the following files)`)
	// editLine: an edit tool's success (Claude Code's Write and Edit).
	editLine = regexp.MustCompile(`^(?:File created successfully at: |The file \S.* has been updated successfully)`)
	// runningLine: the command goes on in the background (a Codex
	// exec_command still running, a Claude Code background Bash).
	runningLine = regexp.MustCompile(`^(?:Process running with session ID|Command running in background with ID)\b`)
	// patchLine: a file in apply_patch's success list.
	patchLine = regexp.MustCompile(`^[AMD] \S`)
	// commitLine: git commit's "[branch (root-commit) 1a2b3c4] subject".
	commitLine = regexp.MustCompile(`^\[[^\]\s]{1,200}(?: \([a-z-]{1,40}\))? ([0-9a-f]{7,40})\] `)
	prURL      = regexp.MustCompile(`https?://[A-Za-z0-9.-]{1,100}/[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}/(?:pull|pulls|issues|merge_requests)/\d{1,10}`)
	// testCmd: a command that runs tests.
	testCmd = regexp.MustCompile(`\b(?:go test|gotestsum|pytest|py\.test|(?:npm|pnpm|yarn|bun)\b[^|;&]{0,60}\b(?:test|e2e)\b|cargo (?:test|nextest)|make (?:test|check|e2e)\S*|vitest|jest|playwright test|mvn (?:test|verify)|gradlew? test|deno test|rspec|phpunit|ctest|tox)\b`)
)

// Statuses of a tool call (tool.status, evidence.status): besides these,
// "exit N" for a non-zero exit, and "" when no result was read.
const (
	statusOK        = "ok"              // succeeded: a result shows it
	statusError     = "error"           // the harness flagged the result an error
	statusFailed    = "failed"          // a failure line, the harness flagged nothing
	statusRunning   = "running"         // still running when the result was written
	statusNoOutput  = "no output"       // a result with nothing in it
	statusNoOutcome = "outcome unknown" // a result that shows neither
)

// evidence is what a tool result shows.
type evidence struct {
	lines   []string
	status  string // a status above
	failing bool   // a failure was seen (non-zero exit, is_error, failure lines)
	running bool   // the command was still running (backgrounded)
	// exit0, passed: positive terminal evidence of a run (an exit 0, a
	// pass line); done: of an edit or a command's effect (an edit's
	// success line, a commit, a URL).
	exit0, passed, done bool
	commits             []string
	urls                []string
}

// ok: the result shows the call succeeded.
func (ev evidence) ok() bool {
	return !ev.failing && !ev.running && (ev.exit0 || ev.passed || ev.done)
}

// testPassed: the result shows a test run finished and passed.
func (ev evidence) testPassed() bool { return !ev.failing && !ev.running && (ev.exit0 || ev.passed) }

// readEvidence reads a result's text (failed: the harness flagged it an
// error) into bounded evidence.
func readEvidence(text string, failed bool) evidence {
	if len(text) > 2*evidenceWindow {
		text = cutHead(text, evidenceWindow) + "\n" + cutTail(text, evidenceWindow)
	}
	ev := evidence{failing: failed}
	exit, patch := false, false
	var lines []string
	for l := range strings.Lines(text) {
		l = strings.TrimRight(l, "\r\n")
		t := strings.TrimSpace(l)
		if t == "" {
			patch = false
			continue
		}
		keep := false
		if m := exitLine.FindStringSubmatch(t); m != nil && !exit {
			exit, keep = true, true
			code, _ := strconv.Atoi(m[1] + m[2] + m[3])
			if code != 0 {
				ev.status, ev.failing = "exit "+strconv.Itoa(code), true
			} else {
				ev.exit0 = true
			}
		}
		if runningLine.MatchString(t) {
			keep, ev.running = true, true
		}
		if editLine.MatchString(t) {
			ev.done = true
		}
		if failLine.MatchString(l) {
			keep, ev.failing = true, true
		}
		if passLine.MatchString(l) {
			keep, ev.passed = true, true
			patch = patch || strings.HasPrefix(t, "Success. Updated")
		} else if patch && patchLine.MatchString(t) {
			keep = true
		}
		if m := commitLine.FindStringSubmatch(t); m != nil {
			keep, ev.done = true, true
			ev.commits = append(ev.commits, m[1])
		}
		if us := prURL.FindAllString(l, 8); len(us) > 0 {
			keep, ev.done = true, true
			ev.urls = append(ev.urls, us...)
		}
		if keep && (len(lines) == 0 || lines[len(lines)-1] != t) {
			lines = append(lines, t)
		}
	}
	if len(lines) > maxEvidenceLines {
		lines = append(lines[:3:3], lines[len(lines)-(maxEvidenceLines-3):]...)
	}
	if ev.failing && len(lines) == 0 {
		// An error with nothing recognisable: its first line is the header.
		if l, _, _ := strings.Cut(strings.TrimSpace(text), "\n"); l != "" {
			lines = append(lines, l)
		}
	}
	ev.lines = lines
	switch {
	case ev.status != "": // a non-zero exit
	case failed:
		ev.status = statusError
	case ev.failing:
		ev.status = statusFailed
	case ev.running:
		ev.status = statusRunning
	case ev.ok():
		ev.status = statusOK
	case strings.TrimSpace(text) == "":
		ev.status = statusNoOutput
	default:
		ev.status = statusNoOutcome
	}
	return ev
}

func urlKind(u string) string {
	if strings.Contains(u, "/issues/") {
		return "issue"
	}
	return "pr"
}

// artifacts are the references observed, in first-seen order. A file or
// commit seen verified once stays verified; a test's is its latest run's.
type artifacts struct {
	list []Artifact
	at   map[[2]string]int
}

func (a *artifacts) add(kind, ref string, verified bool) {
	if ref == "" {
		return
	}
	if a.at == nil {
		a.at = map[[2]string]int{}
	}
	k := [2]string{kind, ref}
	if i, ok := a.at[k]; ok {
		a.list[i].Verified = a.list[i].Verified || verified
		return
	}
	a.at[k] = len(a.list)
	a.list = append(a.list, Artifact{Kind: kind, Ref: ref, Verified: verified})
}

// set records the latest outcome for a ref (a test run: the last run
// counts, not any run).
func (a *artifacts) set(kind, ref string, verified bool) {
	a.add(kind, ref, verified)
	if i, ok := a.at[[2]string{kind, ref}]; ok {
		a.list[i].Verified = verified
	}
}

package handoffllm

import (
	"regexp"
	"strconv"
	"strings"
)

// What a tool's result keeps: never the log, only bounded evidence lines —
// the exit status, test outcomes and failure lines, error headers, the
// files a patch changed, commits made and pull request / issue URLs.

const (
	evidenceWindow   = 64 << 10 // a result is read in its first and last 64 KiB
	maxEvidenceLines = 8        // lines kept from one result: the first 3 and the last 5
)

var (
	exitLine = regexp.MustCompile(`^(?:Exit code:? (-?\d+)|exit status (-?\d+)|Process exited with code (-?\d+))\b`)
	failLine = regexp.MustCompile(`(?:^--- FAIL|^FAIL\b|\bpanic:|^\s*(?i:error|fatal)(?:\[[^\]]{0,40}\])?:|:\d+(?::\d+)?: (?i:error|fatal error)\b|\bFAILED\b|\b[1-9]\d* (?:failed|failing|errors?)\b|^Traceback \(|npm ERR!|^ERROR\b|BUILD FAILED|\bError \d+$|apply_patch verification failed)`)
	passLine = regexp.MustCompile(`(?:^--- PASS|^ok\s+\S|^PASS\b|\b\d+ (?:passed|passing)\b|^\s*Tests?:\s|BUILD SUCCESS|^Success\. Updated the following files)`)
	// patchLine: a file in apply_patch's success list.
	patchLine = regexp.MustCompile(`^[AMD] \S`)
	// commitLine: git commit's "[branch (root-commit) 1a2b3c4] subject".
	commitLine = regexp.MustCompile(`^\[[^\]\s]{1,200}(?: \([a-z-]{1,40}\))? ([0-9a-f]{7,40})\] `)
	prURL      = regexp.MustCompile(`https?://[A-Za-z0-9.-]{1,100}/[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}/(?:pull|pulls|issues|merge_requests)/\d{1,10}`)
	// testCmd: a command that runs tests.
	testCmd = regexp.MustCompile(`\b(?:go test|gotestsum|pytest|py\.test|(?:npm|pnpm|yarn|bun)\b[^|;&]{0,60}\b(?:test|e2e)\b|cargo (?:test|nextest)|make (?:test|check|e2e)\S*|vitest|jest|playwright test|mvn (?:test|verify)|gradlew? test|deno test|rspec|phpunit|ctest|tox)\b`)
)

// evidence is what a tool result shows.
type evidence struct {
	lines   []string
	status  string // "ok", "error", "exit N"
	failing bool   // a failure was seen (non-zero exit, is_error, failure lines)
	commits []string
	urls    []string
}

// readEvidence reads a result's text (failed: the harness flagged it an
// error) into bounded evidence.
func readEvidence(text string, failed bool) evidence {
	if len(text) > 2*evidenceWindow {
		text = cutHead(text, evidenceWindow) + "\n" + cutTail(text, evidenceWindow)
	}
	ev := evidence{status: "ok", failing: failed}
	if failed {
		ev.status = "error"
	}
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
			}
		}
		if failLine.MatchString(l) {
			keep, ev.failing = true, true
		}
		if passLine.MatchString(l) {
			keep = true
			patch = patch || strings.HasPrefix(t, "Success. Updated")
		} else if patch && patchLine.MatchString(t) {
			keep = true
		}
		if m := commitLine.FindStringSubmatch(t); m != nil {
			keep = true
			ev.commits = append(ev.commits, m[1])
		}
		if us := prURL.FindAllString(l, 8); len(us) > 0 {
			keep = true
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

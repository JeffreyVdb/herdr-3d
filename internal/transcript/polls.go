package transcript

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Codex's background terminals (#132). An exec_command still running when
// its wait ends leaves a session the model follows with write_stdin: a poll
// (chars "") or input typed into it. A poll's row names the command it waits
// on, which only the session's start says: the index keeps which session
// started with which command (Log.sessions), in file order, and gives each
// poll's entry its command (Log.polled) when the poll is indexed. What a
// poll did (still running or exited, its new output) is its own result's.

// maxTermSessions bounds the sessions a log remembers the commands of.
const maxTermSessions = 256

// maxChars caps the typed text a summary shows, in runes.
const maxChars = 40

// pollCall is a call that only polls (or types into) background
// terminals: a direct write_stdin, or an exec script whose only tool calls
// are write_stdin (and view_image).
type pollCall struct {
	sessions []int64 // in call order
	chars    string  // what the first one types ("": a poll)
	direct   bool    // a direct write_stdin (its output is text, not chunks)
}

// codexTerminals reads a Codex call's background terminals: what the index
// needs of it (nil: none), and the poll it is (nil: not one).
func codexTerminals(name string, input json.RawMessage) (*activity.Terminals, *pollCall) {
	switch name {
	case "exec", "exec_command", "write_stdin":
	default:
		return nil, nil
	}
	t := activity.CodexTerminals(name, input)
	if len(t.Nested) == 0 {
		return nil, nil
	}
	if len(t.Polls) == 0 || t.Other || len(t.Polls) < len(t.Nested) {
		return &t, nil // it runs commands (or other tools): its own summary
	}
	return &t, &pollCall{sessions: t.Polls, chars: t.Nested[0].Chars, direct: name == "write_stdin"}
}

// starts reports whether t has a command whose session may start.
func starts(t *activity.Terminals) bool {
	for _, n := range t.Nested {
		if n.Session == 0 {
			return true
		}
	}
	return false
}

// summary is the poll's row summary: what it did to which command (cmd:
// the first session's, "" unknown), then the outcome (when its result is
// in). The command gives way to the cap, the rest does not.
func (p *pollCall) summary(cmd, outcome string) string {
	target := strings.TrimSpace(cmd)
	if target == "" {
		target = "background terminal"
		if id := p.sessions[0]; id > 0 {
			target += " " + strconv.FormatInt(id, 10)
		}
	}
	more := ""
	if len(p.sessions) > 1 {
		more = " (+" + strconv.Itoa(len(p.sessions)-1) + " more)"
	}
	if p.chars == "" {
		return clipSummaryWith("Waited for "+target, more+outcome)
	}
	return clipSummaryWith("Sent "+readableChars(p.chars)+" to "+target, more+outcome)
}

// readableChars is typed text as a summary shows it: scrubbed, control
// characters readable (⏎ for a newline or return, ^C and the like for the
// others), clipped.
func readableChars(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range activity.Scrub(s) {
		if n == maxChars {
			b.WriteString("…")
			break
		}
		n++
		switch {
		case r == '\n' || r == '\r':
			b.WriteString("⏎")
		case r < 0x20:
			b.WriteByte('^')
			b.WriteByte(byte(r) + '@')
		case r == 0x7f:
			b.WriteString("^?")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// pollResult is what a poll's output says: whether the process is still
// running (and how long the poll waited) or exited (with its code), and
// its new output.
type pollResult struct {
	known, running bool
	code           int64
	wall           float64 // seconds, -1: not said
	body           string
	decoded        bool // body is the new output (else the output as it was)
}

// outcome is the summary's suffix of a poll's result.
func (r pollResult) outcome() string {
	switch {
	case !r.known:
		return ""
	case r.running && r.wall >= 0:
		return " · still running · " + seconds(r.wall)
	case r.running:
		return " · still running"
	}
	return " · exited " + strconv.FormatInt(r.code, 10)
}

// seconds is a wait as a summary says it: 30s, 1.5s, 2m 10s.
func seconds(s float64) string {
	if s >= 60 {
		n := int64(math.Round(s))
		return fmt.Sprintf("%dm %ds", n/60, n%60)
	}
	return strconv.FormatFloat(math.Round(s*10)/10, 'f', -1, 64) + "s"
}

var (
	directWall    = regexp.MustCompile(`(?m)^Wall time: ([0-9.]+) seconds$`)
	directRunning = regexp.MustCompile(`(?m)^Process running with session ID \d+$`)
	directExit    = regexp.MustCompile(`(?m)^Process exited with code (-?\d+)$`)
)

// pollOutput reads a poll's output text: a direct write_stdin's header and
// output, or a script's chunks (the first poll's says the outcome; the
// body is every chunk's output). Text it cannot read is the body as is.
func (p *pollCall) pollOutput(text string) pollResult {
	r := pollResult{wall: -1, body: text}
	head, out, ok := strings.Cut(text, "Output:\n")
	if !ok {
		return r
	}
	if p.direct {
		if m := directExit.FindStringSubmatch(head); m != nil {
			r.known, r.code = true, parseInt(m[1])
		} else if directRunning.MatchString(head) {
			r.known, r.running = true, true
		}
		if m := directWall.FindStringSubmatch(head); m != nil && r.running {
			r.wall, _ = strconv.ParseFloat(m[1], 64)
		}
		r.body, r.decoded = out, true
		return r
	}
	var bodies []string
	first := true
	for _, line := range strings.Split(out, "\n") {
		c, ok := activity.ReadChunk(line)
		if !ok {
			bodies = append(bodies, line)
			continue
		}
		r.decoded = true
		bodies = append(bodies, strings.TrimSuffix(c.Output, "\n"))
		if first {
			first = false
			switch {
			case c.ExitCode != nil:
				r.known, r.code = true, *c.ExitCode
			case c.Session != 0:
				r.known, r.running = true, true
				if c.Wall != nil {
					r.wall = *c.Wall
				}
			}
		}
	}
	if r.decoded {
		r.body = strings.Trim(strings.Join(bodies, "\n"), "\n")
	}
	return r
}

func parseInt(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// pollStatus is a poll's status: an exit other than 0 is an error, a
// still running process is a poll that is done.
func (r pollResult) status(status string) string {
	if r.known && !r.running && r.code != 0 {
		return proto.ToolError
	}
	return status
}

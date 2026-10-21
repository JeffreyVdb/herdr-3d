package codexaccount

// #140: Auto, the Codex profile a hire runs on when the hire leaves it to
// the bridge (docs/decisions.md "#140"). Rules first, in order: the first
// that matches the hire's repo or folder wins, whatever the limits say.
// With none, the profiles that "may be used for anything" are compared by
// what their latest readings have left, the 5-hour window first, then the
// week. Auto is resolved once, at hire, to a concrete key: nothing ever
// moves a worker to another profile because its quota ran out.

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
)

// MaxRules bounds the rules.
const MaxRules = 32

// Fresh is how old a reading can be and still count (the clients' rule:
// older is stale).
const Fresh = 10 * time.Minute

// Rule sends a hire that matches to a profile. Match is one of
// github.com/<owner>/* (any repo of that owner), github.com/<owner>/<repo>
// (that repo), or a folder: an absolute path or one under ~/, matched on
// whole path segments (~/work matches ~/work/x, not ~/workshop).
type Rule struct {
	Match   string `json:"match"`
	Profile string `json:"profile"`
}

// Hire is what Pick knows of a hire.
type Hire struct {
	// Cwd is the folder the hire starts from (absolute; a worktree hire's
	// source, not its new checkout).
	Cwd string
	// Repo is the GitHub owner/repo of its origin ("": none).
	Repo string
	// UserHome expands a rule's ~/ ("": such a rule never matches).
	UserHome string
}

// Reading is what Pick needs of a profile's latest Codex limits reading.
type Reading struct {
	At      time.Time
	Stale   bool
	Error   string
	Reached string
	Windows []Window
}

// Window is one of a reading's windows. Only the plan's own (Model "")
// count.
type Window struct {
	Label string
	Model string
	Pct   float64
}

// match is a parsed Rule.Match.
type match struct {
	owner, repo string // repo "*": any of owner's
	path        string // a folder, as typed (cleaned; maybe ~/…)
}

// normMatch is m trimmed and in its stored form (github.com in lower case,
// a folder cleaned), ok false when it is none of the three forms.
func normMatch(m string) (string, bool) {
	p, problem := parseMatch(m)
	if problem != "" {
		return "", false
	}
	if p.path != "" {
		return p.path, true
	}
	return "github.com/" + p.owner + "/" + p.repo, true
}

// parseMatch parses a rule's match; problem says why it is none of the
// forms, in words for the person who typed it.
func parseMatch(m string) (match, string) {
	m = strings.TrimSpace(m)
	switch {
	case m == "":
		return match{}, "type a repo (github.com/<owner>/* or github.com/<owner>/<repo>) or a folder (/… or ~/…)"
	case strings.ContainsFunc(m, func(r rune) bool { return r < 0x20 || r == 0x7f }):
		return match{}, "a match cannot have a line break or a tab in it"
	case len(m) > MaxPath:
		return match{}, fmt.Sprintf("a match has at most %d characters", MaxPath)
	}
	if rest, ok := cutFold(m, "github.com/"); ok {
		owner, repo, _ := strings.Cut(rest, "/")
		switch {
		case !gitremote.ValidOwner(owner):
			return match{}, fmt.Sprintf("%q is not a GitHub owner: use github.com/<owner>/* or github.com/<owner>/<repo>", owner)
		case repo == "*":
			return match{owner: owner, repo: "*"}, ""
		case !gitremote.ValidRepo(owner + "/" + repo):
			return match{}, fmt.Sprintf("%q is not a GitHub repo: use github.com/<owner>/* or github.com/<owner>/<repo>", repo)
		}
		return match{owner: owner, repo: repo}, ""
	}
	if m == "~" || strings.HasPrefix(m, "~/") {
		return match{path: "~" + strings.TrimSuffix(filepath.Clean("/"+strings.TrimPrefix(m, "~")), "/")}, ""
	}
	if !filepath.IsAbs(m) {
		return match{}, "use github.com/<owner>/*, github.com/<owner>/<repo>, or a folder starting with / or ~/"
	}
	return match{path: filepath.Clean(m)}, ""
}

func cutFold(s, prefix string) (string, bool) {
	if len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix) {
		return s[len(prefix):], true
	}
	return s, false
}

// matches reports whether the hire is m's (owner and repo ignoring case,
// as GitHub does).
func (m match) matches(h Hire) bool {
	if m.path == "" {
		owner, repo, ok := strings.Cut(h.Repo, "/")
		return ok && strings.EqualFold(owner, m.owner) && (m.repo == "*" || strings.EqualFold(repo, m.repo))
	}
	if h.Cwd == "" {
		return false
	}
	prefix := m.path
	if rest, ok := strings.CutPrefix(prefix, "~"); ok {
		if h.UserHome == "" {
			return false
		}
		prefix = filepath.Join(h.UserHome, rest)
	}
	cwd := filepath.Clean(h.Cwd)
	return cwd == prefix || prefix == "/" || strings.HasPrefix(cwd, prefix+"/")
}

// label is how a reason names m: the owner's rule without github.com.
func (m match) label() string {
	if m.path != "" {
		return m.path
	}
	return m.owner + "/" + m.repo
}

// SetRules replaces the rules (#140): at most MaxRules, each one of the
// match forms and naming a profile listed now, no match twice (a GitHub
// one ignoring case, a folder exactly). A refusal starts with the rule's
// number ("Rule 2: …"), so the editor can put it under that row.
func (s *Service) SetRules(ctx context.Context, rules []Rule) (Settings, error) {
	set := s.Settings()
	if len(rules) > MaxRules {
		return set, &SettingsError{fmt.Sprintf("At most %d rules; remove one first.", MaxRules)}
	}
	all := list(s.userHome, s.defaultHome, set)
	out := make([]Rule, 0, len(rules))
	seen := map[string]int{}
	for i, r := range rules {
		n := i + 1
		m, problem := parseMatch(r.Match)
		if problem != "" {
			return set, &SettingsError{fmt.Sprintf("Rule %d: %s.", n, problem)}
		}
		stored, _ := normMatch(r.Match)
		key := stored
		if m.path == "" {
			key = strings.ToLower(stored) // GitHub ignores case; a folder keeps it, as matches does
		}
		if j, ok := seen[key]; ok {
			return set, &SettingsError{fmt.Sprintf("Rule %d: rule %d already matches %s.", n, j, m.label())}
		}
		seen[key] = n
		switch _, ok := find(all, r.Profile); {
		case r.Profile == "":
			return set, &SettingsError{fmt.Sprintf("Rule %d: choose the profile it hires on.", n)}
		case !ok:
			return set, &SettingsError{fmt.Sprintf("Rule %d: there is no Codex profile %q.", n, r.Profile)}
		}
		out = append(out, Rule{Match: stored, Profile: r.Profile})
	}
	set.Rules = out
	return set, nil
}

// left is what a window has left, when known.
type left struct {
	pct   float64
	known bool
}

// cmpLeft is +1 when a has more left than b (a known value beats an
// unknown one), -1 when less, 0 when the same or both unknown.
func cmpLeft(a, b left) int {
	switch {
	case a.known && b.known && a.pct > b.pct, a.known && !b.known:
		return 1
	case a.known && b.known && a.pct < b.pct, !a.known && b.known:
		return -1
	}
	return 0
}

// leftIn is what reading r has left in its plan window label: unknown with
// no reading, a stale or failed one, one older than Fresh, or no such
// window; a reached limit has nothing left.
func leftIn(r Reading, ok bool, label string, now time.Time) left {
	if !ok || r.Stale || r.Error != "" || now.Sub(r.At) > Fresh {
		return left{}
	}
	for _, w := range r.Windows {
		if w.Model == "" && w.Label == label {
			if r.Reached != "" {
				return left{known: true}
			}
			return left{pct: min(100, max(0, 100-w.Pct)), known: true}
		}
	}
	return left{}
}

// candidate is a profile in the tiebreak.
type candidate struct {
	a          Account
	five, week left
}

// Pick is the profile an Auto hire runs on, and why, in words for the hire
// report ("Account: work (rule acme/*)"). Pure: the caller lists the
// profiles (signed in also when a reading had a plan), hands over each
// one's latest Codex reading by key, and the clock.
//
//  1. The first rule that matches wins, while its profile is listed, its
//     folder there, signed in and not hidden; limits never override it.
//     One that is not: the next rule, with a note in the reason.
//  2. Else the profiles that may be used for anything (listed, there,
//     signed in, not hidden): the one with more left in its 5-hour window,
//     then its week; a stale or failed reading, or one older than Fresh, is
//     unknown, and a known value beats it. Still tied (or nothing known):
//     the default among them, else the first listed.
//  3. Else the default profile.
func Pick(h Hire, accounts []Account, readings map[string]Reading, rules []Rule, now time.Time) (key, reason string) {
	var notes []string
	for _, r := range rules {
		m, problem := parseMatch(r.Match)
		if problem != "" || !m.matches(h) {
			continue
		}
		a, ok := find(accounts, r.Profile)
		name := r.Profile
		if ok {
			name = a.Name
		}
		switch {
		case !ok || !a.Exists && !a.Default:
			notes = append(notes, fmt.Sprintf("rule %s names %s, which is gone", m.label(), name))
		case a.Hidden:
			notes = append(notes, fmt.Sprintf("rule %s names %s, which is hidden", m.label(), name))
		case !a.SignedIn:
			notes = append(notes, fmt.Sprintf("rule %s names %s, which is not signed in", m.label(), name))
		default:
			return a.Key, account(a, "rule "+m.label(), notes)
		}
	}
	var cands []candidate
	for _, a := range accounts {
		if a.Anything && (a.Exists || a.Default) && a.SignedIn && !a.Hidden {
			r, ok := readings[a.Key]
			cands = append(cands, candidate{a: a, five: leftIn(r, ok, "5h", now), week: leftIn(r, ok, "week", now)})
		}
	}
	def := Account{}
	for _, a := range accounts {
		if a.Default {
			def = a
			break
		}
	}
	switch len(cands) {
	case 0:
		why := "no profile may be used for anything: the default"
		if len(notes) == 0 {
			why = "no rule matched, " + why
		}
		return def.Key, account(def, why, notes)
	case 1:
		return cands[0].a.Key, account(cands[0].a, "the only profile that may be used for anything", notes)
	}
	cmp := func(x, y candidate) (int, string) {
		if c := cmpLeft(x.five, y.five); c != 0 {
			return c, "5h"
		}
		return cmpLeft(x.week, y.week), "week"
	}
	best := cands[0]
	for _, c := range cands[1:] {
		if d, _ := cmp(c, best); d > 0 {
			best = c
		}
	}
	// What decided it: the window that set best apart from the closest
	// other; none when another is just as good.
	by, tied := "5h", []candidate{best}
	for _, c := range cands {
		if c.a.Key == best.a.Key {
			continue
		}
		switch d, w := cmp(best, c); {
		case d == 0:
			tied = append(tied, c)
		case w == "week":
			by = "week"
		}
	}
	if len(tied) == 1 {
		if by == "5h" {
			return best.a.Key, account(best.a, fmt.Sprintf("most left: %.0f%% of 5 h", best.five.pct), notes)
		}
		return best.a.Key, account(best.a, fmt.Sprintf("most left: %.0f%% of the week", best.week.pct), notes)
	}
	why := "same limits left"
	if !best.five.known && !best.week.known {
		why = "no fresh limits reading"
	}
	for _, c := range tied {
		if c.a.Default {
			return c.a.Key, account(c.a, why+": the default", notes)
		}
	}
	// best is the first listed of them: only a better one replaced it.
	return best.a.Key, account(best.a, why+": first listed", notes)
}

// account is a reason: "Account: <name> (<why>; <notes>)".
func account(a Account, why string, notes []string) string {
	return fmt.Sprintf("Account: %s (%s)", a.Name, strings.Join(append([]string{why}, notes...), "; "))
}

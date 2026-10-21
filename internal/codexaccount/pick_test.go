package codexaccount

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var now = time.UnixMilli(1_800_000_000_000)

// fresh is a reading taken a minute ago with pct used of 5h and week.
func fresh(five, week float64) Reading {
	return Reading{At: now.Add(-time.Minute), Windows: []Window{{Label: "5h", Pct: five}, {Label: "week", Pct: week}}}
}

func TestPick(t *testing.T) {
	codex := Account{Key: "codex", Name: "codex", Home: "/u/.codex", Default: true, Exists: true, SignedIn: true}
	personal := Account{Key: "personal", Name: "personal", Home: "/u/.codex-personal", Exists: true, SignedIn: true, Anything: true}
	work := Account{Key: "work", Name: "work", Home: "/u/.codex-work", Exists: true, SignedIn: true}
	flag := func(a Account) Account { a.Anything = true; return a }
	with := func(a Account, fn func(*Account)) Account { fn(&a); return a }
	acme := Hire{Cwd: "/u/src/widgets", Repo: "acme/widgets", UserHome: "/u"}
	mine := Hire{Cwd: "/u/src/dotfiles", Repo: "me/dotfiles", UserHome: "/u"}
	acmeRule := []Rule{{Match: "github.com/acme/*", Profile: "work"}}
	for _, tc := range []struct {
		name     string
		hire     Hire
		accounts []Account
		readings map[string]Reading
		rules    []Rule
		key, why string
	}{
		{"rule match", acme, []Account{codex, personal, work}, nil, acmeRule, "work", "Account: work (rule acme/*)"},
		{"rule beats more left elsewhere", acme, []Account{codex, personal, flag(work)},
			map[string]Reading{"work": fresh(99, 99), "personal": fresh(0, 0)}, acmeRule, "work", "Account: work (rule acme/*)"},
		{"owner rule before repo rule", acme, []Account{codex, personal, work}, nil,
			[]Rule{{Match: "github.com/acme/*", Profile: "work"}, {Match: "github.com/acme/widgets", Profile: "personal"}}, "work", "Account: work (rule acme/*)"},
		{"repo rule before owner rule", acme, []Account{codex, personal, work}, nil,
			[]Rule{{Match: "github.com/acme/widgets", Profile: "personal"}, {Match: "github.com/acme/*", Profile: "work"}}, "personal", "Account: personal (rule acme/widgets)"},
		{"owner and repo ignore case", Hire{Repo: "ACME/Widgets"}, []Account{codex, work}, nil,
			[]Rule{{Match: "github.com/acme/widgets", Profile: "work"}}, "work", "Account: work (rule acme/widgets)"},
		{"another owner does not match", mine, []Account{codex, work}, nil, acmeRule, "codex",
			"Account: codex (no rule matched, no profile may be used for anything: the default)"},
		{"path prefix", Hire{Cwd: "/u/work/api", UserHome: "/u"}, []Account{codex, work}, nil,
			[]Rule{{Match: "~/work", Profile: "work"}}, "work", "Account: work (rule ~/work)"},
		{"path prefix is the folder itself", Hire{Cwd: "/u/work", UserHome: "/u"}, []Account{codex, work}, nil,
			[]Rule{{Match: "~/work/", Profile: "work"}}, "work", "Account: work (rule ~/work)"},
		{"path prefix on whole segments", Hire{Cwd: "/u/workshop/x", UserHome: "/u"}, []Account{codex, work}, nil,
			[]Rule{{Match: "~/work", Profile: "work"}}, "codex", "Account: codex (no rule matched, no profile may be used for anything: the default)"},
		{"absolute path prefix", Hire{Cwd: "/srv/acme/a"}, []Account{codex, work}, nil,
			[]Rule{{Match: "/srv/acme", Profile: "work"}}, "work", "Account: work (rule /srv/acme)"},
		{"~ without a user home never matches", Hire{Cwd: "/u/work/api"}, []Account{codex, work}, nil,
			[]Rule{{Match: "~/work", Profile: "work"}}, "codex", "Account: codex (no rule matched, no profile may be used for anything: the default)"},
		{"no rule, one eligible", mine, []Account{codex, personal, work}, nil, acmeRule, "personal",
			"Account: personal (the only profile that may be used for anything)"},
		{"5h decides", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"personal": fresh(28, 90), "work": fresh(60, 0)}, nil, "personal", "Account: personal (most left: 72% of 5 h)"},
		{"5h tie, week decides", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"personal": fresh(40, 90), "work": fresh(40, 20)}, nil, "work", "Account: work (most left: 80% of the week)"},
		{"fresh beats stale", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"personal": with2(fresh(0, 0), func(r *Reading) { r.Stale = true }), "work": fresh(90, 90)}, nil, "work",
			"Account: work (most left: 10% of 5 h)"},
		{"fresh beats an error", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"personal": with2(fresh(0, 0), func(r *Reading) { r.Error = "no_plan" }), "work": fresh(90, 90)}, nil, "work",
			"Account: work (most left: 10% of 5 h)"},
		{"fresh beats one older than 10 min", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"personal": with2(fresh(0, 0), func(r *Reading) { r.At = now.Add(-11 * time.Minute) }), "work": fresh(90, 90)}, nil, "work",
			"Account: work (most left: 10% of 5 h)"},
		{"fresh beats none", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"work": fresh(90, 90)}, nil, "work", "Account: work (most left: 10% of 5 h)"},
		{"both stale, no default among them: first listed", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"personal": with2(fresh(90, 90), func(r *Reading) { r.Stale = true }), "work": with2(fresh(0, 0), func(r *Reading) { r.Stale = true })},
			nil, "personal", "Account: personal (no fresh limits reading: first listed)"},
		{"both stale, the default among them", mine, []Account{flag(codex), personal, flag(work)},
			map[string]Reading{"codex": with2(fresh(0, 0), func(r *Reading) { r.Stale = true })}, nil, "codex",
			"Account: codex (no fresh limits reading: the default)"},
		{"the same left: the default", mine, []Account{personal, flag(codex)},
			map[string]Reading{"personal": fresh(10, 10), "codex": fresh(10, 10)}, nil, "codex", "Account: codex (same limits left: the default)"},
		{"reached counts as nothing left", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{"personal": with2(fresh(1, 1), func(r *Reading) { r.Reached = "rate_limit_reached" }), "work": fresh(95, 95)}, nil, "work",
			"Account: work (most left: 5% of 5 h)"},
		{"per-model windows do not count", mine, []Account{codex, personal, flag(work)},
			map[string]Reading{
				"personal": {At: now, Windows: []Window{{Label: "5h", Model: "gpt", Pct: 0}, {Label: "5h", Pct: 50}}},
				"work":     fresh(40, 0),
			}, nil, "work", "Account: work (most left: 60% of 5 h)"},
		{"none eligible: the default", mine, []Account{codex, work}, nil, nil, "codex",
			"Account: codex (no rule matched, no profile may be used for anything: the default)"},
		{"flag on but hidden, gone or signed out", mine, []Account{codex, with(personal, func(a *Account) { a.Hidden = true }),
			with(flag(work), func(a *Account) { a.SignedIn = false }), {Key: "old", Name: "old", Added: true, Anything: true, SignedIn: true}}, nil, nil, "codex",
			"Account: codex (no rule matched, no profile may be used for anything: the default)"},
		{"rule names a removed profile", acme, []Account{codex, personal}, nil, acmeRule, "personal",
			"Account: personal (the only profile that may be used for anything; rule acme/* names work, which is gone)"},
		{"rule names a profile whose folder is gone", acme, []Account{codex, with(work, func(a *Account) { a.Exists = false })}, nil, acmeRule, "codex",
			"Account: codex (no profile may be used for anything: the default; rule acme/* names work, which is gone)"},
		{"rule names a hidden profile", acme, []Account{codex, personal, with(work, func(a *Account) { a.Hidden = true })}, nil, acmeRule, "personal",
			"Account: personal (the only profile that may be used for anything; rule acme/* names work, which is hidden)"},
		{"rule names a signed-out profile", acme, []Account{codex, personal, with(work, func(a *Account) { a.SignedIn = false; a.Name = "Work" })}, nil, acmeRule, "personal",
			"Account: personal (the only profile that may be used for anything; rule acme/* names Work, which is not signed in)"},
		{"a rule that falls through tries the next", acme, []Account{codex, personal}, nil,
			[]Rule{{Match: "github.com/acme/widgets", Profile: "work"}, {Match: "github.com/acme/*", Profile: "personal"}}, "personal",
			"Account: personal (rule acme/*; rule acme/widgets names work, which is gone)"},
		{"a rule may name the default", acme, []Account{codex, personal}, nil,
			[]Rule{{Match: "github.com/acme/*", Profile: "codex"}}, "codex", "Account: codex (rule acme/*)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key, why := Pick(tc.hire, tc.accounts, tc.readings, tc.rules, now)
			if key != tc.key || why != tc.why {
				t.Fatalf("Pick = %q, %q; want %q, %q", key, why, tc.key, tc.why)
			}
		})
	}
}

func with2(r Reading, fn func(*Reading)) Reading { fn(&r); return r }

// #140: "May be used for anything" is kept per folder, the default's too,
// and goes with a removed folder; rules are checked and stored in order.
func TestRulesAndAnything(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-work": true, "spare": false})
	s := New(h, filepath.Join(h, ".codex"))
	set, err := s.SetAnything(ctx, "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	s.Configure(set)
	if set, err = s.Add(ctx, filepath.Join(h, "spare")); err != nil {
		t.Fatal(err)
	}
	s.Configure(set)
	spare := ""
	list, _ := s.Accounts(ctx)
	for _, a := range list {
		if a.Added {
			spare = a.Key
		}
	}
	if set, err = s.SetAnything(ctx, spare, true); err != nil {
		t.Fatal(err)
	}
	s.Configure(set)
	list, _ = s.Accounts(ctx)
	got := map[string]bool{}
	for _, a := range list {
		got[a.Key] = a.Anything
	}
	if !got["codex"] || got["work"] || !got[spare] {
		t.Fatalf("anything = %v", got)
	}
	if _, err := s.SetAnything(ctx, "nope", true); !errors.As(err, new(*NotFoundError)) {
		t.Fatalf("unknown key: %v", err)
	}
	if set, err = s.Remove(ctx, spare); err != nil {
		t.Fatal(err)
	}
	if len(set.Overrides) != 1 || set.Overrides[0].Path != filepath.Join(h, ".codex") {
		t.Fatalf("overrides after remove = %+v", set.Overrides)
	}
	s.Configure(set)
	if set, err = s.SetAnything(ctx, "codex", false); err != nil || len(set.Overrides) != 0 {
		t.Fatalf("off again = %+v, %v", set.Overrides, err)
	}

	rules := []Rule{{Match: " GitHub.com/Acme/* ", Profile: "work"}, {Match: "~/work/", Profile: "codex"}, {Match: "/srv//x/", Profile: "work"}}
	if set, err = s.SetRules(ctx, rules); err != nil {
		t.Fatal(err)
	}
	want := []Rule{{Match: "github.com/Acme/*", Profile: "work"}, {Match: "~/work", Profile: "codex"}, {Match: "/srv/x", Profile: "work"}}
	if !slices.Equal(set.Rules, want) {
		t.Fatalf("rules = %+v", set.Rules)
	}
	if set, err = s.SetRules(ctx, nil); err != nil || set.Rules == nil || len(set.Rules) != 0 {
		t.Fatalf("cleared = %#v, %v", set.Rules, err)
	}
	many := make([]Rule, MaxRules+1)
	for i := range many {
		many[i] = Rule{Match: "/srv/" + strings.Repeat("x", i+1), Profile: "work"}
	}
	if _, err := s.SetRules(ctx, many[:MaxRules]); err != nil {
		t.Fatalf("%d rules: %v", MaxRules, err)
	}
	for _, tc := range []struct {
		rules []Rule
		msg   string
	}{
		{many, "At most 32 rules; remove one first."},
		{[]Rule{{Match: "", Profile: "work"}}, "Rule 1: type a repo (github.com/<owner>/* or github.com/<owner>/<repo>) or a folder (/… or ~/…)."},
		{[]Rule{{Match: "/a", Profile: "work"}, {Match: "github.com/bad_owner/*", Profile: "work"}}, `Rule 2: "bad_owner" is not a GitHub owner: use github.com/<owner>/* or github.com/<owner>/<repo>.`},
		{[]Rule{{Match: "github.com/acme/a/b", Profile: "work"}}, `Rule 1: "a/b" is not a GitHub repo: use github.com/<owner>/* or github.com/<owner>/<repo>.`},
		{[]Rule{{Match: "github.com/acme", Profile: "work"}}, `Rule 1: "" is not a GitHub repo: use github.com/<owner>/* or github.com/<owner>/<repo>.`},
		{[]Rule{{Match: "acme/*", Profile: "work"}}, "Rule 1: use github.com/<owner>/*, github.com/<owner>/<repo>, or a folder starting with / or ~/."},
		{[]Rule{{Match: "/a\tb", Profile: "work"}}, "Rule 1: a match cannot have a line break or a tab in it."},
		{[]Rule{{Match: "/a", Profile: ""}}, "Rule 1: choose the profile it hires on."},
		{[]Rule{{Match: "/a", Profile: "gone"}}, `Rule 1: there is no Codex profile "gone".`},
		{[]Rule{{Match: "github.com/acme/*", Profile: "work"}, {Match: "github.com/ACME/*", Profile: "codex"}}, "Rule 2: rule 1 already matches ACME/*."},
	} {
		_, err := s.SetRules(ctx, tc.rules)
		var se *SettingsError
		if !errors.As(err, &se) || se.Msg != tc.msg {
			t.Errorf("SetRules(%v) = %v; want %q", tc.rules, err, tc.msg)
		}
	}

	// Hand-written settings: a rule that does not parse goes, the rest stay
	// in order, at most MaxRules.
	c := Clean(Settings{Rules: append([]Rule{{Match: "nope", Profile: "work"}, {Match: "/a", Profile: ""}, {Match: "~/w/", Profile: "work"}}, many...)})
	if len(c.Rules) != MaxRules || c.Rules[0] != (Rule{Match: "~/w", Profile: "work"}) {
		t.Fatalf("clean = %d rules, first %+v", len(c.Rules), c.Rules[0])
	}
	if c := Clean(Settings{Overrides: []Override{{Path: "/u/.codex", Anything: true}}}); len(c.Overrides) != 1 || !c.Overrides[0].Anything {
		t.Fatalf("clean keeps anything: %+v", c.Overrides)
	}
}

// #140: no folder is keyed "auto", Auto's codex_profile.
func TestAutoIsNoKey(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-auto": true})
	list, _ := New(h, filepath.Join(h, ".codex")).Accounts(ctx)
	if got := keys(list); len(got) != 2 || got[1] != hashed("auto", filepath.Join(h, ".codex-auto")) || list[1].Name != "auto" {
		t.Fatalf("keys = %v, names %v", got, list)
	}
	list, _ = New(h, filepath.Join(h, ".codex-auto")).Accounts(ctx)
	if list[0].Key == "auto" || !list[0].Default {
		t.Fatalf("default keyed %q", list[0].Key)
	}
}

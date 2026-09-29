package world_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func intp(n int) *int { return &n }

func TestRunOf(t *testing.T) {
	for _, tc := range []struct {
		name   string
		label  string
		tokens map[string]string
		want   world.Run
	}{
		{"coder label", "CODE|bridge-ro|7|r2", nil, world.Run{Round: 2, Ticket: "7"}},
		{"reviewer label", "REVIEW|bridge-ro|#12|r1", nil, world.Run{Round: 1, Ticket: "#12"}},
		{"ux label", "UX|bridge-ro|m6|r3", nil, world.Run{Round: 3, Ticket: "m6"}},
		{"no ticket", "CODE|title|r1", nil, world.Run{Round: 1}},
		{"no round", "CODE|title|7", nil, world.Run{}},
		{"researcher", "GROUND|herdr", nil, world.Run{}},
		{"researcher with a round", "GROUND|herdr|r2", nil, world.Run{Round: 2}},
		{"ground has no label ticket", "GROUND|x|7|r1", nil, world.Run{Round: 1}},
		{"orch label", "ORCH|herdr-3d", nil, world.Run{}},
		{"plain label", "admin|7|r1", nil, world.Run{}},
		{"bad round", "CODE|x|7|r0", nil, world.Run{}},
		{"long ticket", "CODE|x|" + strings.Repeat("t", 33) + "|r1", nil, world.Run{Round: 1}},
		{"tokens win", "CODE|x|7|r1", map[string]string{"h3d_round": "4", "h3d_ticket": "#9", "h3d_report": "code-x-r4.json"},
			world.Run{Round: 4, Ticket: "#9", Report: "code-x-r4.json"}},
		{"bad round token falls back", "CODE|x|7|r1", map[string]string{"h3d_round": "x"}, world.Run{Round: 1, Ticket: "7"}},
		{"orchestrator tokens", "ORCH|x", map[string]string{"h3d_phase": "review", "h3d_pass": "2"},
			world.Run{Phase: "review", Pass: intp(2)}},
		{"pass zero", "", map[string]string{"h3d_pass": "0"}, world.Run{Pass: intp(0)}},
		{"bad pass", "", map[string]string{"h3d_pass": "-1"}, world.Run{}},
		{"plus pass", "", map[string]string{"h3d_pass": "+1"}, world.Run{}},
		{"long phase is cut", "", map[string]string{"h3d_phase": strings.Repeat("p", 40)}, world.Run{Phase: strings.Repeat("p", 32)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := world.RunOf(tc.label, tc.tokens); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("RunOf(%q, %v) = %+v, want %+v", tc.label, tc.tokens, got, tc.want)
			}
		})
	}
}

func TestIssueNumber(t *testing.T) {
	for in, want := range map[string]int{"7": 7, "#7": 7, "#123": 123, "": 0, "#": 0, "m6": 0, "07": 0, "-7": 0, "+7": 0,
		"#+7": 0, "7a": 0, "99999999999": 0} {
		if got := world.IssueNumber(in); got != want {
			t.Errorf("IssueNumber(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestCutUTF8(t *testing.T) {
	if got := world.CutUTF8("héllo", 2); got != "h" {
		t.Fatalf("cut inside é = %q", got)
	}
	if got := world.CutUTF8("héllo", 3); got != "hé" {
		t.Fatalf("cut after é = %q", got)
	}
	if got := world.CutUTF8("abc", 5); got != "abc" {
		t.Fatalf("short = %q", got)
	}
}

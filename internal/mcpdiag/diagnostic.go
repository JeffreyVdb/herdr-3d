// Package mcpdiag reduces MCP startup evidence to bounded, display-safe
// facts. Raw errors, terminal screens and configuration never leave it.
package mcpdiag

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

const Limit = 32

type Diagnostic struct {
	Name     string `json:"name"`
	Stage    string `json:"stage"` // starting, ready, failed, cancelled
	Category string `json:"category,omitempty"`
	Source   string `json:"source"` // terminal, notification, thread_status
}

var namePattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}$`)

func Name(s string) string {
	if namePattern.MatchString(s) {
		return s
	}
	return ""
}

// Category is shared by startup diagnostics and the MCP inventory.
func Category(text string) string {
	m := strings.ToLower(text)
	switch {
	case strings.Contains(m, "auth"), strings.Contains(m, "401"), strings.Contains(m, "403"):
		return "auth"
	case strings.Contains(m, "connection closed"):
		return "closed"
	case strings.Contains(m, "timed out"), strings.Contains(m, "timeout"):
		return "timeout"
	case strings.Contains(m, "not found"), strings.Contains(m, "no such file"):
		return "not_found"
	case strings.Contains(m, "refused"):
		return "refused"
	}
	return "startup"
}

func Reason(category string) string {
	switch category {
	case "auth":
		return "Authentication failed"
	case "closed":
		return "Connection closed"
	case "timeout":
		return "Timed out"
	case "not_found":
		return "Command not found"
	case "refused":
		return "Connection refused"
	}
	return "Startup failed"
}

// Merge keeps the latest fact for each named server, with a fixed cap.
func Merge(rows []Diagnostic, next ...Diagnostic) []Diagnostic {
	rows = slices.Clone(rows)
	for _, d := range next {
		if Name(d.Name) == "" {
			continue
		}
		if i := slices.IndexFunc(rows, func(v Diagnostic) bool { return v.Name == d.Name }); i >= 0 {
			rows[i] = d
		} else if len(rows) < Limit {
			rows = append(rows, d)
		}
	}
	return rows
}

// Terminal accepts only known Codex startup phrases. Soft terminal wraps
// may split the required-server failure before its timeout clause.
var client = regexp.MustCompile("MCP client for [`']?([A-Za-z0-9_][A-Za-z0-9_.:-]{0,99})[`']? (timed out|failed to start)[^\\n]*")
var required = regexp.MustCompile(`required MCP servers failed to initialize: ([A-Za-z0-9_][A-Za-z0-9_.-]{0,99}):\s*([^\n]{0,300})`)

func Terminal(screen string) []Diagnostic {
	if len(screen) > 32<<10 {
		screen = screen[len(screen)-(32<<10):]
	}
	var out []Diagnostic
	for _, re := range []*regexp.Regexp{client, required} {
		for _, m := range re.FindAllStringSubmatch(screen, Limit) {
			out = Merge(out, Diagnostic{Name: m[1], Stage: "failed", Category: Category(m[0]), Source: "terminal"})
		}
	}
	return out
}

// Failure carries evidence through rollback without carrying raw output.
type Failure struct {
	Diagnostics []Diagnostic
	Cause       error
}

func (f *Failure) Unwrap() error { return f.Cause }
func (f *Failure) Error() string {
	text := "Codex did not become ready within 30 seconds."
	for _, d := range f.Diagnostics {
		switch d.Stage {
		case "starting":
			text += fmt.Sprintf(" %s was still connecting.", d.Name)
		case "failed", "cancelled":
			if d.Category == "timeout" {
				text += fmt.Sprintf(" %s timed out.", d.Name)
			} else {
				text += fmt.Sprintf(" %s: %s.", d.Name, Reason(d.Category))
			}
		}
	}
	return text
}

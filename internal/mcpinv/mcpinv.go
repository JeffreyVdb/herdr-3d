// Package mcpinv is #196's MCP & skills inventory: per harness, the MCP
// servers and skills configured for a checkout and a config home, read
// without starting a server (Claude Code's config files and SKILL.md
// folders; a fresh Codex app-server's config/read and skills/list), the
// connection checks that start them on request in a fresh probe process,
// and the cache both are served from (docs/protocol.md "MCP and skills").
//
// Everything it returns is display-safe by construction: the proto types
// have no field for a config object, command, argument, environment value,
// header, URL, token or raw error text, and every note and reason is one
// of the bridge's own phrases. It imports no AI or model service.
package mcpinv

import (
	"errors"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Harnesses.
const (
	Claude = "claude"
	Codex  = "codex"
)

// Key is one cache entry's identity: the harness, the checkout ("": user
// scope only) and the config home (Claude Code's config dir; Codex's
// resolved CODEX_HOME), so one profile's answer is never another's.
type Key struct {
	Harness, Cwd, Home string
}

// Failure is a read or check that failed as a whole, with the bridge's
// phrase for why (Note: display-safe; the cause is only logged).
type Failure struct {
	Note  string
	Cause error
}

func (f *Failure) Error() string {
	if f.Cause != nil {
		return f.Note + ": " + f.Cause.Error()
	}
	return f.Note
}

func (f *Failure) Unwrap() error { return f.Cause }

// failureNote is err's display-safe note: a Failure's, else fallback.
func failureNote(err error, fallback string) string {
	var f *Failure
	if errors.As(err, &f) && f.Note != "" {
		return f.Note
	}
	return fallback
}

// Display is path for people: under home it starts with ~.
func Display(home, path string) string {
	if home == "" || path == "" {
		return path
	}
	home = filepath.Clean(home)
	if path == home {
		return "~"
	}
	if rest, ok := strings.CutPrefix(path, home+string(filepath.Separator)); ok {
		return "~/" + rest
	}
	return path
}

// Bounds of text taken from a harness or a file.
const (
	maxName        = 200
	maxDescription = 1024
)

// cleanName is s as a name to show: trimmed, valid UTF-8, no control
// characters, at most maxName bytes; "" when it is not usable.
func cleanName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > maxName || !utf8.ValidString(s) || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return ""
	}
	return s
}

// cleanText is a description to show: runs of white space and control
// characters made one space, trimmed, invalid UTF-8 dropped, at most
// maxDescription runes.
func cleanText(s string) string {
	s = strings.ToValidUTF8(s, "")
	var b strings.Builder
	space, n := false, 0
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			space = b.Len() > 0
			continue
		}
		if n >= maxDescription {
			break
		}
		if space {
			b.WriteByte(' ')
			space = false
			n++
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// stamp is t as the wire's RFC 3339 time (nil for the zero time).
func stamp(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func ptr[T any](v T) *T { return &v }

// emptyProvider is a provider with nothing read yet: every list [] (never
// null on the wire) and no check.
func emptyProvider() proto.MCPProvider {
	return proto.MCPProvider{Available: true, Servers: []proto.MCPServer{},
		Check:  proto.MCPCheck{State: proto.MCPCheckNone},
		Skills: proto.MCPSkills{Items: []proto.MCPSkill{}, Errors: []proto.MCPSkillError{}}}
}

// Unavailable is a provider whose CLI the bridge cannot run.
func Unavailable(reason string) proto.MCPProvider {
	p := emptyProvider()
	p.Available, p.Reason = false, reason
	p.Config = proto.MCPRead{State: proto.MCPStateUnavailable, Note: reason}
	p.Skills.State, p.Skills.Note = proto.MCPStateUnavailable, reason
	return p
}

// clone is a deep enough copy of p for the cache to hand out.
func clone(p proto.MCPProvider) proto.MCPProvider {
	p.Servers = append([]proto.MCPServer{}, p.Servers...)
	p.Skills.Items = append([]proto.MCPSkill{}, p.Skills.Items...)
	p.Skills.Errors = append([]proto.MCPSkillError{}, p.Skills.Errors...)
	return p
}

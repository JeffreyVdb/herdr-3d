// Package tsserve recognizes the supported, simple Tailscale Serve commands.
package tsserve

import (
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"unicode"
)

type token struct {
	text       string
	start, end int
}

// Serve is a parsed command, retaining its original spelling for cleanup.
type Serve struct {
	command  string
	tokens   []token
	target   int
	bg       int
	port     int
	protocol string
}

// Parse accepts only simple commands whose shell spelling needs no interpretation.
func Parse(cmd string) (Serve, bool) {
	if strings.ContainsAny(cmd, "\r\n") {
		return Serve{}, false
	}
	var ts []token
	for i := 0; i < len(cmd); {
		if unicode.IsSpace(rune(cmd[i])) {
			i++
			continue
		}
		start := i
		for i < len(cmd) && !unicode.IsSpace(rune(cmd[i])) {
			if strings.ContainsRune("'\"\\$`;|&<>(){}*?!#~", rune(cmd[i])) {
				return Serve{}, false
			}
			i++
		}
		ts = append(ts, token{cmd[start:i], start, i})
	}
	i := 0
	if i < len(ts) && ts[i].text == "sudo" {
		i++
		if i < len(ts) && ts[i].text == "-A" {
			i++
		}
	}
	if i+2 >= len(ts) || ts[i].text != "tailscale" || ts[i+1].text != "serve" {
		return Serve{}, false
	}
	i += 2
	s := Serve{command: cmd, tokens: ts, bg: -1, port: 443, protocol: "https"}
	endpoint := false
	for i < len(ts) && strings.HasPrefix(ts[i].text, "--") {
		flag := ts[i].text
		name, val, eq := strings.Cut(flag, "=")
		switch name {
		case "--bg", "--yes":
			if eq {
				return Serve{}, false
			}
			if name == "--bg" {
				if s.bg >= 0 {
					return Serve{}, false
				}
				s.bg = i
			}
		case "--https", "--http", "--tcp", "--tls-terminated-tcp", "--set-path":
			if !eq {
				i++
				if i >= len(ts) {
					return Serve{}, false
				}
				val = ts[i].text
			}
			if val == "" {
				return Serve{}, false
			}
			if name != "--set-path" {
				if endpoint {
					return Serve{}, false
				}
				endpoint = true
				p, e := strconv.Atoi(val)
				if e != nil || p < 1 || p > 65535 {
					return Serve{}, false
				}
				s.port = p
				s.protocol = strings.TrimPrefix(name, "--")
			}
		default:
			return Serve{}, false
		}
		i++
	}
	if i != len(ts)-1 || ts[i].text == "" {
		return Serve{}, false
	}
	s.target = i
	return s, true
}

// ForegroundVariant removes only --bg and the whitespace following it.
func ForegroundVariant(cmd string) (string, bool) {
	s, ok := Parse(cmd)
	if !ok || s.bg < 0 || s.tokens[s.target].text == "off" {
		return "", false
	}
	t := s.tokens[s.bg]
	end := t.end
	for end < len(cmd) && unicode.IsSpace(rune(cmd[end])) {
		end++
	}
	return cmd[:t.start] + cmd[end:], true
}

// CleanupCommand preserves the original flags and replaces the target with off.
func CleanupCommand(s Serve) string {
	if len(s.tokens) == 0 {
		return ""
	}
	t := s.tokens[s.target]
	return s.command[:t.start] + "off" + s.command[t.end:]
}
func Endpoint(s Serve) string { return fmt.Sprintf("%s:%d", s.protocol, s.port) }

type config struct {
	TCP        map[string]json.RawMessage
	Web        map[string]json.RawMessage
	Foreground map[string]*config
}

// Conflict checks all listeners, including foreground sessions, for the port.
func Conflict(statusJSON []byte, s Serve) (bool, error) {
	var c config
	if err := json.Unmarshal(statusJSON, &c); err != nil {
		return false, err
	}
	return c.hasPort(s.port), nil
}
func (c *config) hasPort(port int) bool {
	if c == nil {
		return false
	}
	if _, ok := c.TCP[strconv.Itoa(port)]; ok {
		return true
	}
	for hp := range c.Web {
		_, p, e := net.SplitHostPort(hp)
		if e == nil && p == strconv.Itoa(port) {
			return true
		}
	}
	for _, f := range c.Foreground {
		if f.hasPort(port) {
			return true
		}
	}
	return false
}

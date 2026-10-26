// Package askpass implements the supported top-level sudo rewrite.
package askpass

import "strings"

// Rewrite adds sudo's askpass option to a simple, top-level invocation.
func Rewrite(cmd string) (string, bool) {
	i := 0
	for i < len(cmd) && (cmd[i] == ' ' || cmd[i] == '\t') {
		i++
	}
	if !strings.HasPrefix(cmd[i:], "sudo") || i+4 >= len(cmd) || (cmd[i+4] != ' ' && cmd[i+4] != '\t') {
		return "", false
	}
	rest := cmd[i+4:]
	fields, simple := simpleWords(rest)
	if !simple || len(fields) == 0 {
		return "", false
	}
	command := false
	for j := 0; j < len(fields); j++ {
		f := fields[j]
		if command {
			break
		}
		if f == "--" {
			if j+1 >= len(fields) {
				return "", false
			}
			command = true
			continue
		}
		if !strings.HasPrefix(f, "-") || f == "-" {
			command = true
			break
		}
		if strings.HasPrefix(f, "--") {
			name, _, _ := strings.Cut(f, "=")
			for _, forbidden := range []string{"--askpass", "--stdin", "--non-interactive"} {
				if strings.HasPrefix(forbidden, name) {
					return "", false
				}
			}
			switch name {
			case "--askpass", "--stdin", "--non-interactive":
				return "", false
			}
			if f == "--user" || f == "--group" || f == "--host" || f == "--prompt" || f == "--chdir" || f == "--chroot" || f == "--role" || f == "--type" || f == "--close-from" || f == "--command-timeout" || f == "--auth-type" {
				j++
				if j >= len(fields) {
					return "", false
				}
			}
			continue
		}
		for k := 1; k < len(f); k++ {
			if strings.ContainsRune("ASn", rune(f[k])) {
				return "", false
			}
			if strings.ContainsRune("ughpCDRrtTa", rune(f[k])) {
				if k == len(f)-1 {
					j++
					if j >= len(fields) {
						return "", false
					}
				}
				break
			}
		}
	}
	if !command {
		return "", false
	}
	return cmd[:i+4] + " -A" + rest, true
}

// simpleWords recognizes shell words without evaluating expansions. Shell
// operators are forbidden outside quotes, and substitutions are forbidden
// wherever the shell would evaluate them.
func simpleWords(input string) ([]string, bool) {
	var words []string
	var word strings.Builder
	var quote byte
	started := false
	flush := func() {
		if started {
			words = append(words, word.String())
			word.Reset()
			started = false
		}
	}
	for i := 0; i < len(input); i++ {
		c := input[i]
		if c == '\n' || c == '\r' {
			return nil, false
		}
		if quote == '\'' {
			if c == '\'' {
				quote = 0
			} else {
				word.WriteByte(c)
			}
			continue
		}
		if c == '\\' {
			if i+1 >= len(input) || input[i+1] == '\n' || input[i+1] == '\r' {
				return nil, false
			}
			i++
			word.WriteByte(input[i])
			started = true
			continue
		}
		if quote == '"' {
			if c == '"' {
				quote = 0
				continue
			}
			if c == '$' || c == '`' {
				return nil, false
			}
			word.WriteByte(c)
			continue
		}
		switch c {
		case ' ', '\t':
			flush()
		case '\'', '"':
			quote = c
			started = true
		case ';', '|', '&', '<', '>', '(', ')', '$', '`':
			return nil, false
		case '#':
			if !started {
				return nil, false
			}
			word.WriteByte(c)
		default:
			word.WriteByte(c)
			started = true
		}
	}
	if quote != 0 {
		return nil, false
	}
	flush()
	return words, true
}

// User reports sudo's target account from the options preceding its command.
func User(command string) string {
	i := 0
	for i < len(command) && (command[i] == ' ' || command[i] == '\t') {
		i++
	}
	if !strings.HasPrefix(command[i:], "sudo") {
		return "root"
	}
	fields, ok := simpleWords(command[i+4:])
	if !ok {
		return "root"
	}
	for i := 0; i < len(fields); i++ {
		f := fields[i]
		if f == "--" || !strings.HasPrefix(f, "-") || f == "-" {
			break
		}
		if strings.HasPrefix(f, "--") {
			name, value, hasValue := strings.Cut(f, "=")
			if name == "--user" {
				if hasValue && value != "" {
					return value
				}
				if i+1 < len(fields) {
					return fields[i+1]
				}
				return "root"
			}
			switch name {
			case "--group", "--host", "--prompt", "--chdir", "--chroot", "--role", "--type", "--close-from", "--command-timeout", "--auth-type":
				if !hasValue {
					i++
				}
			}
			continue
		}
		for k := 1; k < len(f); k++ {
			if f[k] == 'u' {
				if k+1 < len(f) {
					return f[k+1:]
				}
				if i+1 < len(fields) {
					return fields[i+1]
				}
				return "root"
			}
			if strings.ContainsRune("ghpCDRrtTa", rune(f[k])) {
				if k+1 == len(f) {
					i++
				}
				break
			}
		}
	}
	return "root"
}

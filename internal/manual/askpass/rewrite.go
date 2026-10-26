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
	// Shell composition and expansion are outside the supported simple command.
	if strings.ContainsAny(rest, ";|&<>$`\n\r\\\"'") {
		return "", false
	}
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return "", false
	}
	command := false
	for j := 0; j < len(fields); j++ {
		f := fields[j]
		if command {
			break
		}
		if f == "--" {
			command = true
			continue
		}
		if !strings.HasPrefix(f, "-") || f == "-" {
			command = true
			break
		}
		if strings.HasPrefix(f, "--") {
			switch f {
			case "--askpass", "--stdin", "--non-interactive":
				return "", false
			}
			if f == "--user" || f == "--group" || f == "--host" || f == "--prompt" || f == "--chdir" || f == "--role" || f == "--type" {
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
			if strings.ContainsRune("ughpCRT", rune(f[k])) {
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

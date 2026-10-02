package activity

// The shell rules: a command line split into its simple commands (quote
// aware, a heredoc's body with its command), each one's prefixes (cd, VAR=,
// env, time, timeout, sudo…) and runners (uv run, pnpm exec, npx…) taken off,
// placed by its head and arguments, the strongest kind of the line winning.

import (
	"path"
	"regexp"
	"strings"
)

// segment is one simple command of a command line.
type segment struct {
	words []string // its words, quotes removed
	files []string // the files it writes through a redirect (never /dev/…)
	body  string   // its heredocs' bodies
	piped bool     // it reads the output of the command before it (after a |)
}

// splitShell splits a command line on &&, ||, ;, |, &, ( ) and line ends
// outside quotes. Best effort: what it does not understand stays in a word.
func splitShell(s string) []segment {
	sc := &shellScanner{s: s}
	sc.run()
	return sc.segs
}

type heredoc struct {
	delim string
	strip bool // <<-: leading tabs
	seg   int
}

type shellScanner struct {
	s       string
	i       int
	segs    []segment
	cur     int // the segment being read (-1: none yet)
	piped   bool
	pending []heredoc
}

func (sc *shellScanner) seg() *segment {
	if sc.cur < 0 || sc.cur >= len(sc.segs) {
		sc.segs = append(sc.segs, segment{piped: sc.piped})
		sc.cur, sc.piped = len(sc.segs)-1, false
	}
	return &sc.segs[sc.cur]
}

// end closes the segment being read; piped says the next one reads it.
func (sc *shellScanner) end(piped bool) {
	if sc.cur >= 0 && sc.cur < len(sc.segs) && len(sc.segs[sc.cur].words) == 0 && len(sc.segs[sc.cur].files) == 0 &&
		!sc.hasPending(sc.cur) {
		sc.segs = sc.segs[:sc.cur]
	}
	sc.cur = len(sc.segs)
	sc.piped = piped
}

func (sc *shellScanner) hasPending(i int) bool {
	for _, h := range sc.pending {
		if h.seg == i {
			return true
		}
	}
	return false
}

func (sc *shellScanner) run() {
	sc.cur = -1
	s := sc.s
	for sc.i < len(s) {
		c := s[sc.i]
		switch {
		case c == ' ' || c == '\t' || c == '\r':
			sc.i++
		case c == '\\' && sc.i+1 < len(s) && s[sc.i+1] == '\n':
			sc.i += 2
		case c == '\n':
			sc.i++
			sc.end(false)
			sc.bodies()
		case c == '#':
			for sc.i < len(s) && s[sc.i] != '\n' {
				sc.i++
			}
		case c == ';':
			sc.i++
			sc.end(false)
		case c == '&':
			switch {
			case strings.HasPrefix(s[sc.i:], "&&"):
				sc.i += 2
				sc.end(false)
			case strings.HasPrefix(s[sc.i:], "&>"):
				sc.i += 2
				if sc.i < len(s) && s[sc.i] == '>' {
					sc.i++
				}
				sc.redirect(false)
			default: // in the background
				sc.i++
				sc.end(false)
			}
		case c == '|':
			switch {
			case strings.HasPrefix(s[sc.i:], "||"):
				sc.i += 2
				sc.end(false)
			case strings.HasPrefix(s[sc.i:], "|&"):
				sc.i += 2
				sc.end(true)
			default:
				sc.i++
				sc.end(true)
			}
		case c == '(' || c == ')' || c == '{' && sc.wordStart() || c == '}' && sc.wordStart():
			sc.i++
			sc.end(false)
		case c == '>':
			sc.i++
			dup := false
			switch {
			case sc.i < len(s) && (s[sc.i] == '>' || s[sc.i] == '|'):
				sc.i++
			case sc.i < len(s) && s[sc.i] == '&':
				sc.i++
				dup = true
			}
			sc.redirect(dup)
		case c == '<':
			switch {
			case strings.HasPrefix(s[sc.i:], "<<<"):
				sc.i += 3
				sc.word()
			case strings.HasPrefix(s[sc.i:], "<<"):
				sc.i += 2
				strip := false
				if sc.i < len(s) && s[sc.i] == '-' {
					strip = true
					sc.i++
				}
				d := sc.word()
				sc.seg()
				sc.pending = append(sc.pending, heredoc{delim: d, strip: strip, seg: sc.cur})
			case strings.HasPrefix(s[sc.i:], "<("):
				j := matchParen(s, sc.i+1)
				sc.seg().words = append(sc.seg().words, s[sc.i:j])
				sc.i = j
			default:
				sc.i++
				sc.word()
			}
		default:
			w, fd := sc.word(), false
			if sc.i < len(s) && s[sc.i] == '>' && isDigits(w) {
				fd = true // 2>file: the fd is no word
			}
			if !fd {
				g := sc.seg()
				g.words = append(g.words, w)
			}
		}
	}
	sc.end(false)
}

// wordStart reports whether the scanner is between words (a { or } there
// groups commands).
func (sc *shellScanner) wordStart() bool {
	if sc.i+1 < len(sc.s) {
		n := sc.s[sc.i+1]
		return n == ' ' || n == '\t' || n == '\n' || n == ';'
	}
	return true
}

// redirect reads a redirect's target: a file the segment writes, unless it
// is a device or (dup) an fd.
func (sc *shellScanner) redirect(dup bool) {
	t := sc.word()
	if t == "" || (dup && (isDigits(t) || t == "-")) || strings.HasPrefix(t, "/dev/") {
		return
	}
	g := sc.seg()
	g.files = append(g.files, t)
}

// bodies reads the bodies of the heredocs started on the line just ended.
func (sc *shellScanner) bodies() {
	for len(sc.pending) > 0 {
		h := sc.pending[0]
		sc.pending = sc.pending[1:]
		var body strings.Builder
		for sc.i < len(sc.s) {
			j := strings.IndexByte(sc.s[sc.i:], '\n')
			line := sc.s[sc.i:]
			next := len(sc.s)
			if j >= 0 {
				line, next = sc.s[sc.i:sc.i+j], sc.i+j+1
			}
			sc.i = next
			l := strings.TrimRight(line, "\r")
			if h.strip {
				l = strings.TrimLeft(l, "\t")
			}
			if l == h.delim {
				break
			}
			body.WriteString(line)
			body.WriteByte('\n')
		}
		if h.seg >= 0 && h.seg < len(sc.segs) {
			sc.segs[h.seg].body += body.String()
		}
	}
}

// word reads one word at the scanner (spaces before it skipped), its quotes
// removed.
func (sc *shellScanner) word() string {
	s := sc.s
	for sc.i < len(s) && (s[sc.i] == ' ' || s[sc.i] == '\t') {
		sc.i++
	}
	var b strings.Builder
	for sc.i < len(s) {
		c := s[sc.i]
		switch c {
		case ' ', '\t', '\n', '\r', ';', '&', '|', '<', '>', '(', ')':
			return b.String()
		case '\\':
			if sc.i+1 < len(s) {
				if s[sc.i+1] != '\n' {
					b.WriteByte(s[sc.i+1])
				}
				sc.i += 2
				continue
			}
			sc.i++
		case '\'':
			j := strings.IndexByte(s[sc.i+1:], '\'')
			if j < 0 {
				b.WriteString(s[sc.i+1:])
				sc.i = len(s)
				continue
			}
			b.WriteString(s[sc.i+1 : sc.i+1+j])
			sc.i += j + 2
		case '"':
			sc.i++
			for sc.i < len(s) && s[sc.i] != '"' {
				if s[sc.i] == '\\' && sc.i+1 < len(s) && strings.IndexByte("\"\\$`\n", s[sc.i+1]) >= 0 {
					b.WriteByte(s[sc.i+1])
					sc.i += 2
					continue
				}
				b.WriteByte(s[sc.i])
				sc.i++
			}
			sc.i++
		case '$':
			if sc.i+1 < len(s) && s[sc.i+1] == '(' {
				j := matchParen(s, sc.i+1)
				b.WriteString(s[sc.i:j])
				sc.i = j
				continue
			}
			b.WriteByte(c)
			sc.i++
		case '`':
			j := strings.IndexByte(s[sc.i+1:], '`')
			if j < 0 {
				b.WriteString(s[sc.i:])
				sc.i = len(s)
				continue
			}
			b.WriteString(s[sc.i : sc.i+j+2])
			sc.i += j + 2
		default:
			b.WriteByte(c)
			sc.i++
		}
	}
	return b.String()
}

// matchParen is the index after the ) closing the ( at s[i], quotes skipped
// (len(s) if it never closes).
func matchParen(s string, i int) int {
	depth := 0
	for j := i; j < len(s); j++ {
		switch s[j] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return j + 1
			}
		case '\'':
			if k := strings.IndexByte(s[j+1:], '\''); k >= 0 {
				j += k + 1
			}
		case '"':
			for j++; j < len(s) && s[j] != '"'; j++ {
				if s[j] == '\\' {
					j++
				}
			}
		}
	}
	return len(s)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------------------------------------------
// The rules

// strength orders the kinds a shell line can get: the strongest of its
// commands wins.
var strength = map[Kind]int{KindTesting: 6, KindBuilding: 5, KindShipping: 4, KindWriting: 3, KindInvestigating: 2,
	KindWaiting: 1}

// strong kinds win over a command the rules cannot place; weak ones lose to
// it (`python3 x.py | tail` is not investigating).
func strong(k Kind) bool { return strength[k] >= strength[KindWriting] }

// shellResult is what the rules make of a command line.
type shellResult struct {
	kind   Kind
	detail string
	ok     bool
}

// segResult is what the rules make of one simple command.
type segResult struct {
	kind    Kind
	detail  string
	neutral bool // says nothing (cd, export, echo…)
	unknown bool // the rules cannot place it
	loop    int  // +1: a loop starts (while, until, for); -1: one ends (done)
	poll    bool // a loop's condition or a sleep: polling
}

var (
	assignRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	// testLogRe is what a polling loop that waits on tests mentions.
	testLogRe = regexp.MustCompile(`(?i)\b(passed|failed|pytest|e2e|playwright|vitest|jest|go test|test results?|tests?\.log)\b`)
)

// classifyShell places a command line.
func classifyShell(cmd string) shellResult { return classifyShellDepth(cmd, 0) }

func classifyShellDepth(cmd string, depth int) shellResult {
	segs := splitShell(cmd)
	var rs []segResult
	looping, polling := 0, false
	for _, sg := range segs {
		r := classifySeg(sg, depth)
		if r.loop > 0 {
			looping++
		}
		if looping > 0 && (r.poll || r.kind == KindWaiting) {
			polling = true
		}
		if r.loop < 0 && looping > 0 {
			looping--
		}
		rs = append(rs, r)
	}
	var best *segResult
	unknown := false
	for i := range rs {
		r := &rs[i]
		switch {
		case r.neutral:
			continue
		case r.unknown:
			unknown = true
			continue
		case polling && r.kind == KindInvestigating: // a polling loop's reads say nothing
			continue
		}
		if best == nil || strength[r.kind] > strength[best.kind] {
			best = r
		}
	}
	switch {
	case polling && (best == nil || !strong(best.kind)):
		if testLogRe.MatchString(cmd) {
			return shellResult{kind: KindTesting, detail: "test log", ok: true}
		}
		return shellResult{kind: KindWaiting, detail: "poll loop", ok: true}
	case best == nil && !unknown:
		return shellResult{} // nothing but neutral commands
	case best == nil || (unknown && !strong(best.kind)):
		return shellResult{kind: KindWorking, detail: firstHead(rs, segs), ok: false}
	}
	return shellResult{kind: best.kind, detail: best.detail, ok: true}
}

// firstHead is the detail of an unplaced line: its first command's head.
func firstHead(rs []segResult, segs []segment) string {
	for i, r := range rs {
		if r.unknown {
			return headDetail(strip(segs[i].words))
		}
	}
	return ""
}

// headDetail is a command's head as a detail: its words, absolute paths as
// basenames, clipped.
func headDetail(words []string) string {
	var out []string
	for _, w := range words {
		if assignRe.MatchString(w) {
			continue
		}
		out = append(out, baseOf(w))
		if len(strings.Join(out, " ")) > MaxDetail*2 {
			break
		}
	}
	return safeDetail(strings.Join(out, " "), MaxDetail)
}

// baseOf is an absolute path's basename (also after a flag's =), else w.
func baseOf(w string) string {
	if strings.HasPrefix(w, "/") || strings.HasPrefix(w, "~/") {
		return path.Base(w)
	}
	if i := strings.Index(w, "=/"); i > 0 && strings.HasPrefix(w, "-") {
		return w[:i+1] + path.Base(w[i+1:])
	}
	return w
}

// neutralHeads say nothing about what the agent does.
var neutralHeads = set("cd", "pushd", "popd", "export", "set", "unset", "source", ".", "echo", "printf", "true", "false",
	":", "exit", "return", "local", "declare", "typeset", "readonly", "shopt", "trap", "ulimit", "umask", "alias", "test",
	"[", "[[", "]]", "read", "shift", "clear", "fi", "esac", "then", "else", "elif", "if", "do", "in", "case",
	"function", "date")

var investigatingHeads = set("cat", "bat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ack",
	"ls", "ll", "la", "exa", "eza", "lsd", "find", "fd", "fdfind", "wc", "jq", "yq", "awk", "gawk", "mawk", "tree", "diff",
	"cmp", "comm", "file", "stat", "du", "df", "nl", "sort", "uniq", "cut", "tr", "column", "xxd", "od", "hexdump",
	"strings", "readlink", "realpath", "basename", "dirname", "pwd", "which", "type", "whereis", "whatis", "man",
	"ps", "pgrep", "pidof", "lsof", "ss", "netstat", "top", "htop", "free", "uptime", "id", "whoami", "hostname",
	"uname", "printenv", "nproc", "lscpu", "curl", "http", "https", "xh", "dig", "nslookup", "ping", "journalctl",
	"sqlite3", "psql", "tac", "rev", "fold", "fmt", "paste", "join", "md5sum", "sha256sum", "sha1sum", "shasum",
	"base64", "zcat", "zgrep", "pdftotext", "identify", "exiftool", "ffprobe", "locale", "getent",
	"groups", "last", "w", "who", "vmstat", "iostat", "dmesg", "lsblk", "blkid", "mount", "findmnt", "ip", "ifconfig",
	"nvidia-smi", "history", "nm", "objdump", "readelf", "ldd")

var writingHeads = set("cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod", "chown", "chgrp", "install",
	"truncate", "patch", "rsync", "dd", "unzip", "gunzip", "gzip", "bunzip2", "xz", "zip", "shred", "mktemp", "rename",
	"goimports", "gofumpt", "black", "isort", "autopep8", "yapf", "sponge", "convert", "magick", "ffmpeg", "pandoc",
	"cwebp", "pngquant", "optipng", "svgo")

var testingHeads = set("pytest", "py.test", "tox", "nox", "vitest", "jest", "mocha", "ava", "tap", "playwright",
	"cypress", "tsc", "vue-tsc", "eslint", "ruff", "mypy", "pyright", "pylint", "flake8", "bandit", "golangci-lint",
	"staticcheck", "govulncheck", "shellcheck", "hadolint", "biome", "stylelint", "rspec", "phpunit", "ctest", "bats",
	"agent-browser", "markdownlint", "actionlint", "yamllint", "checkov", "tflint", "semgrep", "codespell", "typos",
	"knip", "depcheck", "c8", "nyc", "coverage", "pre-commit", "lefthook", "k6", "locust", "hurl", "newman")

var buildingHeads = set("webpack", "esbuild", "rollup", "parcel", "turbo", "nx", "bazel", "bazelisk", "gradle",
	"gradlew", "mvn", "cmake", "ninja", "meson", "scons", "rustc", "gcc", "g++", "clang", "cc", "javac", "swiftc",
	"protoc", "buf", "sqlc", "templ", "air", "nodemon", "serve", "http-server", "live-server", "vite", "next", "nuxt",
	"astro", "remix", "svelte-kit", "wrangler", "hugo", "jekyll", "mkdocs", "sphinx-build", "pip", "pip3", "poetry",
	"pdm", "pipenv", "conda", "mamba", "brew", "apt", "apt-get", "dnf", "yum", "pacman", "corepack", "nvm", "fnm",
	"asdf", "mise", "rustup", "packer", "terraform-init")

var waitingHeads = set("sleep", "wait", "watch", "inotifywait", "entr")

// runners run the command after them (and their own flags).
var runners = map[string][]string{
	"uv": {"run"}, "poetry": {"run"}, "pdm": {"run"}, "pipenv": {"run"}, "hatch": {"run"}, "pnpm": {"exec", "dlx"},
	"yarn": {"dlx", "exec"}, "bun": {"x"}, "npm": {"exec"}, "pipx": {"run"}, "conda": {"run"}, "rye": {"run"},
	"mise": {"exec", "x"}, "asdf": {"exec"}, "direnv": {"exec"},
}

// singleRunners run the command after their flags.
var singleRunners = set("npx", "bunx", "uvx", "pnpx", "env", "time", "nice", "ionice", "nohup", "sudo", "doas",
	"command", "builtin", "exec", "stdbuf", "chrt", "taskset", "caffeinate", "unbuffer", "xargs", "chronic",
	"dumb-init", "tini")

// valueFlags take a value after them (so it is not the command).
var valueFlags = set("-n", "-u", "-g", "-C", "-c", "-f", "-s", "-k", "-p", "-I", "-P", "-d", "-L", "-E", "-w",
	"--with", "--directory", "--project", "--python", "--package", "--from", "--signal", "--kill-after", "--prefix",
	"--dir", "--filter", "--cwd", "--name", "--env-file", "--unit", "--user-unit", "--group", "--uid", "--gid",
	"--chdir", "--workdir", "--preload", "--index-url", "--extra-index-url", "--env", "-e", "--session", "--worktree",
	"--project-dir", "--port", "--host", "--config")

// strip takes a command's prefixes, wrappers and runners off: what is left
// starts with the command that runs.
func strip(words []string) []string {
	for len(words) > 0 {
		w := words[0]
		head := path.Base(w)
		switch {
		case assignRe.MatchString(w):
			words = words[1:]
		case head == "!" || head == "then" || head == "do" || head == "else" || head == "elif" || head == "if" ||
			head == "{" || head == "time":
			words = words[1:]
		case head == "timeout" || head == "gtimeout":
			words = skipFlags(words[1:])
			if len(words) > 0 && durationLike(words[0]) {
				words = words[1:]
			}
		case head == "portlease":
			return words // its own rule (dev servers)
		case head == "flock": // flock [flags] <lockfile> <cmd…>
			words = skipFlags(words[1:])
			if len(words) > 0 {
				words = words[1:]
			}
		case singleRunners[head]:
			words = skipFlags(words[1:])
		case runners[head] != nil && len(words) > 1 && contains(runners[head], words[1]):
			words = skipFlags(words[2:])
		case (head == "python" || head == "python3" || strings.HasPrefix(head, "python3.")) && len(words) > 2 &&
			words[1] == "-m" && pyModules[words[2]]:
			words = words[2:]
		default:
			return words
		}
	}
	return words
}

// pyModules run as a command with python -m.
var pyModules = set("pytest", "unittest", "mypy", "ruff", "black", "isort", "flake8", "pylint", "pip", "coverage",
	"tox", "nox", "build", "twine", "http.server", "uvicorn", "pyright", "bandit", "doctest", "compileall")

func skipFlags(words []string) []string {
	for len(words) > 0 {
		w := words[0]
		switch {
		case w == "--":
			return words[1:]
		case assignRe.MatchString(w):
			words = words[1:]
		case strings.HasPrefix(w, "-") && len(w) > 1:
			if valueFlags[w] && len(words) > 1 {
				words = words[2:]
			} else {
				words = words[1:]
			}
		default:
			return words
		}
	}
	return words
}

func durationLike(s string) bool {
	s = strings.TrimRight(s, "smhd")
	return isDigits(strings.ReplaceAll(s, ".", ""))
}

// classifySeg places one simple command.
func classifySeg(sg segment, depth int) segResult {
	words := sg.words
	if len(words) == 0 {
		if len(sg.files) > 0 {
			return segResult{kind: KindWriting, detail: safeDetail("> "+path.Base(sg.files[0]), MaxDetail)}
		}
		return segResult{neutral: true}
	}
	switch path.Base(words[0]) {
	case "while", "until":
		r := segResult{loop: 1}
		inner := classifySeg(segment{words: words[1:], body: sg.body, files: sg.files}, depth)
		r.kind, r.detail, r.neutral, r.unknown = inner.kind, inner.detail, inner.neutral, inner.unknown
		return r
	case "for", "select":
		return segResult{loop: 1, neutral: true}
	case "done":
		return segResult{loop: -1, neutral: true}
	}
	words = strip(words)
	if len(words) == 0 {
		return segResult{neutral: true}
	}
	r := placeCommand(words, sg, depth)
	if len(sg.files) > 0 && strength[r.kind] < strength[KindWriting] {
		// A redirect into a file: the command writes it.
		return segResult{kind: KindWriting, detail: safeDetail(path.Base(words[0])+" > "+path.Base(sg.files[0]), MaxDetail)}
	}
	if sg.piped && !r.unknown && (r.kind == KindInvestigating || r.neutral) {
		return segResult{neutral: true} // a filter on another command's output
	}
	return r
}

// placeCommand places a command by its head and arguments (its prefixes
// taken off).
func placeCommand(words []string, sg segment, depth int) segResult {
	head := path.Base(words[0])
	args := words[1:]
	at := func(k Kind) segResult { return segResult{kind: k, detail: headDetail(words)} }
	switch {
	case head == "git":
		return gitRule(words)
	case head == "gh":
		return ghRule(words)
	case head == "npm" || head == "pnpm" || head == "yarn" || head == "bun":
		return pkgRule(words)
	case head == "make" || head == "gmake" || head == "just" || head == "task" || head == "mage":
		return makeRule(words)
	case head == "go":
		return goRule(words)
	case head == "cargo":
		return cargoRule(words)
	case head == "docker" || head == "podman" || head == "nerdctl":
		return dockerRule(words)
	case head == "kubectl" || head == "helm" || head == "k9s":
		if len(args) > 0 && contains([]string{"get", "describe", "logs", "top", "explain", "version", "status", "list", "history", "show", "template"}, args[0]) {
			return at(KindInvestigating)
		}
		return segResult{unknown: true}
	case head == "systemctl":
		if len(args) > 0 && (args[0] == "status" || args[0] == "show" || strings.HasPrefix(args[0], "list") || args[0] == "is-active" || args[0] == "cat") ||
			len(args) > 1 && args[0] == "--user" && (args[1] == "status" || args[1] == "show" || strings.HasPrefix(args[1], "list") || args[1] == "is-active" || args[1] == "cat") {
			return at(KindInvestigating)
		}
		return segResult{unknown: true}
	case head == "portlease":
		return portleaseRule(words, sg, depth)
	case head == "sed":
		if hasFlag(args, "-i") || hasPrefixFlag(args, "-i") || hasFlag(args, "--in-place") || hasPrefixFlag(args, "--in-place") {
			return at(KindWriting)
		}
		return at(KindInvestigating)
	case head == "perl":
		if hasPrefixFlag(args, "-pi") || hasPrefixFlag(args, "-i") || hasPrefixFlag(args, "-ni") {
			return at(KindWriting)
		}
		if hasFlag(args, "-e") || hasFlag(args, "-ne") || hasFlag(args, "-E") {
			return inlineRule(head, args, sg)
		}
		return segResult{unknown: true}
	case head == "awk" || head == "gawk":
		if hasFlag(args, "-i") && contains(args, "inplace") {
			return at(KindWriting)
		}
		return at(KindInvestigating)
	case head == "tee":
		for _, a := range args {
			if !strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "/dev/") {
				return segResult{kind: KindWriting, detail: safeDetail("tee "+path.Base(a), MaxDetail)}
			}
		}
		return segResult{neutral: true}
	case head == "tail" && (hasFlag(args, "-f") || hasFlag(args, "-F") || hasFlag(args, "--follow")):
		return at(KindWaiting)
	case head == "find":
		if contains(args, "-delete") {
			return at(KindWriting)
		}
		for i, a := range args {
			if (a == "-exec" || a == "-execdir" || a == "-ok") && i+1 < len(args) {
				inner := placeCommand(args[i+1:], segment{}, depth)
				if strength[inner.kind] > strength[KindInvestigating] {
					return segResult{kind: inner.kind, detail: headDetail(words)}
				}
			}
		}
		return at(KindInvestigating)
	case head == "tar":
		if len(args) > 0 && (strings.Contains(args[0], "t") && !strings.Contains(args[0], "x") && !strings.Contains(args[0], "c") || args[0] == "--list") {
			return at(KindInvestigating)
		}
		return at(KindWriting)
	case head == "prettier" || head == "eslint" || head == "ruff" || head == "gofmt" || head == "rustfmt" || head == "clang-format" || head == "dprint":
		return formatterRule(head, words)
	case head == "bash" || head == "sh" || head == "zsh" || head == "dash" || head == "fish" || head == "ksh":
		for i, a := range args {
			if (a == "-c" || a == "-lc" || a == "-ic" || a == "-ec" || a == "-xc" || a == "-euc" || a == "-eux" || strings.HasPrefix(a, "-") && strings.HasSuffix(a, "c")) && i+1 < len(args) && depth < 3 {
				res := classifyShellDepth(args[i+1], depth+1)
				return fromShell(res)
			}
		}
		if len(args) == 0 && sg.body != "" && depth < 3 {
			return fromShell(classifyShellDepth(sg.body, depth+1))
		}
		return segResult{unknown: true}
	case head == "eval" && len(args) > 0 && depth < 3:
		return fromShell(classifyShellDepth(strings.Join(args, " "), depth+1))
	case isInterpreter(head):
		return inlineRule(head, args, sg)
	case head == "uv":
		if len(args) > 0 && (args[0] == "sync" || args[0] == "pip" || args[0] == "add" || args[0] == "lock" || args[0] == "venv" || args[0] == "build" || args[0] == "tool") {
			return at(KindBuilding)
		}
		return segResult{unknown: true}
	case head == "deno":
		if len(args) > 0 && (args[0] == "test" || args[0] == "lint" || args[0] == "check" || args[0] == "bench") {
			return at(KindTesting)
		}
		if len(args) > 0 && args[0] == "eval" {
			return inlineRule(head, append([]string{"-e"}, args[1:]...), sg)
		}
		if len(args) > 0 && (args[0] == "fmt") {
			return at(KindWriting)
		}
		return segResult{unknown: true}
	case head == "terraform" || head == "tofu":
		if len(args) > 0 && (args[0] == "plan" || args[0] == "validate" || args[0] == "show" || args[0] == "output" || args[0] == "state") {
			return at(KindInvestigating)
		}
		if len(args) > 0 && (args[0] == "init" || args[0] == "fmt") {
			return at(KindBuilding)
		}
		if len(args) > 0 && args[0] == "apply" {
			return at(KindShipping)
		}
		return segResult{unknown: true}
	case head == "pip" || head == "pip3":
		if len(args) > 0 && (args[0] == "show" || args[0] == "list" || args[0] == "freeze") {
			return at(KindInvestigating)
		}
		return at(KindBuilding)
	case head == "wget":
		return at(KindWriting)
	case neutralHeads[head]:
		return segResult{neutral: true}
	case testingHeads[head]:
		return at(KindTesting)
	case buildingHeads[head]:
		if head == "vite" && len(args) > 0 && (args[0] == "test") {
			return at(KindTesting)
		}
		return at(KindBuilding)
	case waitingHeads[head]:
		r := at(KindWaiting)
		r.poll = head == "sleep"
		return r
	case writingHeads[head]:
		return at(KindWriting)
	case investigatingHeads[head]:
		return at(KindInvestigating)
	case strings.HasSuffix(head, "-test") || strings.HasSuffix(head, "_test") || head == "test.sh" || strings.HasPrefix(head, "test_") ||
		strings.HasPrefix(head, "run_tests") || strings.HasPrefix(head, "run-tests"):
		return at(KindTesting)
	}
	return segResult{unknown: true, detail: headDetail(words)}
}

func fromShell(r shellResult) segResult {
	switch {
	case r.kind == "":
		return segResult{neutral: true}
	case !r.ok:
		return segResult{unknown: true, detail: r.detail}
	}
	return segResult{kind: r.kind, detail: r.detail}
}

// gitRule places git by its subcommand (its global flags skipped).
func gitRule(words []string) segResult {
	args := words[1:]
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		if (args[0] == "-C" || args[0] == "-c" || args[0] == "--git-dir" || args[0] == "--work-tree" || args[0] == "--namespace") && len(args) > 1 {
			args = args[2:]
			continue
		}
		args = args[1:]
	}
	if len(args) == 0 {
		return segResult{neutral: true}
	}
	sub := args[0]
	k := KindInvestigating
	switch sub {
	case "commit", "push", "merge", "rebase", "tag", "cherry-pick", "revert", "am", "format-patch", "send-email":
		k = KindShipping
		if sub == "tag" && (len(args) == 1 || hasFlag(args, "-l") || hasFlag(args, "--list")) {
			k = KindInvestigating
		}
	case "add", "checkout", "restore", "apply", "switch", "mv", "rm", "reset", "clean", "stash", "init", "clone",
		"worktree", "submodule", "sparse-checkout", "update-index", "lfs", "notes", "commit-tree", "read-tree":
		k = KindWriting
		switch {
		case sub == "stash" && len(args) > 1 && (args[1] == "list" || args[1] == "show"):
			k = KindInvestigating
		case sub == "worktree" && len(args) > 1 && args[1] == "list":
			k = KindInvestigating
		case sub == "submodule" && (len(args) == 1 || args[1] == "status"):
			k = KindInvestigating
		}
	case "branch":
		if hasFlag(args, "-d") || hasFlag(args, "-D") || hasFlag(args, "-m") || hasFlag(args, "-M") ||
			(len(args) > 1 && !strings.HasPrefix(args[1], "-")) {
			k = KindWriting
		}
	case "config":
		if !hasFlag(args, "--get") && !hasFlag(args, "--list") && !hasFlag(args, "-l") && len(args) > 2 {
			k = KindWriting
		}
	case "bisect":
		k = KindTesting
	}
	// A read shows its arguments; a write or a commit only its subcommand
	// (never a message).
	d := "git " + sub
	if k == KindInvestigating {
		d = safeDetail("git "+strings.Join(detailArgs(args), " "), MaxDetail)
	}
	return segResult{kind: k, detail: d}
}

// ghRule places gh by its noun and verb.
func ghRule(words []string) segResult {
	args := skipGHFlags(words[1:])
	if len(args) == 0 {
		return segResult{neutral: true}
	}
	d := safeDetail("gh "+strings.Join(args[:min(2, len(args))], " "), MaxDetail)
	noun := args[0]
	verb := ""
	if len(args) > 1 {
		verb = args[1]
	}
	switch noun {
	case "api":
		for i, a := range args {
			switch {
			case (a == "-X" || a == "--method") && i+1 < len(args) && !strings.EqualFold(args[i+1], "GET"):
				return segResult{kind: KindShipping, detail: d}
			case strings.HasPrefix(a, "--method=") && !strings.EqualFold(strings.TrimPrefix(a, "--method="), "GET"),
				strings.HasPrefix(a, "-X") && len(a) > 2 && !strings.EqualFold(a[2:], "GET"):
				return segResult{kind: KindShipping, detail: d}
			case a == "-f" || a == "-F" || a == "--field" || a == "--raw-field" || a == "--input":
				if !contains(args, "graphql") || hasGraphQLMutation(args) {
					return segResult{kind: KindShipping, detail: d}
				}
			}
		}
		return segResult{kind: KindInvestigating, detail: d}
	case "search", "browse", "status", "auth", "help", "version":
		return segResult{kind: KindInvestigating, detail: d}
	}
	switch verb {
	case "view", "list", "status", "diff", "checks", "search", "item-list", "field-list", "ls", "show", "download":
		return segResult{kind: KindInvestigating, detail: d}
	case "watch":
		return segResult{kind: KindWaiting, detail: d}
	case "checkout", "clone", "fork", "sync":
		return segResult{kind: KindWriting, detail: d}
	case "create", "merge", "comment", "edit", "close", "reopen", "review", "ready", "item-edit", "item-add",
		"item-create", "item-archive", "delete", "upload", "rerun", "cancel", "run", "develop", "transfer", "lock",
		"unlock", "pin", "unpin", "set", "add", "remove", "archive":
		return segResult{kind: KindShipping, detail: d}
	}
	return segResult{unknown: true, detail: d}
}

func skipGHFlags(args []string) []string {
	var out []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "-R" || a == "--repo" || a == "--hostname" {
			i++
			continue
		}
		out = append(out, a)
	}
	return out
}

func hasGraphQLMutation(args []string) bool {
	for _, a := range args {
		if strings.Contains(a, "mutation") {
			return true
		}
	}
	return false
}

// detailArgs are a command's arguments for its detail: absolute paths as
// basenames, flag values kept.
func detailArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		out = append(out, baseOf(a))
	}
	return out
}

// testScript is a package script or make target that checks.
var testScript = regexp.MustCompile(`(?i)(^|[:_-])(test|tests|e2e|spec|check|checks|lint|typecheck|types|tsc|verify|vet|vitest|playwright|jest|cypress|shot|ci|coverage|fixtures:check)([:_-]|$)`)

// buildScript is one that builds or serves.
var buildScript = regexp.MustCompile(`(?i)(^|[:_-])(build|dev|start|serve|preview|watch|compile|bundle|install|generate|gen|codegen|run)([:_-]|$)`)

// pkgRule places npm, pnpm, yarn and bun by their subcommand or script.
func pkgRule(words []string) segResult {
	args := words[1:]
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if (a == "-C" || a == "--dir" || a == "--prefix" || a == "--filter" || a == "-F" || a == "--cwd" || a == "-w" || a == "--workspace") && i+1 < len(args) {
			i++
			continue
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		rest = append(rest, args[i:]...)
		break
	}
	at := func(k Kind) segResult {
		return segResult{kind: k, detail: headDetail(append([]string{words[0]}, rest...))}
	}
	if len(rest) == 0 {
		return segResult{unknown: true}
	}
	sub := rest[0]
	switch sub {
	case "test", "t", "tst", "vitest", "jest", "playwright", "lint", "tsc", "typecheck", "e2e", "check":
		return at(KindTesting)
	case "install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "dedupe", "rebuild",
		"link", "unlink", "prune", "fetch", "build", "dev", "start", "serve", "preview", "create", "init", "setup":
		return at(KindBuilding)
	case "publish", "pack", "version", "release":
		return at(KindShipping)
	case "ls", "list", "view", "info", "why", "outdated", "audit", "whoami", "config", "root", "bin", "help", "-v", "--version", "show", "licenses":
		return at(KindInvestigating)
	case "run", "run-script":
		if len(rest) < 2 {
			return at(KindInvestigating)
		}
		sub = rest[1]
	case "exec", "dlx", "x":
		return segResult{unknown: true}
	}
	switch {
	case testScript.MatchString(sub):
		return at(KindTesting)
	case buildScript.MatchString(sub):
		return at(KindBuilding)
	case strings.Contains(sub, "fmt") || strings.Contains(sub, "format"):
		return at(KindWriting)
	}
	return segResult{unknown: true, detail: headDetail(append([]string{words[0]}, rest...))}
}

// makeRule places make (and just, task) by its targets: a check is testing,
// anything else (a dev server too) building.
func makeRule(words []string) segResult {
	var targets []string
	args := words[1:]
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case (a == "-C" || a == "-f" || a == "-j" || a == "-l" || a == "--directory" || a == "--file" || a == "-I") && i+1 < len(args):
			i++
		case strings.HasPrefix(a, "-") || assignRe.MatchString(a):
		default:
			targets = append(targets, a)
		}
	}
	d := headDetail(append([]string{path.Base(words[0])}, targets...))
	for _, t := range targets {
		if testScript.MatchString(t) {
			return segResult{kind: KindTesting, detail: d}
		}
	}
	for _, t := range targets {
		if t == "fmt" || t == "format" || t == "tidy" {
			return segResult{kind: KindWriting, detail: d}
		}
		if t == "release" || t == "publish" || t == "deploy" || t == "ship" {
			return segResult{kind: KindShipping, detail: d}
		}
	}
	return segResult{kind: KindBuilding, detail: d}
}

func goRule(words []string) segResult {
	args := words[1:]
	at := func(k Kind) segResult { return segResult{kind: k, detail: headDetail(words)} }
	if len(args) == 0 {
		return segResult{unknown: true}
	}
	switch args[0] {
	case "test", "vet":
		return at(KindTesting)
	case "build", "install", "run", "generate", "get", "mod", "work", "clean":
		if args[0] == "mod" && len(args) > 1 && (args[1] == "graph" || args[1] == "why" || args[1] == "verify") {
			return at(KindInvestigating)
		}
		return at(KindBuilding)
	case "fmt", "fix":
		return at(KindWriting)
	case "list", "doc", "env", "version", "help", "tool":
		if args[0] == "tool" && len(args) > 1 && (args[1] == "cover" || args[1] == "pprof" || args[1] == "nm" || args[1] == "objdump") {
			return at(KindInvestigating)
		}
		return at(KindInvestigating)
	}
	return segResult{unknown: true}
}

func cargoRule(words []string) segResult {
	args := skipFlags(words[1:])
	at := func(k Kind) segResult { return segResult{kind: k, detail: headDetail(words)} }
	if len(args) == 0 {
		return segResult{unknown: true}
	}
	switch args[0] {
	case "test", "nextest", "clippy", "check", "bench", "miri", "audit", "deny":
		return at(KindTesting)
	case "build", "run", "install", "update", "add", "remove", "fetch", "doc", "clean", "b", "r":
		return at(KindBuilding)
	case "fmt":
		if hasFlag(args, "--check") {
			return at(KindTesting)
		}
		return at(KindWriting)
	case "publish", "release":
		return at(KindShipping)
	case "tree", "metadata", "search", "version":
		return at(KindInvestigating)
	}
	return segResult{unknown: true}
}

func dockerRule(words []string) segResult {
	args := skipFlags(words[1:])
	at := func(k Kind) segResult { return segResult{kind: k, detail: headDetail(words)} }
	if len(args) == 0 {
		return segResult{unknown: true}
	}
	switch args[0] {
	case "build", "buildx", "run", "compose", "create", "start", "pull", "up":
		if args[0] == "compose" && len(args) > 1 && (args[1] == "ps" || args[1] == "logs" || args[1] == "config" || args[1] == "ls") {
			return at(KindInvestigating)
		}
		return at(KindBuilding)
	case "push", "tag":
		return at(KindShipping)
	case "ps", "logs", "inspect", "images", "image", "stats", "top", "info", "version", "history", "diff", "events", "port", "volume", "network", "context":
		return at(KindInvestigating)
	case "rm", "rmi", "stop", "kill", "prune", "system":
		return at(KindWriting)
	case "exec":
		return segResult{unknown: true}
	}
	return segResult{unknown: true}
}

// portleaseRule: `portlease run … -- <cmd>` runs a dev server (building),
// whatever it is; its other subcommands read.
func portleaseRule(words []string, sg segment, depth int) segResult {
	args := words[1:]
	if len(args) == 0 || args[0] != "run" {
		return segResult{kind: KindInvestigating, detail: headDetail(words)}
	}
	inner := args[1:]
	for i, a := range inner {
		if a == "--" {
			inner = inner[i+1:]
			break
		}
	}
	if len(inner) > 0 && inner[0] != "run" {
		r := placeCommand(strip(inner), sg, depth)
		if r.kind == KindTesting || r.kind == KindBuilding {
			return r
		}
		return segResult{kind: KindBuilding, detail: headDetail(strip(inner))}
	}
	return segResult{kind: KindBuilding, detail: "portlease run"}
}

// formatterRule: a formatter or linter checks (testing) unless it rewrites
// files (writing).
func formatterRule(head string, words []string) segResult {
	args := words[1:]
	at := func(k Kind) segResult { return segResult{kind: k, detail: headDetail(words)} }
	switch head {
	case "prettier", "dprint":
		if hasFlag(args, "--write") || hasFlag(args, "-w") || (head == "dprint" && contains(args, "fmt")) {
			return at(KindWriting)
		}
	case "eslint":
		if hasFlag(args, "--fix") {
			return at(KindWriting)
		}
	case "ruff":
		if (contains(args, "format") && !hasFlag(args, "--check")) || hasFlag(args, "--fix") {
			return at(KindWriting)
		}
	case "gofmt", "rustfmt", "clang-format":
		if hasFlag(args, "-w") || hasFlag(args, "-i") || (head == "rustfmt" && !hasFlag(args, "--check")) {
			return at(KindWriting)
		}
	}
	return at(KindTesting)
}

func isInterpreter(head string) bool {
	switch head {
	case "python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "ruby", "irb", "php", "lua", "Rscript":
		return true
	}
	return strings.HasPrefix(head, "python3.")
}

// writesRe is what an inline script does to write a file.
var writesRe = regexp.MustCompile(`open\([^)]*['"](?:[wax]b?\+?|r\+b?)['"]|\.write_(?:text|bytes)\(|\.write\(|\bjson\.dump\(|` +
	`\bfs\.(?:promises\.)?(?:writeFile|appendFile|rm|rmdir|unlink|rename|mkdir|copyFile|cp)(?:Sync)?\(|` +
	`\b(?:writeFileSync|appendFileSync|unlinkSync|mkdirSync|renameSync|rmSync)\(|\bshutil\.|` +
	`\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|truncate)\(|\.(?:unlink|mkdir|rename|touch|rmdir)\(|` +
	`\bFile\.write|\bIO\.write\(|\bfile_put_contents\(`)

// stdWriteRe is printing, not writing a file.
var stdWriteRe = regexp.MustCompile(`\b(?:sys|process)\.std(?:out|err)\.write\(`)

// inlineRule places an interpreter: an inline script (python3 - <<'PY',
// python -c, node -e, node --input-type=module <<) by its body; a script
// file, or a REPL, is the model's.
func inlineRule(head string, args []string, sg segment) segResult {
	body, inline := "", false
	for i, a := range args {
		if (a == "-c" || a == "-e" || a == "-p" || a == "--eval" || a == "--print" || a == "-r" || a == "-ne" || a == "-E") && i+1 < len(args) {
			body, inline = args[i+1], true
			break
		}
		if a == "-" || strings.HasPrefix(a, "--input-type") {
			inline = true
			break
		}
		if !strings.HasPrefix(a, "-") {
			return segResult{unknown: true, detail: headDetail(append([]string{head}, args[i:]...))}
		}
	}
	if sg.body != "" {
		body, inline = body+"\n"+sg.body, true
	}
	if !inline {
		return segResult{unknown: true, detail: head}
	}
	if writesRe.MatchString(stdWriteRe.ReplaceAllString(body, "")) {
		return segResult{kind: KindWriting, detail: head + " inline script"}
	}
	return segResult{kind: KindInvestigating, detail: head + " inline script"}
}

func hasFlag(args []string, f string) bool { return contains(args, f) }

// hasPrefixFlag reports a flag given with its value stuck on (-i.bak, -pi).
func hasPrefixFlag(args []string, f string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, f) && !strings.HasPrefix(a, "--") == !strings.HasPrefix(f, "--") {
			return true
		}
	}
	return false
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func set(ss ...string) map[string]bool {
	m := make(map[string]bool, len(ss))
	for _, s := range ss {
		m[s] = true
	}
	return m
}

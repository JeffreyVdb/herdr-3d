package activity

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

// bash is a Claude Bash input.
func bash(cmd string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"command": cmd, "description": "x"})
	return b
}

// execCmd is a Codex direct exec_command's arguments.
func execCmd(cmd string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"cmd": cmd, "workdir": "/home/u/w", "yield_time_ms": 10000})
	return b
}

// script is a Codex code-mode exec's input (a JSON string).
func script(s string) json.RawMessage {
	b, _ := json.Marshal(s)
	return b
}

func TestClassifyRealToolCalls(t *testing.T) {
	cases := []struct {
		name          string
		harness, tool string
		input         json.RawMessage
		kind          Kind
		detail        string // "" not checked; "-" must be empty
		ok            bool
	}{
		// The ticket's examples.
		{"sed -n reads", Claude, "Bash", bash("sed -n 700,800p internal/transcript/codex.go"), KindInvestigating, "sed -n 700,800p internal/transc…", true},
		{"sed -n reads a .py", Claude, "Bash", bash("sed -n 700,800p x.py"), KindInvestigating, "sed -n 700,800p x.py", true},
		{"pytest -n auto", Claude, "Bash", bash("pytest -n auto"), KindTesting, "pytest -n auto", true},
		{"cd, uv run pytest, tail", Claude, "Bash", bash("cd backend && uv run pytest -q | tail -20"), KindTesting, "pytest -q", true},
		{"cat heredoc into a file", Claude, "Bash", bash("cat > /tmp/notes.md <<'EOF'\n# Notes\nrm -rf / is not run\nEOF"), KindWriting, "cat > notes.md", true},
		{"git commit", Claude, "Bash", bash("git add -A && git commit -m \"$(cat <<'EOF'\nfeat(bridge): activity (#98)\nEOF\n)\""), KindShipping, "git commit", true},
		{"git commit -m", Claude, "Bash", bash(`git commit -m "fix: the thing"`), KindShipping, "git commit", true},
		{"agent-browser screenshot", Claude, "Bash", bash("agent-browser --session ux-r1 screenshot /tmp/shot.png"), KindTesting, "", true},
		{"portlease dev server", Claude, "Bash", bash("portlease run --project herdr-3d --worktree $PWD --name preview -- npm run dev"), KindBuilding, "npm run dev", true},
		{"npm run dev", Claude, "Bash", bash("npm run dev"), KindBuilding, "npm run dev", true},
		{"make dev", Claude, "Bash", bash("make dev"), KindBuilding, "make dev", true},
		{"go run", Claude, "Bash", bash("go run ./cmd/herdr-world serve"), KindBuilding, "", true},
		{"vite dev", Claude, "Bash", bash("cd game && pnpm exec vite --host 127.0.0.1"), KindBuilding, "", true},
		{"python inline read", Claude, "Bash", bash("python3 - <<'PY'\nimport json\nd = json.load(open('report.json'))\nprint(d['summary'])\nPY"), KindInvestigating, "python3 inline script", true},
		{"python inline write", Claude, "Bash", bash("python3 - <<'EOF'\np='docs/decisions.md'\ns=open(p).read()\nopen(p,'w').write(s+'x')\nEOF"), KindWriting, "python3 inline script", true},
		{"python -c read", Claude, "Bash", bash(`python3 -c "import sys,json; print(json.load(sys.stdin)['x'])" < out.json`), KindInvestigating, "", true},
		{"python -c write", Claude, "Bash", bash(`python -c "from pathlib import Path; Path('a.txt').write_text('x')"`), KindWriting, "", true},
		{"node -e read", Claude, "Bash", bash(`node -e "console.log(require('./package.json').version)"`), KindInvestigating, "node inline script", true},
		{"node -e write", Claude, "Bash", bash(`node -e "require('fs').writeFileSync('x.json', '{}')"`), KindWriting, "", true},
		{"node module heredoc", Claude, "Bash", bash("node --input-type=module <<'EOF'\nimport fs from 'node:fs';\nconsole.log(fs.readFileSync('a').length)\nEOF"), KindInvestigating, "", true},
		{"sys.stdout.write is not writing", Claude, "Bash", bash(`python3 -c "import sys; sys.stdout.write('hi')"`), KindInvestigating, "", true},
		// Shapes from this machine's transcripts.
		{"gh issue view", Claude, "Bash", bash("gh issue view 98 --repo JeffreyVdb/herdr-3d --comments"), KindInvestigating, "gh issue view", true},
		{"gh pr create", Claude, "Bash", bash(`gh pr create --title "feat: x" --body "$(cat body.md)"`), KindShipping, "gh pr create", true},
		{"gh api read", Claude, "Bash", bash("gh api repos/JeffreyVdb/herdr-3d/pulls/99/comments --jq '.[].body'"), KindInvestigating, "", true},
		{"gh api post", Claude, "Bash", bash("gh api -X POST repos/o/r/issues/1/comments -f body=hi"), KindShipping, "", true},
		{"git status", Claude, "Bash", bash("git status --short && git log --oneline -5"), KindInvestigating, "git status --short", true},
		{"git push", Claude, "Bash", bash("git push -u origin h3d/button-3-61f2e6"), KindShipping, "git push", true},
		{"go test race", Claude, "Bash", bash("go test -race ./internal/activity/ ./internal/server/ 2>&1 | tail -30"), KindTesting, "go test -race ./internal/activi…", true},
		{"make e2e", Claude, "Bash", bash("make e2e H3D_WORKERS=4 2>&1 | tail -40"), KindTesting, "make e2e", true},
		{"make build", Claude, "Bash", bash("make build"), KindBuilding, "make build", true},
		{"pnpm test", Claude, "Bash", bash("pnpm -C game test -- --run src/laptop"), KindTesting, "", true},
		{"pnpm script check", Claude, "Bash", bash("cd game && pnpm fixtures:check"), KindTesting, "", true},
		{"playwright", Claude, "Bash", bash("flock $XDG_RUNTIME_DIR/herdr-3d-e2e.lock pnpm exec playwright test e2e/activity.spec.ts"), KindTesting, "playwright test e2e/activity.sp…", true},
		{"rg", Claude, "Bash", bash(`rg -n "AskTracker" internal/ | head -20`), KindInvestigating, "", true},
		{"ls && cat", Claude, "Bash", bash("ls -la internal/ai && cat internal/ai/jev.go"), KindInvestigating, "", true},
		{"mkdir and cp", Claude, "Bash", bash("mkdir -p out && cp a.txt out/"), KindWriting, "", true},
		{"sed -i", Claude, "Bash", bash("sed -i 's/old/new/' internal/x.go"), KindWriting, "", true},
		{"perl -pi", Claude, "Bash", bash("perl -pi -e 's/a/b/g' x.txt"), KindWriting, "", true},
		{"tee", Claude, "Bash", bash("echo hi | tee out.log"), KindWriting, "tee out.log", true},
		{"tee /dev/null", Claude, "Bash", bash("echo hi | tee /dev/null"), KindWorking, "", true},
		{"redirect into a file", Claude, "Bash", bash("ls > files.txt"), KindWriting, "", true},
		{"stderr to /dev/null is no write", Claude, "Bash", bash("ls missing 2>/dev/null"), KindInvestigating, "", true},
		{"sleep", Claude, "Bash", bash("sleep 30"), KindWaiting, "sleep 30", true},
		{"testing beats building", Claude, "Bash", bash("go build ./... && go test ./..."), KindTesting, "", true},
		{"building beats shipping", Claude, "Bash", bash("make build && git push"), KindBuilding, "", true},
		{"shipping beats writing", Claude, "Bash", bash("git add . && git commit -m x"), KindShipping, "", true},
		{"env prefix", Claude, "Bash", bash("H3D_WORKERS=2 CI=1 timeout 600 make e2e"), KindTesting, "make e2e", true},
		{"sudo nice", Claude, "Bash", bash("sudo -u dev nice -n 10 pytest tests/"), KindTesting, "pytest tests/", true},
		{"bash -lc", Claude, "Bash", bash(`bash -lc "cd x && pnpm run build"`), KindBuilding, "", true},
		{"monitor-style poll loop on a test log", Claude, "Bash", bash(`until grep -qE "[0-9]+ (passed|failed)" /tmp/e2e-full.log; do sleep 20; done; tail -5 /tmp/e2e-full.log`), KindTesting, "test log", true},
		{"poll loop", Claude, "Bash", bash(`while ! curl -s localhost:8080/health; do sleep 1; done`), KindWaiting, "poll loop", true},
		{"read loop is no poll", Claude, "Bash", bash(`cat list | while read f; do wc -l "$f"; done`), KindInvestigating, "", true},
		// The rules leave these to the model.
		{"a script", Claude, "Bash", bash("python3 /home/u/.agents/skills/write-code/scripts/wait_for_results.py /home/u/runs/r1 --timeout 600"), KindWorking, "python3 wait_for_results.py r1…", false},
		{"a script piped to a filter", Claude, "Bash", bash("python3 x.py | tail -5"), KindWorking, "", false},
		{"herdr", Claude, "Bash", bash("herdr agent get code-wrapup-r1"), KindWorking, "herdr agent get code-wrapup-r1", false},
		{"parallel-cli", Claude, "Bash", bash("parallel-cli extract https://example.com/docs"), KindWorking, "", false},
		{"unknown with a strong label", Claude, "Bash", bash("./scripts/gen.sh && git commit -m x"), KindShipping, "", true},
		{"unknown with a weak label", Claude, "Bash", bash("ls && ./scripts/deploy.sh"), KindWorking, "", false},
		// Claude tools by name.
		{"Read", Claude, "Read", json.RawMessage(`{"file_path":"/home/u/w/internal/server/usage.go"}`), KindInvestigating, "usage.go", true},
		{"Read image", Claude, "Read", json.RawMessage(`{"file_path":"/home/u/w/game/test-results/m16-transcript.png"}`), KindInvestigating, "m16-transcript.png", true},
		{"Write", Claude, "Write", json.RawMessage(`{"file_path":"/home/u/w/docs/protocol.md","content":"x"}`), KindWriting, "protocol.md", true},
		{"Edit", Claude, "Edit", json.RawMessage(`{"file_path":"/home/u/w/a.go","old_string":"a","new_string":"b"}`), KindWriting, "a.go", true},
		{"Grep", Claude, "Grep", json.RawMessage(`{"pattern":"txLines","path":"/home/u/w/internal"}`), KindInvestigating, "txLines", true},
		{"WebSearch", Claude, "WebSearch", json.RawMessage(`{"query":"claude code jsonl format"}`), KindResearching, "claude code jsonl format", true},
		{"WebFetch", Claude, "WebFetch", json.RawMessage(`{"url":"https://claude-dev.tools/docs/jsonl-format","prompt":"x"}`), KindResearching, "claude-dev.tools", true},
		{"Agent", Claude, "Agent", json.RawMessage(`{"description":"Standards axis review","prompt":"x","subagent_type":"code-reviewer"}`), KindDelegating, "Standards axis review", true},
		{"TodoWrite", Claude, "TodoWrite", json.RawMessage(`{"todos":[]}`), KindPlanning, "-", true},
		{"Monitor", Claude, "Monitor", json.RawMessage(`{"command":"until grep -q passed log; do sleep 20; done","timeout_ms":3000000,"description":"full e2e finish"}`), KindWaiting, "full e2e finish", true},
		{"Skill keeps", Claude, "Skill", json.RawMessage(`{"skill":"x"}`), "", "-", true},
		{"mcp tool", Claude, "mcp__context7__query-docs", json.RawMessage(`{}`), KindWorking, "query-docs", false},
		// Codex.
		{"codex exec_command", Codex, "exec_command", execCmd("cat /home/u/.agents/skills/impeccable/SKILL.md > /dev/null; ls; cat PRODUCT.md"), KindInvestigating, "", true},
		{"codex shell argv", Codex, "shell", json.RawMessage(`{"command":["bash","-lc","go test ./..."],"workdir":"/w"}`), KindTesting, "go test ./...", true},
		{"codex apply_patch", Codex, "apply_patch", json.RawMessage(`"*** Begin Patch\n*** Update File: game/src/a.ts\n@@\n-x\n+y\n*** Add File: game/src/b.ts\n+z\n*** End Patch"`), KindWriting, "a.ts +1", true},
		{"codex exec with apply_patch", Codex, "exec", script("text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: internal/x.go\\n@@\\n-a\\n+b\\n*** End Patch\\n\"));\n"), KindWriting, "x.go", true},
		{"codex exec cat", Codex, "exec", script(`text(await tools.exec_command({cmd:"cat /home/u/.local/state/write-code/runs/r4.brief.md",max_output_tokens:20000}));` + "\n"), KindInvestigating, "cat r4.brief.md", true},
		{"codex exec every command counts", Codex, "exec", script("text(await tools.write_stdin({session_id:74775,chars:\"\",\"yield_time_ms\":1000}));\ntext(await tools.exec_command({cmd:\"agent-browser --session ux90 eval 'window.__h3d.face()'; agent-browser --session ux90 screenshot /tmp/s.png\",\"yield_time_ms\":1000}));\n"), KindTesting, "", true},
		{"codex exec write_stdin + view_image is an image", Codex, "exec", script("text(await tools.write_stdin({session_id:19707,chars:\"\",\"yield_time_ms\":1000,\"max_output_tokens\":3500}));\nconst r=await tools.view_image({path:\"/home/u/runs/ux-evidence/needs-you-desk.png\"});image(r.image_url);\n"), KindImage, "needs-you-desk.png", true},
		{"codex exec two images", Codex, "exec", script("const r=await tools.view_image({path:\"/tmp/shots/head-1500-partition.png\"});image(r.image_url);\nconst s=await tools.view_image({path:\"/tmp/shots/head-1300-sofa.png\"});image(s.image_url);\n"), KindImage, "head-1300-sofa.png", true},
		{"codex exec poll only keeps", Codex, "exec", script(`text(await tools.write_stdin({session_id:19707,chars:"",yield_time_ms:1000}));`), "", "-", true},
		{"codex view_image", Codex, "view_image", json.RawMessage(`{"path":"/tmp/github-app-access-request-guide.png","detail":"original"}`), KindInvestigating, "github-app-access-request-guide…", true},
		{"codex update_plan", Codex, "update_plan", json.RawMessage(`{"plan":[]}`), KindPlanning, "", true},
		{"codex web", Codex, "exec", script(`text(await tools.web__run({search_query:[{q:"x"}]}));`), KindResearching, "", true},
		{"codex unknown script", Codex, "exec_command", execCmd("python3 scripts/wait_for_results.py runs/r1"), KindWorking, "", false},
		{"codex ask keeps", Codex, "request_user_input", json.RawMessage(`{"questions":[]}`), "", "-", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k, d, ok := Classify(c.harness, c.tool, c.input)
			if k != c.kind || ok != c.ok {
				t.Fatalf("Classify = (%q, %q, %v), want (%q, %v)", k, d, ok, c.kind, c.ok)
			}
			switch c.detail {
			case "":
			case "-":
				if d != "" {
					t.Fatalf("detail %q, want none", d)
				}
			default:
				if d != c.detail {
					t.Fatalf("detail %q, want %q", d, c.detail)
				}
			}
			if utf8.RuneCountInString(d) > MaxDetail {
				t.Fatalf("detail %q is longer than %d", d, MaxDetail)
			}
		})
	}
}

func TestUnplacedCommandsAreForTheModel(t *testing.T) {
	c := Analyze(Claude, "Bash", bash("python3 x.py --run 20261002-0603 | tail"))
	if c.OK || c.Command == "" || c.Tool != "Bash" {
		t.Fatalf("%+v", c)
	}
	// Placed, or nothing to say: nothing to ask.
	for _, in := range []json.RawMessage{bash("pytest"), bash("cd x"), json.RawMessage(`{"file_path":"/a"}`)} {
		if c := Analyze(Claude, "Bash", in); c.Command != "" {
			t.Fatalf("%s: %+v", in, c)
		}
	}
	if c := Analyze(Claude, "mcp__x__y", nil); c.Command != "" || c.OK {
		t.Fatalf("an unknown tool has no command to ask about: %+v", c)
	}
}

// The detail is short and safe: never the whole command line, never a key.
func TestDetailIsShortAndSafe(t *testing.T) {
	long := "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' https://api.example.com/v1/things?x=1"
	_, d, _ := Classify(Claude, "Bash", bash(long))
	if strings.Contains(d, "abcdefghij") || utf8.RuneCountInString(d) > MaxDetail {
		t.Fatalf("%q", d)
	}
	_, d, _ = Classify(Claude, "Bash", bash("GH_TOKEN=ghp_abcdefghijklmnop1234 gh pr list"))
	if strings.Contains(d, "ghp_") {
		t.Fatalf("%q", d)
	}
	_, d, _ = Classify(Claude, "Bash", bash("pytest /home/u/very/long/path/to/the/tests/test_something_quite_long.py -k 'some and other'"))
	if strings.Contains(d, "/home/u") || utf8.RuneCountInString(d) > MaxDetail {
		t.Fatalf("%q", d)
	}
	if got := Scrub("git clone https://user:s3cr3t@host/x"); strings.Contains(got, "s3cr3t") {
		t.Fatalf("%q", got)
	}
}

// #98 acceptance: a Codex write_stdin poll of a pytest session keeps Testing.
func TestWriteStdinPollsKeepTheSessionsLabel(t *testing.T) {
	var s Sessions
	// A direct exec_command still running.
	start := Analyze(Codex, "exec_command", execCmd("uv run pytest -n auto tests/"))
	s.Started(start, "Chunk ID: 1\nWall time: 10.0 seconds\nProcess running with session ID 4321\nOriginal token count: 0\nOutput:\n")
	poll := Analyze(Codex, "write_stdin", json.RawMessage(`{"session_id":4321,"chars":"","yield_time_ms":30000}`))
	if got := s.Resolve(poll); got.Kind != KindTesting || got.Keep || got.Detail != "pytest -n auto tests/" {
		t.Fatalf("%+v", got)
	}
	// An unknown session keeps the current label.
	other := Analyze(Codex, "write_stdin", json.RawMessage(`{"session_id":99,"chars":""}`))
	if got := s.Resolve(other); !got.Keep || got.Kind != "" {
		t.Fatalf("%+v", got)
	}
	// Code mode: the results line up with the calls, one JSON object each.
	sc := Analyze(Codex, "exec", script("text(await tools.write_stdin({session_id:74775,chars:\"\",\"yield_time_ms\":1000}));\n"+
		"text(await tools.exec_command({cmd:\"agent-browser --session ux90 eval 'x'\",\"yield_time_ms\":1000}));\n"))
	s.Started(sc, `Script completed`+"\n"+`{"chunk_id":"7df488","wall_time_seconds":0.0002,"exit_code":0,"original_token_count":2,"output":"null\n"}`+
		"\n"+`{"chunk_id":"1a7183","wall_time_seconds":1.0,"session_id":19707,"original_token_count":0,"output":""}`)
	poll2 := Analyze(Codex, "exec", script(`text(await tools.write_stdin({session_id:19707,chars:"","yield_time_ms":1000}));`))
	if got := s.Resolve(poll2); got.Kind != KindTesting || got.Keep {
		t.Fatalf("%+v", got)
	}
	// The session that ended (74775) was not the pytest one's: still unknown.
	if got := s.Resolve(Analyze(Codex, "write_stdin", json.RawMessage(`{"session_id":74775,"chars":""}`))); !got.Keep {
		t.Fatalf("%+v", got)
	}
}

func TestShellSplitting(t *testing.T) {
	segs := splitShell("cd a && echo 'x && y' | grep -c \"a;b\"; cat > out.txt <<'EOF'\nline && not split\nEOF\nls 2>&1")
	var heads []string
	for _, s := range segs {
		heads = append(heads, s.words[0])
	}
	if strings.Join(heads, ",") != "cd,echo,grep,cat,ls" {
		t.Fatalf("%q", heads)
	}
	if segs[1].words[1] != "x && y" || segs[2].words[2] != "a;b" || !segs[2].piped {
		t.Fatalf("%+v", segs)
	}
	if segs[3].body != "line && not split\n" || len(segs[3].files) != 1 || segs[3].files[0] != "out.txt" {
		t.Fatalf("%+v", segs[3])
	}
	if len(segs[4].files) != 0 {
		t.Fatalf("2>&1 is no file: %+v", segs[4])
	}
}

// #132: what a Codex call does with background terminals, without the shell
// rules: its commands, the sessions it polls and what it types.
func TestCodexTerminals(t *testing.T) {
	cases := []struct {
		name, tool string
		input      json.RawMessage
		want       Terminals
	}{
		{"a pure poll", "exec", script(`const r = await tools.write_stdin({session_id:84659,chars:"",yield_time_ms:5000,max_output_tokens:1000});`),
			Terminals{Nested: []Nested{{Session: 84659}}, Polls: []int64{84659}}},
		{"quoted keys", "exec", script(`text(await tools.write_stdin({"session_id":12,"chars":"","yield_time_ms":30000}));`),
			Terminals{Nested: []Nested{{Session: 12}}, Polls: []int64{12}}},
		{"a session in a variable", "exec", script(`const id = 5; text(await tools.write_stdin({session_id:id,chars:""})); text(await tools.write_stdin({session_id, chars:""}));`),
			Terminals{Nested: []Nested{{Session: -1}, {Session: -1}}, Polls: []int64{-1, -1}}},
		{"no chars", "exec", script(`text(await tools.write_stdin({session_id:12}));`),
			Terminals{Nested: []Nested{{Session: 12}}, Polls: []int64{12}}},
		{"ctrl-c, escaped either way", "exec", script(`await tools.write_stdin({session_id:7,chars:"\u0003"}); await tools.write_stdin({session_id:8,chars:'\x03'});`),
			Terminals{Nested: []Nested{{Session: 7, Chars: "\x03"}, {Session: 8, Chars: "\x03"}}, Polls: []int64{7, 8}}},
		{"typed text in a template literal", "exec", script("await tools.write_stdin({session_id:7,chars:`y\n`});"),
			Terminals{Nested: []Nested{{Session: 7, Chars: "y\n"}}, Polls: []int64{7}}},
		{"a poll and an image", "exec", script(`text(await tools.write_stdin({session_id:3,chars:""})); image((await tools.view_image({path:"a.png"})).image_url);`),
			Terminals{Nested: []Nested{{Session: 3}}, Polls: []int64{3}}},
		{"a poll and a command", "exec", script(`await tools.write_stdin({session_id:3,chars:""}); await tools.exec_command({cmd:"ls -la"});`),
			Terminals{Nested: []Nested{{Session: 3}, {Command: "ls -la"}}, Polls: []int64{3}}},
		{"commands", "exec", script(`await Promise.all([tools.exec_command({cmd:"go test ./..."}), tools.exec_command({"cmd":'pnpm build'})]);`),
			Terminals{Nested: []Nested{{Command: "go test ./..."}, {Command: "pnpm build"}}}},
		{"a poll and a patch", "exec", script(`await tools.write_stdin({session_id:3,chars:""}); await tools.apply_patch("*** Begin Patch\n*** End Patch");`),
			Terminals{Nested: []Nested{{Session: 3}}, Polls: []int64{3}, Other: true}},
		{"direct exec_command", "exec_command", execCmd("uv run pytest -x"), Terminals{Nested: []Nested{{Command: "uv run pytest -x"}}}},
		{"direct write_stdin", "write_stdin", json.RawMessage(`{"session_id":4321,"chars":"\u0004","yield_time_ms":30000}`),
			Terminals{Nested: []Nested{{Session: 4321, Chars: "\x04"}}, Polls: []int64{4321}}},
		{"namespaced", "functions.write_stdin", json.RawMessage(`{"session_id":5}`), Terminals{Nested: []Nested{{Session: 5}}, Polls: []int64{5}}},
		{"another tool", "apply_patch", json.RawMessage(`"*** Begin Patch"`), Terminals{Other: true}},
	}
	for _, c := range cases {
		got := CodexTerminals(c.tool, c.input)
		if g, w := fmt.Sprintf("%+v", got), fmt.Sprintf("%+v", c.want); g != w {
			t.Errorf("%s: %s, want %s", c.name, g, w)
		}
	}
}

// #132: the sessions a call's output says its commands started, matched as
// Sessions.Started matches them.
func TestStarts(t *testing.T) {
	cmd := func(s string) Nested { return Nested{Command: s} }
	poll := func(id int64) Nested { return Nested{Session: id} }
	cases := []struct {
		name   string
		nested []Nested
		polls  []int64
		output string
		want   []Start
	}{
		{"direct, running", []Nested{cmd("a")}, nil, "Chunk ID: 1\nWall time: 10.0 seconds\nProcess running with session ID 4321\nOutput:\n", []Start{{4321, 0}}},
		{"direct, exited", []Nested{cmd("a")}, nil, "Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nok\n", nil},
		{"chunks in call order", []Nested{poll(9), cmd("a"), cmd("b")}, []int64{9}, "Script completed\nWall time 1.0 seconds\nOutput:\n" +
			`{"chunk_id":"1","wall_time_seconds":0.5,"exit_code":0,"output":""}` + "\n" +
			`{"chunk_id":"2","wall_time_seconds":1.0,"session_id":11,"output":""}` + "\n" +
			`{"chunk_id":"3","wall_time_seconds":1.0,"session_id":12,"output":""}`, []Start{{11, 1}, {12, 2}}},
		{"one command, chunks that do not line up", []Nested{poll(9), cmd("a")}, []int64{9}, "Script completed\nOutput:\n" +
			`{"chunk_id":"2","session_id":9,"output":"{"}` + "\n" + `{"chunk_id":"3","session_id":13,"output":""}`, []Start{{13, 1}}},
		{"two commands, chunks that do not line up", []Nested{cmd("a"), cmd("b")}, nil, `{"session_id":13,"output":""}`, nil},
		{"no output", []Nested{cmd("a")}, nil, "", nil},
		{"braces in an output", []Nested{cmd("a"), cmd("b")}, nil, "Script completed\nOutput:\n" +
			`{"chunk_id":"1","wall_time_seconds":1.0,"session_id":11,"output":"{\"a\": {}}"}` + "\n" +
			`{"chunk_id":"2","wall_time_seconds":1.0,"exit_code":0,"output":"}"}`, []Start{{11, 0}}},
		{"wrapped by Promise.allSettled", []Nested{cmd("a"), cmd("b")}, nil, "Script completed\nOutput:\n" +
			`{"status":"fulfilled","value":{"chunk_id":"1","wall_time_seconds":1.0,"exit_code":0,"output":""}}` + "\n" +
			`{"i":1,"result":{"chunk_id":"2","wall_time_seconds":1.0,"session_id":12,"output":""}}`, []Start{{12, 1}}},
		{"after a truncation note", []Nested{cmd("a"), cmd("b")}, nil, "Script completed\nOutput:\n" +
			`{"chunk_id":"1","wall_time_seconds":1.0,"session_id":11,"output":""}` + "\n" +
			"Warning: truncated output (original token count: 4000)\nTotal output lines: 812\n\n" +
			`{"chunk_id":"2","wall_time_seconds":1.0,"session_id":12,"original_token_count":4000,"output":"…"}`, []Start{{11, 0}, {12, 1}}},
	}
	for _, c := range cases {
		if got := Starts(c.nested, c.polls, c.output); fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

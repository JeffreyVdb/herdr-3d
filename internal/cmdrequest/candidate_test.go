package cmdrequest

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// firstReply is Pinecone's settled reply of 27 October (#213) the
// classifier scored 0.52: the reply text only, byte for byte.
func firstReply(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "reply-213-first.txt"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	if h := hex.EncodeToString(sum[:]); !strings.HasPrefix(h, "e3b2b1db2819") {
		t.Fatalf("fixture is not the reply: %s", h)
	}
	return string(b)
}

func TestCandidate(t *testing.T) {
	cases := []struct{ name, reply, rule string }{
		{"the missed reply", "", RuleFence},
		{"run, bash fence", "Run:\n\n```bash\nmise upgrade --global codex\ncodex --version\n```", RuleFence},
		{"untagged fence", "Making it reachable needs root, so you'll need to run:\n\n```\n! sudo tailscale serve --bg --https=8443 http://127.0.0.1:35033\n```", RuleFence},
		{"paste, console fence", "Paste this into your terminal:\n```console\n$ gh auth login\n```", RulePrompt},
		{"tilde fence", "Launch it with:\n~~~sh\n./serve\n~~~", RuleFence},
		{"indented fence in a list", "- **Run it yourself:** it takes a while:\n  ```\n  ! aws account disable-region --region-name me-south-1\n  ```", RuleFence},
		{"dollar lines", "Run these two:\n\n$ make\n$ make install", RulePrompt},
		{"execute", "Execute this from the repository root:\n```sh\nmake release\n```", RuleFence},
		{"example", "Example:\n```sh\nmake test\n```", ""},
		{"an example of running", "For example, you could run:\n```sh\nmake test\n```", ""},
		{"alternative", "Alternatively, run:\n```sh\nmake test\n```", ""},
		{"already run", "I've run the suite:\n```sh\ngo test ./...\n```", ""},
		{"already ran, with an ask word later", "I ran this and it passed; run it again if you like:\n```sh\ngo test ./...\n```", ""},
		{"output", "Running it printed this output:\n```\nok  pkg 0.1s\n```", ""},
		{"not shell", "Run this in your browser console:\n```js\nlocalStorage.clear()\n```", ""},
		{"go code", "Start with this function:\n```go\nfunc main() {}\n```", ""},
		{"ask in an earlier paragraph", "Please run the tests later.\n\nHere is the diff:\n```\n- a\n+ b\n```", ""},
		{"empty fence", "Run:\n```sh\n```", ""},
		{"inline command only", "Please run `make test` when you can.", ""},
		{"plain prose", "Done: the server restarts cleanly and all tests pass.", ""},
		{"dollar line without an ask", "The log shows:\n\n$ make\nmake: Nothing to be done", ""},
		{"second fence asks", "Here is what changed:\n```\n- a\n```\n\nNow run:\n```sh\nmake\n```", RuleFence},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reply := c.reply
			if reply == "" {
				reply = firstReply(t)
			}
			if got := Candidate(reply); got != c.rule {
				t.Fatalf("Candidate = %q, want %q", got, c.rule)
			}
		})
	}
}

func TestGate(t *testing.T) {
	reply := firstReply(t)
	for _, c := range []struct {
		score      float64
		reply      string
		extract    bool
		gate, rule string
	}{
		{0.52, reply, true, "candidate", RuleFence},
		{Band, reply, true, "candidate", RuleFence},
		{Band - 0.01, reply, false, "below", RuleFence},
		{Threshold, reply, true, "threshold", RuleFence},
		{0.95, "Please run `pwd`.", true, "threshold", ""},
		{0.52, "Please run `pwd`.", false, "below", ""},
		{0.69, "Example:\n```sh\nmake test\n```", false, "below", ""},
	} {
		if d := Gate(c.score, c.reply); d.Extract != c.extract || d.Gate != c.gate || d.Rule != c.rule {
			t.Errorf("Gate(%v, %.20q) = %+v", c.score, c.reply, d)
		}
	}
}

func TestParseReportRejections(t *testing.T) {
	reply := "Run `pwd` in /tmp, then `ls` and `id` and `date`; on your Mac `uname`."
	res, err := ParseReport(reply, `{"commands":[
		{"command":"pwd","cwd":"/tmp","host":"bridge"},
		{"command":"rm -rf /","host":"bridge"},
		{"command":"pw","host":"bridge"},
		{"command":"ls","cwd":"/made-up","host":"bridge"},
		{"command":"uname","host":"other","host_text":"Linux box"},
		{"command":"uname","host":"other"},
		{"command":"ls","host":"elsewhere"},
		{"command":"   ","host":"bridge"},
		{"command":"ls","host":"bridge"},
		{"command":"id","host":"unknown"},
		{"command":"date","host":"bridge"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Commands) != 3 || res.Commands[0].Command != "pwd" || res.Commands[1].Command != "ls" || res.Commands[2].Command != "id" {
		t.Fatalf("%+v", res.Commands)
	}
	want := "bad_command:1,cwd:1,host:1,host_text:2,not_in_reply:1,over_limit:1,overlap:1"
	if got := res.Rejections(); got != want {
		t.Fatalf("rejections %q, want %q", got, want)
	}
	for _, answer := range []string{"no json here", `{"commands": "pwd"}`} {
		if _, err := ParseReport(reply, answer); !errors.Is(err, ErrMalformed) {
			t.Fatalf("%q: %v", answer, err)
		}
	}
}

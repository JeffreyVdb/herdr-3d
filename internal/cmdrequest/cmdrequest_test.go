package cmdrequest

import (
	"context"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

func TestParseExactSpans(t *testing.T) {
	reply := "Please run this on your Mac in /tmp:\n```sh\nprintf '%s' \"hello\"\n```"
	cmds, err := Parse(reply, `{"commands":[{"command":"printf '%s' \"hello\"","cwd":"/tmp","host":"other","host_text":"your Mac"},{"command":"invented","host":"bridge"}]}`)
	if err != nil || len(cmds) != 1 || cmds[0].Command != `printf '%s' "hello"` || cmds[0].HostText != "your Mac" {
		t.Fatalf("%+v %v", cmds, err)
	}
}

func TestReplyFixtures(t *testing.T) {
	fixtures := []struct{ reply, answer, command string }{
		{"Please run `sudo make install` on the bridge host", `{"commands":[{"command":"sudo make install","host":"bridge"}]}`, "sudo make install"},
		{"Run:\ncat <<'EOF'\nhello\nEOF", `{"commands":[{"command":"cat <<'EOF'\nhello\nEOF","host":"bridge"}]}`, "cat <<'EOF'\nhello\nEOF"},
		{"Run make \\\n test", `{"commands":[{"command":"make \\\n test","host":"bridge"}]}`, "make \\\n test"},
		{`Run echo 'a' "b"`, `{"commands":[{"command":"echo 'a' \"b\"","host":"bridge"}]}`, `echo 'a' "b"`},
		{"Example: run make test", `{"commands":[]}`, ""},
		{"Error: command `make test` failed", `{"commands":[]}`, ""},
		{"I ran `make test` and it passed", `{"commands":[]}`, ""},
		{"Alternatively you could run make test", `{"commands":[]}`, ""},
		{"On your Mac run pwd", `{"commands":[{"command":"pwd","host":"other","host_text":"your Mac"}]}`, "pwd"},
		{"In /tmp run pwd", `{"commands":[{"command":"pwd","cwd":"/tmp","host":"bridge"}]}`, "pwd"},
		{"Run pwd", `{"commands":[{"command":"rm -rf /","host":"bridge"}]}`, ""},
		{"Run pwd", `{"commands":[{"command":"pwd","cwd":"/made-up","host":"bridge"}]}`, ""},
		{"Run pwd", `{"commands":[{"command":"pwd","host":"other","host_text":"Mac"}]}`, ""},
		{"Run pwd", `{"commands":[{"command":"pwd","host":"unknown"}]}`, "pwd"},
		{"Run pwd", `{"commands":[{"command":"pwd","host":"other"}]}`, ""},
		{"Run pwd", `{"commands":[{"command":"","host":"bridge"}]}`, ""},
		{"Run pwd", `{"commands":[{"command":"pwd","host":"bogus"}]}`, ""},
		{"Run `pwd`", `{"commands":[{"command":"pwd","host":"bridge","why":"invented"}]}`, "pwd"},
		{"Run pwd", `{"commands":[{"command":"pwd","host":"bridge"},{"command":"pwd","host":"bridge"}]}`, "pwd"},
		{"Run `echo ok`", `{"commands":[{"command":"echo ok","host":"bridge"}]}`, "echo ok"},
	}
	for _, f := range fixtures {
		t.Run(f.reply+f.answer, func(t *testing.T) {
			got, err := Extract(context.Background(), &ai.FakeLLM{Text: f.answer}, f.reply)
			if err != nil {
				t.Fatal(err)
			}
			if f.command == "" {
				if len(got) != 0 {
					t.Fatalf("%+v", got)
				}
				return
			}
			if len(got) != 1 || got[0].Command != f.command {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestEntryLimitAndFence(t *testing.T) {
	reply := "Run:\n```sh\none\n```\nthen two three four"
	got, err := Parse(reply, "{\"commands\":[{\"command\":\"```sh\\none\\n```\",\"host\":\"bridge\"},{\"command\":\"two\",\"host\":\"bridge\"},{\"command\":\"three\",\"host\":\"bridge\"},{\"command\":\"four\",\"host\":\"bridge\"}]}")
	if err != nil || len(got) != 3 || got[0].Command != "one" || got[2].Command != "three" {
		t.Fatalf("%+v %v", got, err)
	}
}

package cmdrequest

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// accountReply is the reply of #220 whose card said "Machine: your user":
// the reply text only, byte for byte.
func accountReply(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "reply-220-account.txt"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	if h := hex.EncodeToString(sum[:]); !strings.HasPrefix(h, "3621dd1dce69") {
		t.Fatalf("fixture is not the reply: %s", h)
	}
	return string(b)
}

const accountCommand = "! sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215"

// accountPhrases are execution accounts and privileges, each without a
// leading "as", "under" or "with".
var accountPhrases = []string{
	"your user", "your account", "your user account", "your login", "root", "the root user", "yourself", "sudo",
	"an admin", "an administrator", "your own user", "your own account", "my user", "a superuser", "superuser",
}

// notAccounts name, or could name, a machine: none of them, in any
// spelling, is an account phrase.
var notAccounts = []string{
	"", " ", "as", "your", "with", "the", "own", "your own",
	"your user's Mac", "your user’s Mac", "your user's laptop", "your user's", "the deploy user's host", "a different user's machine", "the user's machine",
	"your user on the build server", "your user account on prod", "root on prod", "as root on the build server", "sudo on your Mac", "your user and your Mac",
	"the build server", "your Mac", "your laptop", "the host", "localhost", "prod", "another machine", "a different user", "the login node", "your login node",
	"build-01.example.com", "10.0.0.5", "::1", "user@host", "user@10.0.0.5", "root@prod", "ssh root@prod", "ssh prod", "ssh your user",
	"the root server", "rootfs", "root.example.com", "root-1", "userhost", "user1", "users", "accounts-db", "admin-box", "admin.internal",
	"your-user", "your_user", "your users", "youruser", "asroot", "as-root", "root,prod", "root/prod", "root (prod)",
	"your user on your Mac", "your account at work", "your admin's laptop", "the admin server",
}

// spellings are a phrase's case, whitespace, quote and punctuation
// variants.
func spellings(p string) []string {
	words := strings.Split(p, " ")
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	cases := []string{p, strings.ToUpper(p), strings.Join(words, " ")}
	var out []string
	for _, c := range cases {
		for _, ws := range []string{" ", "  ", "\t", "\n", " ", " \n "} {
			s := strings.ReplaceAll(c, " ", ws)
			for _, q := range [][2]string{{"", ""}, {`"`, `"`}, {"“", "”"}, {"‘", "’"}, {"'", "'"}, {"`", "`"}, {"  ", " "}} {
				for _, end := range []string{"", ".", ","} {
					out = append(out, q[0]+s+end+q[1])
				}
			}
		}
	}
	return out
}

func TestAccountHostMatrix(t *testing.T) {
	for _, p := range accountPhrases {
		for _, lead := range []string{"", "as ", "under ", "with "} {
			for _, s := range spellings(lead + p) {
				if !accountHost(s) {
					t.Errorf("%q is an account phrase", s)
				}
			}
		}
	}
}

func TestAccountHostNeverAMachine(t *testing.T) {
	for _, p := range notAccounts {
		for _, lead := range []string{"", "as ", "under ", "with ", "on "} {
			for _, s := range spellings(lead + p) {
				if accountHost(s) {
					t.Errorf("%q names or could name a machine", s)
				}
			}
		}
	}
}

// #220: the model's "other" for an account phrase is the bridge, counted as
// account_host; the command's bytes are never touched.
func TestAccountHostIsTheBridge(t *testing.T) {
	type row struct{ name, reply, answer, command string }
	rows := []row{{"the ticket's reply", accountReply(t), `{"commands":[{"command":"! sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215","host":"other","host_text":"your user"}]}`, accountCommand}}
	for _, p := range []string{"as your user", "under your account", "your user account", "as your login", "as root", "root", "as yourself", "with sudo", "as an admin", "under your own user"} {
		rows = append(rows, row{p, "Run `sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215` " + p + ".",
			`{"commands":[{"command":"sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215","host":"other","host_text":"` + p + `"}]}`,
			"sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215"})
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			res, err := ParseReport(r.reply, r.answer)
			if err != nil || len(res.Commands) != 1 {
				t.Fatalf("%+v %v", res, err)
			}
			c := res.Commands[0]
			if c.Command != r.command || c.Host != "bridge" || c.HostText != "" {
				t.Fatalf("%+v", c)
			}
			if res.Rejected["account_host"] != 1 || res.Rejections() != "account_host:1" {
				t.Fatalf("rejected %v", res.Rejected)
			}
		})
	}
}

// A machine, named or ambiguous, keeps its host.
func TestAccountHostKeepsMachines(t *testing.T) {
	reply := accountReply(t)
	for _, f := range []struct{ reply, answer, host, hostText string }{
		{"On your Mac run `pwd` as your user", `{"commands":[{"command":"pwd","host":"other","host_text":"your Mac"}]}`, "other", "your Mac"},
		{"Run `pwd` as your user on the build server", `{"commands":[{"command":"pwd","host":"other","host_text":"your user on the build server"}]}`, "other", "your user on the build server"},
		{"Run `pwd` as root@prod", `{"commands":[{"command":"pwd","host":"other","host_text":"root@prod"}]}`, "other", "root@prod"},
		{"Run `pwd` on your user's Mac", `{"commands":[{"command":"pwd","host":"other","host_text":"your user's Mac"}]}`, "other", "your user's Mac"},
		{reply, `{"commands":[{"command":"! sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215","host":"unknown","host_text":"your user"}]}`, "unknown", "your user"},
		{reply, `{"commands":[{"command":"! sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215","host":"unknown"}]}`, "unknown", ""},
	} {
		res, err := ParseReport(f.reply, f.answer)
		if err != nil || len(res.Commands) != 1 {
			t.Fatalf("%q: %+v %v", f.reply, res, err)
		}
		if c := res.Commands[0]; c.Host != f.host || c.HostText != f.hostText || len(res.Rejected) != 0 {
			t.Fatalf("%q: %+v rejected %v", f.reply, c, res.Rejected)
		}
	}
	// An account phrase that is not in the reply is still a fabrication.
	res, err := ParseReport("Run `pwd`", `{"commands":[{"command":"pwd","host":"other","host_text":"your user"}]}`)
	if err != nil || len(res.Commands) != 0 || res.Rejections() != "host_text:1" {
		t.Fatalf("%+v %v", res, err)
	}
}

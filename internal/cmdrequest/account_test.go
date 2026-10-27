package cmdrequest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	for _, p := range []string{"as your user", "under your account", "with your user account", "as your login", "as root", "as the root user", "as yourself", "with sudo", "as an admin", "under your own user"} {
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
		{"On your Mac, run `pwd` as your user", `{"commands":[{"command":"pwd","host":"other","host_text":"your user"}]}`, "other", "your user"},
		{"On root, run `pwd`.", `{"commands":[{"command":"pwd","host":"other","host_text":"root"}]}`, "other", "root"},
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

// leadPhrase is p after lead, or p when it already starts with one.
func leadPhrase(lead, p string) string {
	if _, led := accountPhrase(p); led {
		return p
	}
	return lead + p
}

// expectHost parses reply with the model's answer for command and checks
// the entry's host, host text and rejections.
func expectHost(t *testing.T, reply, answer, command, host, hostText, rejections string) {
	t.Helper()
	res, err := ParseReport(reply, answer)
	if err != nil || len(res.Commands) != 1 {
		t.Fatalf("%q %s: %+v %v", reply, answer, res, err)
	}
	if c := res.Commands[0]; c.Command != command || c.Host != host || c.HostText != hostText || res.Rejections() != rejections {
		t.Fatalf("%q %s: %+v rejected %v", reply, answer, c, res.Rejected)
	}
}

func otherAnswer(command, hostText, cwd string) string {
	m := map[string]string{"command": command, "host": "other", "host_text": hostText}
	if cwd != "" {
		m["cwd"] = cwd
	}
	b, _ := json.Marshal(map[string]any{"commands": []any{m}})
	return string(b)
}

// R1: an account phrase never moves a command to the bridge when the reply
// mentions another machine, before or after the command, in its own
// sentence or at the start of one, whichever of the phrase's spans the
// model quotes.
func TestAccountHostMachineInReply(t *testing.T) {
	expectHost(t, "On your Mac, run `pwd` as your user", `{"commands":[{"command":"pwd","host":"other","host_text":"your user"}]}`, "pwd", "other", "your user", "")
	n := 0
	for _, m := range machineMentions {
		for _, p := range accountPhrases {
			for _, lead := range []string{"as ", "under ", "with "} {
				a := leadPhrase(lead, p)
				for _, reply := range []string{
					"Then, " + m + ", run `pwd` " + a + ".",
					"Run `pwd` " + a + " " + m + ".",
					"Run `pwd` " + a + ". Do it " + m + ".",
					"Do it " + m + ". Run `pwd` " + a + ".",
					strings.ToUpper(m[:1]) + m[1:] + ", run `pwd` " + a + ".",
					"I couldn't do it " + a + ".\n\nTo do it " + m + ", run:\n\n```sh\npwd\n```\n",
				} {
					for _, ht := range []string{p, a} {
						expectHost(t, reply, otherAnswer("pwd", ht, ""), "pwd", "other", ht, "")
						n++
					}
				}
			}
		}
	}
	t.Logf("%d replies", n)
}

// R2: a bare account noun ("root", "sudo") can be a host's name; only a lead
// in the reply ("as root", "with sudo") makes it an account, and every use
// of it in the reply must have one.
func TestAccountHostNeedsALead(t *testing.T) {
	for _, f := range []struct{ reply, hostText, host string }{
		{"On root, run `pwd`.", "root", "other"},
		{"Use sudo: run `pwd` on root", "sudo", "other"},
		{"Use sudo: run `pwd` on root", "root", "other"},
		{"root: run `pwd`", "root", "other"},
		{"Run `pwd` root.", "root", "other"},
		{"Run `pwd`, superuser.", "superuser", "other"},
		{"Run `pwd` yourself.", "yourself", "other"},
		{"Run `pwd` your user account.", "your user account", "other"},
		{"Run `pwd` on root as root.", "root", "other"},
		{"On root, run `pwd` as root", "root", "other"},
		{"On root, run `pwd` as root", "as root", "other"},
		{"Run `pwd` as root, then tell root it is done.", "root", "other"},
		{"Run `pwd` with sudo; sudo asks for your password.", "sudo", "other"},
		{"Run `pwd` as the root user; the root user owns it.", "the root user", "other"},
		{"Run `sudo pwd`.", "sudo", "other"},
		{"Run `pwd`, it has root.", "as root", "other"},
		{"Run `pwd` as rootfs.", "root", "other"},
		{"Run `pwd` as root.", "root", "bridge"},
		{"Run `pwd` AS ROOT.", "ROOT", "bridge"},
		{"Run `pwd` as\n  root.", "root", "bridge"},
		{"Run `pwd` with sudo.", "sudo", "bridge"},
		{"Run `pwd` with sudo, as root.", "sudo", "bridge"},
		{"Run `pwd` as root. As root, it can read the logs.", "root", "bridge"},
		{"Run `pwd` as “root”.", "“root”", "bridge"},
		{"Run `sudo pwd` with sudo.", "sudo", "bridge"},
		{"Run `pwd` as superuser.", "superuser", "bridge"},
		{"Run `pwd` under yourself.", "yourself", "bridge"},
	} {
		hostText, rejections := f.hostText, ""
		if f.host == "bridge" {
			hostText, rejections = "", "account_host:1"
		}
		cmd := "pwd"
		if strings.Contains(f.reply, "`sudo pwd`") {
			cmd = "sudo pwd"
		}
		expectHost(t, f.reply, otherAnswer(cmd, f.hostText, ""), cmd, f.host, hostText, rejections)
	}
	for _, p := range accountPhrases {
		if _, led := accountPhrase(p); !led {
			expectHost(t, "Run `pwd` "+p+".", otherAnswer("pwd", p, ""), "pwd", "other", p, "")
		}
	}
}

// Still runnable: an account phrase with a lead, in a reply that names no
// machine, is the bridge, whichever of its spans the model quotes; a cwd
// the reply gives is not prose.
func TestAccountHostRunnableReplies(t *testing.T) {
	expectHost(t, accountReply(t), otherAnswer(accountCommand, "your user", ""), accountCommand, "bridge", "", "account_host:1")
	expectHost(t, accountReply(t), otherAnswer(accountCommand, "as your user", ""), accountCommand, "bridge", "", "account_host:1")
	type tmpl struct{ reply, command, cwd string }
	n := 0
	for _, p := range accountPhrases {
		for _, lead := range []string{"as ", "under ", "with "} {
			a := leadPhrase(lead, p)
			A := strings.ToUpper(a[:1]) + a[1:]
			for _, f := range []tmpl{
				{"Run `pwd` " + a + ".", "pwd", ""},
				{"Please run `sudo systemctl restart foo` " + a + ".", "sudo systemctl restart foo", ""},
				{A + ", run `ls -la` in /home/jeff/repo.", "ls -la", ""},
				{A + ", run `ls -la` in /home/jeff/repo.", "ls -la", "/home/jeff/repo"},
				{A + ", run `ls -la` in /root/build-server.", "ls -la", "/root/build-server"},
				{"I couldn't do it " + a + ". To do it, run `" + accountCommand + "`, then open https://kiswe-omarchy.tail2d07d5.ts.net:8216/?a=1 with the same query string.", accountCommand, ""},
				{"I couldn't do it " + a + ". To do it, run `" + accountCommand + "`, then open https://kiswe-omarchy.tail2d07d5.ts.net:8216/?x=1 with the same query string.", accountCommand, ""},
				{"Run this " + a + ":\n\n```sh\nsudo tailscale serve --bg --https=8216 http://127.0.0.1:45215\n```\n", "sudo tailscale serve --bg --https=8216 http://127.0.0.1:45215", ""},
				{"Run this " + a + ":\n\n```\nsudo systemctl restart foo\nsudo systemctl status foo\n```", "sudo systemctl restart foo\nsudo systemctl status foo", ""},
			} {
				hts := []string{p, a}
				if strings.HasPrefix(f.reply, A) {
					hts = []string{p, A}
				}
				for _, ht := range hts {
					expectHost(t, f.reply, otherAnswer(f.command, ht, f.cwd), f.command, "bridge", "", "account_host:1")
					n++
				}
			}
		}
	}
	t.Logf("%d replies", n)
}

// R3: the command and a path cwd are blanked only when they occur once and
// not after "on", "onto" or "from"; a machine named like the command or the
// cwd, before or after it, at a sentence's start or inside a longer word,
// is never hidden.
func TestAccountHostRepeatedSpans(t *testing.T) {
	expectHost(t, "On prod, run `prod` as your user.", otherAnswer("prod", "your user", ""), "prod", "other", "your user", "")
	expectHost(t, "On /server, run `pwd` as your user in /server.", otherAnswer("pwd", "your user", "/server"), "pwd", "other", "your user", "")
	n := 0
	for _, p := range accountPhrases {
		for _, lead := range []string{"as ", "under ", "with "} {
			a := leadPhrase(lead, p)
			type tmpl struct{ reply, command, cwd string }
			var rows []tmpl
			for _, m := range []string{"prod", "build", "mac", "server", "node1", "kiswe-mbp", "staging", "db"} {
				for _, r := range []string{
					"On M, run `M` A.",
					"on M, run `M` A.",
					"Run `M` A on M.",
					"Run `M` A. Do it on M.",
					"Do it on M. Run `M` A.",
					"From M, run `M` A.",
					"Copy it onto M, then run `M` A.",
					"On `M`, run `M` A.",
					"On M-db, run `M` A.",
					"Run it A on `M`.",
					"I couldn't do it A.\n\nOn M, run:\n\n```sh\nM\n```\n",
				} {
					rows = append(rows, tmpl{strings.NewReplacer("M", m, "A", a).Replace(r), m, ""})
				}
			}
			for _, cwd := range []string{"/server", "/mnt/mac", "~/prod", "/srv/node1", "~/build-box"} {
				for _, r := range []string{
					"On C, run `pwd` A in C.",
					"On C, run `pwd` A.",
					"on C, run `pwd` A.",
					"Run `pwd` A in C. Do it on C.",
					"From C, run `pwd` A.",
					"On `C`, run `pwd` A.",
					"In C, run `pwd` A on C.",
				} {
					rows = append(rows, tmpl{strings.NewReplacer("C", cwd, "A", a).Replace(r), "pwd", cwd})
				}
			}
			// A repeat that is a machine noun, with no "on" before it.
			for _, m := range []string{"mac", "server", "box", "vm", "laptop"} {
				rows = append(rows, tmpl{"In the " + m + "'s shell, run `" + m + "` " + a + ".", m, ""},
					tmpl{"Open a shell in the " + m + "-1. Run `" + m + "` " + a + ".", m, ""})
			}
			for _, cwd := range []string{"/server", "/mnt/mac", "~/build-box"} {
				rows = append(rows, tmpl{"In " + cwd + ", run `pwd` " + a + " in " + cwd + ".", "pwd", cwd})
			}
			for _, f := range rows {
				for _, ht := range []string{p, a} {
					expectHost(t, f.reply, otherAnswer(f.command, ht, f.cwd), f.command, "other", ht, "")
					n++
				}
			}
			// A repeat that names no machine keeps the reply runnable.
			for _, f := range []tmpl{
				{"Run `ls` " + a + ", then `ls` again.", "ls", ""},
				{"In /home/jeff/repo, run `ls -la` " + a + " in /home/jeff/repo.", "ls -la", "/home/jeff/repo"},
			} {
				expectHost(t, f.reply, otherAnswer(f.command, a, f.cwd), f.command, "bridge", "", "account_host:1")
			}
		}
	}
	t.Logf("%d replies", n)
}

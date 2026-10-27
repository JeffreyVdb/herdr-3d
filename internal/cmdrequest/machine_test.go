package cmdrequest

import (
	"strings"
	"testing"
)

// machineMentions name another machine, each in a way the detector must
// catch wherever it sits in a reply.
var machineMentions = []string{
	"on your Mac", "on the build server", "on your laptop", "from your Mac", "on prod", "on root", "on kiswe-mbp",
	"on another machine", "on a different machine", "on that box", "onto the server", "from `kiswe-mbp`", "on “prod”",
	"over ssh", "after you ssh in", "with scp", "via rsync", "over sftp", "at jeff@kiswe-mbp", "at root@prod",
	"remotely", "in the remote shell", "in your Mac's terminal", "in the VM", "inside the container", "in a container",
	"at your phone", "at the workstation", "at your PC", "at the desktop", "in the host shell", "at your machine",
	"at your computer", "at 10.0.0.5", "in your MacBook", "at the login node", "in the servers' shells", "in both boxes",
}

func TestMachineMention(t *testing.T) {
	fires := []string{
		"On your Mac, run it.", "ON YOUR MAC", "run it on prod", "run it on​prod", "run it on\n\tprod",
		"run it on [prod]", "run it on (the box)", "the build-server", "a VM.", "macs", "mac",
	}
	for _, m := range machineMentions {
		fires = append(fires, m, strings.ToUpper(m), "Run it "+m+".", strings.ToUpper(m[:1])+m[1:]+", run it.")
	}
	for _, s := range fires {
		if !machineMention(s) {
			t.Errorf("%q mentions a machine", s)
		}
	}
	quiet := []string{
		"", "Run `` as your user.", "Please run `` under your account.", "As root, run `` in /home/jeff/repo.",
		"I couldn't do it as your user. To do it, run ``, then open https://kiswe-omarchy.tail2d07d5.ts.net:8216/?a=1 with the same query string.",
		"Open https://kiswe-omarchy.tail2d07d5.ts.net:8216/?x=1 when it is done.", "Open http://build-server.example.com/a?b=c.",
		"Open [the URL](https://user@my-server.example.com/) after.", "Run this as root:\n\n```sh\n\n```\n",
		"Run this with sudo:\n\n```bash\n\n```", "turn it on.", "To do it, then open it.", "over Tailscale", "the Tailscale URL",
		"once", "upon", "front", "hostess", "boxing", "remoted", "macro", "machinery", "1.2.3", "a@", "@b", "monday",
	}
	quiet = append(quiet, accountReply(t), strings.Replace(accountReply(t), "`"+accountCommand+"`", "``", 1))
	for _, s := range quiet {
		if machineMention(s) {
			t.Errorf("%q mentions no machine", s)
		}
	}
}

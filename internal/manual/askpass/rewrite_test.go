package askpass

import "testing"

func TestRewrite(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"sudo -u root cmd", "sudo -A -u root cmd"},
		{`sudo -u 'root' echo "hello world"`, `sudo -A -u 'root' echo "hello world"`},
		{`sudo echo 'literal | pipe'`, `sudo -A echo 'literal | pipe'`},
		{"sudo -- cmd", "sudo -A -- cmd"}, {"sudo --", ""},
		{"sudo --non cmd", ""}, {"sudo -En cmd", ""},
		{`sudo echo "$(whoami)"`, ""}, {`sudo echo x; cmd`, ""},
		{"sudo -E cmd", "sudo -A -E cmd"},
		{" \tsudo cmd", " \tsudo -A cmd"}, {"sudo -A cmd", ""}, {"sudo -S cmd", ""},
		{"sudo -n cmd", ""}, {"bash -c sudo", ""}, {"FOO=1 sudo cmd", ""},
		{"sudo cmd | cat", ""}, {"sudo cmd && cat", ""}, {"sudo cmd\ncat", ""}, {"sudoedit file", ""},
	} {
		t.Run(tt.in, func(t *testing.T) {
			got, ok := Rewrite(tt.in)
			if got != tt.want || ok != (tt.want != "") {
				t.Fatalf("got %q, %v", got, ok)
			}
		})
	}
}

func TestUser(t *testing.T) {
	for _, tt := range []struct{ command, want string }{
		{"sudo -A -u root cmd", "root"}, {`sudo -A --user='alice' cmd`, "alice"},
		{"sudo -AEubob cmd", "bob"}, {"sudo -A echo -u alice", "root"},
		{"sudo -A -p prompt -u alice cmd", "alice"},
	} {
		if got := User(tt.command); got != tt.want {
			t.Errorf("User(%q) = %q, want %q", tt.command, got, tt.want)
		}
	}
}

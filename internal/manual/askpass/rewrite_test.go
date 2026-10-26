package askpass

import "testing"

func TestRewrite(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"sudo -u root cmd", "sudo -A -u root cmd"}, {"sudo -E cmd", "sudo -A -E cmd"},
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

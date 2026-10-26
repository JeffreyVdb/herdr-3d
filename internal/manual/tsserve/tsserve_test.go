package tsserve

import "testing"

func TestServe(t *testing.T) {
	cmd := "sudo tailscale serve --bg --https=8443 http://127.0.0.1:39525"
	s, ok := Parse(cmd)
	if !ok {
		t.Fatal("parse")
	}
	if got := Endpoint(s); got != "https:8443" {
		t.Fatal(got)
	}
	if got := CleanupCommand(s); got != "sudo tailscale serve --bg --https=8443 off" {
		t.Fatal(got)
	}
	if got, ok := ForegroundVariant(cmd); !ok || got != "sudo tailscale serve --https=8443 http://127.0.0.1:39525" {
		t.Fatal(got, ok)
	}
	for _, tt := range []struct {
		json string
		want bool
		bad  bool
	}{
		{`{}`, false, false}, {`{"TCP":{"443":{"HTTPS":true}}}`, false, false}, {`{"TCP":{"8443":{"HTTPS":true}}}`, true, false}, {`{"Foreground":{"session":{"Web":{"node:8443":{"Handlers":{}}}}}}`, true, false}, {`{`, false, true},
	} {
		got, err := Conflict([]byte(tt.json), s)
		if got != tt.want || (err != nil) != tt.bad {
			t.Errorf("%s: %v %v", tt.json, got, err)
		}
	}
}

func TestSimpleCommandsOnly(t *testing.T) {
	for _, cmd := range []string{"tailscale serve --bg https://localhost:3000; rm file", "tailscale serve --bg\nother", "tailscale serve --bg $(whoami)", "tailscale serve --https=0 target", "tailscale serve --bg off"} {
		if _, ok := ForegroundVariant(cmd); ok {
			t.Errorf("unexpected variant for %q", cmd)
		}
	}
	s, ok := Parse("sudo -A tailscale serve --bg --http 8080 --set-path /demo target")
	if !ok || Endpoint(s) != "http:8080" || CleanupCommand(s) != "sudo -A tailscale serve --bg --http 8080 --set-path /demo off" {
		t.Fatalf("%+v %v", s, ok)
	}
}

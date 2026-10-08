package kaneo

import (
	"errors"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

func TestParseURL(t *testing.T) {
	for _, tc := range []struct {
		in, api, web string
	}{
		{"https://tasks.example.com", "https://tasks.example.com/api", "https://tasks.example.com"},
		{"https://tasks.example.com/", "https://tasks.example.com/api", "https://tasks.example.com"},
		{"  https://tasks.example.com/api  ", "https://tasks.example.com/api", "https://tasks.example.com"},
		{"https://tasks.example.com/api/", "https://tasks.example.com/api", "https://tasks.example.com"},
		{"https://tasks.example.com/api//", "https://tasks.example.com/api", "https://tasks.example.com"},
		{"HTTPS://Tasks.Example.COM/API", "https://tasks.example.com/api", "https://tasks.example.com"},
		{"https://tasks.example.com:443/api", "https://tasks.example.com/api", "https://tasks.example.com"},
		{"https://tasks.example.com:8443", "https://tasks.example.com:8443/api", "https://tasks.example.com:8443"},
		// Loopback may be plain http (tests, a local instance).
		{"http://localhost:3000", "http://localhost:3000/api", "http://localhost:3000"},
		{"http://127.0.0.1:35933/api", "http://127.0.0.1:35933/api", "http://127.0.0.1:35933"},
		{"http://127.8.9.10", "http://127.8.9.10/api", "http://127.8.9.10"},
		{"http://[::1]:80/", "http://[::1]/api", "http://[::1]"},
	} {
		ep, err := ParseURL(tc.in)
		if err != nil {
			t.Errorf("%q: %v", tc.in, err)
			continue
		}
		if ep.APIBase != tc.api || ep.WebOrigin != tc.web {
			t.Errorf("%q = %+v, want %s and %s", tc.in, ep, tc.api, tc.web)
		}
	}
	for _, in := range []string{
		"",
		"tasks.example.com",
		"ftp://tasks.example.com",
		"javascript:alert(1)",
		"https://",
		"https://user:pass@tasks.example.com",
		"https://user@tasks.example.com",
		"https://tasks.example.com/api?x=1",
		"https://tasks.example.com/?",
		"https://tasks.example.com/#frag",
		"https://tasks.example.com/api#",
		"http://tasks.example.com",          // plain http off loopback
		"http://localhost.example.com",      // not loopback
		"https://tasks.example.com/api/api", // a path that is not the API base
		"https://tasks.example.com/dashboard/workspace/ws_1",
		"https://tasks.example.com/api/openapi",
		"https://tasks example.com",
		"https://tasks.example.com/a\npi",
	} {
		if ep, err := ParseURL(in); !errors.Is(err, provider.ErrBadInput) {
			t.Errorf("%q = %+v, %v; want a bad input", in, ep, err)
		}
	}
}

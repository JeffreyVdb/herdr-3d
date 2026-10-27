package manual

import "testing"

func TestNoNewPrivsStatus(t *testing.T) {
	for _, tc := range []struct {
		status     string
		restricted bool
		ok         bool
	}{
		{"Name:\therdr\nNoNewPrivs:\t0\n", false, true},
		{"NoNewPrivs:\t1\n", true, true},
		{"Name:\therdr\n", false, false},
		{"NoNewPrivs:\t2\n", false, false},
	} {
		got, err := ParseNoNewPrivs(tc.status)
		if got != tc.restricted || (err == nil) != tc.ok {
			t.Errorf("%q: %v %v", tc.status, got, err)
		}
	}
}

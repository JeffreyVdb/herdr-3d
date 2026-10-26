package manual

import "testing"

func TestStartTicks(t *testing.T) {
	for _, tc := range []struct {
		stat string
		want uint64
		ok   bool
	}{
		{"42 (name with ) parentheses) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987 20", 987, true},
		{"42 (broken) S 1 2", 0, false},
		{"invalid", 0, false},
	} {
		got, err := ParseStartTicks(tc.stat)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("%q: %d, %v", tc.stat, got, err)
		}
	}
}

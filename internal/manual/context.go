package manual

import (
	"fmt"
	"strings"
)

func ParseNoNewPrivs(status string) (bool, error) {
	for _, line := range strings.Split(status, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok && k == "NoNewPrivs" {
			switch strings.TrimSpace(v) {
			case "0":
				return false, nil
			case "1":
				return true, nil
			default:
				return false, fmt.Errorf("invalid NoNewPrivs")
			}
		}
	}
	return false, fmt.Errorf("NoNewPrivs missing")
}

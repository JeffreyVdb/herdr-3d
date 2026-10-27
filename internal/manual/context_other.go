//go:build !linux

package manual

import (
	"context"
	"errors"
)

func ServerNoNewPrivs(context.Context, string) (bool, error) {
	return false, errors.New("manual processes require Linux")
}

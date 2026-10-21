//go:build !linux && !darwin

package codexaccount

import (
	"errors"
	"os"
)

// renameNew refuses here: this system has no rename that never replaces
// anything, and the share steps never replace what they did not plan to.
func renameNew(old, new string) error {
	return &os.LinkError{Op: "rename", Old: old, New: new, Err: errors.New("not supported on this system")}
}

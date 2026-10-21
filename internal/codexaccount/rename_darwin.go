package codexaccount

import (
	"os"

	"golang.org/x/sys/unix"
)

// renameNew renames old to new unless new exists (an error that is
// fs.ErrExist then): it never replaces anything.
func renameNew(old, new string) error {
	if err := unix.RenamexNp(old, new, unix.RENAME_EXCL); err != nil {
		return &os.LinkError{Op: "rename", Old: old, New: new, Err: err}
	}
	return nil
}

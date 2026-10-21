package codexaccount

import (
	"os"

	"golang.org/x/sys/unix"
)

// renameNew renames old to new unless new exists (an error that is
// fs.ErrExist then): it never replaces anything.
func renameNew(old, new string) error {
	if err := unix.Renameat2(unix.AT_FDCWD, old, unix.AT_FDCWD, new, unix.RENAME_NOREPLACE); err != nil {
		return &os.LinkError{Op: "rename", Old: old, New: new, Err: err}
	}
	return nil
}

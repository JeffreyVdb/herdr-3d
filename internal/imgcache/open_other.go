//go:build !linux

package imgcache

import "golang.org/x/sys/unix"

// walkDir opens a directory on the way to a file only to look up the next
// name in it.
const walkDir = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC

package imgcache

import "golang.org/x/sys/unix"

// walkDir opens a directory on the way to a file only to look up the next
// name in it: O_PATH needs search permission, not read, so a directory
// above a root that others may pass through but not list still works.
const walkDir = unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC

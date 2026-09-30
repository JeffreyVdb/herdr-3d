package imgcache

import "syscall"

func parentUmask(m int) int { return syscall.Umask(m) }

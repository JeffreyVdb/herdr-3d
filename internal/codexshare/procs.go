package codexshare

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// OwnerVar marks every process a fixture starts: the Herdr session server
// (so its panes and what they run inherit it), the app-servers and daemons
// started from those panes, and the MCP children Codex starts. Only a
// process of this user carrying the fixture's exact value is the fixture's
// to signal; a process that merely names the fixture's paths is not.
const OwnerVar = "H3D_CODEXSHARE_OWNER"

// NewOwner returns a fresh random owner marker.
func NewOwner() string {
	var rnd [16]byte
	_, _ = rand.Read(rnd[:])
	return hex.EncodeToString(rnd[:])
}

// OwnedPIDs lists this user's processes whose environment has
// OwnerVar=owner exactly and whose command line contains substr ("" for
// any). The calling process is never listed.
func OwnedPIDs(owner, substr string) []int {
	if owner == "" {
		return nil
	}
	entries, _ := os.ReadDir("/proc")
	uid := uint32(os.Getuid())
	var out []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		dir := filepath.Join("/proc", e.Name())
		if st, err := os.Stat(dir); err != nil || st.Sys().(*syscall.Stat_t).Uid != uid {
			continue
		}
		if !hasEntry(dir, "environ", OwnerVar+"="+owner) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, "cmdline"))
		if err != nil {
			continue
		}
		if strings.Contains(strings.ReplaceAll(string(raw), "\x00", " "), substr) {
			out = append(out, pid)
		}
	}
	return out
}

// hasEntry reports whether the NUL-separated /proc file dir/name has an
// entry equal to want.
func hasEntry(dir, name, want string) bool {
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return false
	}
	for kv := range strings.SplitSeq(string(raw), "\x00") {
		if kv == want {
			return true
		}
	}
	return false
}

// KillOwned ends owner's processes (SIGTERM, then SIGKILL for any still
// there) and returns those that survived both.
func KillOwned(owner string) []int {
	for _, pid := range OwnedPIDs(owner, "") {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	time.Sleep(300 * time.Millisecond)
	for _, pid := range OwnedPIDs(owner, "") {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	time.Sleep(100 * time.Millisecond)
	return OwnedPIDs(owner, "")
}

package codexapp

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Server is a running shared-server launch's app-server process, as the
// bridge recorded it: its pid and its start time (clock ticks since boot,
// /proc/<pid>/stat field 22), so a reused pid is not mistaken for it.
type Server struct {
	PID   int
	Start uint64
}

// procRoot is /proc (tests point it elsewhere).
var procRoot = "/proc"

// MarkedPIDs lists this user's processes whose environment has
// MarkerVar=token exactly and whose command line contains substr ("" for
// any). The calling process is never listed.
func MarkedPIDs(token, substr string) []int {
	if !tokenRe.MatchString(token) {
		return nil
	}
	entries, _ := os.ReadDir(procRoot)
	var out []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		if marked(pid, token) && strings.Contains(cmdline(pid), substr) {
			out = append(out, pid)
		}
	}
	return out
}

// marked reports whether pid is this user's and carries MarkerVar=token.
func marked(pid int, token string) bool {
	dir := filepath.Join(procRoot, strconv.Itoa(pid))
	st, err := os.Stat(dir)
	if err != nil {
		return false
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); !ok || int(sys.Uid) != os.Getuid() {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(dir, "environ"))
	if err != nil {
		return false
	}
	want := MarkerVar + "=" + token
	for kv := range strings.SplitSeq(string(raw), "\x00") {
		if kv == want {
			return true
		}
	}
	return false
}

func cmdline(pid int) string {
	raw, _ := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "cmdline"))
	return strings.ReplaceAll(string(raw), "\x00", " ")
}

// startTime is /proc/<pid>/stat field 22.
func startTime(pid int) (uint64, error) {
	raw, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	// comm (field 2) may hold spaces and parentheses: fields restart after
	// the last ')'.
	i := strings.LastIndexByte(string(raw), ')')
	if i < 0 {
		return 0, errors.New("codexapp: unreadable stat")
	}
	f := strings.Fields(string(raw[i+1:]))
	if len(f) < 20 {
		return 0, errors.New("codexapp: short stat")
	}
	return strconv.ParseUint(f[19], 10, 64) // field 22 is the 20th after comm
}

// FindServer finds the launch's app-server process: marked with its token
// and listening on its socket.
func FindServer(l Launch) (Server, error) {
	pids := MarkedPIDs(l.Token, "app-server")
	for _, pid := range pids {
		if !strings.Contains(cmdline(pid), "--listen unix://"+l.Socket()) {
			continue
		}
		st, err := startTime(pid)
		if err != nil {
			continue
		}
		return Server{PID: pid, Start: st}, nil
	}
	return Server{}, fmt.Errorf("codexapp: no app-server process of %s is running", l.Name)
}

// Alive reports whether the recorded server is still that process: the
// pid has the same start time and still carries the launch's token.
func Alive(l Launch, s Server) bool {
	if s.PID <= 0 {
		return false
	}
	st, err := startTime(s.PID)
	return err == nil && st == s.Start && marked(s.PID, l.Token)
}

// Stop ends every process of the launch (its marked processes: the
// app-server and what it started), SIGTERM first and SIGKILL for those
// still there after grace, and returns those that survived both. A
// process without the launch's marker is never signalled.
func Stop(l Launch, grace time.Duration) []int {
	pids := MarkedPIDs(l.Token, "")
	if len(pids) == 0 {
		return nil
	}
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	for end := time.Now().Add(grace); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if len(MarkedPIDs(l.Token, "")) == 0 {
			return nil
		}
	}
	for _, pid := range MarkedPIDs(l.Token, "") {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	time.Sleep(100 * time.Millisecond)
	return MarkedPIDs(l.Token, "")
}

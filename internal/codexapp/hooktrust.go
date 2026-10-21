package codexapp

// #167: a profile that now shares the default home's setup has its own
// hooks.json with the default's commands; Codex trusts a hook by its file's
// path (`[hooks.state."<home>/hooks.json:<event>:<group>:<handler>"]`), so
// a new home would ask to review them once. SeedHookTrust trusts there, by
// Codex's own config/batchWrite (which writes through the profile's
// config.toml link into the shared file), exactly the hooks whose
// definition (currentHash, path-independent) the default home already
// trusts, and checks with hooks/list that it took: two homes writing the
// one file at once can lose an edit (Codex has no lock across processes;
// docs/decisions.md "#167"), so a miss is written once more.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// HookTrust is what SeedHookTrust did: Seeded hooks are trusted now by its
// write; Untrusted are the profile's hooks still not trusted (one the
// default does not trust either is never trusted here).
type HookTrust struct {
	Seeded    int
	Untrusted int
}

// hookEntry is the part of a hooks/list hook that is read.
type hookEntry struct {
	Key         string `json:"key"`
	Source      string `json:"source"`
	SourcePath  string `json:"sourcePath"`
	TrustStatus string `json:"trustStatus"`
	CurrentHash string `json:"currentHash"`
}

// stdioServer is `codex app-server` over stdio in a scratch folder.
type stdioServer struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	lines  *bufio.Scanner
	next   int
	dir    string
	cancel context.CancelFunc
	ctx    context.Context
}

func startStdio(ctx context.Context, codex string, env []string) (*stdioServer, error) {
	dir, err := os.MkdirTemp("", "h3d-hooks-")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &stdioServer{dir: dir, ctx: ctx, cancel: cancel}
	s.cmd = exec.CommandContext(ctx, codex, "app-server")
	s.cmd.Dir, s.cmd.Env = dir, env
	if s.in, err = s.cmd.StdinPipe(); err == nil {
		var out io.ReadCloser
		if out, err = s.cmd.StdoutPipe(); err == nil {
			s.lines = bufio.NewScanner(out)
			s.lines.Buffer(make([]byte, 64<<10), MaxMessage)
			err = s.cmd.Start()
		}
	}
	if err != nil {
		cancel()
		os.RemoveAll(dir)
		return nil, err
	}
	if err := s.call("initialize", initParams("hooks"), nil); err != nil {
		s.close()
		return nil, err
	}
	if _, err := s.in.Write([]byte(`{"method":"initialized"}` + "\n")); err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *stdioServer) close() {
	s.in.Close()
	s.cancel()
	_ = s.cmd.Wait()
	os.RemoveAll(s.dir)
}

func (s *stdioServer) call(method string, params, result any) error {
	s.next++
	req := map[string]any{"id": s.next, "method": method}
	if params != nil {
		req["params"] = params
	}
	b, err := json.Marshal(req)
	if err != nil {
		return err
	}
	if _, err := s.in.Write(append(b, '\n')); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	id := strconv.Itoa(s.next)
	for s.lines.Scan() {
		var m Message
		if json.Unmarshal(s.lines.Bytes(), &m) != nil || m.Method != "" || strings.TrimSpace(string(m.ID)) != id {
			continue // a notification, or not ours
		}
		if m.Error != nil {
			return fmt.Errorf("%s: %w", method, m.Error)
		}
		if result == nil {
			return nil
		}
		return json.Unmarshal(m.Result, result)
	}
	if err := s.ctx.Err(); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	return fmt.Errorf("%s: codex app-server ended before it answered", method)
}

// userHooks are the user-layer hooks hooks/list reports, those of the
// file file only when it is not "".
func (s *stdioServer) userHooks(file string) ([]hookEntry, error) {
	var r struct {
		Data []struct {
			Hooks []hookEntry `json:"hooks"`
		} `json:"data"`
	}
	if err := s.call("hooks/list", map[string]any{"cwds": []string{s.dir}}, &r); err != nil {
		return nil, err
	}
	var out []hookEntry
	seen := map[string]bool{}
	for _, d := range r.Data {
		for _, h := range d.Hooks {
			if h.Source != "user" || seen[h.Key] || file != "" && filepath.Clean(h.SourcePath) != file {
				continue
			}
			seen[h.Key] = true
			out = append(out, h)
		}
	}
	return out, nil
}

// SeedHookTrust trusts the hooks of home's hooks.json (home canonical,
// env its CODEX_HOME) whose definitions the default home (defEnv) trusts.
func SeedHookTrust(ctx context.Context, codex string, defEnv, env []string, home string) (HookTrust, error) {
	def, err := startStdio(ctx, codex, defEnv)
	if err != nil {
		return HookTrust{}, err
	}
	trusted := map[string]bool{}
	hooks, err := def.userHooks("")
	def.close()
	if err != nil {
		return HookTrust{}, err
	}
	for _, h := range hooks {
		if h.TrustStatus == "trusted" && h.CurrentHash != "" {
			trusted[h.CurrentHash] = true
		}
	}
	p, err := startStdio(ctx, codex, env)
	if err != nil {
		return HookTrust{}, err
	}
	defer p.close()
	file := filepath.Join(home, "hooks.json")
	var res HookTrust
	first := -1
	for try := 0; ; try++ {
		mine, err := p.userHooks(file)
		if err != nil {
			return res, err
		}
		var edits []map[string]any
		res.Untrusted = 0
		for _, h := range mine {
			if h.TrustStatus == "trusted" {
				continue
			}
			res.Untrusted++
			if trusted[h.CurrentHash] && !strings.ContainsAny(h.Key, "\"\\\n") {
				edits = append(edits, map[string]any{"keyPath": `hooks.state."` + h.Key + `".trusted_hash`, "value": h.CurrentHash, "mergeStrategy": "replace"})
			}
		}
		if first < 0 {
			first = len(edits)
		}
		if len(edits) == 0 || try == 2 { // written, and once more for a lost write
			res.Seeded = first - len(edits)
			return res, nil
		}
		if err := p.call("config/batchWrite", map[string]any{"edits": edits}, nil); err != nil {
			return res, err
		}
	}
}

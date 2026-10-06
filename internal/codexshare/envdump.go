package codexshare

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// EnvDumpVar names the directory an env-dump MCP server writes to. A test
// binary that finds it set serves ServeEnvDump instead of running tests.
const EnvDumpVar = "H3D_CODEXSHARE_ENVDUMP"

// EnvDump is what an env-dump MCP child saw when Codex started it.
type EnvDump struct {
	PID int               `json:"pid"`
	Cwd string            `json:"cwd"`
	Env map[string]string `json:"env"` // H3D_*, PATH, HOME, SHELL, HERDR_PANE_ID, CODEX_HOME
}

// dumpKey reports whether an env key is recorded (never full env: no secrets).
func dumpKey(k string) bool {
	switch k {
	case "PATH", "HOME", "SHELL", "HERDR_PANE_ID", "CODEX_HOME", "DIRENV_DIR":
		return true
	}
	return strings.HasPrefix(k, "H3D_") && k != EnvDumpVar
}

// Snapshot records the current process's cwd and recorded variables.
func Snapshot() EnvDump {
	d := EnvDump{PID: os.Getpid(), Env: map[string]string{}}
	d.Cwd, _ = os.Getwd()
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if dumpKey(k) {
			d.Env[k] = v
		}
	}
	return d
}

// ServeEnvDump writes Snapshot to dir/mcp-<pid>.json, then serves a minimal
// MCP stdio server (newline-delimited JSON-RPC) with one tool, dump_env,
// that returns the same snapshot.
func ServeEnvDump(dir string, in io.Reader, out io.Writer) error {
	d := Snapshot()
	b, _ := json.Marshal(d)
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("mcp-%d.json", d.PID)), b, 0o600); err != nil {
		return err
	}
	enc := json.NewEncoder(out)
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"params"`
		}
		if json.Unmarshal(sc.Bytes(), &req) != nil || len(req.ID) == 0 {
			continue // notifications need no answer
		}
		var result any
		switch req.Method {
		case "initialize":
			pv := req.Params.ProtocolVersion
			if pv == "" {
				pv = "2025-06-18"
			}
			result = map[string]any{
				"protocolVersion": pv,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "h3d-envdump", "version": "0.0.0"},
			}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{
				"name":        "dump_env",
				"description": "Return the fixture variables this MCP server process sees.",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			}}}
		case "tools/call":
			keys := make([]string, 0, len(d.Env))
			for k := range d.Env {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			var lines []string
			for _, k := range keys {
				lines = append(lines, k+"="+d.Env[k])
			}
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": strings.Join(lines, "\n")}}}
		default:
			result = map[string]any{}
		}
		if err := enc.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}); err != nil {
			return err
		}
	}
	return sc.Err()
}

// ReadEnvDumps reads every dump in dir.
func ReadEnvDumps(dir string) ([]EnvDump, error) {
	files, err := filepath.Glob(filepath.Join(dir, "mcp-*.json"))
	if err != nil {
		return nil, err
	}
	var out []EnvDump
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var d EnvDump
		if err := json.Unmarshal(b, &d); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		out = append(out, d)
	}
	return out, nil
}

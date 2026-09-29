package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/execpath"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// The test executable stands in for either CLI; no installed harness or
// credentials are used by the tests.
func TestMain(m *testing.M) {
	if scenario := os.Getenv("H3D_MODEL_PROBE_TEST"); scenario != "" {
		fakeHarness(scenario)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeHarness(scenario string) {
	trace, err := os.Create(os.Getenv("H3D_MODEL_PROBE_TRACE"))
	if err != nil {
		os.Exit(2)
	}
	cwd, _ := os.Getwd()
	_ = json.NewEncoder(trace).Encode(map[string]any{"pid": os.Getpid(), "args": os.Args[1:], "cwd": cwd,
		"herdr": os.Getenv("HERDR_SESSION"), "claudecode": os.Getenv("CLAUDECODE"), "codex_home": os.Getenv("CODEX_HOME")})
	input := bufio.NewScanner(os.Stdin)
	read := func() map[string]any {
		if !input.Scan() {
			os.Exit(3)
		}
		var msg map[string]any
		if json.Unmarshal(input.Bytes(), &msg) != nil {
			os.Exit(4)
		}
		_ = json.NewEncoder(trace).Encode(msg)
		return msg
	}
	write := func(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
	first := read()
	if scenario == "hang" {
		for input.Scan() {
		}
		return
	}
	if scenario == "malformed" {
		fmt.Println("not JSON")
		return
	}
	if scenario == "oversize" {
		fmt.Println(strings.Repeat("x", 1<<20))
		return
	}
	if strings.HasPrefix(scenario, "claude") {
		if first["type"] != "control_request" || first["request"].(map[string]any)["subtype"] != "initialize" {
			os.Exit(5)
		}
		models := []map[string]any{
			{"value": "default", "resolvedModel": "claude-future", "supportedEffortLevels": []string{"medium", "high", "max"}},
			{"value": "opus", "resolvedModel": "claude-future", "supportedEffortLevels": []string{"medium", "high", "max"}},
			{"value": "custom-model", "supportedEffortLevels": []string{"medium", "max"}},
		}
		if scenario == "claude-legacy" {
			models = []map[string]any{{"value": "sonnet"}, {"value": "opus", "resolvedModel": "provider:custom/model", "supportedEffortLevels": []string{"medium", "high"}}}
		}
		subtype := "success"
		if scenario == "claude-error" {
			subtype = "error"
		}
		write(map[string]any{"type": "system", "subtype": "unrelated"})
		write(map[string]any{"type": "control_response", "response": map[string]any{"request_id": "unrelated", "subtype": "success"}})
		write(map[string]any{"type": "control_response", "response": map[string]any{"request_id": first["request_id"],
			"subtype": subtype, "response": map[string]any{"models": models}}})
	} else {
		if first["method"] != "initialize" {
			os.Exit(6)
		}
		write(map[string]any{"id": first["id"], "result": map[string]any{}})
		if read()["method"] != "initialized" {
			os.Exit(7)
		}
		for page := 0; page < 2; page++ {
			req := read()
			if req["method"] != "model/list" {
				os.Exit(8)
			}
			params := req["params"].(map[string]any)
			if params["includeHidden"] != false || (page == 1 && params["cursor"] != "page-2") {
				os.Exit(9)
			}
			if scenario == "rpc-error" {
				write(map[string]any{"id": req["id"], "error": map[string]any{"code": -32601, "message": "unsupported"}})
				break
			}
			entry := func(id string, efforts ...string) map[string]any {
				levels := []map[string]string{}
				for _, e := range efforts {
					levels = append(levels, map[string]string{"reasoningEffort": e})
				}
				return map[string]any{"model": id, "supportedReasoningEfforts": levels}
			}
			data := []map[string]any{entry("gpt-6.1-sol", "low", "high", "ultra"), entry("gpt-hidden", "low"), entry("--help", "low")}
			data[1]["hidden"] = true
			var cursor any = "page-2"
			if page == 1 {
				data = []map[string]any{entry("gpt-future", "high"), entry("gpt-6.1-sol", "low", "high", "ultra")}
				cursor = nil
			}
			if scenario == "cycle" {
				cursor = "page-2"
			}
			if scenario == "empty" {
				data, cursor = []map[string]any{}, nil
			}
			write(map[string]any{"method": "unrelated", "params": map[string]any{}})
			write(map[string]any{"id": req["id"], "result": map[string]any{"data": data, "nextCursor": cursor}})
			if cursor == nil {
				break
			}
		}
	}
	for input.Scan() { // any unexpected turn is recorded before the probe exits
		_, _ = trace.Write(append(input.Bytes(), '\n'))
	}
}

func fakeBin(t *testing.T, scenario string) (string, string) {
	t.Helper()
	trace := filepath.Join(t.TempDir(), "probe.jsonl")
	t.Setenv("H3D_MODEL_PROBE_TEST", scenario)
	t.Setenv("H3D_MODEL_PROBE_TRACE", trace)
	return os.Args[0], trace
}

func TestCodexCatalog(t *testing.T) {
	bin, trace := fakeBin(t, "codex")
	t.Setenv("HERDR_SESSION", "parent-session")
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CODEX_HOME", "/configured/codex")
	got, err := Codex(context.Background(), bin)
	want := proto.HarnessOptions{Models: []string{"gpt-6.1-sol", "gpt-future"}, Efforts: []string{"high"},
		ExtraEfforts: map[string][]string{"gpt-6.1-sol": {"low", "ultra"}}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog = %+v, %v; want %+v", got, err, want)
	}
	data, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 5 { // process metadata, initialize, initialized, two pages
		t.Fatalf("requests = %s", data)
	}
	var meta struct {
		PID        int      `json:"pid"`
		Args       []string `json:"args"`
		Cwd        string   `json:"cwd"`
		Herdr      string   `json:"herdr"`
		ClaudeCode string   `json:"claudecode"`
		CodexHome  string   `json:"codex_home"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &meta); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(meta.Args, []string{"app-server"}) || meta.Herdr != "" || meta.ClaudeCode != "" || meta.CodexHome != "/configured/codex" {
		t.Fatalf("probe metadata = %s", lines[0])
	}
	if err := syscall.Kill(meta.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("probe still exists: %v", err)
	}
	if _, err := os.Stat(meta.Cwd); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("probe cwd wasn't removed: %v", err)
	}
}

func TestClaudeCatalog(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprint(legacy), func(t *testing.T) {
			scenario := "claude"
			want := proto.HarnessOptions{Models: []string{"claude-future", "custom-model"}, Efforts: []string{"medium", "max"},
				ExtraEfforts: map[string][]string{"claude-future": {"high"}}}
			if legacy {
				scenario = "claude-legacy"
				want = proto.HarnessOptions{Models: []string{"sonnet", "opus"}, Efforts: []string{"medium", "high"}, ExtraEfforts: map[string][]string{"sonnet": {"low"}}}
			}
			bin, trace := fakeBin(t, scenario)
			got, err := Claude(context.Background(), bin)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("catalog = %+v, %v; want %+v", got, err, want)
			}
			data, _ := os.ReadFile(trace)
			lines := strings.Split(strings.TrimSpace(string(data)), "\n")
			if len(lines) != 2 {
				t.Fatalf("unexpected requests = %s", data)
			}
			var meta struct {
				Args []string `json:"args"`
			}
			_ = json.Unmarshal([]byte(lines[0]), &meta)
			if !slices.Equal(meta.Args, []string{"--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
				"--no-session-persistence", "--strict-mcp-config", "--tools", "", "--settings", `{"disableAllHooks":true}`}) {
				t.Fatalf("Claude argv = %q", meta.Args)
			}
		})
	}
}

func TestProbeFailures(t *testing.T) {
	for _, scenario := range []string{"rpc-error", "cycle", "empty", "malformed", "oversize", "claude-error"} {
		t.Run(scenario, func(t *testing.T) {
			bin, _ := fakeBin(t, scenario)
			discover := Codex
			if strings.HasPrefix(scenario, "claude") {
				discover = Claude
			}
			if _, err := discover(context.Background(), bin); err == nil {
				t.Fatal("invalid catalog accepted")
			}
		})
	}
	t.Run("canceled", func(t *testing.T) {
		bin, _ := fakeBin(t, "hang")
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		start := time.Now()
		if _, err := Codex(ctx, bin); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("hung probe: %v", err)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatal("probe didn't respect cancellation")
		}
	})
	t.Run("missing", func(t *testing.T) {
		if _, err := Codex(context.Background(), filepath.Join(t.TempDir(), "missing")); err == nil {
			t.Fatal("missing CLI accepted")
		}
	})
}

func TestCatalogWithDisjointEfforts(t *testing.T) {
	got, err := options([]model{{"a", []string{"low", "low", "--invalid"}}, {"b", []string{"high"}}, {"bad model", []string{"high"}}})
	want := proto.HarnessOptions{Models: []string{"a", "b"}, Efforts: []string{}, ExtraEfforts: map[string][]string{"a": {"low"}, "b": {"high"}}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("catalog = %+v, %v; want %+v", got, err, want)
	}
}

func TestBinaryLookupForService(t *testing.T) {
	bin, _ := fakeBin(t, "codex")
	home := t.TempDir()
	local := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(local, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(bin, filepath.Join(local, "codex")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	pathDir := t.TempDir()
	t.Setenv("PATH", pathDir)
	// The real default CLI path must work under the service's restricted PATH.
	if got, err := Codex(context.Background(), ""); err != nil || !slices.Contains(got.Models, "gpt-6.1-sol") {
		t.Fatalf("service discovery = %+v, %v", got, err)
	}
	pathBin := filepath.Join(pathDir, "codex")
	if err := os.Symlink(bin, pathBin); err != nil {
		t.Fatal(err)
	}
	if got := execpath.Resolve("codex"); got != pathBin {
		t.Fatalf("PATH precedence: %q, want %q", got, pathBin)
	}
	if got := execpath.Resolve(filepath.Join(local, "codex")); got != filepath.Join(local, "codex") {
		t.Fatalf("explicit path: %q", got)
	}
}

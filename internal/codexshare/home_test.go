package codexshare

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
)

func TestWriteHomeIsSelfContained(t *testing.T) {
	dir := t.TempDir()
	err := WriteHome(dir, HomeOptions{
		MockURL: "http://127.0.0.1:1234/v1",
		Trusted: []string{"/tmp/ws \"a\""},
		Top:     `developer_instructions = "dev"`,
		Extra:   "[shell_environment_policy]\ninherit = \"all\"",
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := os.ReadFile(filepath.Join(dir, "config.toml"))
	if top, _, _ := strings.Cut(string(cfg), "["); !strings.Contains(top, `developer_instructions = "dev"`) {
		t.Errorf("top-level keys must precede the first table:\n%s", cfg)
	}
	for _, want := range []string{
		`model_provider = "mock"`,
		`model_catalog_json = "` + filepath.Join(dir, "catalog.json") + `"`,
		`base_url = "http://127.0.0.1:1234/v1"`,
		`requires_openai_auth = false`,
		`supports_websockets = false`,
		`check_for_update_on_startup = false`,
		`approval_policy = "never"`,
		`sandbox_mode = "danger-full-access"`,
		`[projects."/tmp/ws \"a\""]`,
		`[shell_environment_policy]`,
		`metrics_exporter = "none"`,
	} {
		if !strings.Contains(string(cfg), want) {
			t.Errorf("config.toml lacks %s:\n%s", want, cfg)
		}
	}
	var cat struct {
		Models []struct {
			Slug                       string   `json:"slug"`
			ToolMode                   string   `json:"tool_mode"`
			PreferWebsockets           bool     `json:"prefer_websockets"`
			ExperimentalSupportedTools []string `json:"experimental_supported_tools"`
		} `json:"models"`
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "catalog.json"))
	if err := json.Unmarshal(raw, &cat); err != nil || len(cat.Models) != 1 {
		t.Fatalf("catalog: %v", err)
	}
	m := cat.Models[0]
	if m.Slug != "mock" || m.ToolMode != "direct" || m.PreferWebsockets || len(m.ExperimentalSupportedTools) != 1 ||
		m.ExperimentalSupportedTools[0] != "request_user_input_async" {
		t.Fatalf("catalog model %+v", m)
	}
	settings, _ := os.ReadFile(filepath.Join(dir, "app-server-daemon", "settings.json"))
	if !strings.Contains(string(settings), `"autoUpdateEnabled":false`) {
		t.Fatalf("daemon settings %s", settings)
	}
}

func TestCleanEnvDropsRetargetingVariables(t *testing.T) {
	env := []string{
		"PATH=/bin", "HOME=/h", "CODEX_HOME=/h/.codex", "CODEX_THREAD_ID=x", "OPENAI_API_KEY=k", "OTEL_X=1",
		"HERDR_PANE_ID=w1:p1", "HERDR_SOCKET_PATH=/s", "CLAUDECODE=1", "PARALLEL_API_KEY=p", "SHELL=/bin/bash",
	}
	got := strings.Join(CleanEnv(env, "CODEX_HOME=/tmp/home", "SHELL=/bin/fish"), " ")
	if want := "PATH=/bin HOME=/h CODEX_HOME=/tmp/home SHELL=/bin/fish"; got != want {
		t.Fatalf("CleanEnv = %q, want %q", got, want)
	}
}

// #186: the fixture runs on exactly the verified versions, each of them a
// release the production gate accepts.
func TestCheckFixtureCodex(t *testing.T) {
	for out, ok := range map[string]bool{
		"codex-cli 0.160.1\n": true, "codex-cli 0.161.0": true,
		"codex-cli 0.160.2": false, "codex-cli 0.161.1": false, "codex-cli 0.162.0": false, "codex-cli 0.159.9": false, "": false,
	} {
		if err := CheckFixtureCodex(out); (err == nil) != ok {
			t.Errorf("CheckFixtureCodex(%q) = %v", out, err)
		}
	}
	if err := CheckFixtureCodex("codex-cli 0.162.0"); err == nil ||
		err.Error() != `codex --version = "codex-cli 0.162.0": the fixture is verified with codex-cli 0.160.1, codex-cli 0.161.0 only` {
		t.Errorf("error %v", err)
	}
	for _, v := range VerifiedCodex {
		if err := codexapp.CheckVersion(v); err != nil {
			t.Errorf("the fixture's %s is not a supported line: %v", v, err)
		}
	}
}

package codexshare

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteHomeIsSelfContained(t *testing.T) {
	dir := t.TempDir()
	err := WriteHome(dir, HomeOptions{
		MockURL: "http://127.0.0.1:1234/v1",
		Trusted: []string{"/tmp/ws \"a\""},
		Extra:   "[shell_environment_policy]\ninherit = \"all\"",
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := os.ReadFile(filepath.Join(dir, "config.toml"))
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

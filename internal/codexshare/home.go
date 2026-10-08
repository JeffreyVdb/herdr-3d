package codexshare

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// VerifiedCodex are the exact Codex versions (`codex --version`) the
// fixture was verified with: 0.160.1 (#154/#155), 0.161.0 (#186). The
// integration tests skip on any other, loudly: verifying a release is
// adding it here and to codexapp.SupportedLines, then running
// `make codex-shared-tui` without a version skip
// (docs/research/codex-shared-tui.md).
var VerifiedCodex = []string{"codex-cli 0.160.1", "codex-cli 0.161.0"}

// CheckFixtureCodex checks `codex --version` output against VerifiedCodex.
func CheckFixtureCodex(out string) error {
	v := strings.TrimSpace(out)
	if !slices.Contains(VerifiedCodex, v) {
		return fmt.Errorf("codex --version = %q: the fixture is verified with %s only", v, strings.Join(VerifiedCodex, ", "))
	}
	return nil
}

// catalog is a one-model catalog for the mock provider (loaded unchanged by
// 0.160.1 and 0.161.0): rust-v0.160.1's
// codex-rs/models-manager/models.json "gpt-6-astra" entry with slug "mock",
// tool_mode "direct", prefer_websockets and use_responses_lite false and
// experimental_supported_tools ["request_user_input_async"] (the only way
// to expose the async question tool in this tag).
//
//go:embed catalog.json
var catalog []byte

// HomeOptions configure an isolated CODEX_HOME.
type HomeOptions struct {
	MockURL        string   // the mock's base URL (Mock.URL)
	Trusted        []string // project directories to pre-trust
	ApprovalPolicy string   // default "never"
	Sandbox        string   // default "danger-full-access"
	Top            string   // raw top-level TOML keys, written before any table
	Extra          string   // raw TOML appended (MCP servers, shell policy, …)
}

// WriteHome writes config.toml and the mock model catalog into dir, a
// throwaway CODEX_HOME. It never reads or writes ~/.codex. Update checks,
// analytics, feedback and every OTEL exporter are off, and the managed
// daemon's updater is disabled for a daemon started from this home.
func WriteHome(dir string, o HomeOptions) error {
	if o.ApprovalPolicy == "" {
		o.ApprovalPolicy = "never"
	}
	if o.Sandbox == "" {
		o.Sandbox = "danger-full-access"
	}
	if err := os.MkdirAll(filepath.Join(dir, "app-server-daemon"), 0o700); err != nil {
		return err
	}
	cat := filepath.Join(dir, "catalog.json")
	if err := os.WriteFile(cat, catalog, 0o600); err != nil {
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "model = \"mock\"\nmodel_provider = \"mock\"\nmodel_catalog_json = %s\n", tomlString(cat))
	b.WriteString("check_for_update_on_startup = false\n")
	fmt.Fprintf(&b, "approval_policy = %s\nsandbox_mode = %s\n", tomlString(o.ApprovalPolicy), tomlString(o.Sandbox))
	b.WriteString("web_search = \"disabled\"\n")
	if o.Top != "" {
		b.WriteString(o.Top + "\n")
	}
	b.WriteString("\n")
	b.WriteString("[model_providers.mock]\nname = \"Local mock\"\n")
	fmt.Fprintf(&b, "base_url = %s\n", tomlString(o.MockURL))
	b.WriteString("wire_api = \"responses\"\nrequires_openai_auth = false\nsupports_websockets = false\n\n")
	b.WriteString("[analytics]\nenabled = false\n\n[feedback]\nenabled = false\n\n")
	b.WriteString("[otel]\nexporter = \"none\"\ntrace_exporter = \"none\"\nmetrics_exporter = \"none\"\n")
	for _, p := range o.Trusted {
		fmt.Fprintf(&b, "\n[projects.%s]\ntrust_level = \"trusted\"\n", tomlString(p))
	}
	if o.Extra != "" {
		b.WriteString("\n" + o.Extra + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "app-server-daemon", "settings.json"),
		[]byte(`{"updater":{"autoUpdateEnabled":false}}`+"\n"), 0o600)
}

// tomlString quotes s as a TOML basic string.
func tomlString(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`)
	return `"` + r.Replace(s) + `"`
}

// TOMLString quotes s as a TOML basic string, for HomeOptions.Extra.
func TOMLString(s string) string { return tomlString(s) }

// dropped are variables that must not reach a fixture's Codex: they would
// retarget it at the user's home, a real provider, another server or the
// caller's herdr pane.
var dropped = []string{"CODEX_", "OPENAI_", "OTEL_", "HERDR_", "CLAUDE", "PARALLEL_API_KEY"}

// CleanEnv returns env without Codex, OpenAI, OTEL, herdr pane and Claude
// variables, then sets the pairs in set (KEY=VALUE).
func CleanEnv(env []string, set ...string) []string {
	out := make([]string, 0, len(env)+len(set))
next:
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		for _, p := range dropped {
			if strings.HasPrefix(k, p) {
				continue next
			}
		}
		for _, s := range set {
			if sk, _, _ := strings.Cut(s, "="); sk == k {
				continue next
			}
		}
		out = append(out, kv)
	}
	return append(out, set...)
}

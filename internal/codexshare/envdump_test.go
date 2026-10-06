package codexshare

import (
	"bufio"
	"encoding/json"
	"strings"
	"testing"
)

func TestServeEnvDumpRecordsOnlyFixtureVariables(t *testing.T) {
	t.Setenv("H3D_DIRENV_SENTINEL", "ws-a")
	t.Setenv("SECRET_TOKEN", "never-recorded")
	dir := t.TempDir()
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dump_env"}}`,
	}, "\n") + "\n"
	var out strings.Builder
	if err := ServeEnvDump(dir, strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var replies []map[string]any
	sc := bufio.NewScanner(strings.NewReader(out.String()))
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		replies = append(replies, m)
	}
	if len(replies) != 3 {
		t.Fatalf("replies %v", replies)
	}
	if pv := replies[0]["result"].(map[string]any)["protocolVersion"]; pv != "2025-03-26" {
		t.Fatalf("protocol %v", pv)
	}
	if !strings.Contains(out.String(), "H3D_DIRENV_SENTINEL=ws-a") || strings.Contains(out.String(), "never-recorded") {
		t.Fatalf("tool output %s", out.String())
	}
	dumps, err := ReadEnvDumps(dir)
	if err != nil || len(dumps) != 1 || dumps[0].Env["H3D_DIRENV_SENTINEL"] != "ws-a" || dumps[0].Env["SECRET_TOKEN"] != "" {
		t.Fatalf("dumps %+v %v", dumps, err)
	}
}

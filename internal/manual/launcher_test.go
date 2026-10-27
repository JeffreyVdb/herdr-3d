package manual

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLaunchRecordsExit(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "command"), []byte("exit 7"), 0600); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(LaunchConfig{Shell: "/bin/bash"})
	if err := os.WriteFile(filepath.Join(dir, "launch.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Launch(dir, &out); err != nil {
		t.Fatal(err)
	}
	status, err := ReadStatus(dir)
	if err != nil || status.ExitCode == nil || *status.ExitCode != 7 || status.PID <= 0 || status.StartTicks == 0 {
		t.Fatalf("status=%+v err=%v", status, err)
	}
}

func TestLaunchRecordsMissingShell(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "command"), []byte("echo never"), 0600); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(LaunchConfig{Shell: filepath.Join(dir, "missing-shell")})
	if err := os.WriteFile(filepath.Join(dir, "launch.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Launch(dir, &out); err == nil {
		t.Fatal("missing shell accepted")
	}
	status, err := ReadStatus(dir)
	if err != nil || status.Error == "" || status.EndedAt == 0 {
		t.Fatalf("status=%+v err=%v", status, err)
	}
}

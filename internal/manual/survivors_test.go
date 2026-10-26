package manual

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRecordSurvivorsPersistsReverifiedIdentities(t *testing.T) {
	dir := t.TempDir()
	ticks, err := StartTicks(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	id := Identity{PID: os.Getpid(), StartTicks: ticks}
	if err := RecordSurvivors(dir, []Identity{id, id}); err != nil {
		t.Fatal(err)
	}
	got, err := ReadSurvivors(dir)
	if err != nil || len(got) != 1 || got[0] != id {
		t.Fatalf("recorded: %+v %v", got, err)
	}
	if err := RecordSurvivors(dir, nil); err != nil {
		t.Fatal(err)
	}
	got, err = ReadSurvivors(dir)
	if err != nil || len(got) != 1 || got[0] != id {
		t.Fatalf("retained: %+v %v", got, err)
	}
	info, err := os.Stat(filepath.Join(dir, "survivors.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("mode: %v %v", info, err)
	}
}

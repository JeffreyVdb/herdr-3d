package manual

import (
	"os"
	"testing"
)

func TestIdentityMatchesCurrentProcess(t *testing.T) {
	ticks, err := StartTicks(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !IdentityAlive(os.Getpid(), ticks) {
		t.Fatal("current identity not found")
	}
	if IdentityAlive(os.Getpid(), ticks+1) {
		t.Fatal("reused PID matched")
	}
	if IdentityAlive(0, ticks) {
		t.Fatal("invalid PID matched")
	}
}

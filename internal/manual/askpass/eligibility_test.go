package askpass

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var updateEligibility = flag.Bool("update-eligibility", false, "rewrite testdata/eligibility.json")

// eligibilityCases are the commands both sides of #213's parity check judge:
// the bridge's Rewrite here, the game's askpassEligible / askpassForm in
// game/src/ui/manualProcesses.test.ts (it reads testdata/eligibility.json).
var eligibilityCases = []string{
	// The user's real launch shape: the form's text ends in a newline.
	"sudo -k python3 tools/hello_world_server.py 80\n",
	"sudo -k python3 tools/hello_world_server.py 80",
	"sudo -k python3 tools/hello_world_server.py 80\r\n",
	"sudo -k python3 tools/hello_world_server.py 80 \t\n\n",
	"sudo systemctl restart nginx",
	"sudo cmd",
	"sudo\tcmd",
	" \tsudo cmd",
	"sudo -u root cmd",
	"sudo -u postgres psql",
	"sudo --user=alice cmd",
	"sudo -E cmd",
	"sudo -kE cmd",
	"sudo -- cmd",
	`sudo -u 'root' echo "hello world"`,
	`sudo echo 'literal | pipe'`,
	"sudo -p prompt cmd",
	// Not eligible: sudo's own prompt modes, composition, substitutions, other shapes.
	"sudo",
	"sudo ",
	"sudo\n",
	"sudo -k",
	"sudo -k\n",
	"sudo --",
	"sudo -A cmd",
	"sudo -S cmd",
	"sudo -n cmd",
	"sudo -En cmd",
	"sudo --askpass cmd",
	"sudo --stdin cmd",
	"sudo --non cmd",
	"sudo --non-interactive cmd",
	"sudo cmd\ncat",
	"sudo cmd\n\ncat\n",
	"sudo cmd | cat",
	"sudo cmd && cat",
	"sudo cmd; cat",
	"sudo cmd > out",
	`sudo echo "$(whoami)"`,
	"sudo echo `whoami`",
	"sudo echo $HOME",
	"sudo -u",
	"sudoedit file",
	"bash -c sudo",
	"FOO=1 sudo cmd",
	"echo sudo cmd",
	"\nsudo cmd",
}

type eligibilityCase struct {
	Command  string  `json:"command"`
	Eligible bool    `json:"eligible"`
	Launched *string `json:"launched"`
}

func eligibilityVectors() []eligibilityCase {
	out := make([]eligibilityCase, 0, len(eligibilityCases))
	for _, c := range eligibilityCases {
		v := eligibilityCase{Command: c}
		if launched, ok := Rewrite(c); ok {
			v.Eligible, v.Launched = true, &launched
		}
		out = append(out, v)
	}
	return out
}

// TestEligibilityVectors keeps testdata/eligibility.json the bridge's own
// verdicts (contract §2: the bridge is the authority). With
// -update-eligibility it rewrites the file.
func TestEligibilityVectors(t *testing.T) {
	b, err := json.MarshalIndent(eligibilityVectors(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	path := filepath.Join("testdata", "eligibility.json")
	if *updateEligibility {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, b) {
		t.Fatalf("%s is out of date: go test ./internal/manual/askpass -run TestEligibilityVectors -update-eligibility", path)
	}
}

// The user's launch: -A inserted after sudo, every other byte (the trailing
// newline too) unchanged; the target account still resolves.
func TestRewriteRealLaunchShape(t *testing.T) {
	got, ok := Rewrite("sudo -k python3 tools/hello_world_server.py 80\n")
	if !ok || got != "sudo -A -k python3 tools/hello_world_server.py 80\n" {
		t.Fatalf("got %q, %v", got, ok)
	}
	if u := User("sudo -A -u alice cmd\n"); u != "alice" {
		t.Fatalf("User with a trailing newline = %q", u)
	}
}

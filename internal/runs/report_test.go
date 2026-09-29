package runs_test

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/runs"
)

func intp(n int) *int       { return &n }
func strp(s string) *string { return &s }

func TestValidName(t *testing.T) {
	for _, ok := range []string{"20260929-0746-m6-freelnc", "code-runs-r1.json", "a", "A.b_c-d", strings.Repeat("x", 80), "a.."} {
		if !runs.ValidName(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "..", ".", ".hidden", "-x", "_x", "a/b", "../x", "a b", strings.Repeat("x", 81), "é", "a\n"} {
		if runs.ValidName(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
	if r := runs.Initial("..", "x.json"); r.State != proto.ReportInvalid || r.Error == "" {
		t.Errorf("bad run = %+v", r)
	}
	if r := runs.Initial("run", "../x.json"); r.State != proto.ReportInvalid || r.Error == "" {
		t.Errorf("bad name = %+v", r)
	}
	if r := runs.Initial("run", "x.json"); r.State != proto.ReportPending {
		t.Errorf("good names = %+v", r)
	}
}

func TestParse(t *testing.T) {
	long := strings.Repeat("é", 400) // 800 bytes
	for _, tc := range []struct {
		name, role, data string
		want             proto.RunReport
	}{
		{"coder", "code", `{"input_required":null,"summary":"done, head abc","crucial_bits":[]}`,
			proto.RunReport{State: "ready", At: 5, Summary: "done, head abc"}},
		{"coder summary cut", "code", `{"summary":"` + long + `"}`,
			proto.RunReport{State: "ready", At: 5, Summary: strings.Repeat("é", 150)}},
		{"researcher", "ground", `{"summary":"found it","input_required":null}`,
			proto.RunReport{State: "ready", At: 5, Summary: "found it"}},
		{"coder needs input", "code", `{"input_required":"Which port should the demo use?","summary":"half"}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp("Which port should the demo use?"), Summary: "half"}},
		{"input cut", "code", `{"input_required":"` + long + `"}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp(strings.Repeat("é", 250))}},
		{"empty input is none", "code", `{"input_required":""}`, proto.RunReport{State: "ready", At: 5}},
		{"pass", "review", `{"verdict":"PASS","input_required":null,"issues_found":[{"priority":"nit"}]}`,
			proto.RunReport{State: "ready", At: 5, Verdict: "PASS", Blockers: intp(0), Issues: intp(1)}},
		{"changes required", "review", `{"verdict":"CHANGES_REQUIRED","issues_found":[{"id":"R1","priority":"BLOCKER"},
			{"id":"R2","priority":"medium"},{"id":"R3","priority":"BLOCKER"},{"id":"R4","priority":"low"},"odd"]}`,
			proto.RunReport{State: "ready", At: 5, Verdict: "CHANGES_REQUIRED", Blockers: intp(2), Issues: intp(5)}},
		{"incomplete ux", "ux", `{"verdict":"INCOMPLETE","issues_found":[]}`,
			proto.RunReport{State: "ready", At: 5, Verdict: "INCOMPLETE", Blockers: intp(0), Issues: intp(0)}},
		{"reviewer without issues_found", "review", `{"verdict":"PASS"}`,
			proto.RunReport{State: "ready", At: 5, Verdict: "PASS", Blockers: intp(0), Issues: intp(0)}},
		{"reviewer needs input", "review", `{"verdict":null,"input_required":"base SHA?"}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp("base SHA?")}},
		{"a coder's verdict is ignored", "code", `{"verdict":"nonsense","summary":"s"}`,
			proto.RunReport{State: "ready", At: 5, Summary: "s"}},
		{"no summary for reviewers", "review", `{"verdict":"PASS","summary":"s"}`,
			proto.RunReport{State: "ready", At: 5, Verdict: "PASS", Blockers: intp(0), Issues: intp(0)}},
		{"bad verdict", "review", `{"verdict":"LGTM"}`, proto.RunReport{State: "invalid", At: 5, Error: "bad verdict"}},
		{"verdict not a string", "ux", `{"verdict":1}`, proto.RunReport{State: "invalid", At: 5, Error: "bad verdict"}},
		{"no verdict", "review", `{"issues_found":[]}`, proto.RunReport{State: "invalid", At: 5, Error: "no verdict"}},
		{"issues not an array", "review", `{"verdict":"PASS","issues_found":{}}`,
			proto.RunReport{State: "invalid", At: 5, Error: "issues_found is not an array"}},
		{"array", "code", `[1,2]`, proto.RunReport{State: "invalid", At: 5, Error: "not a JSON object"}},
		{"null", "code", `null`, proto.RunReport{State: "invalid", At: 5, Error: "not a JSON object"}},
		{"garbage", "code", `{"summary":`, proto.RunReport{State: "invalid", At: 5, Error: "not a JSON object"}},
		{"input not a string", "code", `{"input_required":true}`,
			proto.RunReport{State: "invalid", At: 5, Error: "input_required is not a string"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := runs.Parse([]byte(tc.data), tc.role, 5); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %s, want %s", show(got), show(tc.want))
			}
		})
	}
}

func show(r proto.RunReport) string {
	s := fmt.Sprintf("%s at=%d verdict=%q summary=%q error=%q", r.State, r.At, r.Verdict, r.Summary, r.Error)
	if r.Blockers != nil {
		s += fmt.Sprintf(" blockers=%d", *r.Blockers)
	}
	if r.Issues != nil {
		s += fmt.Sprintf(" issues=%d", *r.Issues)
	}
	if r.InputRequired != nil {
		s += fmt.Sprintf(" input=%q", *r.InputRequired)
	}
	return s
}

func TestRead(t *testing.T) {
	dir := t.TempDir()
	run := filepath.Join(dir, "run-1")
	if err := os.Mkdir(run, 0o755); err != nil {
		t.Fatal(err)
	}
	if r := runs.Read(dir, "run-1", "code-r1.json", "code"); r.State != proto.ReportPending {
		t.Fatalf("absent = %+v", r)
	}
	if _, ok, err := runs.Stat(dir, "run-1", "code-r1.json"); ok || err != nil {
		t.Fatalf("absent stat = %v %v", ok, err)
	}
	// Published by rename, as write-code does.
	tmp := filepath.Join(run, "code-r1.json.tmp")
	if err := os.WriteFile(tmp, []byte(`{"summary":"ok"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(run, "code-r1.json")); err != nil {
		t.Fatal(err)
	}
	st, ok, err := runs.Stat(dir, "run-1", "code-r1.json")
	if !ok || err != nil || st.Size != int64(len(`{"summary":"ok"}`)) {
		t.Fatalf("stat = %+v %v %v", st, ok, err)
	}
	r := runs.Read(dir, "run-1", "code-r1.json", "code")
	fi, _ := os.Stat(filepath.Join(run, "code-r1.json"))
	if r.State != proto.ReportReady || r.Summary != "ok" || r.At != fi.ModTime().UnixMilli() {
		t.Fatalf("ready = %+v", r)
	}

	// A symlink, even to a good report, is invalid.
	if err := os.Symlink(filepath.Join(run, "code-r1.json"), filepath.Join(run, "link.json")); err != nil {
		t.Fatal(err)
	}
	if r := runs.Read(dir, "run-1", "link.json", "code"); r.State != proto.ReportInvalid || r.Error != "not a regular file" {
		t.Fatalf("symlink = %+v", r)
	}
	// A directory, a FIFO.
	if err := os.Mkdir(filepath.Join(run, "dir.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	if r := runs.Read(dir, "run-1", "dir.json", "code"); r.State != proto.ReportInvalid {
		t.Fatalf("dir = %+v", r)
	}
	if err := syscall.Mkfifo(filepath.Join(run, "fifo.json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := runs.Read(dir, "run-1", "fifo.json", "code"); r.State != proto.ReportInvalid {
		t.Fatalf("fifo = %+v", r)
	}
	// Oversize.
	big := `{"summary":"` + strings.Repeat("x", runs.MaxReportSize) + `"}`
	if err := os.WriteFile(filepath.Join(run, "big.json"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := runs.Read(dir, "run-1", "big.json", "code"); r.State != proto.ReportInvalid || r.Error != "report too large" || r.At == 0 {
		t.Fatalf("big = %+v", r)
	}
	// Exactly at the limit is fine.
	edge := `{"summary":"` + strings.Repeat("x", runs.MaxReportSize-len(`{"summary":""}`)) + `"}`
	if err := os.WriteFile(filepath.Join(run, "edge.json"), []byte(edge), 0o644); err != nil {
		t.Fatal(err)
	}
	if r := runs.Read(dir, "run-1", "edge.json", "code"); r.State != proto.ReportReady || len(r.Summary) != runs.MaxSummary {
		t.Fatalf("edge = %+v", show(r))
	}
}

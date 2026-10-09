package runs_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

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
	long := strings.Repeat("é", 400)                         // 800 bytes
	huge := strings.Repeat("é", runs.MaxInputRequired/2+100) // past the cap
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
		{"long input kept whole (#215)", "code", `{"input_required":"` + long + `"}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp(long)}},
		{"input cut UTF-8-safe and flagged", "code", `{"input_required":"` + huge + `"}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp(strings.Repeat("é", runs.MaxInputRequired/2)), InputTruncated: true}},
		{"input for the orchestrator", "code", `{"input_required":"x","input_for":" Orchestrator "}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp("x"), InputFor: "orchestrator"}},
		{"input for the user", "code", `{"input_required":"x","input_for":"user"}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp("x"), InputFor: "user"}},
		{"unknown input_for ignored", "code", `{"input_required":"x","input_for":"bob"}`,
			proto.RunReport{State: "ready", At: 5, InputRequired: strp("x")}},
		{"input_for without a request ignored", "code", `{"input_for":"user"}`, proto.RunReport{State: "ready", At: 5}},
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

// #215: the request that the issue's real report had, with the orchestrator
// acceptance alternative after byte 500, survives whole.
func TestReadKeepsTextAfterByte500(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "run-1"), 0o755); err != nil {
		t.Fatal(err)
	}
	req := strings.Repeat("September parity fails on stale local CUR data. ", 12) + "Either refresh /backend/data to rerun, or orchestrator acceptance of the existing evidence plus the passing August run."
	if len(req) < 600 {
		t.Fatal("fixture too short")
	}
	data, _ := json.Marshal(map[string]any{"input_required": req, "summary": "done"})
	if err := os.WriteFile(filepath.Join(dir, "run-1", "coder-r1.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	r := runs.Read(dir, "run-1", "coder-r1.json", "code")
	if r.InputRequired == nil || *r.InputRequired != req || r.InputTruncated {
		t.Fatalf("request = %v (truncated %v)", r.InputRequired, r.InputTruncated)
	}
}

func TestResolvedName(t *testing.T) {
	for in, want := range map[string]string{
		"coder-r1.json": "coder-r1.resolved.json",
		"coder-r1":      "coder-r1.resolved.json",
		"a.b.json":      "a.b.resolved.json",
	} {
		if got, ok := runs.ResolvedName(in); !ok || got != want {
			t.Errorf("ResolvedName(%q) = %q %v, want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "../x.json", "coder-r1.resolved.json", "x.resolved.json", strings.Repeat("x", 75) + ".json", strings.Repeat("x", 70) + ".json"} {
		if got, ok := runs.ResolvedName(in); ok {
			t.Errorf("ResolvedName(%q) = %q, want none", in, got)
		}
	}
	// A sidecar name is a valid name (the poller and the bridge reuse it) and a report never has the
	// sidecar's, so the two cannot be mistaken for each other.
	side, _ := runs.ResolvedName("coder-r1.json")
	if !runs.ValidName(side) {
		t.Errorf("%q is no valid name", side)
	}
}

func TestReadResolved(t *testing.T) {
	dir := t.TempDir()
	run := filepath.Join(dir, "run-1")
	if err := os.Mkdir(run, 0o755); err != nil {
		t.Fatal(err)
	}
	report, side := filepath.Join(run, "coder-r1.json"), filepath.Join(run, "coder-r1.resolved.json")
	write := func(path, data string, mod time.Time) {
		t.Helper()
		_ = os.Remove(path)
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mod, mod); err != nil {
			t.Fatal(err)
		}
	}
	t0 := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	read := func() proto.RunReport { return runs.Read(dir, "run-1", "coder-r1.json", "code") }
	write(report, `{"input_required":"accept the evidence?","summary":"s"}`, t0)
	if r := read(); r.InputRequired == nil || r.InputResolved != nil {
		t.Fatalf("no sidecar = %+v", r)
	}

	write(side, `{"resolved_by":"orchestrator","note":"accepted as AC4 evidence"}`, t0.Add(time.Second))
	r := read()
	want := &proto.InputResolved{By: "orchestrator", Note: "accepted as AC4 evidence", At: t0.Add(time.Second).UnixMilli()}
	if r.InputRequired == nil || *r.InputRequired != "accept the evidence?" || !reflect.DeepEqual(r.InputResolved, want) {
		t.Fatalf("resolved = %+v %+v", r, r.InputResolved)
	}
	// Same mtime as the report: resolved (>=).
	write(side, `{}`, t0)
	if r = read(); !reflect.DeepEqual(r.InputResolved, &proto.InputResolved{By: "orchestrator", At: t0.UnixMilli()}) {
		t.Fatalf("empty object, same mtime = %+v", r.InputResolved)
	}
	// Both fields are cut UTF-8-safely.
	write(side, `{"resolved_by":"`+strings.Repeat("é", 100)+`","note":"`+strings.Repeat("é", 400)+`"}`, t0.Add(time.Second))
	if r = read(); r.InputResolved == nil || len(r.InputResolved.By) != runs.MaxResolveBy || len(r.InputResolved.Note) != runs.MaxResolveNote {
		t.Fatalf("cut = %+v", r.InputResolved)
	}
	// Stale: older than the report.
	write(side, `{"note":"old"}`, t0.Add(-time.Second))
	if r = read(); r.InputResolved != nil || r.InputRequired == nil {
		t.Fatalf("stale = %+v", r)
	}
	// Report rewritten after the resolution: active again.
	write(side, `{"note":"ok"}`, t0.Add(time.Second))
	write(report, `{"input_required":"a new request"}`, t0.Add(2*time.Second))
	if r = read(); r.InputResolved != nil || *r.InputRequired != "a new request" {
		t.Fatalf("rewritten = %+v", r)
	}
	// Invalid or garbage sidecars are ignored.
	for name, data := range map[string]string{
		"garbage": `{"note":`, "array": `[]`, "null": `null`, "string": `"ok"`,
		"note not a string": `{"note":3}`, "by not a string": `{"resolved_by":true}`, "empty file": ``,
	} {
		write(side, data, t0.Add(3*time.Second))
		if r = read(); r.InputResolved != nil {
			t.Errorf("%s: resolved = %+v", name, r.InputResolved)
		}
	}
	// Oversize.
	write(side, `{"note":"`+strings.Repeat("x", runs.MaxResolveSize)+`"}`, t0.Add(3*time.Second))
	if r = read(); r.InputResolved != nil {
		t.Errorf("oversize resolved = %+v", r.InputResolved)
	}
	// A symlink (even to a good sidecar), a directory, a FIFO.
	good := filepath.Join(run, "elsewhere")
	write(good, `{"note":"ok"}`, t0.Add(3*time.Second))
	for name, mk := range map[string]func() error{
		"symlink": func() error { return os.Symlink(good, side) },
		"dir":     func() error { return os.Mkdir(side, 0o755) },
		"fifo":    func() error { return syscall.Mkfifo(side, 0o644) },
	} {
		_ = os.RemoveAll(side)
		if err := mk(); err != nil {
			t.Fatal(err)
		}
		if r = read(); r.InputResolved != nil || r.InputRequired == nil {
			t.Errorf("%s: resolved = %+v", name, r.InputResolved)
		}
	}
	_ = os.RemoveAll(side)
	// A resolved report with no request has nothing resolved.
	write(report, `{"summary":"s"}`, t0)
	write(side, `{"note":"ok"}`, t0.Add(time.Second))
	if r = read(); r.InputResolved != nil {
		t.Errorf("no request, resolved = %+v", r.InputResolved)
	}
	// Stat sees the sidecar.
	if _, ok, err := runs.StatResolved(dir, "run-1", "coder-r1.json"); !ok || err != nil {
		t.Errorf("StatResolved = %v %v", ok, err)
	}
	if _, ok, _ := runs.StatResolved(dir, "run-1", "other.json"); ok {
		t.Error("StatResolved of another report")
	}
}

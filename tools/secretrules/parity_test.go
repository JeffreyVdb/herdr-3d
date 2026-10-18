package main

// The parity check (#108, make secret-rules-parity): Gitleaks v8.30.1's own
// DetectString (IgnoreGitleaksAllow, the one documented difference) and
// internal/promptsecret's generated rules must find the same (rule, secret,
// byte range) set in every input: the pilot corpus, every static sample in
// Gitleaks' rule sources (cmd/generate/config/rules: each rule's true and
// false positives), those joined into multi-line prompts, and targeted
// inputs. Upstream reports a finding's match by line and column, not the
// secret's bytes: each finding's occurrence is found again by replaying its
// rule over the text (the match trimmed of LFs and matched again, its secret
// group) and kept only where its match, secret, line and column agree.

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/zricethezav/gitleaks/v8/config"
	"github.com/zricethezav/gitleaks/v8/detect"
)

type corpusItem struct {
	ID       string   `json:"id"`
	Group    string   `json:"group"`
	Text     string   `json:"text"`
	Expected [][2]int `json:"expected"` // Python code point indices
}

func loadCorpus(t *testing.T) []corpusItem {
	t.Helper()
	b, err := os.ReadFile("testdata/corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var items []corpusItem
	if err := json.Unmarshal(b, &items); err != nil {
		t.Fatal(err)
	}
	return items
}

// tuple is one finding as compared: rule, byte range, secret.
type tuple struct {
	Rule       string
	Start, End int
	Secret     string
}

func (x tuple) String() string { return fmt.Sprintf("%s [%d,%d) %q", x.Rule, x.Start, x.End, x.Secret) }

// oracle is Gitleaks' findings in text, each at its own occurrence.
func oracle(t *testing.T, d *detect.Detector, text string) []tuple {
	t.Helper()
	var out []tuple
	for _, f := range d.DetectString(text) {
		if f.Secret == "" {
			continue // promptsecret.Gitleaks leaves empty secrets out too
		}
		r := d.Config.Rules[f.RuleID]
		var hits []tuple
		for _, m := range r.Regex.FindAllStringIndex(text, -1) {
			full := text[m[0]:m[1]]
			match := strings.Trim(full, "\n")
			lead := len(full) - len(strings.TrimLeft(full, "\n"))
			line, col := lineCol(text, m[0])
			if match != f.Match || line != f.StartLine || col != f.StartColumn {
				continue
			}
			secret, from, to := match, 0, len(match)
			if g := r.Regex.FindStringSubmatchIndex(match); len(g) >= 4 {
				if r.SecretGroup > 0 {
					from, to = g[2*r.SecretGroup], g[2*r.SecretGroup+1]
					if from < 0 {
						from, to = 0, 0
					}
					secret = match[from:to]
				} else {
					for k := 1; 2*k+1 < len(g); k++ {
						if g[2*k] >= 0 && g[2*k+1] > g[2*k] {
							from, to = g[2*k], g[2*k+1]
							secret = match[from:to]
							break
						}
					}
				}
			}
			if secret != f.Secret {
				continue
			}
			s := m[0] + lead + from
			if text[s:s+len(secret)] != secret {
				t.Fatalf("replay of %s: bytes differ", f.RuleID)
			}
			hits = append(hits, tuple{f.RuleID, s, m[0] + lead + to, secret})
		}
		if len(hits) != 1 {
			t.Fatalf("%s: finding at line %d col %d found %d times in replay", f.RuleID, f.StartLine, f.StartColumn, len(hits))
		}
		out = append(out, hits[0])
	}
	return sortTuples(out)
}

// lineCol is upstream's (DetectString) start line and column of a match at
// byte start: lines counted by the LFs at or before it (an LF is the anchor
// of the line after it), the column from that LF, 1-based.
func lineCol(text string, start int) (line, col int) {
	prev := 0
	for i := 0; i <= start && i < len(text); i++ {
		if text[i] == '\n' {
			line++
			prev = i
		}
	}
	return line, start - prev + 1
}

func runtimeTuples(text string) []tuple {
	var out []tuple
	for _, m := range promptsecret.Gitleaks(text) {
		out = append(out, tuple{m.Rule, m.Start, m.End, text[m.Start:m.End]})
	}
	return sortTuples(out)
}

func sortTuples(ts []tuple) []tuple {
	slices.SortFunc(ts, func(a, b tuple) int {
		if a.Start != b.Start {
			return a.Start - b.Start
		}
		if a.End != b.End {
			return a.End - b.End
		}
		return strings.Compare(a.Rule, b.Rule)
	})
	return ts
}

// samples are the static strings of Gitleaks' rule sources (their true and
// false positives, and the words its rules are built from).
func samples(t *testing.T) []string {
	t.Helper()
	dir := filepath.Join(gitleaksDir(t), "cmd", "generate", "config", "rules")
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("rule sources in %s: %v", dir, err)
	}
	seen := map[string]bool{}
	var out []string
	for _, f := range files {
		file, err := parser.ParseFile(token.NewFileSet(), f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			cl, ok := n.(*ast.CompositeLit)
			if !ok {
				return true
			}
			for _, e := range cl.Elts {
				if kv, ok := e.(*ast.KeyValueExpr); ok {
					e = kv.Value
				}
				lit, ok := e.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				s, err := strconv.Unquote(lit.Value)
				if err != nil || s == "" || seen[s] || !utf8.ValidString(s) {
					continue
				}
				seen[s] = true
				out = append(out, s)
			}
			return true
		})
	}
	return out
}

// gitleaksDir is the module cache directory of the linked Gitleaks.
func gitleaksDir(t *testing.T) string {
	t.Helper()
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("no build info")
	}
	for _, m := range bi.Deps {
		if m.Path == gitleaksModule {
			if m.Version != gitleaksVersion {
				t.Fatalf("gitleaks %s, want %s", m.Version, gitleaksVersion)
			}
			mod := os.Getenv("GOMODCACHE")
			if mod == "" {
				mod = filepath.Join(os.Getenv("HOME"), "go", "pkg", "mod")
			}
			return filepath.Join(mod, "github.com", "zricethezav", "gitleaks", "v8@"+m.Version)
		}
	}
	t.Fatal("gitleaks is not linked in")
	return ""
}

// targeted are inputs for the semantics the samples may not reach.
var targeted = []string{
	// keyword case, CRLF, a leading and trailing LF, repeats on one line
	"GITHUB_TOKEN=ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167\r\nUse it.",
	"Github_Token=GHP_gt2mqvtdhgoubkn5tfdov4eynhjvekcai167 and ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167",
	"\n\nghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167\n\n",
	"token ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167 again ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167.",
	// generic beside a provider on one line, and on separate lines
	`api_key = "ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"; secret_token = "tn4UAZwxrXndIta2u8MNDYyKcbCwwdEfDJCxRQyA"`,
	"api_key = \"tn4UAZwxrXndIta2u8MNDYyKcbCwwdEfDJCxRQyA\"\nghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167",
	// generic: stopwords (global and the rule's), the line and match allowlists
	`api_key = "abcdefghijklmnopqrstuvwxyz0123"`,
	`client_secret = "014df517-39d1-4453-b7b3-9930c563627c"`,
	"RUN --mount=type=secret,id=api_key,token=a8f5f167f44f4964e6c998dee827110c ./build.sh",
	"import { apiKeyA8f5f167f44f4964 } from 'secrets'",
	`access_id = "a8f5f167f44f4964e6c998dee827110c"`,
	// low and high entropy around a threshold, Unicode beside a secret
	`password = "aaaaaaaaaaaaaaaaaaaaaaaa"`,
	"🔒 wachtwoord: é🙂 API_KEY=\"Zq8vN3xW5tY7uR2sP4oK6mJ9\" ✓",
	"é🙂 prefix\ngithub_token=\"ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167\"",
	// PEM, multi-line, CRLF
	"key:\r\n-----BEGIN RSA PRIVATE KEY-----\r\nMIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\r\nVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK\r\n-----END RSA PRIVATE KEY-----\r\n",
	// a path-only rule's file name and a path rule's content stay out
	"keystore.p12 and terraform: password = \"Hunter2Hunter2\"",
	// templates and placeholders the global allowlist drops
	`token = "${GITHUB_TOKEN}" secret = "{{ .Values.secret }}" password = "%DB_PASSWORD%"`,
}

func TestGeneratedRulesMatchGitleaks(t *testing.T) {
	d, err := detect.NewDetectorDefaultConfig()
	if err != nil {
		t.Fatal(err)
	}
	d.IgnoreGitleaksAllow = true
	corpus := loadCorpus(t)
	var inputs []string
	for _, it := range corpus {
		inputs = append(inputs, it.Text)
	}
	ss := samples(t)
	inputs = append(inputs, ss...)
	// Joined: a rule's samples beside others' on one line and on the next.
	for i := 0; i+3 <= len(ss); i += 3 {
		inputs = append(inputs, strings.Join(ss[i:i+3], " "), strings.Join(ss[i:i+3], "\n"), strings.Join(ss[i:i+3], "\r\n"))
	}
	inputs = append(inputs, targeted...)
	found, diffs := 0, 0
	for _, text := range inputs {
		want, got := oracle(t, d, text), runtimeTuples(text)
		found += len(want)
		if !slices.Equal(want, got) {
			diffs++
			if diffs <= 20 {
				t.Errorf("input %q:\n gitleaks %v\n runtime  %v", clip(text), want, got)
			}
		}
	}
	if diffs > 0 {
		t.Fatalf("%d of %d inputs differ", diffs, len(inputs))
	}
	if found < 500 {
		t.Fatalf("only %d findings over %d inputs: the inputs do not exercise the rules", found, len(inputs))
	}
	t.Logf("parity: %d inputs (%d corpus, %d samples), %d findings, identical", len(inputs), len(corpus), len(ss), found)

	// The pilot's measure, for the record: annotated secrets found exactly
	// by the generated rules alone (the research had 18/36 for Gitleaks).
	exact, total := 0, 0
	for _, it := range corpus {
		got := map[[2]int]bool{}
		for _, m := range promptsecret.Gitleaks(it.Text) {
			got[[2]int{m.Start, m.End}] = true
		}
		for _, e := range it.Expected {
			total++
			if got[[2]int{byteIndex(it.Text, e[0]), byteIndex(it.Text, e[1])}] {
				exact++
			}
		}
	}
	t.Logf("pilot corpus, generated rules alone: %d/%d exact", exact, total)
	if exact != 18 || total != 36 {
		t.Errorf("pilot corpus: %d/%d exact, the research measured 18/36", exact, total)
	}
}

// The whole scan (generated and structural rules, overlaps resolved) on the
// pilot corpus, for the record: development evidence, not a holdout.
func TestScanOnThePilotCorpus(t *testing.T) {
	exact, total, flagged, clean := 0, 0, 0, 0
	for _, it := range loadCorpus(t) {
		cs := promptsecret.Scan(it.Text, nil)
		got := map[[2]int]bool{}
		for _, c := range cs {
			got[[2]int{c.Start, c.End}] = true
		}
		for _, e := range it.Expected {
			total++
			if got[[2]int{byteIndex(it.Text, e[0]), byteIndex(it.Text, e[1])}] {
				exact++
			}
		}
		if len(it.Expected) == 0 {
			clean++
			if len(cs) > 0 {
				flagged++
			}
		}
	}
	t.Logf("pilot corpus, full scan: %d/%d exact, %d/%d clean prompts flagged", exact, total, flagged, clean)
	if exact < 34 {
		t.Errorf("full scan: %d/%d exact", exact, total)
	}
}

// byteIndex is the byte offset of code point index i (Python's indices).
func byteIndex(s string, i int) int {
	n := 0
	for b := range s {
		if n == i {
			return b
		}
		n++
	}
	return len(s)
}

func clip(s string) string {
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}

// The generator refuses what the runtime does not implement.
func TestLoadRefusesUnimplementedFeatures(t *testing.T) {
	base := "[[rules]]\nid = \"a\"\nregex = '''abc'''\n"
	for name, raw := range map[string]string{
		"required":   base + "[[rules.required]]\nid = \"a\"\n",
		"skipReport": base + "skipReport = true\n",
		"unknown":    base + "severity = \"high\"\n",
		"extend":     "[extend]\nuseDefault = true\n" + base,
		"path":       "[[rules]]\nid = \"p\"\npath = '''.*'''\nregex = '''abc'''\n",
	} {
		if _, err := Load(raw); err == nil {
			t.Errorf("%s: loaded", name)
		}
	}
	if d, err := Load(base + "[[rules]]\nid = \"b\"\npath = '''\\.tf$'''\nregex = '''def'''\n"); err != nil ||
		len(d.Rules) != 1 || !slices.Equal(d.Dropped, []string{"b"}) {
		t.Fatalf("a path rule is left out: %+v, %v", d, err)
	}
}

// The generated file is what the generator writes now.
func TestGeneratedFileIsCurrent(t *testing.T) {
	want, err := generate(config.DefaultConfig)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile("../../internal/promptsecret/gitleaks_rules.go")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("internal/promptsecret/gitleaks_rules.go is stale: make secret-rules")
	}
}

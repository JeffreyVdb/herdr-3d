package handoffllm

import (
	"maps"
	"math/rand/v2"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// Secret-shaped test values are built at run time (never one literal in
// the source), so a secret scanner on the repository has nothing to flag.
func rep(s string, n int) string { return strings.Repeat(s, n) }

var (
	fakeAWSID     = "AKIA" + "Q2ZX7SYNTHETIC1"[:15] + "Q"
	fakeAWSSecret = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYSYNTHETICKEY"[:18]
	fakeGHP       = "ghp" + "_" + rep("Ab3", 12)
	fakeGHO       = "gho" + "_" + rep("Zy9", 12)
	fakeGHS       = "ghs" + "_" + rep("Qw4", 12)
	fakeGHPat     = "github" + "_pat_" + rep("11ABCDE7a_", 8) + "xy"
	fakeOpenAI    = "sk" + "-proj-" + rep("Ab1Cd2Ef3", 6)
	fakeOpenAIOld = "sk" + "-" + rep("Zz9Yy8Xx7", 5)
	fakeAnthropic = "sk" + "-ant-api03-" + rep("Qq7_Rr8-Ss9", 8) + "AA"
	fakeSlack     = "xox" + "b-123-456-abc"
	fakeSlackUser = "xox" + "p-" + rep("1234567890", 1) + "-" + rep("aBc9", 6)
	fakeSlackHook = "https://hooks." + "slack.com/services/" + rep("T0B1C2D3E4/", 1) + rep("Ab9", 15)
	fakeGoogle    = "AI" + "za" + rep("Sy0-_aB9xZ", 3) + "Q1w2E"
	fakeStripe    = "sk" + "_live_" + "4eC39HqLyjWDarjt"
	fakeStripeRk  = "rk" + "_test_" + "51Hq0aB"
	fakeJWT       = "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
	fakePEMBody   = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaK+Synthetic\n" +
		"VTLw7onLx/IzW7+qKhbwSyntheticBodyLine/With+Slashes/And+Plus==\n"
	fakePEM      = "-----BEGIN RSA " + "PRIVATE KEY-----\n" + fakePEMBody + "-----END RSA " + "PRIVATE KEY-----"
	fakeOpenSSH  = "-----BEGIN OPENSSH " + "PRIVATE KEY-----\n" + fakePEMBody + "-----END OPENSSH " + "PRIVATE KEY-----"
	fakePEMTrunc = "-----BEGIN " + "PRIVATE KEY-----\n" + fakePEMBody
)

func TestScrubCatchesEveryCategory(t *testing.T) {
	cases := []struct {
		name, in, secret, category string
	}{
		{"aws key id", "export AWS_ACCESS_KEY_ID=" + fakeAWSID, fakeAWSID, "aws_access_key"},
		{"aws secret assignment", "aws_secret_access_key = " + fakeAWSSecret, fakeAWSSecret, "aws_secret_key"},
		{"aws secret env", "AWS_SECRET_ACCESS_KEY=\"" + fakeAWSSecret + "\"", fakeAWSSecret, "aws_secret_key"},
		{"github classic", "token " + fakeGHP + " used", fakeGHP, "github_token"},
		{"github oauth", "x " + fakeGHO, fakeGHO, "github_token"},
		{"github server", fakeGHS + ".", fakeGHS, "github_token"},
		{"github fine-grained", "pat: " + fakeGHPat, fakeGHPat, "github_token"},
		{"openai project", "key " + fakeOpenAI + " here", fakeOpenAI, "openai_key"},
		{"openai legacy", "OPENAI " + fakeOpenAIOld, fakeOpenAIOld, "openai_key"},
		{"anthropic", "k=" + fakeAnthropic, fakeAnthropic, "anthropic_key"},
		{"slack short", "slack " + fakeSlack + " ok", fakeSlack, "slack_token"},
		{"slack user", fakeSlackUser, fakeSlackUser, "slack_token"},
		{"slack webhook", "post to " + fakeSlackHook, fakeSlackHook, "slack_webhook"},
		{"google", "maps " + fakeGoogle, fakeGoogle, "google_api_key"},
		{"stripe live", "stripe " + fakeStripe, fakeStripe, "stripe_key"},
		{"stripe restricted short", "rk " + fakeStripeRk, fakeStripeRk, "stripe_key"},
		{"jwt", "cookie=" + fakeJWT, fakeJWT, "jwt"},
		{"pem rsa", "key:\n" + fakePEM + "\nend", "VTLw7onLx/IzW7+qKhbw", "private_key"},
		{"pem openssh", fakeOpenSSH, "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8", "private_key"},
		{"pem truncated", "cat id_rsa\n" + fakePEMTrunc, "VTLw7onLx/IzW7+qKhbw", "private_key"},
		{"bearer header", "curl -H 'Authorization: Bearer abcDEF123ghiJKL456mno' x", "abcDEF123ghiJKL456mno", "auth_header"},
		{"basic header", "Authorization: Basic dXNlcjpodW50ZXIyaHVudGVyMg==", "dXNlcjpodW50ZXIyaHVudGVyMg==", "auth_header"},
		{"bearer prose", "send bearer Zm9vYmFyYmF6cXV4MTIzNDU2 now", "Zm9vYmFyYmF6cXV4MTIzNDU2", "auth_header"},
		{"url credentials", "git clone https://jeff:hunter2hunter2@example.com/r.git", "hunter2hunter2", "url_credentials"},
		{"postgres url", "DATABASE_URL=postgres://app:S3cr3tPw@db:5432/app", "S3cr3tPw", "url_credentials"},
		{"password assignment", "password=hunter2hunter2", "hunter2hunter2", "secret_assignment"},
		{"env password", "DATABASE_PASSWORD=correct-horse-9", "correct-horse-9", "secret_assignment"},
		{"api_key json", `{"api_key": "abcd1234efgh5678"}`, "abcd1234efgh5678", "secret_assignment"},
		{"client secret yaml", "client_secret: z9y8x7w6v5u4", "z9y8x7w6v5u4", "secret_assignment"},
		{"token assignment", "TOKEN='qwerty-12345-asdf'", "qwerty-12345-asdf", "secret_assignment"},
		{"configured literal", "the key is hunter-Q9z!", "hunter-Q9z!", "configured_secret"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, counts := Scrub(c.in, "hunter-Q9z!")
			if strings.Contains(out, c.secret) {
				t.Fatalf("secret survived: %q", out)
			}
			if counts[c.category] < 1 {
				t.Fatalf("category %q not counted: %v (out %q)", c.category, counts, out)
			}
			if !strings.Contains(out, "[redacted:"+c.category+"]") {
				t.Fatalf("no [redacted:%s] marker: %q", c.category, out)
			}
		})
	}
}

func TestScrubKeepsEvidence(t *testing.T) {
	keep := []string{
		"commit 0123456789abcdef0123456789abcdef01234567 merged",
		"short sha 3f2a9c1 and fd911a8fa3cf5b436ead886c59a0b5129b8b3e67",
		"session 123e4567-e89b-42d3-a456-426614174000 resumed",
		"run 00000000-0000-4000-8000-000000000052",
		"sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"edited /home/user/src/internal/handoffllm/reduce_claude_branch_selection_test.go",
		"func parse_handoff_transcript_for_model_input() {}",
		"https://github.com/JeffreyVdb/herdr-3d/pull/46",
		"max_tokens: 1024, cache_read_input_tokens: 103912",
		"token: string; password: string",
		"tokenRe = regexp.MustCompile(`x`)",
		"author: Jeffrey, the bearer of news",
		"PATH=/usr/bin:/bin HOME=/home/u GOFLAGS=-mod=mod",
		"password=$DB_PASSWORD token=${TOKEN} secret=<your-secret>",
		"https://user:$PASS@example.com and https://example.com:8443/x",
		"--- FAIL: TestReduce (0.01s)",
		"ok  github.com/JeffreyVdb/herdr-3d/internal/handoffllm 0.2s",
		"",
	}
	for _, s := range keep {
		out, counts := Scrub(s)
		if out != s {
			t.Errorf("Scrub(%q) = %q (counts %v), want unchanged", s, out, counts)
		}
		if len(counts) != 0 {
			t.Errorf("Scrub(%q) counted %v", s, counts)
		}
	}
}

func TestScrubCounts(t *testing.T) {
	in := strings.Join([]string{fakeGHP, fakeGHO, "password=hunter2hunter2", fakeGHS, "lit-SECRET-1", "lit-SECRET-1"}, "\n")
	out, counts := Scrub(in, "lit-SECRET-1", "")
	want := map[string]int{"github_token": 3, "secret_assignment": 1, "configured_secret": 2}
	if !maps.Equal(counts, want) {
		t.Fatalf("counts %v, want %v (out %q)", counts, want, out)
	}
	if again, c2 := Scrub(out, "lit-SECRET-1"); again != out || len(c2) != 0 {
		t.Fatalf("second scrub changed the text: %q %v", again, c2)
	}
}

func TestScrubEmptySecretRemovesNothing(t *testing.T) {
	out, counts := Scrub("abc", "", "  ")
	if out != "abc" || len(counts) != 0 {
		t.Fatalf("got %q %v", out, counts)
	}
}

func TestScrubDataURI(t *testing.T) {
	in := "see data:image/png;base64," + rep("iVBORw0KGgo", 40) + "== done"
	out, counts := Scrub(in)
	if strings.Contains(out, "iVBORw0KGgo") || counts["data_uri"] != 1 {
		t.Fatalf("got %q %v", out, counts)
	}
	if !strings.HasPrefix(out, "see ") || !strings.HasSuffix(out, " done") {
		t.Fatalf("surroundings lost: %q", out)
	}
}

// TestScrubLargeInputs: Scrub never panics or hangs on large, adversarial
// input (RE2 is linear; this pins the patterns stay that way).
func TestScrubLargeInputs(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	const size = 4 << 20
	alphabet := "abcAKIA0123456789+/=_-:@ \n\"'ghp_sk-xoxb-eyJ.-----BEGIN PRIVATE KEY-----password=token:"
	var b strings.Builder
	for b.Len() < size {
		b.WriteByte(alphabet[r.IntN(len(alphabet))])
	}
	inputs := map[string]string{
		"random":     b.String(),
		"pem open":   "-----BEGIN " + "PRIVATE KEY-----\n" + rep("A/+b", size/4),
		"pem many":   rep("-----BEGIN "+"PRIVATE KEY-----\n", size/28),
		"assignment": rep("password=", size/9),
		"url":        rep("https://a:", size/10),
		"jwt-ish":    rep("eyJabcdefghijkl.", size/16),
		"ws":         rep(" ", size),
	}
	for name, in := range inputs {
		start := time.Now()
		out, _ := Scrub(in, "AKIA")
		if d := time.Since(start); d > 20*time.Second {
			t.Errorf("%s: took %v", name, d)
		}
		if utf8.ValidString(in) && !utf8.ValidString(out) {
			t.Errorf("%s: output is not valid UTF-8", name)
		}
	}
}

func FuzzScrub(f *testing.F) {
	for _, s := range []string{"", fakePEM, fakePEMTrunc, "password=hunter2hunter2", fakeJWT, fakeSlackHook,
		"https://u:p4ssw0rd@h/x", fakeGHP + fakeGHO, "data:image/png;base64,AAAA" + rep("B", 64)} {
		f.Add(s, "lit")
	}
	f.Fuzz(func(t *testing.T, s, lit string) {
		out, counts := Scrub(s, lit)
		for k, n := range counts {
			if n <= 0 || k == "" {
				t.Fatalf("bad count %q=%d", k, n)
			}
		}
		if len(counts) == 0 && out != s {
			t.Fatalf("text changed without a count: %q -> %q", s, out)
		}
		var markers strings.Builder
		for _, c := range scrubCategories {
			markers.WriteString("[redacted:" + c + "]")
		}
		if strings.TrimSpace(lit) != "" && !strings.ContainsAny(lit, "[]") && !strings.Contains(markers.String(), lit) &&
			strings.Contains(out, lit) {
			t.Fatalf("literal %q survived in %q", lit, out)
		}
	})
}

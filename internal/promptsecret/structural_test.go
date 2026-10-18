package promptsecret_test

import (
	"os/exec"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
)

func TestPromptSecretIsALeaf(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", "-f", "{{if not .Standard}}{{.ImportPath}}{{end}}",
		mod+"internal/promptsecret").CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if dep != mod+"internal/promptsecret" {
			t.Errorf("internal/promptsecret depends on %s", dep)
		}
	}
}

// values are the candidates' bytes, in order.
func values(text string) []string {
	var out []string
	for _, c := range promptsecret.Scan(text) {
		out = append(out, text[c.Start:c.End])
	}
	return out
}

type scanCase struct {
	name, text string
	want       []string
}

func checkScans(t *testing.T, cases []scanCase) {
	t.Helper()
	for _, tc := range cases {
		if got := values(tc.text); !slices.Equal(got, tc.want) {
			t.Errorf("%s: %q\n got  %q\n want %q", tc.name, tc.text, got, tc.want)
		}
	}
}

const pemKey = "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
	"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n" +
	"QyNTUxOQAAACDhBT6MWV0pNHNGhRbX0ZbUaVnT7oSPEKIn4dyBTnZu8wAAAJgtF1uYLRdb\n" +
	"-----END OPENSSH PRIVATE KEY-----"

func TestScanFamilies(t *testing.T) {
	t.Parallel()
	checkScans(t, []scanCase{
		// PEM: the whole block, BEGIN to END, newlines kept (CRLF too).
		{"pem", "Use this key:\n" + pemKey + "\nthen connect.", []string{pemKey}},
		{"pem crlf", "k:\r\n" + strings.ReplaceAll(pemKey, "\n", "\r\n") + "\r\n", []string{strings.ReplaceAll(pemKey, "\n", "\r\n")}},
		{"pem pgp", "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----",
			[]string{"-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----"}},
		{"pem unterminated", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow", nil},
		{"public key block", "-----BEGIN PUBLIC KEY-----\nMIIBIjAN\n-----END PUBLIC KEY-----", nil},

		// Headers: the credentials after the scheme; Basic as typed.
		{"bearer header", `curl -H "Authorization: Bearer abc.DEF-123_xyz" https://x.test`, []string{"abc.DEF-123_xyz"}},
		{"basic header", "Authorization: Basic dXNlcjpwYXNzd29yZA==\nAccept: */*", []string{"dXNlcjpwYXNzd29yZA=="}},
		{"token header json", `{"authorization": "Token 9f8e7d6c5b"}`, []string{"9f8e7d6c5b"}},
		{"proxy auth", "Proxy-Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l", []string{"YWxhZGRpbjpvcGVuc2VzYW1l"}},
		{"bare bearer", "send it with Bearer Zx81mQp27LwRt5Yv9Nc and wait", []string{"Zx81mQp27LwRt5Yv9Nc"}},
		{"bearer prose", "the Bearer token goes in a header", nil},
		{"digest", `Authorization: Digest username="u", response="6629fae49393a05397450978507c4ef1"`, nil},
		{"api key header", "X-API-Key: k3y-Value-778", []string{"k3y-Value-778"}},

		// URLs: the userinfo password (percent-encoding kept) and
		// credential-named query parameters.
		{"url password", "Connect to postgres://app:Crane7%21Willow@db.example.test:5432/app", []string{"Crane7%21Willow"}},
		{"url raw at", "mysql://root:p@ss:w0rd@127.0.0.1/db", []string{"p@ss:w0rd"}},
		{"url no password", "ssh://git@github.com/x and https://user@host.test/", nil},
		{"url template password", "redis://:${REDIS_PASSWORD}@cache:6379", nil},
		{"query token", "Call https://api.example.test/v1?access_token=poHWDEJlJLVJ4i0W&limit=10", []string{"poHWDEJlJLVJ4i0W"}},
		{"query key and sig", "https://maps.test/api?key=AIzaFake123&x=1 and https://blob.test/c?sv=2020&sig=abc%2Fdef%3D", []string{"AIzaFake123", "abc%2Fdef%3D"}},
		{"query in parens", "see (https://x.test/?token=Qw3rty123).", []string{"Qw3rty123"}},
		{"form body", "user=admin&password=s3cr3t!&remember=1", []string{"s3cr3t!"}},

		// Assignments: env, export, YAML, JSON, TOML, INI, CLI flags, code.
		{"env", "DB_PASSWORD=Tidepool8!\nDEBUG=1", []string{"Tidepool8!"}},
		{"export", `export GITHUB_TOKEN="abc 123"`, []string{"abc 123"}},
		{"yaml", "db:\n  user: app\n  password: hunter2\n", []string{"hunter2"}},
		{"yaml list", "- name: x\n  api_key: 'k-77'\n", []string{"k-77"}},
		{"json", `{"client_secret":"JDNMg9cFqLpe","region":"eu"}`, []string{"JDNMg9cFqLpe"}},
		{"toml", "[auth]\nsecret = \"t0ml-s3cret\"\n", []string{"t0ml-s3cret"}},
		{"ini", "[db]\npasswd = iniPass9\n", []string{"iniPass9"}},
		{"cli flags", "run --password=hunter22 --token abc999 --verbose", []string{"hunter22", "abc999"}},
		{"code", `self.api_key = "sk_test_51Hello"` + "\n" + `$password = 'php-pw-1';`, []string{"sk_test_51Hello", "php-pw-1"}},
		{"go short", `token := "go-token-42"`, []string{"go-token-42"}},
		{"connection string", "Server=db;User Id=sa;Password=Str0ng;Database=app", []string{"Str0ng"}},
		{"camel and suffix names", "PGPASSWORD=pg1 clientSecret: cs2 APIKey=ak3 authToken=at4", []string{"pg1", "cs2", "ak3", "at4"}},
		{"weak but assigned", "password=example api_key=\"password123\"", []string{"example", "password123"}},
		{"not credential names", "max_tokens: 4096\ntoken_limit=5\nAWS_ACCESS_KEY_ID=AKIA1234\nsecretName: db\nauthor: me", nil},
		{"comparison", `if password == "x" { }`, nil},

		// YAML block scalars: from the first content byte to the end of the
		// last content line.
		{"yaml block", "app:\n  private_key: |\n    line-one\n    line-two\n  user: x\n", []string{"line-one\n    line-two"}},
		{"yaml block one line", "token: >-\n  abc123\n", []string{"abc123"}},

		// Prose.
		{"password is", "The password is Moonlight7!. Please connect.", []string{"Moonlight7!"}},
		{"quoted passphrase", `The password is "lilac otter river cinnamon". Use it.`, []string{"lilac otter river cinnamon"}},
		{"password colon", "Login password: fawn7", []string{"fawn7"}},
		{"password to backticks", "Set the password to `a!B@c#D$e%F^g&H*i(J)k=L+M` and test.", []string{"a!B@c#D$e%F^g&H*i(J)k=L+M"}},
		{"password for", "The password for the staging database is Tidepool8! today", []string{"Tidepool8!"}},
		{"secret no copula", "Use the secret 77dT8gUKD27tyrO2jkyp7I3zh9yaqVrUKceZ to authenticate.", []string{"77dT8gUKD27tyrO2jkyp7I3zh9yaqVrUKceZ"}},
		{"api key is", "API key is fU0YROStoYrbet2IRPC2syDIJY4tQw8a.", []string{"fU0YROStoYrbet2IRPC2syDIJY4tQw8a"}},
		{"dutch", "🔒 Mijn wachtwoord is Lente9!Fiets. Gebruik dit.", []string{"Lente9!Fiets"}},
		{"curly quotes", "my passphrase is “paper lantern 7”.", []string{"paper lantern 7"}},
		{"fenced", "API token (preserve the newline):\n```\nSzAU3xRphJP6\nbps8NmUAlM8h\n```", []string{"SzAU3xRphJP6\nbps8NmUAlM8h"}},
		{"fenced code is not a value", "The token code:\n```go\nfunc token() string { return x }\n```", nil},
		{"prose words without values", "Explain how API tokens should be stored. The password is required. The key is to test.", nil},
		{"secret is short", "the secret is 42 lines long", nil},
		{"public key", "Here is a public SSH key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAgWD66nRU0L", nil},
	})
}

func TestScanExclusions(t *testing.T) {
	t.Parallel()
	checkScans(t, []scanCase{
		{"shell refs", `TOKEN=$GITHUB_TOKEN PASSWORD="${DB_PASSWORD}" SECRET=$(cat /run/x)`, nil},
		{"templates", `password: "{{ .Values.db.password }}" api_key: {{ secret }} token: "<your-token>"`, nil},
		{"windows and printf", `password=%DB_PASSWORD% secret="%(secret)s"`, nil},
		{"functions", `password = os.getenv("DB_PASSWORD")` + "\n" + `const token = process.env.TOKEN;` + "\n" + `api_key = secrets["x"]`, nil},
		{"dotted code", "const token = response.access_token; return token;", nil},
		{"redactions", `password=**** token: "REDACTED" secret='[redacted]' api_key=xxxxxxxx client_secret=sk-…abcd`, nil},
		{"placeholders", `API_KEY="YOUR_API_KEY_HERE" password="<password>" token=replace-me`, nil},
		{"names without values", "Use the existing GITHUB_TOKEN environment variable. The variable name client_secret must remain.", nil},
		{"paths", "private_key: ~/.ssh/id_ed25519\npassword_file=/run/secrets/db\nPWD=/home/u", nil},
		{"booleans", "auth: true\npassword: null\ntoken: false", nil},
		{"bridge reference", "password=[secret in file /run/user/1000/herdr-world/secrets/AB/CD] and the API key is [secret in file /run/user/1000/herdr-world/secrets/AB/EF].", nil},
		{"empty", `password="" token=''`, nil},
		{"length check", "assert(password.length >= 12); // ensure a strong password", nil},
	})
}

func TestScanBoundaries(t *testing.T) {
	t.Parallel()
	checkScans(t, []scanCase{
		// Trailing punctuation after an unquoted value goes; inside quotes
		// it stays.
		{"trailing period", "password: Hunter2!.", []string{"Hunter2!"}},
		{"trailing comma paren", "(token=abc123xyz), then", []string{"abc123xyz"}},
		{"balanced paren kept", "password=pa(ss)9", []string{"pa(ss)9"}},
		{"quoted keeps punctuation", `password: "Hunter2!."`, []string{"Hunter2!."}},
		{"semicolon colon", "export PASSWORD=pw9; PASSWORD=pw8:", []string{"pw9", "pw8"}},
		// Escapes stay as typed.
		{"json escapes", `{"password": "a\"b\\c\u00e9"}`, []string{`a\"b\\c\u00e9`}},
		{"single quote yaml escape", `password: 'it''s-9'`, []string{"it''s-9"}},
		// CRLF ends an unquoted value; Unicode before and inside a value.
		{"crlf", "PASSWORD=crlf9\r\nTOKEN=tok8\r\n", []string{"crlf9", "tok8"}},
		{"unicode before", "é🙂 ünïcode — password: Zeven9!", []string{"Zeven9!"}},
		{"unicode inside", `My password is "wólk🌧️Zeven9!". Log in.`, []string{"wólk🌧️Zeven9!"}},
		{"unicode unquoted", "wachtwoord: wólk🌧️9 ok", []string{"wólk🌧️9"}},
		// Repeated identical values are separate candidates; adjacent
		// secrets stay apart.
		{"repeat", "API key is fU0YROStoYrbet2IRPC2syDIJY4tQw8a. If it fails, retry with fU0YROStoYrbet2IRPC2syDIJY4tQw8a.",
			[]string{"fU0YROStoYrbet2IRPC2syDIJY4tQw8a", "fU0YROStoYrbet2IRPC2syDIJY4tQw8a"}},
		{"repeat both assigned", "A_TOKEN=same-value-1 B_TOKEN=same-value-1", []string{"same-value-1", "same-value-1"}},
		{"repeat not inside a word", "password=Tide8! and xTide8!x but Tide8! alone", []string{"Tide8!", "Tide8!"}},
		{"adjacent", "PASSWORD=a1;TOKEN=b2&SECRET=c3", []string{"a1", "b2", "c3"}},
		{"two on a line", "The password is Willow6! and the API key is K7gsuHixrwyE1VJFpqZ3HGet1XO3ZULnNssC.",
			[]string{"Willow6!", "K7gsuHixrwyE1VJFpqZ3HGet1XO3ZULnNssC"}},
	})
}

// Overlaps (docs/decisions.md, #108): a provider's exact format beats a
// structural span around it; a structural value boundary beats Gitleaks'
// generic rule; one range found twice is one candidate with both kinds.
func TestScanOverlaps(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, text string
		want       []string
		kinds      [][]string
	}{
		{"provider inside structural", "token=ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167,extra",
			[]string{"ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"}, [][]string{{"gitleaks:github-pat"}}},
		{"same range merged", `GITHUB_TOKEN="ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"`,
			[]string{"ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"}, [][]string{{"assignment", "gitleaks:github-pat", "prose"}}},
		{"structural beats generic", `api_key = "Xk29fLq0ZrMv8;tail"`,
			[]string{"Xk29fLq0ZrMv8;tail"}, [][]string{{"assignment", "prose"}}},
		{"pem", "Use this private key:\n" + pemKey,
			[]string{pemKey}, [][]string{{"gitleaks:private-key", "pem"}}},
	} {
		if tc.name == "structural beats generic" && !slices.ContainsFunc(promptsecret.Gitleaks(tc.text), func(m promptsecret.RuleMatch) bool {
			return m.Rule == "generic-api-key" && tc.text[m.Start:m.End] == "Xk29fLq0ZrMv8"
		}) {
			t.Errorf("%s: the generic rule no longer finds the shorter range: pick another case", tc.name)
		}
		cs := promptsecret.Scan(tc.text)
		var got []string
		var kinds [][]string
		for _, c := range cs {
			got = append(got, tc.text[c.Start:c.End])
			kinds = append(kinds, c.Kinds)
		}
		if !slices.Equal(got, tc.want) || !slices.EqualFunc(kinds, tc.kinds, slices.Equal) {
			t.Errorf("%s: got %q %q, want %q %q", tc.name, got, kinds, tc.want, tc.kinds)
		}
		for i := 1; i < len(cs); i++ {
			if cs[i].Start < cs[i-1].End {
				t.Errorf("%s: candidates overlap: %+v", tc.name, cs)
			}
		}
	}
}

func TestScanEncodedFlag(t *testing.T) {
	t.Parallel()
	for text, want := range map[string]bool{
		`{"password": "a\"b"}`:      true,
		`export TOKEN="x\$y1"`:      true,
		"postgres://u:p%40ss@h/db":  true,
		"password: plain9":          false,
		"secret: |\n  one\n  two\n": true,
		`{"key":"-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"}`: true,
	} {
		cs := promptsecret.Scan(text)
		if len(cs) != 1 || cs[0].Encoded != want {
			t.Errorf("%q: %+v, want one with encoded %t", text, cs, want)
		}
	}
}

// A 32 KiB prompt is scanned whole: secrets at its start, middle and end.
func TestScanLongInput(t *testing.T) {
	t.Parallel()
	const size = 32 << 10
	filler := "Review the module and keep its behavior. "
	head, mid, tail := "PASSWORD=Head7!x ", " The password is Mid8!y. ", " API_KEY=C4ePZxIWz93RLnvISeHK7LXOVEkAPco15vUi6tM5"
	body := size - len(head) - len(mid) - len(tail)
	fill := strings.Repeat(filler, body/len(filler)+1)
	text := head + fill[:body/2] + mid + fill[:body-body/2] + tail
	if len(text) != size {
		t.Fatalf("built %d bytes", len(text))
	}
	got := values(text)
	if want := []string{"Head7!x", "Mid8!y", "C4ePZxIWz93RLnvISeHK7LXOVEkAPco15vUi6tM5"}; !slices.Equal(got, want) {
		t.Fatalf("got %q", got)
	}
}

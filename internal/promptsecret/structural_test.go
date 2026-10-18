package promptsecret_test

import (
	"encoding/base64"
	"os/exec"
	"regexp"
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

// ownDir is the tests' secrets directory; own says which paths are the
// bridge's files there (secretfiles' shape: two random names).
const ownDir = "/run/user/1000/herdr-world/secrets"

var ownName = regexp.MustCompile(`^[A-Z2-7]{26}/[A-Z2-7]{26}$`)

func own(path string) bool {
	rest, ok := strings.CutPrefix(path, ownDir+"/")
	return ok && ownName.MatchString(rest)
}

// ownRef is a reference the bridge could have written, to file (a name).
func ownRef(file string) string {
	return promptsecret.Reference(ownDir + "/ZAHZG3XWLNNJXZCMAIQUEMHIF7/" + file)
}

// values are the candidates' bytes, in order.
func values(text string) []string {
	var out []string
	for _, c := range promptsecret.Scan(text, own) {
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
		{"bridge reference", "password=" + ownRef("GXWCYAQQ2YUJGSWNCUK2JAZZ57") + " and the API key is " + ownRef("LEI5ZMIW4XSUXWUGR2R2IAUNOA") + ".", nil},
		{"empty", `password="" token=''`, nil},
		{"length check", "assert(password.length >= 12); // ensure a strong password", nil},
	})
}

// The bridge's own references (a follow-up of a sent prompt) are never
// proposed, in any syntax, nor is a bracket next to one; only the exact
// reference to one of its files is left out: what runs into one keeps its
// bytes outside it, a match that owes its shape or its edge to one takes no
// other value's bytes, and text that only looks like one is scanned.
func TestScanOwnReferences(t *testing.T) {
	t.Parallel()
	r1, r2 := ownRef("GXWCYAQQ2YUJGSWNCUK2JAZZ57"), ownRef("LEI5ZMIW4XSUXWUGR2R2IAUNOA")
	const gh = "ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"
	const ghHead = "ghp_GT2MQVTdhGOubkn5tfdOv4eY" // 28 of a GitHub token's 40 bytes: a reference holds the rest
	const jwtHead, jwtTail = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIi", ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
	const tfTail = ".atlasv1.k3Jd9fLq0ZrMv8Xw2PbN7cHt4YsG6uRe1WqA5oTz8iKl3mVy0nBx9Cj2FhD7gSaE4" // a reference holds its head
	checkScans(t, []scanCase{
		{"quoted", `PASSWORD="` + r1 + `" export TOKEN='` + r2 + `'`, nil},
		{"json", `{"api_key": "` + r1 + `", "password": "` + r2 + `"}`, nil},
		{"yaml", "password: " + r1 + "\ntoken: " + r2 + "\nsecret: |\n  " + r1 + "\n", nil},
		{"headers", "Authorization: Bearer " + r1 + "\nAuthorization: Basic " + r2 + "\nBearer " + r1, nil},
		{"urls", "postgres://app:" + r1 + "@db:5432/x https://h/x?token=" + r2 + "&x=1", nil},
		{"prose", "the password is " + r1 + ". The token is " + r2 + ", Le mot de passe est " + r1, nil},
		{"fenced", "Here is the token:\n```\n" + r1 + "\n```", nil},
		{"flags", "run --password " + r1 + " --token=" + r2, nil},
		{"adjacent and punctuated", "api_key=" + r1 + r2 + " PASSWORD=" + r1 + "; secret=(" + r2 + ")", nil},
		{"the issue's wording", "Use the API credential in this file: " + r1, nil},
		{"the tuning round's syntaxes", "The literal password used by the job is «" + r1 + "». curl -u admin:" + r1 + " https://x.test\n" +
			r2 + "\nThe preceding line is the actual deployment password. The API credential is " + r1 + ". " +
			"PASSWORD='" + r2 + "' Authorization: Bearer " + r1 + ". the token is (" + r2 + ").", nil},
		{"a value around one", `PASSWORD="Value-77! ` + r1 + `" password=hunter2` + r2, []string{"Value-77!", "hunter2"}},
		{"a path not of the bridge", `PASSWORD="Value-77! [secret in file /x]"`, []string{"Value-77! [secret in file /x]"}},
		{"forged", "Use [secret in file /token=" + gh + "] and [secret in file " + ownDir + "/ZAHZG3XWLNNJXZCMAIQUEMHIF7/" + gh + "]",
			[]string{gh, gh}},
		{"not closed", "password=" + strings.TrimSuffix(r1, "]"), []string{"[secret"}},
		{"a value repeated", "password=Hunter-22 " + r1 + " and Hunter-22 again", []string{"Hunter-22", "Hunter-22"}},
		// Review S1 (pass 2): only a reference's bytes, and a lone wrapper
		// beside it, are left out; any value next to one, on either side,
		// quoted or not, however weak, is proposed.
		{"symbols before, quoted", `PASSWORD="!@#%&+=?_- ` + r1 + `"`, []string{"!@#%&+=?_-"}},
		{"symbols before, unquoted", `PASSWORD=!@#%&+=?_-` + r1, []string{"!@#%&+=?_-"}},
		{"symbols after, quoted", `PASSWORD="` + r1 + ` !@#%&+=?_-"`, []string{"!@#%&+=?_-"}},
		{"symbols after, unquoted", `PASSWORD=` + r1 + `!@#%&+=?_-`, []string{"!@#%&+=?_-"}},
		{"brackets only", `PASSWORD="()[]{} ` + r1 + `"`, []string{"()[]{}"}},
		{"two wrappers", `PASSWORD="` + r1 + ` ))"`, []string{"))"}},
		{"one symbol", `PASSWORD="! ` + r1 + `" password=` + r1 + `%`, []string{"!", "%"}},
		{"digits only", `PASSWORD="` + r1 + ` 12345678" token=` + r1 + `4711`, []string{"12345678", "4711"}},
		{"letters only", `password=hunter` + r1 + ` secret: ` + r1 + `abcdefgh`, []string{"hunter", "abcdefgh"}},
		{"short", `PASSWORD=a` + r1 + ` api_key="` + r1 + `x1"`, []string{"a", "x1"}},
		{"both sides", `PASSWORD="ab ` + r1 + ` #9" password=Z` + r1 + `9`, []string{"ab", "#9", "Z", "9"}},
		{"lone wrappers", "secret=(" + r1 + ") token=[" + r2 + "] password=\"" + r1 + ",\"", nil},
		// Review S1 (pass 3): a reference stands for a value's place, not
		// its content. A match whose shape the masked reference completes
		// (a token format, a header's length), before, around or after it,
		// never takes the bytes of the value around it.
		{"a token the mask completes", `PASSWORD="` + ghHead + r1 + ` Tail-Sentinel-77!"`, []string{ghHead, "Tail-Sentinel-77!"}},
		{"a token the mask completes, symbols", `PASSWORD="` + ghHead + r1 + `!@#%&+=?_-"`, []string{ghHead, "!@#%&+=?_-"}},
		{"a token the mask completes, unquoted", `PASSWORD=` + ghHead + r1 + `Tail-Sentinel-77!`, []string{ghHead, "Tail-Sentinel-77!"}},
		{"a token the mask completes, two references", `PASSWORD="` + ghHead + r1 + ` mid-77 ` + r2 + ` Tail-77!"`,
			[]string{ghHead, "mid-77", "Tail-77!"}},
		{"a fine-grained token", `TOKEN="github_pat_11ABCDEFG0abcdefghijk` + r1 + ` and-tail"`,
			[]string{"github_pat_11ABCDEFG0abcdefghijk", "and-tail"}},
		{"a JWT around one", `TOKEN="` + jwtHead + r1 + jwtTail + ` and-tail"`, []string{jwtHead, jwtTail + " and-tail"}},
		{"a JWT around one, unquoted", `TOKEN=` + jwtHead + r1 + jwtTail + `;more`, []string{jwtHead, jwtTail + ";more"}},
		{"a token from inside one", `TOKEN="` + r1 + tfTail + ` and-tail"`, []string{tfTail + " and-tail"}},
		{"a header the mask lengthens", `PASSWORD="Bearer abc` + r1 + ` tail-77"`, []string{"Bearer abc", "tail-77"}},
		// Chosen: a header credential protected out of a quoted value
		// proposes the value's other words again, as a token's does
		// (PASSWORD="[…] tail"): the mask cannot vouch for the header.
		{"a header in a value", `PASSWORD="Bearer ` + r1 + ` tail"`, []string{"Bearer", "tail"}},
		// A match the reference's '[' cut short takes no bytes either.
		{"a token typed up to one", `TOKEN="xoxb-1234567890-1234567890abc` + r1 + ` and-tail"`,
			[]string{"xoxb-1234567890-1234567890abc", "and-tail"}},
		{"a header typed up to one", `PASSWORD="Bearer abcdefghij123456` + r1 + `def"`, []string{"Bearer abcdefghij123456", "def"}},
		// What only runs through a reference keeps its boundary and rank.
		{"a header through one", "Authorization: Bearer abc" + r1 + "def", []string{"abc", "def"}},
		{"a bare header through one", "Bearer abcdefghij123456" + r1 + "def", []string{"abcdefghij123456", "def"}},
		{"prose through one", "the password is ab" + r1 + "cd", []string{"ab", "cd"}},
		{"a query value in a value", `PASSWORD="https://h/x?token=abc` + r1 + `&x=1"`, []string{"abc"}},
		{"a query reference in a value", `PASSWORD="https://h/x?token=` + r1 + `&x=1"`, nil},
		{"a template's sign", "PASSWORD=$" + r1, []string{"$"}},
		{"a token's head alone", ghHead + r1, []string{ghHead}},
		// Review S1 (pass 4): a match the reference helped (the mask's
		// bytes, or an edge its '[' made) that wins never takes the typed
		// bytes of the value around it, even when the value's own span
		// was itself shaped (prose, a bare Bearer, a header without a
		// scheme) and so borrowed too.
		{"prose, a token the mask completes", "the password is " + ghHead + r1 + "Tail-Sentinel-77!", []string{ghHead, "Tail-Sentinel-77!"}},
		{"key prose, a token the mask completes", "the token is " + ghHead + r1 + "Tail-Sentinel-77!", []string{ghHead, "Tail-Sentinel-77!"}},
		{"a bare header, a token the mask completes", "Bearer " + ghHead + r1 + "Tail-Sentinel-77!", []string{ghHead, "Tail-Sentinel-77!"}},
		{"a header without a scheme, a token the mask completes", "Authorization: " + ghHead + r1 + "Tail-Sentinel-77!",
			[]string{ghHead, "Tail-Sentinel-77!"}},
		{"prose, two references", "the password is " + ghHead + r1 + "Tail77" + r2 + "End88", []string{ghHead, "Tail77", "End88"}},
		{"prose, a fine-grained token", "the token is github_pat_11ABCDEFG0abcdefghijk" + r1 + "Tail77",
			[]string{"github_pat_11ABCDEFG0abcdefghijk", "Tail77"}},
		{"a bare header, a Slack token", "Bearer xoxb-1234567890-k3Jd9" + r1 + "Tail77", []string{"xoxb-1234567890-k3Jd9", "Tail77"}},
		// A dotted value glued to one is a value, not code: what a
		// reference is beside is never a dotted name.
		{"a JWT's rest after one", "PASSWORD=" + r1 + jwtHead + jwtTail, []string{jwtHead + jwtTail}},
		{"a bare header, a JWT before one", "Bearer " + jwtHead + jwtTail + r1, []string{jwtHead + jwtTail}},
		// The tuning round's detectors through one.
		{"quoted words through one", `the password used by the job is "ab` + r1 + `cd"`, []string{"ab", "cd"}},
		{"curl through one", "curl -u admin:ab" + r1 + "cd https://x.test", []string{"ab", "cd"}},
		{"a named line through one", "ab" + r1 + "cd\nThe preceding line is the actual password.", []string{"ab", "cd"}},
		{"credential phrase through one", "The API credential is AKIAH3JW" + r1 + "!Q6RM3UVZ7XK", []string{"AKIAH3JW", "!Q6RM3UVZ7XK"}},
		// Review S1 (tune): a match typed whole inside a value that runs into
		// one (a complete token, a header's credential, a URL's password)
		// takes none of the value's other typed bytes, before or after it.
		{"a complete token inside a value", `PASSWORD="Prefix-Sentinel-77-` + gh + "!" + r1 + `Tail-Sentinel-77!"`,
			[]string{"Prefix-Sentinel-77-", gh, "!", "Tail-Sentinel-77!"}},
		{"a complete token inside a value, glued", `PASSWORD="Prefix77-` + gh + r1 + `Tail77"`, []string{"Prefix77-", gh, "Tail77"}},
		{"a complete token after one", `PASSWORD="` + r1 + `Prefix77-` + gh + `"`, []string{"Prefix77-", gh}},
		{"prose, a complete token inside", `the password is "Prefix77-` + gh + "!" + r1 + `Tail77"`, []string{"Prefix77-", gh, "!", "Tail77"}},
		{"prose unquoted, a complete token inside", "the password is Prefix77-" + gh + "!" + r1 + "Tail77", []string{"Prefix77-", gh, "!", "Tail77"}},
		{"a bare header, a complete token inside", "Bearer Prefix77-" + gh + r1 + "Tail77", []string{"Prefix77-", gh, "Tail77"}},
		{"a header inside a value", `PASSWORD="Bearer abcdefghij1234567890 ` + r1 + ` tail"`, []string{"Bearer", "abcdefghij1234567890", "tail"}},
		{"a URL's password inside a value", `PASSWORD="https://app:Hunter-22@db.test ` + r1 + `"`, []string{"https://app:", "Hunter-22", "@db.test"}},
		// Chosen: beside one, the value's next item is its bytes too
		// (without one, token=ghp_…,extra proposes the token alone).
		{"a token and a list beside one", `PASSWORD="` + gh + `,extra ` + r1 + `"`, []string{gh, ",extra"}},
	})
	// A part keeps the detectors of the range it was cut from.
	for _, text := range []string{`PASSWORD="!@#%&+=?_- ` + r1 + `"`, `PASSWORD=` + r1 + `!@#%&+=?_-`} {
		for _, c := range promptsecret.Scan(text, own) {
			if len(c.Kinds) == 0 {
				t.Errorf("%q: %q has no kinds", text, text[c.Start:c.End])
			}
		}
	}
	// With no own paths, a reference is text like any other.
	if cs := promptsecret.Scan(`PASSWORD="`+r1+`"`, nil); len(cs) != 1 {
		t.Fatalf("no own paths: %+v", cs)
	}
	// Review T6: only an own reference makes a value glued to it no code,
	// never the mask's bytes typed.
	for _, paths := range []func(string) bool{nil, own} {
		if cs := promptsecret.Scan("const token = response.Qz7Qz7Qz7; password = getSecret(Qz7Qz7)", paths); len(cs) != 0 {
			t.Errorf("the mask's bytes typed: %+v", cs)
		}
	}
}

// Review S1 (pass 4, and the tuning round), as a matrix: a value that runs
// into the bridge's own references, in each syntax, on either side of one,
// between two, with typed bytes before the token or not, keeps every typed
// byte outside them proposed, whatever wins inside it (a token the mask
// completes, one a reference's '[' cuts short, a complete one).
// Only the references' bytes, a lone wrapper beside one, and an unquoted
// value's closing bracket (a sentence's) are left out.
func TestScanReferenceMatrix(t *testing.T) {
	t.Parallel()
	r1, r2 := ownRef("GXWCYAQQ2YUJGSWNCUK2JAZZ57"), ownRef("LEI5ZMIW4XSUXWUGR2R2IAUNOA")
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
	tokens := []struct{ name, head, rest string }{ // the middle layout puts a reference between head and rest
		{"github", "ghp_GT2MQVTdhGOubkn5tfdOv4eY", "nhJvEkcAI167"},
		{"github prefix", "ghp_GT2MQVTdhGOubkn5tfdOv4eY", "Tail77"}, // the mask completes it
		{"fine-grained prefix", "github_pat_11ABCDEFG0abcdefghijk", "Tail77"},
		{"slack", "xoxb-1234567890-k3Jd9", "fLq0ZrMv8Xw2PbN"},
		{"slack prefix", "xoxb-1234567890-k3Jd9", "Tail77"},
		{"aws", "AKIAJ5CW2G4N", "7Q6RM3UV"},
		{"stripe", "sk_live_k3Jd", "9fLq0ZrMv8"},
		{"openai prefix", "sk-k3Jd9fLq0ZrMv8Xw2PbNT3BlbkFJ", "Tail77"},
		{"huggingface", "hf_iTfQyUrymftnlmTum", "hmfJBgIuQynOSNPdV"},
		{"jwt", jwt[:46], jwt[46:]},
		{"jwt split", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIi", ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"},
		{"password", "k3Jd9fLq0ZrMv8", "Tail77"},
	}
	syntaxes := []struct {
		name, pre, post string
		quoted          bool
	}{
		{"assignment quoted", `PASSWORD="`, `"`, true},
		{"assignment unquoted", "PASSWORD=", "", false},
		{"json", `{"api_key": "`, `"}`, true},
		{"prose quoted", `the password is "`, `"`, true},
		{"prose unquoted", "the password is ", "", false},
		{"key prose quoted", `the token is "`, `"`, true},
		{"key prose unquoted", "the token is ", "", false},
		{"bare bearer", "Bearer ", "", false},
		{"header without a scheme", "Authorization: ", "", false},
		{"header", "Authorization: Bearer ", "", false},
	}
	trailing := []string{"", "TailSentinel", "!@#%&+=?_-", ")"}
	for _, tok := range tokens {
		layouts := []struct{ name, value string }{
			{"before", r1 + tok.head + tok.rest},
			{"after", tok.head + tok.rest + r1},
			{"middle", tok.head + r1 + tok.rest},
			{"two", tok.head + r1 + tok.rest + r2 + "End88"},
			// Review S1 (tune): typed bytes before the token too.
			{"typed before, after", "Prefix-77-" + tok.head + tok.rest + r1},
			{"typed around, after", "Prefix-77-" + tok.head + tok.rest + "!" + r1},
			{"typed before, before", r1 + "Prefix-77-" + tok.head + tok.rest},
			{"typed before, middle", "Prefix-77-" + tok.head + r1 + tok.rest},
		}
		t.Run(tok.name, func(t *testing.T) {
			t.Parallel()
			for _, l := range layouts {
				for _, tail := range trailing {
					for _, syn := range syntaxes {
						checkReferenceCoverage(t, l.name+"/"+syn.name+"/"+tail, syn.pre, l.value+tail, syn.post, syn.quoted)
					}
				}
			}
		})
	}
}

// checkReferenceCoverage scans pre+value+post and checks that every byte of
// value outside own references is in a candidate (but a part that is only a
// wrapper, and an unquoted value's unbalanced closing bracket), that no
// candidate holds a reference's byte, and that candidates never overlap.
func checkReferenceCoverage(t *testing.T, name, pre, value, post string, quoted bool) {
	t.Helper()
	text := pre + value + post
	cs := promptsecret.Scan(text, own)
	covered := make([]bool, len(text))
	for i, c := range cs {
		if i > 0 && c.Start < cs[i-1].End {
			t.Errorf("%s: candidates overlap: %+v", name, cs)
		}
		for j := c.Start; j < c.End; j++ {
			covered[j] = true
		}
		if strings.Contains(text[c.Start:c.End], "[secret in file "+ownDir) {
			t.Errorf("%s: a candidate holds a reference: %q", name, text[c.Start:c.End])
		}
	}
	refs := ownRefRe.FindAllStringIndex(value, -1)
	at := 0
	var missing []string
	for k := 0; k <= len(refs); k++ {
		end := len(value)
		if k < len(refs) {
			end = refs[k][0]
		}
		part := value[at:end]
		if k == len(refs) && !quoted && strings.HasSuffix(part, ")") && strings.Count(part, ")") > strings.Count(part, "(") {
			part = part[:len(part)-1]
		}
		if part != "" && !isWrapper(part) {
			for j := range len(part) {
				if !covered[len(pre)+at+j] {
					missing = append(missing, part)
					break
				}
			}
		}
		if k < len(refs) {
			at = refs[k][1]
		}
	}
	if len(missing) > 0 {
		t.Errorf("%s: %q: %q not proposed; got %q", name, text, missing, values(text))
	}
}

var ownRefRe = regexp.MustCompile(regexp.QuoteMeta("[secret in file "+ownDir+"/") + `[^\]]+\]`)

// isWrapper is a part a scan may leave out beside a reference: blanks and
// at most one quote, bracket or comma (docs/decisions.md, #108 row 6).
func isWrapper(v string) bool {
	return len(strings.TrimSpace(v)) <= 1 && strings.Trim(v, " \"'`()[]{},") == ""
}

// Recall (#108, the detector-tuning round): each class a held-out
// evaluation found missing or cut short, with a clean look-alike beside
// it (these cases are this repository's own).
func TestScanRecall(t *testing.T) {
	t.Parallel()
	const hf = "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"
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
	const gh = "ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"
	// A JWT of 3 KB (review T5: the pass looked 1 KiB back from the period).
	longJWT := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." +
		base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"user123","scope":"`+strings.Repeat("read-write-employee123 ", 100)+`"}`)) +
		".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
	checkScans(t, []scanCase{
		// 1. A provider's token before a sentence's punctuation: its rule
		// asks for a blank, a quote or the end after it.
		{"token ends a sentence", "Here is the credential: " + hf + ".", []string{hf}},
		{"token in parentheses", "If it fails, retry with token (" + hf + ".", []string{hf}},
		{"token closes parentheses", "the Hugging Face one (" + hf + "). Then", []string{hf}},
		{"stripe before a period", "Use sk_live_k3Jd9fLq0ZrMv8. Then deploy.", []string{"sk_live_k3Jd9fLq0ZrMv8"}},
		{"jwt before a comma", "the session cookie holds " + jwt + ", which expires", []string{jwt}},
		{"token before an exclamation", "Finally got it: " + hf + "!", []string{hf}},
		{"a long token ends a sentence", "Use " + longJWT + ".", []string{longJWT}},
		{"a long token, notes before", strings.Repeat("notes for deployment\n", 200) + "Use " + longJWT + ".", []string{longJWT}},
		{"a long token, no punctuation", "Use " + longJWT, []string{longJWT}},
		// Each ending after an opening parenthesis, at a line's end and
		// before more words (E2: a colon before more text was read as a
		// name's only).
		{"( token : at a line's end", "If it fails, retry with token (" + hf + ":\nThen it works.", []string{hf}},
		{"( token : before words", "If it fails, retry with token (" + hf + ": then it works.", []string{hf}},
		{"( token : at the end", "If it fails, retry with token (" + hf + ":", []string{hf}},
		{"( token . at a line's end", "If it fails, retry with token (" + hf + ".\nThen it works.", []string{hf}},
		{"( token . before words", "If it fails, retry with token (" + hf + ". Then it works.", []string{hf}},
		{"( token ; at a line's end", "If it fails, retry with token (" + hf + ";\nThen it works.", []string{hf}},
		{"( token ; before words", "If it fails, retry with token (" + hf + "; then it works.", []string{hf}},
		{"( token ) at a line's end", "If it fails, retry with token (" + hf + ")\nThen it works.", []string{hf}},
		{"( token ) before words", "If it fails, retry with token (" + hf + ") then it works.", []string{hf}},
		{"token : at a line's end", "retry with token " + hf + ":\nnext", []string{hf}},
		{"token : before a long word", "the token " + hf + ": https://huggingface.co/settings/tokens", []string{hf}},
		{"( token : before a long line", "retry with token (" + hf + ":\nhttps://huggingface.co/settings/tokens", []string{hf}},
		{"tokens : before each other", "tokens " + hf + ": " + gh + ":\nnext", []string{hf, gh}},
		// A long name's colon is no sentence's: the keyword's rule needs it.
		{"a long name's value", "adafruit_io_key: k3jd9flq0zrmv8xw2pbn7cht4ysg6ure.", []string{"k3jd9flq0zrmv8xw2pbn7cht4ysg6ure"}},
		{"a long name's value on the next line", "adafruit_io_key:\n  k3jd9flq0zrmv8xw2pbn7cht4ysg6ure.", []string{"k3jd9flq0zrmv8xw2pbn7cht4ysg6ure"}},
		{"a long name's value before a colon", "adafruit_io_key: k3jd9flq0zrmv8xw2pbn7cht4ysg6ure:\nnext", []string{"k3jd9flq0zrmv8xw2pbn7cht4ysg6ure"}},
		{"long names' colons", "deploy_key_v77_prod:\n  build_2026_10_18_rc1: done\nhuggingface_hub_cache: /var/cache/hf_models_2026\n" +
			"hf_transfer_enabled_flag: true (huggingface_hub_v2:", nil},
		{"a word with a token's prefix", "Install hf_transfer. Then set sk_live_mode, and run it.", nil},
		{"a short prefix", "Read the hf_hub docs (see sk_test).", nil},
		// 2. A header's credential runs to its end: a blank or a quote (a
		// sentence's punctuation off when a blank follows), symbols kept.
		{"header with a symbol", "Authorization: Bearer AKIAH3JW!Q6RM3UVZ7XK\r\nAccept: x", []string{"AKIAH3JW!Q6RM3UVZ7XK"}},
		{"header line keeps its punctuation", "Authorization: Bearer UK0CcwZUvP8p!.:\r\nHost: x\r\n", []string{"UK0CcwZUvP8p!.:"}},
		{"header at the end", "Authorization: Basic dXNlcjpwYXNzd29yZA==!", []string{"dXNlcjpwYXNzd29yZA==!"}},
		{"bare header with a symbol", "send Bearer Zx81mQp27LwRt5!Yv9Nc, then wait", []string{"Zx81mQp27LwRt5!Yv9Nc"}},
		{"header in quotes", `curl -H 'Authorization: Bearer abc!DEF-123' https://x.test`, []string{"abc!DEF-123"}},
		{"header in a sentence", "send Authorization: Bearer Zx81mQp27LwRt5Yv9Nc. Then wait", []string{"Zx81mQp27LwRt5Yv9Nc"}},
		{"credential phrase", "The actual API credential is AKIAH3JW!Q6RM3UVZ7XK and nothing else.", []string{"AKIAH3JW!Q6RM3UVZ7XK"}},
		{"credentials colon", "credentials: Zx81-mQp27-LwRt5", []string{"Zx81-mQp27-LwRt5"}},
		{"header templates", "Authorization: Bearer ${TOKEN}\nAuthorization: Bearer sk-proj-${OPENAI_API_KEY}\n" +
			`-H "Authorization: Bearer $(gcloud auth print-access-token)"`, nil},
		// What the shell expands is no credential (review T4 (p2)); in
		// single quotes it keeps the '$'.
		{"header expansions", `curl -H "Authorization: Bearer $$" -H "Authorization: Bearer $?" -H "Authorization: Bearer abc$TOKEN" ` +
			`-H "Authorization: Bearer Zx81mQp27LwRt5$1" -H "Authorization: Basic dXNlcjpwYXNz$[1]" https://x.test` + "\n" +
			"Authorization: Bearer Zx81mQp27LwRt5$@\nsend Bearer Zx81mQp27LwRt5$HOST_9, then wait", nil},
		{"header literal $ in single quotes", `curl -H 'Authorization: Bearer Zx81mQp27LwRt5$HOME' https://x.test`, []string{"Zx81mQp27LwRt5$HOME"}},
		{"header $ before no expansion", `curl -H "Authorization: Bearer Zx81mQp27LwRt5$%" https://x.test`, []string{"Zx81mQp27LwRt5$%"}},
		{"bearer url", "use Bearer https://auth.example.test/oauth2/token123456 there", nil},
		{"header placeholder", "curl -H 'Authorization: Bearer [key]' https://api.example.test", nil},
		{"credential words without values", "The credential is stored in the vault. Credentials: see the docs. Rotate API credentials yearly.", nil},
		// A provider's format inside a wider value: the value's rest glued
		// after it is proposed too; a list's next item, a URL's query or
		// path is not the value's rest.
		{"provider prefix in a header", "Authorization: Bearer " + gh + "!tail9", []string{gh, "!tail9"}},
		{"provider prefix in an assignment", `PASSWORD="AKIAJ5CW2G4N7Q6RM3UV!x9 more"`, []string{"AKIAJ5CW2G4N7Q6RM3UV", "!x9"}},
		{"provider prefix in prose", "the API key is " + gh + "-old2 now", []string{gh, "-old2"}},
		{"provider then a list", "token=" + gh + ",extra", []string{gh}},
		{"provider then a query", "the token is https://api.example.test/?access_token=" + gh + "&x=1", []string{gh}},
		{"provider then a path", "the token is " + gh + "/settings", []string{gh}},
		{"provider then a period in quotes", `the token is "` + gh + `."`, []string{gh}},
		{"provider then an escape", `"Github_Token: ` + gh + `\r\nUse it."`, []string{gh}},
		// 3. A shell word's '\'' keeps the value whole.
		{"shell escape", `PASSWORD='abc'\''def9'`, []string{`abc'\''def9`}},
		{"shell escape flag", `run --password 'abc'\''def' now`, []string{`abc'\''def`}},
		{"shell escape export", `export DB_PASSWORD='it'\''s-Secret9'`, []string{`it'\''s-Secret9`}},
		{"shell escape without a credential", `echo 'it'\''s fine'`, nil},
		// 4. curl's -u user:password: the password, escapes as typed.
		{"curl user", `curl -u "user:pa\"ss\$HOME\` + "`id\\`" + `\\end" https://x.test`, []string{`pa\"ss\$HOME\` + "`id\\`" + `\\end`}},
		{"curl user unquoted", "curl --user admin:s3cret! https://x.test", []string{"s3cret!"}},
		{"curl user glued", "curl -sSf -uadmin:hunt3r! https://x.test", []string{"hunt3r!"}},
		{"curl's own rule", "curl -u admin:hunter22 https://x.test", []string{"admin:hunter22"}},               // Gitleaks' format wins
		{"curl user quoted mid-word", "curl -u admin:'hun ter2' https://x.test", []string{"admin:'hun ter2'"}}, // Gitleaks' format
		{"curl user templates", `curl -u "$USER:$PASS" https://x.test; curl -u user: https://x.test; curl -u ${CREDS} https://x.test`, nil},
		{"curl user placeholders", "Use `curl -u user:pass https://x.test` or curl -u user:password, curl --user admin:[key] there.", nil},
		{"not curl", "docker run -u 1000:1000 img && git push -u origin main && ps -u root:root", nil},
		{"not curl's flag", "see curl docs; docker run -u 1000:1000 img", nil},
		// Review T1: a quoted | ; & is an argument's, no command's end.
		{"curl after a quoted query", `curl 'https://example.test/?a=1&b=2' -u "user:pa\"ss\$HOME"`, []string{`pa\"ss\$HOME`}},
		{"curl after a quoted ;", `curl 'https://example.test/?a=1;b=2' -u "user:pa\"ss\$HOME"`, []string{`pa\"ss\$HOME`}},
		{"curl after a double-quoted |", `curl -H "X-Filter: a|b" --user admin:s3cret! https://x.test`, []string{"s3cret!"}},
		{"curl after an escaped &", `curl https://x.test/?a=1\&b=2 --user admin:s3cret!`, []string{"s3cret!"}},
		{"not curl after an unquoted &", "curl https://x.test & sudo --user admin:s3cret! true", nil},
		// Review T4: what the shell computes is no password (an escaped $ or
		// one in single quotes is typed). One-letter users: Gitleaks' own
		// curl rule asks for three.
		{"curl user substitution", `curl -u "u:abc$(cmd)" https://x.test`, nil},
		{"curl user substitution, long flag", `curl --user "u:abc$(cmd)" https://x.test`, nil},
		{"curl user expansion", `curl -u "u:pre${HOST}" https://x.test`, nil},
		{"curl user variable", `curl -u admin:ab!c$HOME https://x.test`, nil},
		{"curl user backquotes", `curl -u "u:abc` + "`id`" + `" https://x.test`, nil},
		{"curl user parameter", `curl -u u:'abc'$1 https://x.test`, nil},
		{"curl user literal $", `curl -u 'u:abc$HOME9' https://x.test`, []string{"abc$HOME9"}},
		// Review T4 (p2): every '$' the shell expands, in double quotes or
		// none: a special parameter, a digit, $[…], and unquoted $'…' and
		// $"…" (their bytes are not the password's); before the password
		// too when the colon is inside it (${CREDS:-u:pw}).
		{"curl user special parameters", `curl -u "u:abc$?" https://x.test; curl -u "u:abc$$" https://x.test; ` +
			`curl -u "u:abc$@" https://x.test; curl -u "u:abc$*" https://x.test; curl -u "u:abc$!" https://x.test; ` +
			`curl -u "u:abc$#" https://x.test; curl -u "u:abc$-" https://x.test; curl -u "u:abc$0" https://x.test`, nil},
		{"curl user special parameters unquoted", `curl -u u:abc$$ https://x.test; curl -u u:abc$? https://x.test; curl -u u:x$-y https://x.test`, nil},
		{"curl user arithmetic", `curl -u "u:abc$[1+2]x" https://x.test`, nil},
		{"curl user ANSI-C and locale quotes", `curl -u u:$'p\x41ss' https://x.test; curl -u u:pre$"x9k2" https://x.test`, nil},
		{"curl user colon inside an expansion", `curl -u ${C:-u:x9} https://x.test; curl -u "$(u:x)" https://x.test`, nil},
		{"curl user colon inside backquotes", "curl -u \"`u:x`\" https://x.test", nil},
		{"curl user after an expansion", `curl -u "$U:abc9!" https://x.test`, []string{"abc9!"}},
		{"curl user literal $ forms", `curl -u "u:abc$" https://x.test; curl -u "u:ab$%c" https://x.test; curl -u "u:ab$'c" https://x.test; ` +
			`curl -u 'u:abc$$' https://x.test; curl -u "u:abc\$\$" https://x.test`,
			[]string{"abc$", "ab$%c", "ab$'c", "abc$$", `abc\$\$`}},
		{"templates inside quoted words and named lines", `the password used by the job is "pw-${HOST}9" today` + "\n" +
			"key-$(hostname)-77\nThe preceding line is the actual password.", nil},
		// 5. A quoted value after a credential word and a few words more.
		{"quoted after words", `the password enclosed in these quotes, including the last character: "Kx81-mQp27LwRt5."`, []string{"Kx81-mQp27LwRt5."}},
		{"quoted after words, colon", `the password enclosed in these quotes, including the last character: "Kx81-mQp27LwRt5:"`, []string{"Kx81-mQp27LwRt5:"}},
		{"guillemets after words", "The literal password used by the deploy job is «clé-Ab12xYz🔐é.終».", []string{"clé-Ab12xYz🔐é.終"}},
		{"a phrase with commas", "The literal password, including its punctuation, is «Qx7-mR2!pL9.».", []string{"Qx7-mR2!pL9."}}, // E1
		{"quoted after a relative clause", `The password that the nightly job reads is "Kx81-mQp27LwRt5".`, []string{"Kx81-mQp27LwRt5"}},
		{"quoted after a preposition", `The token for the staging cluster we deploy to is "Zx81mQp27LwRt5Yv9Nc".`, []string{"Zx81mQp27LwRt5Yv9Nc"}},
		{"quoted token after words", `The API token we rotated yesterday is "Zx81mQp27LwRt5Yv9Nc".`, []string{"Zx81mQp27LwRt5Yv9Nc"}},
		{"a copula before the quote", `return "the saved key is only ever sent to "+st.Instance.APIBase+"."`, nil},
		{"quoted words about a password", `The password field is "required". The password validation message is "Password too short". ` +
			`Passwords must include one of these symbols: "!@#$%^&*". The password policy setting is "min_length=12". ` +
			`The token endpoint is "/oauth/token". The secret name in the vault is "db-password".`, nil},
		// 6. What prose says a password was set to is the value assigned.
		{"was set to", "Note: the password was set to `example` on the staging box.", []string{"example"}},
		{"is set to", "the password is set to `hunter2`", []string{"hunter2"}},
		{"has been changed to", `The admin password has been changed to "Spring-2026".`, []string{"Spring-2026"}},
		{"set to a template", "the password was set to ${DB_PASSWORD}; the token was set to <your-token>; the secret was set to `****`; " +
			`the API key was set to os.getenv("KEY"); the password was set to {{ .Values.pw }}; the password was set to REDACTED.`, nil},
		{"set to words", "The password was set to the default. The token is set to expire.", nil},
		// 7. A line of one value a later sentence names.
		{"preceding line", "Kx81mQp27LwRt-Yvq9\nThe preceding line is the actual deployment password.", []string{"Kx81mQp27LwRt-Yvq9"}},
		{"line above, blank between", "Notes:\n  Zx81mQp27LwRt5Yv9Nc  \n\nThe line above is our API token.", []string{"Zx81mQp27LwRt5Yv9Nc"}},
		{"line above, its own line", "Zx81mQp27LwRt5Yv9Nc\nLine above is the API token.", []string{"Zx81mQp27LwRt5Yv9Nc"}},
		{"first line", "Kx81mQp27LwRt-Yvq9\nPlease rotate it.\nThe first line is the password.", []string{"Kx81mQp27LwRt-Yvq9"}},
		{"lines named, no value", "if err != nil {\n}\nThe previous line is the key to this bug.\nreturn x.y\nThe preceding line is the token check.", nil},
	})
	for _, text := range []string{`PASSWORD='abc'\''def9'`, `curl -u "user:pa\"ss" https://x.test`} {
		if cs := promptsecret.Scan(text, own); len(cs) != 1 || !cs[0].Encoded {
			t.Errorf("%q: %+v, want one encoded candidate", text, cs)
		}
	}
}

// curl's password and a header's credential are read as the shell reads
// their argument, from its start (review T4 (p2), T3P-1): each value shape
// in each quoting context is proposed as typed when the shell keeps all its
// bytes, and not at all when it computes one. A header's credential ends at
// a blank, quote, backslash or backquote (decisions row 5), so its value is
// what comes before them.
func TestScanShellWords(t *testing.T) {
	t.Parallel()
	const pre, post = "Zx81!mQp27", "Lw9" // the ! keeps Gitleaks' own curl rule out
	const all, none, skip = "=", "", "-"  // the whole value; no candidate; a context that cannot hold the shape
	curl := []string{"curl -u u:%s https://x.test", "curl --user u:%s https://x.test", "curl -u 'u:%s' https://x.test",
		`curl -u "u:%s" https://x.test`}
	header := []string{"curl -H 'Authorization: Bearer %s' https://x.test", "curl -H 'Authorization: Bearer %s more' https://x.test",
		`curl -H "Authorization: Bearer %s" https://x.test`, `curl -H "Authorization: Bearer %s'x" https://x.test`,
		"Authorization: Bearer %s\nHost: x.test"}
	shapes := []struct {
		name, shape string
		// The candidate in curl's unquoted, '…' and "…" words, and in a
		// header's '…', "…" and own line.
		unquoted, single, double, hSingle, hDouble, hLine string
	}{
		{"a name", "$HOME", none, all, none, all, none, none},
		{"an escaped $", `\$HOME`, all, all, all, pre, pre, pre},
		{"${…}", "${HOST}", none, all, none, none, none, none}, // a header refuses a template, quoted or not
		{"$(…)", "$(id)", none, all, none, none, none, none},
		{"$((…))", "$((1+2))", none, all, none, none, none, none},
		{"$[…]", "$[1+2]", none, all, none, all, none, none},
		{"backquotes", "`id`", none, all, none, pre, pre, pre},
		{"$$", "$$", none, all, none, all, none, none},
		{"$?", "$?", none, all, none, all, none, none},
		{"$#", "$#", none, all, none, all, none, none},
		{"$!", "$!", none, all, none, all, none, none},
		{"$@", "$@", none, all, none, all, none, none},
		{"$-", "$-", none, all, none, all, none, none},
		{"$1", "$1", none, all, none, all, none, none},
		{"$'…'", "$'x'", all, skip, all, skip, pre + "$", pre + "$"},
		{"$'…' with an escape", `$'\x41'`, none, skip, all, skip, pre + "$", pre + "$"},
		{"a $ before nothing", "$%", all, all, all, all, all, all},
		{"a blank", " ", pre, all, all, pre, pre, pre},
		{"an apostrophe", "'", pre, skip, all, skip, pre, pre},
		{"operators", ";|&<>()", pre, all, all, all, all, all},
	}
	for _, sh := range shapes {
		v := pre + sh.shape + post
		check := func(form, want string) {
			if want == skip {
				return
			}
			text := strings.Replace(form, "%s", v, 1)
			var wants []string
			switch want {
			case all:
				wants = []string{v}
			case none:
			default:
				wants = []string{want}
			}
			if got := values(text); !slices.Equal(got, wants) {
				t.Errorf("%s: %q\n got  %q\n want %q", sh.name, text, got, wants)
			}
		}
		for i, form := range curl {
			check(form, []string{sh.unquoted, sh.unquoted, sh.single, sh.double}[i])
		}
		for i, form := range header {
			want := []string{sh.hSingle, sh.hSingle, sh.hDouble, sh.hDouble, sh.hLine}[i]
			if i == 1 && want == all && strings.ContainsRune(sh.shape, ' ') {
				want = pre
			}
			check(form, want)
		}
	}
	checkScans(t, []scanCase{
		// The reviewers' texts.
		{"unquoted substitution", "curl -u u:abc$(id) https://x.test", nil},
		{"unquoted arithmetic", "curl --user u:abc$((1+2)) https://x.test", nil},
		{"a blank in single quotes", "curl -H 'Authorization: Bearer P@$$w0rd ' https://x.test", []string{"P@$$w0rd"}},
		{"an apostrophe in double quotes", `curl -H "Authorization: Bearer $$'suffix" https://x.test; ` +
			`curl -H "Authorization: Bearer $?'suffix" https://x.test; curl -H "Authorization: Bearer abc$TOKEN'suffix" https://x.test`, nil},
		{"more in single quotes", "curl -H 'Authorization: Bearer Zx81mQp27LwRt5$HOME more' https://x.test", []string{"Zx81mQp27LwRt5$HOME"}},
		{"a tab in single quotes", "curl -H 'Authorization: Bearer a!B@c#D$e\t' https://x.test", []string{"a!B@c#D$e"}},
		// A substitution's own blanks, operators and quotes are inside it.
		{"an operator in a substitution", "curl -u u:abc$(id;echo x) https://x.test", nil},
		{"a quoted ) in a substitution", `curl -u u:abc$(echo ")")x https://x.test`, nil},
		{"a substitution left open", "curl -u u:abc$(id", nil},
		{"a backquote left open", "curl -u u:Zx81mQp27Lw9`", nil},
		// Backquotes hold a command, as $(…) does: Markdown's inline code,
		// a Go raw string, closed at their next unescaped backquote.
		{"inline code", "Run `curl -u u:Zx81mQp27Lw9` once", []string{"Zx81mQp27Lw9"}},
		{"raw strings", "{`curl -u admin:Zx81!mQp27Lw9`, `b https://x.test`}", []string{"Zx81!mQp27Lw9"}},
		{"a quote left open in backquotes", "Run `curl -u 'u:Zx81!mQp27Lw9` once", nil},
		{"a quote in backquotes holds none", "x=`curl -u \"u:Zx81!mQp27Lw9`\"", nil},
		// A word of one $'…' string is the bytes inside it, as '…' is.
		{"one $'…' string", "curl -u $'admin:Zx81!mQp27Lw9' https://x.test", []string{"Zx81!mQp27Lw9"}},
		{"one $'…' placeholder", "curl -u $'admin:[key]' https://x.test", nil},
		// An unquoted operator ends the word.
		{"after ;", "curl -u u:Zx81mQp27Lw9;echo ok", []string{"Zx81mQp27Lw9"}},
		{"after |", "curl -u u:Zx81mQp27Lw9|cat", []string{"Zx81mQp27Lw9"}},
		{"after &&", "curl -u u:Zx81mQp27Lw9&&echo ok", []string{"Zx81mQp27Lw9"}},
		{"after )", "(curl -u u:Zx81mQp27Lw9)", []string{"Zx81mQp27Lw9"}},
		{"after >", "curl -u u:Zx81mQp27Lw9>out", []string{"Zx81mQp27Lw9"}},
		// The user before the colon may be computed; a colon inside what
		// the shell computes may be the password's start.
		{"a name before the colon", "curl -u $USER:Zx81!mQp27Lw9 https://x.test", []string{"Zx81!mQp27Lw9"}},
		{"a substitution before the colon", "curl -u $(whoami):Zx81!mQp27Lw9 https://x.test", []string{"Zx81!mQp27Lw9"}},
		{"backquotes before the colon", "curl -u `whoami`:Zx81!mQp27Lw9 https://x.test", []string{"Zx81!mQp27Lw9"}},
		{"nested quotes before the colon", `curl -u $(printf '%s' "$(printf ')')"):Zx81!mQp27Lw9 https://x.test`,
			[]string{"Zx81!mQp27Lw9"}},
		{"a colon in what the shell computes", "curl -u ${C:-u:Zx81!mQp27Lw9} https://x.test", nil},
		// The option is read where the shell reads it: in a curl command
		// of its own, a $(…)'s too, over continued lines; never in a quote,
		// and never inside a password word read already (its bytes).
		{"curl in a substitution", "TOKEN=$(curl -s -u u:Zx81!mQp27Lw9 https://x.test)", []string{"Zx81!mQp27Lw9"}},
		{"a continued line", "curl https://x.test \\\n  -u u:Zx81!mQp27Lw9 \\\n  -o out", []string{"Zx81!mQp27Lw9"}},
		{"in a quoted command", `bash -c "curl -u u:Zx81!mQp27Lw9 https://x.test"`, nil},
		{"after an apostrophe", "Don't run curl -u u:Zx81!mQp27Lw9 here", nil},
		{"inside a password word", "curl -u u:$(curl -u u:Zx81!mQp27Lw9 https://x.test) https://x.test", nil},
		{"not curl's", "wget -u u:Zx81!mQp27Lw9 https://x.test; curl -o out https://x.test", nil},
		// A header's argument opens at the quote before its name, or at the
		// -H before it; a JSON key's quote closes before its value's opens.
		{"glued -H", "curl -H'Authorization: Bearer Zx81mQp27$HOMELw9' https://x.test", []string{"Zx81mQp27$HOMELw9"}},
		{"--header=", "curl --header='Authorization: Bearer Zx81mQp27$HOMELw9' https://x.test", []string{"Zx81mQp27$HOMELw9"}},
		{"$'…' header", "curl -H $'Authorization: Bearer Zx81mQp27LwRt5Yv9' https://x.test", []string{"Zx81mQp27LwRt5Yv9"}},
		{"after an apostrophe in prose", "Don't use -H 'Authorization: Bearer Zx81mQp27LwRt5$HOME' here", []string{"Zx81mQp27LwRt5$HOME"}},
		{"a bare Bearer in another header", "curl -H 'X-Token: Bearer Zx81mQp27LwRt5$HOME' https://x.test", []string{"Bearer", "Zx81mQp27LwRt5$HOME"}},
		{"a bare Bearer in double quotes", `curl -H "X-Token: Bearer Zx81mQp27LwRt5$HOME" https://x.test`, []string{"Bearer"}},
		{"JSON in single quotes", `"Authorization": 'Bearer Zx81mQp27LwRt5$x'`, []string{"Zx81mQp27LwRt5$x"}},
		{"JSON in double quotes", `{"Authorization":"Bearer Zx81mQp27LwRt5$x"}`, nil},
		// A header further into another quoted argument reads as unquoted
		// (decisions row 4): its argument's start is not known.
		{"a header inside a sentence in quotes", "echo 'see Authorization: Bearer Zx81mQp27LwRt5$HOME'", nil},
	})
}

// A header's credential is judged by the quotes of the word that holds it
// in a curl command, read from the word's start (review T3P-1); out of one
// (prose, a pasted request, JSON, inline code) by the quote before its
// name or the argument of a -H before it (headerArg). Each context holds a
// literal value (proposed whole) and one with $$ (proposed whole where the
// shell keeps it, not at all where it computes it).
func TestScanHeaderQuoting(t *testing.T) {
	t.Parallel()
	const plain, dollars = "Zx81mQp27LwRt5Yv9", "P@$$w0rdZx81mQp27"
	contexts := []struct {
		name, form string
		dollars    bool // the $$ one is proposed
	}{
		{"single quotes", "curl -H 'Authorization: Bearer %s' https://x.test", true},
		{"double quotes", `curl -H "Authorization: Bearer %s" https://x.test`, false},
		{"empty double quotes, then single", `curl -H ""Authorization:'Bearer %s ' https://x.test`, true},
		{"empty single quotes, then double", `curl -H ''Authorization:"Bearer %s'x" https://x.test`, false},
		{"a double quote inside single", `curl -H 'X-"Authorization: Bearer %s ' https://x.test`, true},
		{"an apostrophe inside double", `curl -H "X-'Authorization: Bearer %s" https://x.test`, false},
		{"a long name in single quotes", "curl -H 'X-" + strings.Repeat("n", 256) + ": Bearer %s ' https://x.test", true},
		{"a -H inside single quotes", "curl -H 'X-Token: -H Bearer %s ' https://x.test", true},
		{"a -H inside double quotes", `curl -H "X-Token: -H Bearer %s" https://x.test`, false},
		{"a JSON body in single quotes", `curl -d '{"Authorization": "Bearer %s"}' https://x.test`, true},
		{"a JSON body in double quotes", `curl -d "{\"Authorization\": \"Bearer %s\"}" https://x.test`, false},
		{"$'…'", "curl -H $'Authorization: Bearer %s' https://x.test", true},
		{"after a quoted apostrophe", `echo "it's"; curl -H 'Authorization: Bearer %s' https://x.test`, true},
		{"curl in a substitution", "TOKEN=$(curl -H 'Authorization: Bearer %s' https://x.test)", true},
		{"curl in a substitution, double", `TOKEN=$(curl -H "Authorization: Bearer %s" https://x.test)`, false},
		{"echo's output in a substitution", `curl -H "$(echo 'Authorization: Bearer %s')" https://x.test`, true},
		{"a continued line, single", "curl https://x.test \\\n  -H 'Authorization: Bearer %s'", true},
		{"a continued line, double", "curl https://x.test \\\n  -H \"Authorization: Bearer %s\"", false},
		{"a quote left open", `curl -H "Authorization: Bearer %s`, false},
		{"inline code", "Run `curl -H 'Authorization: Bearer %s' https://x.test` once", true},
		{"inline code, double", "Run `curl -H \"Authorization: Bearer %s\" https://x.test` once", false},
		// No curl command holds them.
		{"a request line", "Authorization: Bearer %s\nHost: x.test", false},
		{"JSON", `{"Authorization": "Bearer %s"}`, false},
		{"JSON, single-quoted value", `"Authorization": 'Bearer %s'`, true},
		{"prose's -H", "Don't send -H 'Authorization: Bearer %s' anywhere", true},
		{"an apostrophe after curl", `With curl it's -H "Authorization: Bearer %s" here`, false},
	}
	for _, c := range contexts {
		for _, v := range []string{plain, dollars} {
			text := strings.Replace(c.form, "%s", v, 1)
			s := strings.Index(text, v)
			want := v == plain || c.dollars
			found, touched := false, false
			for _, cand := range promptsecret.Scan(text, own) {
				found = found || cand.Start == s && cand.End == s+len(v)
				touched = touched || cand.Start < s+len(v) && s < cand.End
			}
			if found != want || !want && touched {
				t.Errorf("%s: %q: %+v, want the value proposed: %t", c.name, text, promptsecret.Scan(text, own), want)
			}
		}
	}
	// A header whose credentials start inside the last one's is their rest,
	// not a header of its own (each byte is read once: review T4P-1).
	checkScans(t, []scanCase{
		{"a header inside a template", "Authorization:${T}:Authorization:Zx81mQp27LwRt5Yv9", nil},
		{"a header after it", "Authorization: Bearer ${T} Authorization: Bearer Zx81mQp27LwRt5Yv9", []string{"Zx81mQp27LwRt5Yv9"}},
	})
}

// Clean text (#108): what is no secret stays unproposed, whatever the
// detectors learn: hashes, ids, blobs, fixtures, URLs, names, redactions,
// templates, prose about secrets and code.
func TestScanCleanText(t *testing.T) {
	t.Parallel()
	clean := []string{
		"Revert 9fceb02d0ae598e95dc970b74767f19372d61af8 and cherry-pick 4b825dc642cb6eb9a060e54bf8d69288fbee4904. Fixed in a1b2c3d.",
		"Request 3f2504e0-4f89-41d3-9a0c-0305e82c3301 failed; retry 550e8400-e29b-41d4-a716-446655440000.",
		"traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\nX-Request-Id: req_8f3k2j1h0g9f8d7s6a5",
		"The PNG header is iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==.",
		`"integrity": "sha512-3ZKbN0Fq7XhVb5uL0j7m4u0ZsG4J8e5v8Q7xQf9R2l1KkFzWw0C0c3V1d7Y6a8u9Ek5q1Zt0o2x3p4s5r6w7y8A=="`,
		"golang.org/x/text v0.14.0 h1:ScX5w1eTa3QqT8oi6+ziP7dTV1S2+ALU0bI+0zXKWiQ=\nsha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		`const fixture = "Zm9vYmFyYmF6cXV4"; expected := "a3f5c9e1b7d2c8f4"; seed = 0x5DEECE66D`,
		"See https://github.com/org/repo/pull/108?tab=files#diff-abc and https://example.test/api/v1/users?page=2&limit=50.",
		"Set GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY and DB_PASSWORD in the CI settings; the API_KEY variable is read at start.",
		"password=******** token: [REDACTED] api_key=xxxx-xxxx-xxxx secret: <redacted> Authorization: Bearer <token>",
		"password: ${{ secrets.DB_PASSWORD }}\n" + `token = os.environ["GITHUB_TOKEN"]` + "\n" + `const apiKey = getSecret("stripe");`,
		"Authorization: Bearer ${TOKEN}\nBearer $(gcloud auth print-access-token)\n" + `curl -u "$USER:$PASS" https://x.test`,
		"the secret is 42 lines long. The token count is 4096. The key is to keep it simple. The password is required.",
		"This change improves internationalization. Please review the documentation (especially the troubleshooting). Avoid overengineering!",
		"Keep the abstraction; it pays off: maintainability, testability, observability.",
		`fmt.Println("hello, world")` + "\n" + `if password == "" { return errEmpty }` + "\n" + `log.Printf("token refreshed for %s", user)`,
		`// the token "kind" field and the API_KEY one`,
		`The password field is "required". Passwords must include one of these symbols: "!@#$%^&*".`,
		"The credential is stored in the vault. Credentials: see the docs.",
		"docker run -u 1000:1000 img && git push -u origin main",
		`echo 'it'\''s fine' && printf '%s\n' "done"`,
		"Install hf_transfer. Then set sk_live_mode, and run it. They said hey.",
		// Review T2: what prose says of a password (its check's result, its
		// status, its name) is no password; the credential word is no subject
		// there, or the value names something.
		`The password comparison result is "invalid-password". The password check is "not-found".`,
		`The secret identifier is "request-12345". The password hashing algorithm is "argon2id".`,
		`The password used by the job is "DB_PASSWORD". The password we got back is "invalid-password".`,
		`The password reset status is "expired". The password strength rating is "too-weak". The token type is "bearer-v2".`,
		`The secret store backend is "vault-1". The password manager entry is "github-work-2". The API key mode is "live-77".`,
		`The password, as noted, is "required". The password policy name is "min-length-12".`,
		// Review T3: a line a sentence names, figuratively or as code, is none.
		"9fceb02d0ae598e95dc970b74767f19372d61af8\nThe preceding line is the key to reproducing this issue.",
		"validateToken(user123)\nThe preceding line is the token check.",
		"a1b2c3d4e5f6\nThe previous line is the key to this bug.",
		"9fceb02d0ae598e95dc970b74767f19372d61af8\nThe preceding line is the key.",
		"validateToken(user123)\nThe preceding line is the actual token.",
		"config.secrets.load()\nThe line above is the real secret.",
		// Review T6: code holding the mask's bytes, with no reference, is code.
		"const token = response.Qz7Qz7;\nprivate_key=credentials.Qz7Qz7.load()\npassword = getSecret(Qz7Qz7)",
	}
	// Proposed before the tuning round too, and kept: it reads as an
	// assignment (password: too), whose weak value the review judges (row 4).
	known := map[string][]string{`return errors.New("invalid password: too short")`: {"too"}}
	n := 0
	for _, text := range clean {
		if got := values(text); len(got) > 0 {
			n += len(got)
			t.Errorf("%q: proposed %q", text, got)
		}
	}
	for text, want := range known {
		got := values(text)
		n += len(got)
		if !slices.Equal(got, want) {
			t.Errorf("%q: proposed %q, want %q", text, got, want)
		}
	}
	t.Logf("%d clean texts, %d candidates", len(clean)+len(known), n)
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
		cs := promptsecret.Scan(tc.text, own)
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
		cs := promptsecret.Scan(text, own)
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

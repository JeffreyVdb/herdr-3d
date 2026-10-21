package codexaccount

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// hidden are values (and comments) that hold a header-looking line naming
// the secret: none of it is a server.
var hidden = map[string]string{
	"multi-line basic":                 "v = \"\"\"\n[mcp_servers.\"" + secret + "\"]\n\"\"\"",
	"multi-line basic, \\\"\"\"":       "v = \"\"\"a \\\"\"\" \"\"\n[mcp_servers." + secret + "]\n\"\"\"",
	"multi-line basic, quotes at end":  "v = \"\"\"\n[mcp_servers." + secret + "]\n\"x\"\"\"\"\"",
	"multi-line basic, line-end \\":    "v = \"\"\"\\\n[mcp_servers." + secret + "]\n\"\"\"",
	"multi-line literal":               "v = '''\n[mcp_servers.\"" + secret + "\"]\n'''",
	"multi-line literal, quote at end": "v = '''\n[mcp_servers." + secret + "]\n''''",
	"multi-line literal, \\ is text":   "v = '''\\'''\nw = '''\n[mcp_servers." + secret + "]\n'''",
	"array of strings over lines":      "v = [\n  \"a\",\n  \"[mcp_servers." + secret + "]\",\n  '''\n[mcp_servers." + secret + "]\n''',\n]",
	"nested arrays and comments":       "v = [ # [mcp_servers." + secret + "]\n  [\"[mcp_servers." + secret + "]\"], # ]\n  [1, 2.5, true],\n  1979-05-27 07:32:00Z,\n]",
	"inline table":                     "v = { a = \"[mcp_servers." + secret + "]\", b = \"\"\"\n[mcp_servers." + secret + "]\n\"\"\" }",
	"array of inline tables":           "v = [ { mcp_servers = { \"" + secret + "\" = 1 } } ]",
	"comments":                         "# [mcp_servers." + secret + "]\nv = 1 # [mcp_servers." + secret + "]",
	"escaped quote in a string":        "v = \"\\\"[mcp_servers." + secret + "]\"",
	"a key that looks like a header":   "\"[mcp_servers." + secret + "]\" = 1",
}

// servers declares alpha, b.eta, delta, eps, gamma and zeta (and puts the
// secret in their values) in the ways TOML allows.
const servers = `[mcp_servers.alpha]
command = "alpha ` + secret + `"
[mcp_servers."b.eta"]
url = "https://x/?k=` + secret + `"
[mcp_servers.gamma.env]
KEY = "` + secret + `"
[ mcp_servers . 'zeta' ]
args = ["` + secret + `"]
[mcp_servers]
delta = { command = "d", env = { KEY = "` + secret + `" } }
eps.command = "y ` + secret + `"
`

var allServers = []string{"alpha", "b.eta", "delta", "eps", "gamma", "zeta"}

func scan(t *testing.T, config string) ([]string, bool) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(p, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	return mcpServers(p)
}

// serverDocs are every hidden value, alone and all together, at the top,
// in another table and in a server's table, before and after the
// servers (and with CRLF line ends), each with the servers it declares.
func serverDocs() map[string][]string {
	var keys []string
	for k := range hidden {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	var all []string
	cases := map[string]string{}
	for i, k := range keys {
		// Each its own keys, so that all together is TOML too.
		v := strings.NewReplacer("v = ", fmt.Sprintf("v%d = ", i), "w = ", fmt.Sprintf("w%d = ", i)).Replace(hidden[k])
		cases[k] = v
		all = append(all, v)
	}
	cases["all together"] = strings.Join(all, "\n")
	out := map[string][]string{}
	for name, v := range cases {
		out[name] = []string{
			v + "\n" + servers,
			"[profiles.x]\n" + v + "\n" + servers,
			servers + "[other]\n" + v + "\n",
			"[mcp_servers.alpha.more]\n" + v + "\n" + servers,
			strings.ReplaceAll(v+"\n"+servers, "\n", "\r\n"),
		}
	}
	return out
}

// The names are exactly the servers, never the secret; a hidden value
// alone declares none.
func TestMCPServersOnlyFromKeys(t *testing.T) {
	for name, docs := range serverDocs() {
		for _, doc := range docs {
			got, ok := scan(t, doc)
			if !ok || !slices.Equal(got, allServers) {
				t.Fatalf("%s: got %q (ok %v), want %q in\n%s", name, got, ok, allServers, doc)
			}
		}
		if got, ok := scan(t, hidden[name]+"\n"); name != "all together" && (!ok || len(got) != 0) {
			t.Fatalf("%s alone: got %q (ok %v)", name, got, ok)
		}
	}
}

// A file that is not TOML names none: a guess could name a value.
func TestMCPServersNotTOML(t *testing.T) {
	for _, doc := range []string{
		"v = \"\"\"\n[mcp_servers." + secret + "]\n",
		"v = '''\n[mcp_servers." + secret + "]\n",
		"v = \"[mcp_servers.x]\n[mcp_servers." + secret + "]\n",
		"v = a\"\"\"\n[mcp_servers." + secret + "]\n\"\"\"\n",
		"v = [\n\"a\"\n[mcp_servers." + secret + "]\n]\n",
		"[mcp_servers.x] junk\n",
		"v =\n[mcp_servers." + secret + "]\n",
	} {
		if got, ok := scan(t, doc); ok || got != nil {
			t.Fatalf("got %q (ok %v) from\n%s", got, ok, doc)
		}
	}
	if got, ok := mcpServers(filepath.Join(t.TempDir(), "none.toml")); !ok || len(got) != 0 {
		t.Fatalf("no file: got %q (ok %v)", got, ok)
	}
}

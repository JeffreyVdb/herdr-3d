// Package githubcli is the bridge's typed door to the gh CLI, in the
// pattern of internal/herdr Control and internal/gitops: it runs exactly
// one command shape, `gh api graphql --method POST --input -`, with the
// request as JSON on stdin: one of a fixed set of embedded documents (the
// queries/ directory) and its variables. Never a query, a field or an
// argument from a client. gh keeps its own authentication; the bridge
// stores no token. The environment is clean (no HERDR_* or CLAUDE*
// variables, no prompts, no colour), every call has a timeout and its
// output is capped. TestGitHubAllowlist is the tripwire.
package githubcli

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// Doc names one of the embedded GraphQL documents.
type Doc string

// The documents. Queries read, mutations (the ones named in mutations)
// write.
const (
	DocFeed          Doc = "feed"
	DocIssueDetail   Doc = "issue-detail"
	DocPRDetail      Doc = "pr-detail"
	DocIssueNode     Doc = "issue-node"
	DocPRNode        Doc = "pr-node"
	DocStatusTarget  Doc = "status-target"
	DocOpenPRForHead Doc = "open-pr-for-head"
	DocIssuesPage    Doc = "open-issues-page"
	DocPRsPage       Doc = "open-prs-page"

	DocAddComment     Doc = "add-comment"
	DocAddProjectItem Doc = "add-project-item"
	DocSetStatus      Doc = "set-status"
	DocCloseIssue     Doc = "close-issue"
	DocMergePR        Doc = "merge-pr"
	DocCreatePR       Doc = "create-pr"
)

//go:embed queries/*.graphql
var queryFiles embed.FS

// docs are the embedded documents by name.
var docs = func() map[Doc]string {
	out := map[Doc]string{}
	entries, err := fs.ReadDir(queryFiles, "queries")
	if err != nil {
		panic(err)
	}
	for _, e := range entries {
		b, err := queryFiles.ReadFile("queries/" + e.Name())
		if err != nil {
			panic(err)
		}
		out[Doc(strings.TrimSuffix(e.Name(), ".graphql"))] = strings.TrimSpace(string(b))
	}
	return out
}()

// Docs returns the names of the embedded documents, sorted.
func Docs() []Doc {
	out := make([]Doc, 0, len(docs))
	for d := range docs {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Text is a document's GraphQL text ("" for an unknown name).
func Text(d Doc) string { return docs[d] }

// argv is the one command shape; {gh} is the executable.
var argv = []string{"{gh}", "api", "graphql", "--method", "POST", "--input", "-"}

// Defaults.
const (
	DefaultTimeout = 20 * time.Second
	// MaxOutput caps what one call may return.
	MaxOutput = 8 << 20
)

// ErrNotAllowed is returned for a document that is not embedded.
var ErrNotAllowed = errors.New("gh: document not allowed")

// ExitError is a gh that exited with a non-zero code.
type ExitError struct{ Code int }

func (e *ExitError) Error() string { return fmt.Sprintf("gh exited with code %d", e.Code) }

// Runner runs argv with stdin and returns its stdout and stderr. A
// non-zero exit is an *ExitError. Tests inject a fake.
type Runner func(ctx context.Context, argv []string, stdin []byte) (stdout, stderr []byte, err error)

// Client runs GraphQL documents through gh.
type Client struct {
	// Bin is the gh executable (default "gh").
	Bin string
	// Timeout bounds one call (default DefaultTimeout).
	Timeout time.Duration
	// Run executes argv (default: exec in Env). Tests inject a fake.
	Run Runner
}

// GraphQLError is one entry of a response's errors.
type GraphQLError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Path    []any  `json:"path"`
}

// Response is a GraphQL response: its data, and its errors (which gh may
// report with a zero exit and data present).
type Response struct {
	Data   json.RawMessage
	Errors []GraphQLError
}

// FirstError is the first GraphQL error of the given type ("" any).
func (r *Response) FirstError(typ string) *GraphQLError {
	for i := range r.Errors {
		if typ == "" || r.Errors[i].Type == typ {
			return &r.Errors[i]
		}
	}
	return nil
}

var tokenRe = regexp.MustCompile(`\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})`)

// Redact removes anything that looks like a token from s.
func Redact(s string) string { return tokenRe.ReplaceAllString(s, "[token]") }

// Query runs doc with variables (a JSON object). Errors that say gh, the
// network or the login failed are provider.ErrFailed, a rate limit is a
// *provider.RateLimitError; GraphQL errors of a request that reached GitHub
// come back in the Response for the caller to read.
func (c *Client) Query(ctx context.Context, doc Doc, vars map[string]any) (*Response, error) {
	text, ok := docs[doc]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNotAllowed, doc)
	}
	if vars == nil {
		vars = map[string]any{}
	}
	body, err := json.Marshal(map[string]any{"query": text, "variables": vars})
	if err != nil {
		return nil, err
	}
	bin := c.Bin
	if bin == "" {
		bin = "gh"
	}
	args := make([]string, len(argv))
	for i, a := range argv {
		if a == "{gh}" {
			a = bin
		}
		args[i] = a
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	run := c.Run
	if run == nil {
		run = execRunner
	}
	stdout, stderr, err := run(cctx, args, body)
	if err != nil && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return classify(cctx, timeout, stdout, stderr, err)
}

// classify turns gh's outcome into a Response or an error.
func classify(ctx context.Context, timeout time.Duration, stdout, stderr []byte, runErr error) (*Response, error) {
	if runErr != nil {
		var ee *ExitError
		switch {
		case errors.Is(runErr, exec.ErrNotFound), errors.Is(runErr, fs.ErrNotExist):
			return nil, provider.Failed("gh not found")
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return nil, provider.Failed("gh timed out after %s", timeout)
		case errors.Is(runErr, errTooLarge):
			return nil, provider.Failed("gh output too large")
		case errors.As(runErr, &ee):
		default:
			return nil, provider.Failed("gh: %s", clip(Redact(runErr.Error())))
		}
	}
	code := 0
	var ee *ExitError
	if errors.As(runErr, &ee) {
		code = ee.Code
	}
	msg := clip(Redact(strings.TrimSpace(string(stderr))))
	var top struct {
		Data    json.RawMessage `json:"data"`
		Errors  []GraphQLError  `json:"errors"`
		Message string          `json:"message"`
		Status  json.RawMessage `json:"status"`
	}
	parsed := len(bytes.TrimSpace(stdout)) > 0 && json.Unmarshal(stdout, &top) == nil
	status := strings.Trim(string(top.Status), `"`)
	lower := strings.ToLower(msg + " " + top.Message)
	switch {
	case code == 4, status == "401", strings.Contains(lower, "bad credentials"), strings.Contains(lower, "gh auth login"),
		strings.Contains(lower, "http 401"):
		return nil, provider.Failed("GitHub auth")
	case strings.Contains(lower, "rate limit") && (status == "403" || status == "429" || len(top.Errors) == 0):
		return nil, &provider.RateLimitError{Msg: "GitHub rate limit"}
	}
	if parsed && len(top.Errors) > 0 {
		for _, e := range top.Errors {
			if e.Type == "RATE_LIMITED" || strings.Contains(strings.ToLower(e.Message), "rate limit") {
				return nil, &provider.RateLimitError{ResetAt: resetOf(top.Data), Msg: "GitHub rate limit"}
			}
		}
	}
	if parsed && (len(top.Errors) > 0 || (code == 0 && len(top.Data) > 0)) {
		return &Response{Data: top.Data, Errors: top.Errors}, nil
	}
	switch {
	case code != 0 && msg != "":
		return nil, provider.Failed("gh: %s", msg)
	case code != 0:
		return nil, provider.Failed("gh exited with code %d", code)
	case !parsed:
		return nil, provider.Failed("gh: the answer is not JSON")
	}
	return &Response{Data: top.Data}, nil
}

// resetOf reads data.rateLimit.resetAt, if the data has it.
func resetOf(data json.RawMessage) time.Time {
	var d struct {
		RateLimit struct {
			ResetAt time.Time `json:"resetAt"`
		} `json:"rateLimit"`
	}
	if json.Unmarshal(data, &d) != nil {
		return time.Time{}
	}
	return d.RateLimit.ResetAt
}

func clip(s string) string {
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

// Env is the environment gh runs in: the caller's, without herdr pane and
// Claude Code variables, with no prompts, colour or update notices. gh's
// own login (its config directory, GH_TOKEN if set) is kept.
func Env(base []string) []string {
	return append(herdr.CleanEnv(base), "GH_PROMPT_DISABLED=1", "NO_COLOR=1", "GH_NO_UPDATE_NOTIFIER=1")
}

var errTooLarge = errors.New("output too large")

// capped keeps at most MaxOutput bytes and notes that there were more. It
// wraps the buffer rather than embedding it: bytes.Buffer's ReadFrom would
// let io.Copy bypass Write.
type capped struct {
	buf  bytes.Buffer
	over bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := MaxOutput - c.buf.Len(); len(p) > room {
		c.over = true
		if room > 0 {
			c.buf.Write(p[:room])
		}
		return len(p), nil
	}
	return c.buf.Write(p)
}

func (c *capped) Bytes() []byte { return c.buf.Bytes() }

func execRunner(ctx context.Context, argv []string, stdin []byte) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = Env(os.Environ())
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.WaitDelay = time.Second
	var stdout, stderr capped
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		err = &ExitError{Code: ee.ExitCode()}
	}
	if err == nil && stdout.over {
		err = errTooLarge
	}
	return stdout.Bytes(), stderr.Bytes(), err
}

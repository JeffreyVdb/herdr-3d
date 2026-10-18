package proto

// #108 prompt secrets (docs/protocol.md "Prompt secrets"): with the shared
// switch "Review prompt secrets before sending" on (World.PromptSecrets,
// prompt_secrets.update), the bridge scans a prompt for possible secrets
// before it is sent. prompt_secrets.scan proposes candidates bound to a
// revision; a text-carrying command carries the user's decisions in its
// optional `secrets` (round 1: worker.prompt; round 2: every other route
// that takes typed text to an agent, a language model or storage: one
// review, or with several texts one per field, SecretsReviews); the bridge
// scans the text again, checks the decisions against that scan, writes each
// protected range to a private file and sends the text with a reference to
// the file in its place. Offsets are UTF-16 code units, [start, end).

// Commands and the event of the feature.
const (
	CmdPromptSecretsGet    = "prompt_secrets.get"
	CmdPromptSecretsSet    = "prompt_secrets.set"
	CmdPromptSecretsScan   = "prompt_secrets.scan"
	CmdPromptSecretsRevoke = "prompt_secrets.revoke" // round 5
	EvPromptSecretsUpdate  = "prompt_secrets.update"
)

func init() {
	Commands = append(Commands, CmdPromptSecretsGet, CmdPromptSecretsSet, CmdPromptSecretsScan, CmdPromptSecretsRevoke)
}

// Error codes of the feature.
const (
	// ErrSecretsReviewRequired: possible secrets were found and the command
	// carries no review of them, or its decisions do not fit the scan
	// (a candidate without exactly one decision, a range that is empty,
	// outside the text, splits a surrogate pair or overlaps another).
	// Nothing was sent, stored or written.
	ErrSecretsReviewRequired = "secrets_review_required"
	// ErrSecretsReviewStale: the review's revision is not the text's under
	// the current rules and setting (the text changed, the bridge
	// restarted, the switch changed), or a review came while the switch is
	// off. Scan again.
	ErrSecretsReviewStale = "secrets_review_stale"
	// ErrSecretsReviewOff: prompt_secrets.scan while the switch is off.
	ErrSecretsReviewOff = "secrets_review_off"
	// ErrSecretsUnavailable: the protection could not run: no private
	// runtime directory for the files, a file could not be written, or
	// the scan failed or took too long. Nothing was sent.
	ErrSecretsUnavailable = "secrets_unavailable"
	// ErrSecretsReviewStored (round 2): the review of a prompt that is
	// stored (a schedule's, a hire preset's) protects something: a stored
	// prompt keeps no protected file (its files would outlive any agent).
	// Remove the value from it, or protect it at hire time instead. Nothing
	// was stored.
	ErrSecretsReviewStored = "secrets_review_stored"
)

// PromptSecrets is the shared switch: prompt_secrets.get's and .set's ack,
// World.PromptSecrets, and flat in prompt_secrets.update.
type PromptSecrets struct {
	// Enabled: prompts are scanned and reviewed before they are sent.
	Enabled bool `json:"enabled"`
	// Available: the bridge has a private runtime directory for protected
	// files (false: a review that protects anything is refused with
	// secrets_unavailable).
	Available bool `json:"available"`
	// Dir (round 5) is that directory, absolute, while Available: a
	// reference is the bridge's own exactly when its path is
	// <Dir>/<owner>/<file>.
	Dir string `json:"dir,omitempty"`
}

// PromptSecretsUpdate is the prompt_secrets.update event.
type PromptSecretsUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	PromptSecrets
}

// PromptSecretsSetArgs are the args of prompt_secrets.set.
type PromptSecretsSetArgs struct {
	Enabled *bool `json:"enabled"`
}

// PromptSecretsRevokeArgs are the args of prompt_secrets.revoke (round 5):
// the worker whose protected files go (its own and those it holds by a
// lease, for every holder).
type PromptSecretsRevokeArgs struct {
	Worker string `json:"worker"`
}

// PromptSecretsRevoke is prompt_secrets.revoke's ack: how many files went.
type PromptSecretsRevoke struct {
	Removed int `json:"removed"`
}

// PromptSecretsScanArgs are the args of prompt_secrets.scan: the text as it
// will be sent (at most 32 KiB of UTF-8; never cut).
type PromptSecretsScanArgs struct {
	Text string `json:"text"`
}

// PromptSecretsScan is prompt_secrets.scan's ack: the revision (opaque) and
// the candidates in text order, never overlapping. Never null.
type PromptSecretsScan struct {
	Revision   string            `json:"revision"`
	Candidates []SecretCandidate `json:"candidates"`
}

// SecretCandidate is one possible secret: [Start, End) in UTF-16 code
// units, the detectors that found it ("gitleaks:<rule>", "pem",
// "auth-header", "url-password", "url-query", "assignment", "yaml-block",
// "prose", "fenced", "repeat") and Encoded: its bytes hold an escape or
// percent-encoding (or a YAML block's indentation), which a protected file
// keeps as typed.
type SecretCandidate struct {
	ID      string   `json:"id"`
	Start   int      `json:"start"`
	End     int      `json:"end"`
	Kinds   []string `json:"kinds"`
	Encoded bool     `json:"encoded,omitempty"`
}

// Actions of a SecretDecision.
const (
	SecretProtect = "protect"
	SecretIgnore  = "ignore"
)

// SecretsReview is the optional `secrets` of a text-carrying command: the
// revision of the scan of its text and one decision per candidate, plus
// any manual marks.
type SecretsReview struct {
	Revision  string           `json:"revision"`
	Decisions []SecretDecision `json:"decisions"`
}

// SecretsReviews (round 2) is the optional `secrets` of a command that
// carries several texts (run.start, worker.answer_ask,
// worker.answer_followup, worker.answer_async): a review per field that
// has possible secrets, keyed by its path in the args ("text", "extra",
// "prompt", "note", "answers[0].other", "answers[1].value",
// "answers[1].note", "answers[0].answer": an array's index is its
// position in the args' array). Each is a review of that field's text as
// sent, scanned alone (its own revision; its ranges in that text).
type SecretsReviews map[string]*SecretsReview

// SecretDecision is a candidate's decision ({candidate, action}), a
// protected candidate with a corrected range ({candidate, action:
// "protect", start, end}) or a manual mark ({action: "protect", start,
// end}). Start and End are UTF-16 code units.
type SecretDecision struct {
	Candidate string `json:"candidate,omitempty"`
	Action    string `json:"action"`
	Start     *int   `json:"start,omitempty"`
	End       *int   `json:"end,omitempty"`
}

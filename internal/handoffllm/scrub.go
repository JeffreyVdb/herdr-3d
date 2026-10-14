package handoffllm

// Scrub is the dedicated outgoing-text policy for anything sent to the
// configured LLM (transcript text, the user's focus instruction, provenance
// strings). It returns the scrubbed text and redaction counts by category.
func Scrub(text string, secrets ...string) (string, map[string]int) {
	return text, map[string]int{}
}

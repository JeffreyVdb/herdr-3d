package handoffllm

// EstimateTokens is a conservative, tokenizer-free token estimate of s.
func EstimateTokens(s string) int {
	return len(s)
}

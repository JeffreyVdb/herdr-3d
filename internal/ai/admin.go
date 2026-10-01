package ai

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// Fields are the settings a request names. A nil field is not named: a test
// or a model list uses the current one, ai.set keeps it. A blank key is a
// nil key ("keep the current key").
type Fields struct {
	BaseURL *string
	Model   *string
	Key     *string
	// ExtraBody: nil keeps, JSON null clears, an object sets.
	ExtraBody json.RawMessage
}

// ModelsResult is a model list.
type ModelsResult struct {
	Models []ModelInfo
	// BaseURL is the LLM's base URL as the bridge resolved it (/v1 added
	// when {base}/models 404s and {base}/v1/models works).
	BaseURL string
}

// TestResult is a passing test.
type TestResult struct {
	LatencyMS int64
	// JSONMode: the LLM accepted response_format (false: only the plain-text
	// fallback works). nil for the classifier.
	JSONMode *bool
	BaseURL  string
	Score    *float64
}

// draft is the config a request means: the current one with Fields over it.
// It fails on a field the environment owns, a malformed one, or a missing part.
func (s *Service) draft(r Role, f Fields, needComplete bool) (config, error) {
	s.mu.Lock()
	cur := s.effectiveLocked(r)
	locked := s.locked(r)
	s.mu.Unlock()
	isLocked := func(name string) bool {
		for _, l := range locked {
			if l == name {
				return true
			}
		}
		return false
	}
	c := cur
	if f.Key != nil && *f.Key != "" {
		if isLocked("key") {
			return c, newErr(KindEnvLocked, "the key is set by the bridge environment")
		}
		c.key = strings.TrimSpace(*f.Key)
	}
	if f.Model != nil {
		if isLocked("model") {
			return c, newErr(KindEnvLocked, "the model is set by the bridge environment")
		}
		c.model = strings.TrimSpace(*f.Model)
	}
	if r == RoleLLM {
		if f.BaseURL != nil {
			if isLocked("base_url") {
				return c, newErr(KindEnvLocked, "the base URL is set by the bridge environment")
			}
			if strings.TrimSpace(*f.BaseURL) == "" {
				c.baseURL = ""
			} else {
				b, err := ParseBaseURL(*f.BaseURL)
				if err != nil {
					return c, err
				}
				c.baseURL = b
			}
		}
		if f.ExtraBody != nil {
			e, err := ParseExtraBody(f.ExtraBody)
			if err != nil {
				return c, err
			}
			c.extra = e
		}
	} else if f.BaseURL != nil || f.ExtraBody != nil {
		return c, newErr(KindBadConfig, "the classification model has no base URL or extra_body")
	}
	if strings.ContainsAny(c.key, "\r\n\x00") {
		return c, newErr(KindBadConfig, "the key must be a single line")
	}
	if needComplete {
		switch {
		case r == RoleClassifier && (c.key == "" || c.model == ""):
			return c, newErr(KindIncomplete, "the key and the model are both needed")
		case r == RoleLLM && (c.baseURL == "" || c.model == ""):
			return c, newErr(KindIncomplete, "the base URL and the model are both needed")
		}
	}
	return c, nil
}

// Models loads a role's model list. It is one of the only two things that
// call out unasked. A 401 is auth_failed. The LLM's base URL is resolved on
// the way (ModelsResult.BaseURL).
func (s *Service) Models(ctx context.Context, r Role, f Fields) (*ModelsResult, error) {
	if !r.Valid() {
		return nil, newErr(KindUnsupportedRole, "role must be classifier or llm")
	}
	c, err := s.draft(r, f, false)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.opts.ListTimeout)
	defer cancel()
	switch r {
	case RoleClassifier:
		if c.key == "" {
			return nil, newErr(KindIncomplete, "enter the key first")
		}
		m, err := s.jev.models(ctx, c.key)
		if err != nil {
			return nil, s.scrubbed(err, c.key)
		}
		return &ModelsResult{Models: m}, nil
	default:
		if c.baseURL == "" {
			return nil, newErr(KindIncomplete, "enter the base URL first")
		}
		base, m, err := s.resolveBase(ctx, c.baseURL, c.key)
		if err != nil {
			return nil, s.scrubbed(err, c.key)
		}
		return &ModelsResult{Models: m, BaseURL: base}, nil
	}
}

// resolveBase lists {base}/models, and when that 404s tries {base}/v1/models:
// only if that works is /v1 added.
func (s *Service) resolveBase(ctx context.Context, base, key string) (string, []ModelInfo, error) {
	m, err := s.openAI.models(ctx, base, key)
	if err == nil {
		return base, m, nil
	}
	if KindOf(err) != KindNoModels || strings.HasSuffix(base, "/v1") {
		return base, nil, err
	}
	m2, err2 := s.openAI.models(ctx, base+"/v1", key)
	if err2 == nil {
		return base + "/v1", m2, nil
	}
	if k := KindOf(err2); k == KindAuthFailed || k == KindUnreachable || k == KindTimeout {
		return base, nil, err2
	}
	return base, nil, err
}

// Test makes one tiny round trip to prove the key, base URL and model work. It
// is the only other call out unasked. A pass lets exactly this config be
// saved (Set); if it is the config in use, a pass lifts an invalid state and a
// failure sets it.
func (s *Service) Test(ctx context.Context, r Role, f Fields) (*TestResult, error) {
	if !r.Valid() {
		return nil, newErr(KindUnsupportedRole, "role must be classifier or llm")
	}
	c, err := s.draft(r, f, true)
	if err != nil {
		return nil, err
	}
	fp := c.fingerprint(r)
	ctx, cancel := context.WithTimeout(ctx, s.opts.ListTimeout)
	defer cancel()
	start := s.opts.Now()
	var res *TestResult
	var pass passedTest
	switch r {
	case RoleClassifier:
		var score float64
		score, err = s.jev.classify(ctx, c.key, c.model, map[string]any{"message": "Hello, how are you today?"}, "Is the message a greeting?")
		res = &TestResult{Score: &score}
	default:
		res, pass.baseURL, pass.jsonMode, err = s.testLLM(ctx, c)
	}
	if err != nil {
		err = s.scrubbed(err, c.key)
		s.mu.Lock()
		inUse := s.effectiveLocked(r).fingerprint(r) == fp
		s.mu.Unlock()
		if inUse && ctx.Err() == nil {
			s.fail(r, err, false)
		}
		return nil, err
	}
	res.LatencyMS = time.Since(start).Milliseconds()
	pass.fp, pass.at = fp, s.opts.Now()
	s.mu.Lock()
	s.passed[r] = pass
	lift := s.effectiveLocked(r).fingerprint(r) == fp && s.invalid[r] != nil
	if lift {
		s.recoverLocked(r)
	}
	s.mu.Unlock()
	if lift {
		s.notify()
	}
	return res, nil
}

// testLLM asks for a one-line JSON object, with response_format and, when
// the endpoint refuses it, without: that is how json_mode is found.
func (s *Service) testLLM(ctx context.Context, c config) (*TestResult, string, *bool, error) {
	base := c.baseURL
	if b, _, err := s.resolveBase(ctx, c.baseURL, c.key); err == nil {
		base = b
	} else if k := KindOf(err); k == KindAuthFailed || k == KindUnreachable || k == KindTimeout {
		return nil, "", nil, err
	}
	req := Request{
		Messages:  []Message{{Role: "user", Content: `Reply with exactly this JSON object and nothing else: {"ok": true}`}},
		MaxTokens: 64,
		JSON:      true,
	}
	temp := 0.0
	req.Temperature = &temp
	mode := true
	text, rejected, err := s.openAI.complete(ctx, base, c.key, c.model, c.extra, req, mode)
	if rejected {
		mode = false
		text, _, err = s.openAI.complete(ctx, base, c.key, c.model, c.extra, req, mode)
	}
	if err != nil {
		return nil, "", nil, err
	}
	if _, ok := FirstJSONObject(text); !ok {
		return nil, "", nil, newErr(KindBadResponse, "the model did not answer with a JSON object")
	}
	return &TestResult{JSONMode: &mode, BaseURL: base}, base, &mode, nil
}

// Set saves a role's settings. The config must be exactly one a test passed
// (test_required otherwise): a role never becomes ready untested. Fields the
// request does not name stay; a blank key keeps the current one.
func (s *Service) Set(r Role, f Fields) error {
	if !r.Valid() {
		return newErr(KindUnsupportedRole, "role must be classifier or llm")
	}
	c, err := s.draft(r, f, true)
	if err != nil {
		return err
	}
	fp := c.fingerprint(r)
	s.mu.Lock()
	p, ok := s.passed[r]
	if !ok || p.fp != fp || s.opts.Now().Sub(p.at) > testValidity {
		s.mu.Unlock()
		return newErr(KindTestRequired, "test these settings first: they have not passed a test")
	}
	next := s.stored.clone()
	s.applyLocked(&next, r, c, p)
	if err := s.file.save(next); err != nil {
		s.mu.Unlock()
		return newErr(KindFailed, "the settings could not be saved: "+Scrub(err.Error(), c.key))
	}
	s.stored = next
	s.recoverLocked(r)
	s.mu.Unlock()
	s.notify()
	return nil
}

// applyLocked writes c into the stored role, leaving out what the environment
// owns (the stored copy stays what the user chose).
func (s *Service) applyLocked(next *Stored, r Role, c config, p passedTest) {
	locked := map[string]bool{}
	for _, l := range s.locked(r) {
		locked[l] = true
	}
	pick := func(name, v, old string) string {
		if locked[name] {
			return old
		}
		return v
	}
	switch r {
	case RoleClassifier:
		if next.Classifier == nil {
			next.Classifier = &StoredClassifier{}
		}
		next.Classifier.Model = pick("model", c.model, next.Classifier.Model)
		next.Classifier.Key = pick("key", c.key, next.Classifier.Key)
	case RoleLLM:
		if next.LLM == nil {
			next.LLM = &StoredLLM{}
		}
		next.LLM.BaseURL = pick("base_url", p.baseURL, next.LLM.BaseURL)
		next.LLM.Model = pick("model", c.model, next.LLM.Model)
		next.LLM.Key = pick("key", c.key, next.LLM.Key)
		next.LLM.ExtraBody = c.extra
		next.LLM.JSONMode = p.jsonMode
	}
}

// Clear removes a role's stored settings and key. What the environment sets
// stays in force.
func (s *Service) Clear(r Role) error {
	if !r.Valid() {
		return newErr(KindUnsupportedRole, "role must be classifier or llm")
	}
	s.mu.Lock()
	next := s.stored.clone()
	if r == RoleClassifier {
		next.Classifier = nil
	} else {
		next.LLM = nil
	}
	if err := s.file.save(next); err != nil {
		s.mu.Unlock()
		return newErr(KindFailed, "the settings could not be saved: "+Scrub(err.Error()))
	}
	s.stored = next
	delete(s.passed, r)
	s.recoverLocked(r)
	s.mu.Unlock()
	s.notify()
	return nil
}

package proto

import (
	"encoding/json"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// #92 AI integration (docs/protocol.md "AI integration"): the bridge-wide
// settings of the classification model and the OpenAI-compatible LLM. The
// state is in the snapshot (World.AI) and every change is an ai.update event
// with the fields of AI flat in it. A key is sent by the game in ai.models,
// ai.test and ai.set, and is never in anything the bridge sends: only
// key_set and key_hint (the last four characters) are.

// EvAIUpdate carries the AI integration's state (the fields of AI).
const EvAIUpdate = "ai.update"

// Commands of the AI integration.
const (
	CmdAIGet    = "ai.get"
	CmdAIModels = "ai.models"
	CmdAITest   = "ai.test"
	CmdAISet    = "ai.set"
	CmdAIClear  = "ai.clear"
)

func init() { Commands = append(Commands, CmdAIGet, CmdAIModels, CmdAITest, CmdAISet, CmdAIClear) }

// AI is the state of both roles: ai.get's ack, World.AI, and flat in ai.update.
type AI = ai.View

// Roles.
const (
	AIClassifier = string(ai.RoleClassifier)
	AILLM        = string(ai.RoleLLM)
)

// Role states (AI.Classifier.State, AI.LLM.State).
const (
	AIOff        = string(ai.StateOff)
	AIIncomplete = string(ai.StateIncomplete)
	AIInvalid    = string(ai.StateInvalid)
	AIReady      = string(ai.StateReady)
)

// Error codes of the AI commands (besides bad_request, provider_failed,
// rate_limited and unsupported).
const (
	ErrAuthFailed   = "auth_failed"        // the key was rejected (HTTP 401 / 403)
	ErrNoModels     = "no_models_endpoint" // the LLM endpoint has no /models
	ErrUnreachable  = "unreachable"        // the endpoint cannot be reached
	ErrAITimeout    = "timeout"
	ErrBadResponse  = "bad_response"  // the provider answered something else than expected
	ErrAIIncomplete = "incomplete"    // a part the call needs is missing
	ErrTestRequired = "test_required" // ai.set of settings that have not passed ai.test
	ErrEnvLocked    = "env_locked"    // a field the bridge environment sets
)

// AIRoleArgs are the args of ai.clear.
type AIRoleArgs struct {
	Role string `json:"role"`
}

// AIFieldsArgs are the args of ai.models, ai.test and ai.set. A field left
// out is the current one (ai.set: kept); a blank or absent key is the
// current key. extra_body: absent keeps, null clears, an object sets (the
// LLM only). base_url and extra_body are the LLM's.
type AIFieldsArgs struct {
	Role      string          `json:"role"`
	BaseURL   *string         `json:"base_url,omitempty"`
	Model     *string         `json:"model,omitempty"`
	Key       *string         `json:"key,omitempty"`
	ExtraBody json.RawMessage `json:"extra_body,omitempty"`
}

// AIModelsResult is the ack data of ai.models.
type AIModelsResult struct {
	Models []ai.ModelInfo `json:"models"`
	// BaseURL is the LLM's base URL as the bridge resolved it: no trailing
	// slash, /v1 added when {base}/models 404s and {base}/v1/models works.
	BaseURL string `json:"base_url,omitempty"`
}

// AITestResult is the ack data of ai.test (a failing test is an error).
type AITestResult struct {
	OK        bool  `json:"ok"`
	LatencyMS int64 `json:"latency_ms"`
	// JSONMode: the LLM accepted response_format (false: only the plain
	// text fallback works).
	JSONMode *bool    `json:"json_mode,omitempty"`
	BaseURL  string   `json:"base_url,omitempty"`
	Score    *float64 `json:"score,omitempty"`
}

package herdr

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// SessionFileVersion is the only session.json format this package reads
// (herdr 0.9.0 and 0.9.1 both write SNAPSHOT_VERSION = 3).
const SessionFileVersion = 3

// maxSessionFile bounds how much of a session.json is read.
const maxSessionFile = 16 << 20

// SessionFile is herdr's persisted session state: an internal, undocumented
// format. Only what the bridge needs is decoded; unknown fields are ignored.
// Pane map keys are herdr-internal pane ids, not public pane numbers.
type SessionFile struct {
	Version    int              `json:"version"`
	Workspaces []SavedWorkspace `json:"workspaces"`
}

// SavedWorkspace is one entry of session.json `workspaces`.
type SavedWorkspace struct {
	ID                string         `json:"id"`
	CustomName        *string        `json:"custom_name"`
	IdentityCwd       string         `json:"identity_cwd"`
	PublicPaneNumbers map[string]int `json:"public_pane_numbers"`
	Tabs              []SavedTab     `json:"tabs"`
	WorktreeSpace     *SavedWorktree `json:"worktree_space"`
}

// SavedTab is one tab of a saved workspace.
type SavedTab struct {
	RootPane *int                 `json:"root_pane"`
	Panes    map[string]SavedPane `json:"panes"`
}

// SavedPane is one pane of a saved tab.
type SavedPane struct {
	Cwd              string        `json:"cwd"`
	Label            *string       `json:"label"`
	AgentName        *string       `json:"agent_name"`
	ManagedAgentKind *string       `json:"managed_agent_kind"`
	AgentSession     *AgentSession `json:"agent_session"`
}

// SavedWorktree is a workspace's git worktree provenance.
type SavedWorktree struct {
	Key              string `json:"key"`
	Label            string `json:"label"`
	RepoRoot         string `json:"repo_root"`
	CheckoutPath     string `json:"checkout_path"`
	IsLinkedWorktree bool   `json:"is_linked_worktree"`
}

// UnsupportedVersionError means session.json is not format version 3.
type UnsupportedVersionError struct{ Version int }

func (e *UnsupportedVersionError) Error() string {
	return fmt.Sprintf("unsupported session.json version %d (want %d)", e.Version, SessionFileVersion)
}

// ReadSessionFile reads and decodes a session.json. It never touches the
// sibling `session-backups/` directory.
func ReadSessionFile(path string) (*SessionFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxSessionFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSessionFile {
		return nil, fmt.Errorf("%s: file too large", path)
	}
	return ParseSessionFile(data)
}

// ParseSessionFile decodes session.json bytes, checking the version first so
// a future format is reported as such rather than as a decode error.
func ParseSessionFile(data []byte) (*SessionFile, error) {
	var head struct {
		Version *int `json:"version"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("session.json: %w", err)
	}
	if head.Version == nil {
		return nil, &UnsupportedVersionError{Version: 0}
	}
	if *head.Version != SessionFileVersion {
		return nil, &UnsupportedVersionError{Version: *head.Version}
	}
	var sf SessionFile
	if err := json.Unmarshal(data, &sf); err != nil {
		return nil, fmt.Errorf("session.json: %w", err)
	}
	return &sf, nil
}

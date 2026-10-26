package herdr

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var manualID = regexp.MustCompile(`^mp_[0-9a-f]{8,}$`)

func shellQuoteManual(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

func (c *Control) validManualDir(dir string) bool {
	return ValidDir(c.ManualDir) && ValidDir(dir) && filepath.Dir(dir) == c.ManualDir && manualID.MatchString(filepath.Base(dir))
}

type ManualTab struct{ TabID, PaneID string }

func (c *Control) CreateManualTab(ctx context.Context, session, workspace, dir, label string) (ManualTab, error) {
	out, err := c.run(ctx, opTabCreate, map[string]string{"session": session, "workspace": workspace, "dir": dir, "label": label})
	if err != nil {
		return ManualTab{}, err
	}
	var resp struct {
		Result *struct {
			Tab *struct {
				ID string `json:"tab_id"`
			} `json:"tab"`
			RootPane *struct {
				ID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if json.Unmarshal(out, &resp) != nil || resp.Result == nil || resp.Result.Tab == nil || resp.Result.RootPane == nil || !ValidPaneID(resp.Result.Tab.ID) || !ValidPaneID(resp.Result.RootPane.ID) {
		return ManualTab{}, fmt.Errorf("herdr tab create: unexpected output %.300q", out)
	}
	return ManualTab{TabID: resp.Result.Tab.ID, PaneID: resp.Result.RootPane.ID}, nil
}

func (c *Control) CloseManualTab(ctx context.Context, session, tab string) error {
	_, err := c.run(ctx, opTabClose, map[string]string{"session": session, "tab": tab})
	return err
}

func (c *Control) LaunchManual(ctx context.Context, session, pane, dir string) error {
	_, err := c.run(ctx, opManualLaunch, map[string]string{"session": session, "pane": pane, "mpdir": dir})
	return err
}

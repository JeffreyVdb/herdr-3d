package store

// M6 runs: a stand-in for the launch coder's run_launch accessor (contract
// §2.4), so the runs branch compiles on its own. The merge replaces this
// file with the real table and accessor.

import (
	"context"
	"time"
)

// RunLaunch is a run the game started (run.start): the ORCH worker it
// hired and the ticket it was given.
type RunLaunch struct {
	ID           string
	RunID        string
	Session      string
	Repo         string // "" for a free-text ticket
	IssueNumber  int    // 0 for a free-text ticket
	TicketText   string
	OrchWorkerID string
	PresetID     string
	PresetName   string
	CreatedAt    time.Time
}

// RunLaunchByWorker returns the run_launch record of an orchestrator the
// game started (the latest for that worker). The stand-in knows none.
func (s *Store) RunLaunchByWorker(ctx context.Context, workerID string) (RunLaunch, bool, error) {
	return RunLaunch{}, false, nil
}

package helper

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// ChromeCommand is the macOS command that opens url in a Chrome --app
// window. Its own profile directory keeps it out of the user's browser
// profile (and makes Chrome start a separate instance for it).
func ChromeCommand(ctx context.Context, app, url, profile string) *exec.Cmd {
	return exec.CommandContext(ctx, "open", "-na", app, "--args",
		"--app="+url, "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check")
}

// OpenChrome runs ChromeCommand; `open` returns as soon as Chrome launched.
func OpenChrome(ctx context.Context, app, url, profile string) error {
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if out, err := ChromeCommand(ctx, app, url, profile).CombinedOutput(); err != nil {
		return fmt.Errorf("open %s: %w: %s", app, err, out)
	}
	return nil
}

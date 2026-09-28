// Package app is the shared process skeleton for the herdr-3d binaries:
// print the version, run until SIGINT/SIGTERM, exit cleanly.
package app

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// Main parses args, then blocks until SIGINT or SIGTERM. It returns the
// process exit code.
func Main(name string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	showVersion := fs.Bool("version", false, "print version and exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		fmt.Fprintln(stdout, Banner(name))
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := Run(ctx, name, stdout); err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", name, err)
		return 1
	}
	return 0
}

// Run prints the banner and waits for ctx to be cancelled.
func Run(ctx context.Context, name string, stdout io.Writer) error {
	fmt.Fprintln(stdout, Banner(name))
	<-ctx.Done()
	fmt.Fprintf(stdout, "%s: shutting down\n", name)
	return nil
}

// Banner is the one-line version string printed at startup.
func Banner(name string) string {
	return name + " " + version.Version
}

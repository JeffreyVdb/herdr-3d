// Command herdr-world is the server-side bridge daemon: it watches every
// herdr session (read-only) and serves the world over a private unix-socket
// WebSocket. See docs/protocol.md.
package main

import (
	"os"

	"github.com/JeffreyVdb/herdr-3d/internal/app"
)

func main() {
	os.Exit(app.World("herdr-world", os.Args[1:], os.Stdout, os.Stderr))
}

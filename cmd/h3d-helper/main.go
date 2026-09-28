// Command h3d-helper is the Mac-side helper: it keeps an SSH tunnel to the
// bridge socket, serves the game on http://127.0.0.1:7777, proxies its
// WebSocket to the bridge and opens a Chrome --app window. See
// CONTRIBUTING.md "Helper".
package main

import (
	"os"

	"github.com/JeffreyVdb/herdr-3d/internal/app"
)

func main() {
	os.Exit(app.Helper("h3d-helper", os.Args[1:], os.Stdout, os.Stderr))
}

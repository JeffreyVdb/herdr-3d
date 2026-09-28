// Command herdr-world is the server-side bridge daemon (scaffold only).
package main

import (
	"os"

	"github.com/JeffreyVdb/herdr-3d/internal/app"
)

func main() {
	os.Exit(app.Main("herdr-world", os.Args[1:], os.Stdout, os.Stderr))
}

// Command h3d-helper is the Mac-side helper (scaffold only).
package main

import (
	"os"

	"github.com/JeffreyVdb/herdr-3d/internal/app"
)

func main() {
	os.Exit(app.Main("h3d-helper", os.Args[1:], os.Stdout, os.Stderr))
}

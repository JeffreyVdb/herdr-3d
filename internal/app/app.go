// Package app holds the command lines of the herdr-3d binaries: herdr-world
// (the bridge, World) and h3d-helper (the Mac helper, Helper).
package app

import "github.com/JeffreyVdb/herdr-3d/internal/version"

// Banner is the one-line version string printed at startup.
func Banner(name string) string {
	return name + " " + version.Version
}

// Package webdist embeds the built game (game/dist) so h3d-helper is one file.
//
// The game/ subdirectory is filled by `make embed-game`; it is not committed
// (only .gitkeep is, so the package compiles without a game build). A helper
// built without it embeds nothing and falls back to a bundle directory.
package webdist

import (
	"embed"
	"io/fs"
)

//go:embed all:game
var files embed.FS

// FS returns the embedded game, rooted at its index.html, and whether a
// build is embedded.
func FS() (fs.FS, bool) {
	sub, err := fs.Sub(files, "game")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, false
	}
	return sub, true
}

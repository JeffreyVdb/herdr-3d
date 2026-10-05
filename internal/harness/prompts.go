package harness

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #138: the I/O around Translate: the command catalog and the checkout.

// translateWait bounds the lookups of one prompt: a prompt is never held
// longer for its completions (the caller sends the text as typed).
const translateWait = 5 * time.Second

// Prompts is the bridge's prompt translator (server.PromptTranslator).
type Prompts struct {
	catalog *Catalog
	wait    time.Duration
}

// NewPrompts translates with the skills catalog gives and the files of the
// checkout.
func NewPrompts(catalog *Catalog) *Prompts {
	return &Prompts{catalog: catalog, wait: translateWait}
}

// Translate is text for the worker's harness in checkout dir. It looks up
// only what the text and the harness need: nothing for a harness with no
// rules, no catalog for text without a "/". On an error it returns text
// unchanged with the error: the caller fails open.
func (p *Prompts) Translate(ctx context.Context, harness, dir, text string) (string, error) {
	if !Rewrites(harness) || !strings.ContainsAny(text, "/@") {
		return text, nil
	}
	ctx, cancel := context.WithTimeout(ctx, p.wait)
	defer cancel()
	var cmds []proto.CommandEntry
	if strings.Contains(text, "/") {
		res, err := p.catalog.Commands(ctx, harness, dir)
		if err != nil {
			return text, err
		}
		cmds = res.Commands
	}
	return Translate(harness, text, cmds, InCheckout(dir)), nil
}

// InCheckout is the file check Translate takes for the checkout at dir: path
// (relative to dir, or absolute) names a file or a directory that is inside
// dir, before and after symlinks (as imgcache's allowlist: a "..", or a
// symlink that leads out, does not resolve). Nothing is read.
func InCheckout(dir string) func(path string) bool {
	return func(path string) bool {
		if dir == "" || !filepath.IsAbs(dir) || path == "" || strings.ContainsRune(path, 0) {
			return false
		}
		root := filepath.Clean(dir)
		p := path
		if !filepath.IsAbs(p) {
			p = filepath.Join(root, p)
		}
		p = filepath.Clean(p)
		if !within(root, p) {
			return false
		}
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			return false
		}
		real, err := filepath.EvalSymlinks(p)
		if err != nil || !within(realRoot, real) {
			return false
		}
		fi, err := os.Stat(real)
		return err == nil && (fi.IsDir() || fi.Mode().IsRegular())
	}
}

// within reports whether path is root or below it.
func within(root, path string) bool {
	return path == root || strings.HasPrefix(path, strings.TrimSuffix(root, string(filepath.Separator))+string(filepath.Separator))
}

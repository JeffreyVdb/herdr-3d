//go:build !linux

package secretfiles

import (
	"context"
	"time"
)

// Files is unsupported here: Open always fails.
type Files struct{}

// Open fails: protected files need Linux.
func Open(Options) (*Files, error) { return nil, ErrUnsupported }

func (f *Files) Dir() string                { return "" }
func (f *Files) IsFilePath(string) bool     { return false }
func (f *Files) FileAt(string) (File, bool) { return File{}, false }
func (f *Files) Revoked(...string) bool     { return false }
func (f *Files) Close() error               { return nil }

func (f *Files) Write(context.Context, Owner, time.Time, [][]byte) ([]File, error) {
	return nil, ErrUnsupported
}
func (f *Files) Remove(context.Context, []File) error        { return ErrUnsupported }
func (f *Files) Exists([]File) bool                          { return false }
func (f *Files) Claim(context.Context, string, string) error { return ErrUnsupported }
func (f *Files) Lease(context.Context, string, []File) (int, error) {
	return 0, ErrUnsupported
}
func (f *Files) Release(context.Context, Owner, Liveness) error { return ErrUnsupported }
func (f *Files) ReleaseExpired(context.Context, Liveness) error { return ErrUnsupported }
func (f *Files) Revoke(context.Context, string, Liveness) (int, error) {
	return 0, ErrUnsupported
}
func (f *Files) Sweep(context.Context, Liveness) (int, error) { return 0, ErrUnsupported }

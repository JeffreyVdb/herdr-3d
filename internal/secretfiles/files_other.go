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

func (f *Files) Dir() string  { return "" }
func (f *Files) Close() error { return nil }

func (f *Files) Write(context.Context, Owner, time.Time, [][]byte) ([]File, error) {
	return nil, ErrUnsupported
}
func (f *Files) Remove(context.Context, []File) error                  { return ErrUnsupported }
func (f *Files) Exists([]File) bool                                    { return false }
func (f *Files) Claim(context.Context, string, string) error           { return ErrUnsupported }
func (f *Files) Release(context.Context, Owner) error                  { return ErrUnsupported }
func (f *Files) ReleaseExpired(context.Context) error                  { return ErrUnsupported }
func (f *Files) Sweep(context.Context, func(string) bool) (int, error) { return 0, ErrUnsupported }

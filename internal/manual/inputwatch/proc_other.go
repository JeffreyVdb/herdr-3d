//go:build !linux

package inputwatch

// System is nil off Linux: manual processes need Linux, and runs report
// input detection none.
func System() Proc { return nil }

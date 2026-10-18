//go:build race

package promptsecret_test

// shapeSizes are the sizes TestScanTimeShapes compares, 8 times apart: the
// race detector makes a scan about fifteen times slower.
var shapeSizes = [2]int{2 << 10, 16 << 10}

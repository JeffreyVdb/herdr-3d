//go:build !race

package promptsecret_test

// shapeSizes are the sizes TestScanTimeShapes compares, 8 times apart: up
// to the largest prompt the bridge scans (32 KiB).
var shapeSizes = [2]int{4 << 10, 32 << 10}

// Package hoststats reads the bridge host's load for two readers (#74): hire
// capacity (Load) and the office's server rack (the Sampler: CPU and memory
// every few seconds, disk counters every second, and, on Arch-based hosts,
// the number of pending updates).
//
// Everything is read from /proc and /sys directly (no gopsutil), through
// parsers that take bytes or a root directory so fixtures work. The Sampler
// runs only between a Start and its stop: the hub starts it with the first
// connection that watches the rack and stops it with the last, so nothing is
// sampled and no checkupdates runs while nobody looks. Linux only, like the
// bridge.
package hoststats

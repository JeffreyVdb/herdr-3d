//go:build race

package logo

// raceScale stretches the deadlines of the worker tests: the race detector
// makes drawing about ten times slower.
const raceScale = 10

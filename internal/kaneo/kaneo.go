// Package kaneo is the Kaneo provider of the bridge's neutral issue
// interface: a self-hosted (or cloud) Kaneo instance's project as a
// tracker.Tracker, and the read-only calls its settings need, over Kaneo's
// REST API with an API key (a Bearer header).
//
// The surface:
//
//   - ParseURL: an instance's origin or /api base → Endpoint (API base and
//     web origin).
//   - New: a Client of an API base and a key (Options: the *http.Client,
//     the per-call timeout). Test (the connection test: the workspace list
//     and the key's owner, GETs only), Workspaces, Projects (archived ones
//     left out unless asked) and ProjectIn (a project, checked to be of a
//     workspace).
//   - NewTracker: the Tracker of one workspace's project, its links on a web
//     origin. Key is its fetch identity (API base, workspace, project; never
//     the key).
//
// A card's id is Kaneo's task id; its key is "<project slug>-<number>".
// Columns are the project's workflow columns (Done: isFinal) between the
// virtual Planned and Archived ones (Column.Kind). Kaneo has no close: a
// task is completed by moving it to a final column, so Close is
// unsupported. The only writes are PUT /task/status, POST /task/reorder
// (with the snapshot it acts on: a stale one is provider.ErrStale) and POST
// /comment; nothing here ever sends a DELETE. Errors are the provider
// package's kinds (401 provider.ErrUnauthorized, 403 provider.ErrForbidden,
// 429 a *provider.RateLimitError) and never hold the key. This package
// imports only provider, tracker and the standard library; the app wires it
// in.
package kaneo

// ProviderID and ProviderName identify this provider on the wire.
const (
	ProviderID   = "kaneo"
	ProviderName = "Kaneo"
)

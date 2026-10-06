package codexshare

import "github.com/JeffreyVdb/herdr-3d/internal/codexapp"

// Answer is one answer to one async question (codexapp.Answer: the bridge
// and the fixture send the same envelope).
type Answer = codexapp.Answer

// ReplyEnvelope builds the native async-question reply text
// (codexapp.ReplyEnvelope).
func ReplyEnvelope(answers ...Answer) string { return codexapp.ReplyEnvelope(answers...) }

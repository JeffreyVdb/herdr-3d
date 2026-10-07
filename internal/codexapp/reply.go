package codexapp

import "github.com/JeffreyVdb/herdr-3d/internal/codexreply"

// #156: the native answer to Codex's async questions. The envelope's rule
// lives in internal/codexreply (#183: the transcript recognises the same
// envelope and must not link this package); these are its names here.

// AsyncTool is the tool Codex asks async questions with.
const AsyncTool = codexreply.AsyncTool

// Answer is one answer to one async question (codexreply.Answer).
type Answer = codexreply.Answer

// ReplyEnvelope builds the reply text Codex's TUI recognises as answering
// async questions (codexreply.ReplyEnvelope).
func ReplyEnvelope(answers ...Answer) string { return codexreply.ReplyEnvelope(answers...) }

// ParseReply reads a user message's text as a reply envelope
// (codexreply.ParseReply).
func ParseReply(text string) ([]Answer, bool) { return codexreply.ParseReply(text) }

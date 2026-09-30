package server

// TranscriptWatches counts the running transcript watches (tests).
func (h *Hub) TranscriptWatches() int { return len(h.tx.all()) }

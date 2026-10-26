package server

func (h *Hub) commandRequestEntry(worker, key string, index int) (cmd string, variants []string, host string, ok bool) {
	return "", nil, "", false
}

func (h *Hub) closeCommandRequest(worker, key, reason string) {}

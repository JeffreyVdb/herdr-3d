package proto

const CmdTerminalInput = "terminal.input"

func init() { Commands = append(Commands, CmdTerminalInput) }

type TerminalInputArgs struct {
	ID    string  `json:"id"`
	Text  *string `json:"text,omitempty"`
	Bytes *[]byte `json:"bytes,omitempty"`
}

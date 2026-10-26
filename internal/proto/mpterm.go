package proto

const CmdTerminalInput = "terminal.input"
const CmdManualProcessCredential = "manual_process.credential"

func init() { Commands = append(Commands, CmdTerminalInput, CmdManualProcessCredential) }

type TerminalInputArgs struct {
	ID    string  `json:"id"`
	Text  *string `json:"text,omitempty"`
	Bytes *[]byte `json:"bytes,omitempty"`
}

// ManualProcessCredentialArgs answers one open askpass request.
type ManualProcessCredentialArgs struct {
	ID      string  `json:"id"`
	Request string  `json:"request"`
	Secret  *string `json:"secret,omitempty"`
	Cancel  *bool   `json:"cancel,omitempty"`
}

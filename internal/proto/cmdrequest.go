package proto

import "github.com/JeffreyVdb/herdr-3d/internal/cmdrequest"

const CmdWorkerDismissCommandRequest = "worker.dismiss_command_request"

func init() { Commands = append(Commands, CmdWorkerDismissCommandRequest) }

type CommandRequest = cmdrequest.Request
type WorkerDismissCommandRequestArgs struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

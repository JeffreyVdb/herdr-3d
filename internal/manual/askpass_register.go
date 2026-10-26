package manual

import "github.com/JeffreyVdb/herdr-3d/internal/manual/askpass"

func init() {
	AskpassEnv = askpass.Env
	AskpassRewrite = askpass.Rewrite
}

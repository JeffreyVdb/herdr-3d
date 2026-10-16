package app

import (
	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/notify/telegram"
)

// #11: the notifications' wiring. internal/notify is the provider-neutral
// core the hub holds; the Telegram Bot API behind its Channel is
// internal/notify/telegram, imported here and nowhere else in the bridge
// (TestNotifyCoreIsProviderNeutral).

// Telegram opens the bridge's Telegram channel (its token file, or the
// environment's token file): what the world command wires in.
func Telegram(opts telegram.Options) (notify.Channel, error) {
	ch, err := telegram.New(opts)
	if err != nil {
		return nil, err
	}
	return ch, nil
}

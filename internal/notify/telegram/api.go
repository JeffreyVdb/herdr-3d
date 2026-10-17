package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
)

// The Bot API as this package uses it: POST JSON to
// <base>/bot<token>/<method>, an envelope back (ok, result, description,
// error_code, parameters.retry_after). Every error this file returns is a
// *notify.SendError whose message holds no token: Go's *url.Error prints the
// request URL, which holds it, so those are rewritten and every message is
// scrubbed again.

// DefaultBaseURL is the Bot API's.
const DefaultBaseURL = "https://api.telegram.org"

const (
	// callTimeout bounds a call that is not a long poll.
	callTimeout = 15 * time.Second
	// pollMargin is how much longer than its long-poll timeout a getUpdates
	// may take.
	pollMargin = 15 * time.Second
	maxBody    = 1 << 20
	maxMsg     = 200
	// textMax is sendMessage's limit, in characters.
	textMax = 4096
)

// tokenRe is a bot token's shape: the bot's numeric id, a colon, the secret.
// Nothing else may go into the URL's path.
var tokenRe = regexp.MustCompile(`^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$`)

// ValidToken reports whether s looks like a bot token.
func ValidToken(s string) bool { return tokenRe.MatchString(s) }

// botID is the token's numeric prefix (the bot's id: not the secret).
func botID(token string) string {
	id, _, _ := strings.Cut(token, ":")
	return id
}

// Scrub replaces the token (and its secret part alone) in s.
func Scrub(s, token string) string {
	if token == "" {
		return s
	}
	s = strings.ReplaceAll(s, token, "[key]")
	if _, secret, ok := strings.Cut(token, ":"); ok && len(secret) >= 8 {
		s = strings.ReplaceAll(s, secret, "[key]")
	}
	return s
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

type envelope struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	Description string          `json:"description"`
	ErrorCode   int             `json:"error_code"`
	Parameters  *struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

// The Bot API types this package reads (unknown fields are ignored).
type user struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	Username  string `json:"username"`
}

type chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

type message struct {
	MessageID int64  `json:"message_id"`
	From      *user  `json:"from"`
	Chat      chat   `json:"chat"`
	Date      int64  `json:"date"` // unix seconds
	Text      string `json:"text"`
	// #13: the message it replies to, and what says it was not typed here
	// by its sender (only whether they are there is read).
	ReplyTo       *message  `json:"reply_to_message,omitempty"`
	SenderChat    *chat     `json:"sender_chat,omitempty"`
	ForwardOrigin *struct{} `json:"forward_origin,omitempty"`
	ViaBot        *user     `json:"via_bot,omitempty"`
}

// callbackQuery is a tap on a button (#14). Message is the bot's message
// the button is on (date 0: one the bot can no longer read; its chat and
// id are still there).
type callbackQuery struct {
	ID      string   `json:"id"`
	From    *user    `json:"from"`
	Message *message `json:"message"`
	Data    string   `json:"data"`
}

type update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *message       `json:"message"`
	CallbackQuery *callbackQuery `json:"callback_query,omitempty"`
}

type api struct {
	base   string
	client *http.Client
}

// call posts body to method with token and decodes the result into out.
func (a api) call(ctx context.Context, token, method string, body, out any) error {
	if !ValidToken(token) {
		return &notify.SendError{Code: notify.CodeNotConfigured, Msg: "no valid bot token is set"}
	}
	b, err := json.Marshal(body)
	if err != nil {
		return &notify.SendError{Code: notify.CodeFailed, Msg: "the request could not be encoded"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+"/bot"+token+"/"+method, bytes.NewReader(b))
	if err != nil {
		return &notify.SendError{Code: notify.CodeFailed, Msg: clip(Scrub("bad request: "+err.Error(), token), maxMsg)}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return transportError(ctx, err, token)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return transportError(ctx, err, token)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return &notify.SendError{Code: notify.CodeFailed, Status: resp.StatusCode,
			Msg: fmt.Sprintf("Telegram answered %d with something that is not the Bot API's", resp.StatusCode)}
	}
	if !env.OK {
		return apiError(resp.StatusCode, env, token)
	}
	if out != nil {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return &notify.SendError{Code: notify.CodeFailed, Status: resp.StatusCode, Msg: "Telegram's answer could not be read"}
		}
	}
	return nil
}

// transportError is a call that got no answer, its message free of the
// token.
func transportError(ctx context.Context, err error, token string) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		ue.URL = "telegram" // the URL holds the token
	}
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) || isTimeout(err) {
		return &notify.SendError{Code: notify.CodeTimeout, Msg: "Telegram did not answer in time"}
	}
	if errors.Is(err, context.Canceled) {
		return &notify.SendError{Code: notify.CodeFailed, Msg: "cancelled"}
	}
	return &notify.SendError{Code: notify.CodeUnreachable, Msg: clip(Scrub("Telegram could not be reached: "+err.Error(), token), maxMsg)}
}

func isTimeout(err error) bool {
	var t interface{ Timeout() bool }
	return errors.As(err, &t) && t.Timeout()
}

// apiError classifies a Bot API failure.
func apiError(status int, env envelope, token string) error {
	code := env.ErrorCode
	if code == 0 {
		code = status
	}
	desc := clip(Scrub(strings.TrimSpace(env.Description), token), maxMsg)
	e := &notify.SendError{Status: code, Msg: "Telegram: " + desc}
	if desc == "" {
		e.Msg = fmt.Sprintf("Telegram failed (%d)", code)
	}
	lower := strings.ToLower(desc)
	switch {
	case code == 401 || code == 404:
		e.Code, e.Msg = notify.CodeUnauthorized, "Telegram refused the bot token: check it with @BotFather"
	case code == 403, code == 400 && strings.Contains(lower, "chat not found"):
		e.Code, e.Msg = notify.CodeBlocked, "Telegram will not deliver: the bot was blocked, or you have not started a chat with it (open it and press Start)"
	case code == 409:
		e.Code, e.Msg = notify.CodeConflict, "Another program reads this bot's updates (a webhook, or a second bridge with the same token)"
	case code == 429:
		e.Code = notify.CodeRateLimited
		if p := env.Parameters; p != nil && p.RetryAfter > 0 {
			e.RetryAfter = time.Duration(p.RetryAfter) * time.Second
		}
	case code == 400:
		e.Code = notify.CodeBadRequest
	default:
		e.Code = notify.CodeFailed
	}
	return e
}

// getMe checks a token: the bot it is of.
func (a api) getMe(ctx context.Context, token string) (user, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	var u user
	err := a.call(ctx, token, "getMe", struct{}{}, &u)
	return u, err
}

type linkPreview struct {
	IsDisabled bool `json:"is_disabled"`
}

// replyParameters makes a message a reply (#13); sent even when the
// message replied to is gone.
type replyParameters struct {
	MessageID                int64 `json:"message_id"`
	AllowSendingWithoutReply bool  `json:"allow_sending_without_reply"`
}

type sendMessage struct {
	ChatID              int64            `json:"chat_id"`
	Text                string           `json:"text"`
	DisableNotification bool             `json:"disable_notification,omitempty"`
	LinkPreview         linkPreview      `json:"link_preview_options"`
	ReplyParameters     *replyParameters `json:"reply_parameters,omitempty"`
	// #14: an inline keyboard, or a force reply.
	ReplyMarkup any `json:"reply_markup,omitempty"`
}

// #14: a card's buttons, and the reply field opened for a typed answer.
type inlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

type inlineKeyboard struct {
	InlineKeyboard [][]inlineButton `json:"inline_keyboard"`
}

type forceReply struct {
	ForceReply  bool   `json:"force_reply"`
	Placeholder string `json:"input_field_placeholder,omitempty"`
}

// placeholderMax is a force reply's placeholder's limit, in characters.
const placeholderMax = 64

// keyboard is a card's buttons as Telegram takes them (nil: none), their
// labels free of the token.
func keyboard(c notify.Card, token string) *inlineKeyboard {
	if len(c.Buttons) == 0 {
		return nil
	}
	k := &inlineKeyboard{InlineKeyboard: make([][]inlineButton, 0, len(c.Buttons))}
	for _, row := range c.Buttons {
		r := make([]inlineButton, 0, len(row))
		for _, b := range row {
			r = append(r, inlineButton{Text: Scrub(b.Text, token), CallbackData: b.Data})
		}
		k.InlineKeyboard = append(k.InlineKeyboard, r)
	}
	return k
}

// send sends plain text (no parse_mode: nothing in it is markup) and names
// the message it became (#13: a zero Ref when Telegram did not say).
func (a api) send(ctx context.Context, token string, chatID int64, text string, quiet bool) (notify.Ref, error) {
	return a.sendMessage(ctx, token, sendMessage{ChatID: chatID, Text: text, DisableNotification: quiet})
}

// answer sends text as a reply to message msg in chatID (#13).
func (a api) answer(ctx context.Context, token string, chatID, msg int64, text string) error {
	_, err := a.sendMessage(ctx, token, sendMessage{ChatID: chatID, Text: text,
		ReplyParameters: &replyParameters{MessageID: msg, AllowSendingWithoutReply: true}})
	return err
}

// sendCard sends a card (#14): plain text and its buttons.
func (a api) sendCard(ctx context.Context, token string, chatID int64, c notify.Card) (notify.Ref, error) {
	m := sendMessage{ChatID: chatID, Text: c.Text, DisableNotification: c.Quiet}
	if k := keyboard(c, token); k != nil {
		m.ReplyMarkup = k
	}
	return a.sendMessage(ctx, token, m)
}

// askText sends text as a reply to message msg in chatID that opens the
// reply field (#14).
func (a api) askText(ctx context.Context, token string, chatID, msg int64, text, placeholder string) (notify.Ref, error) {
	return a.sendMessage(ctx, token, sendMessage{ChatID: chatID, Text: text,
		ReplyParameters: &replyParameters{MessageID: msg, AllowSendingWithoutReply: true},
		ReplyMarkup:     forceReply{ForceReply: true, Placeholder: clip(Scrub(placeholder, token), placeholderMax)}})
}

type editMessageText struct {
	ChatID      int64           `json:"chat_id"`
	MessageID   int64           `json:"message_id"`
	Text        string          `json:"text"`
	LinkPreview linkPreview     `json:"link_preview_options"`
	ReplyMarkup *inlineKeyboard `json:"reply_markup,omitempty"`
}

type editMessageReplyMarkup struct {
	ChatID    int64 `json:"chat_id"`
	MessageID int64 `json:"message_id"`
}

// editCard replaces a card's text and buttons (#14): a card without
// buttons has none left.
func (a api) editCard(ctx context.Context, token string, chatID, msg int64, c notify.Card) error {
	text := clip(Scrub(c.Text, token), textMax)
	if strings.TrimSpace(text) == "" {
		text = "herdr-3d"
	}
	return notModified(a.call(ctx, token, "editMessageText", editMessageText{ChatID: chatID, MessageID: msg, Text: text,
		LinkPreview: linkPreview{IsDisabled: true}, ReplyMarkup: keyboard(c, token)}, nil))
}

// clearButtons takes a message's buttons away, its text kept (#14).
func (a api) clearButtons(ctx context.Context, token string, chatID, msg int64) error {
	return notModified(a.call(ctx, token, "editMessageReplyMarkup", editMessageReplyMarkup{ChatID: chatID, MessageID: msg}, nil))
}

// notModified: Telegram refuses an edit that changes nothing (a 400 "message
// is not modified"): it is what was wanted.
func notModified(err error) error {
	var se *notify.SendError
	if errors.As(err, &se) && se.Code == notify.CodeBadRequest && strings.Contains(strings.ToLower(se.Msg), "message is not modified") {
		return nil
	}
	return err
}

type answerCallbackQuery struct {
	CallbackQueryID string `json:"callback_query_id"`
	Text            string `json:"text,omitempty"`
}

// tapTextMax is answerCallbackQuery's text limit, in characters.
const tapTextMax = 200

// answerTap answers a tap (#14): its spinner stops, text shows briefly.
func (a api) answerTap(ctx context.Context, token, id, text string) error {
	return a.call(ctx, token, "answerCallbackQuery", answerCallbackQuery{CallbackQueryID: id, Text: clip(Scrub(text, token), tapTextMax)}, nil)
}

func (a api) sendMessage(ctx context.Context, token string, m sendMessage) (notify.Ref, error) {
	m.Text = clip(Scrub(m.Text, token), textMax)
	if strings.TrimSpace(m.Text) == "" {
		m.Text = "herdr-3d"
	}
	m.LinkPreview = linkPreview{IsDisabled: true}
	var raw json.RawMessage
	if err := a.call(ctx, token, "sendMessage", m, &raw); err != nil {
		return notify.Ref{}, err
	}
	// Delivered, whatever the answer holds: a message it cannot name is
	// just not replied to.
	var sent message
	if json.Unmarshal(raw, &sent) != nil {
		return notify.Ref{}, nil
	}
	return notify.Ref{Chat: sent.Chat.ID, Message: sent.MessageID}, nil
}

type reactionType struct {
	Type  string `json:"type"`
	Emoji string `json:"emoji"`
}

type setMessageReaction struct {
	ChatID    int64          `json:"chat_id"`
	MessageID int64          `json:"message_id"`
	Reaction  []reactionType `json:"reaction"`
}

// react sets emoji (one of Telegram's reaction emoji) on message msg in
// chatID (#13).
func (a api) react(ctx context.Context, token string, chatID, msg int64, emoji string) error {
	return a.call(ctx, token, "setMessageReaction", setMessageReaction{ChatID: chatID, MessageID: msg,
		Reaction: []reactionType{{Type: "emoji", Emoji: emoji}}}, nil)
}

// allowedUpdates is sent with every getUpdates: Telegram keeps the last
// list given, so a list without callback_query (#14: the taps) would go on
// dropping them.
var allowedUpdates = []string{"message", "callback_query"}

type getUpdates struct {
	Offset         int64    `json:"offset,omitempty"`
	Limit          int      `json:"limit"`
	Timeout        int      `json:"timeout"`
	AllowedUpdates []string `json:"allowed_updates"`
}

// updates long-polls for messages from offset (0: the oldest kept, -1: the
// newest only, forgetting the rest); timeout in seconds.
func (a api) updates(ctx context.Context, token string, offset int64, timeout int) ([]update, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second+pollMargin)
	defer cancel()
	var out []update
	err := a.call(ctx, token, "getUpdates", getUpdates{Offset: offset, Limit: 100, Timeout: timeout, AllowedUpdates: allowedUpdates}, &out)
	return out, err
}

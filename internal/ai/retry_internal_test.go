package ai

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"
)

// #9: a refused connection provably sent nothing, so NoUncertainRetry still
// allows its retry; anything the provider may have processed does not.
func TestUncertainOutcomes(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err = do(ctx, &http.Client{}, http.MethodPost, "http://"+addr+"/chat/completions", "k", map[string]string{}, 1<<10)
	if KindOf(err) != KindUnreachable || uncertain(err) {
		t.Fatalf("a refused connection: %v, uncertain %v", err, uncertain(err))
	}
	for _, e := range []error{
		newErr(KindTimeout, "t"),
		newErr(KindUnreachable, "reset"),
		&Error{Kind: KindFailed, status: 502},
		newErr(KindBadResponse, "garbled"),
		context.DeadlineExceeded,
	} {
		if !uncertain(e) {
			t.Fatalf("%v is uncertain", e)
		}
	}
	for _, e := range []error{errRetryPlain, &Error{Kind: KindFailed, status: 400}, newErr(KindAuthFailed, "a"), newErr(KindRateLimited, "r")} {
		if uncertain(e) {
			t.Fatalf("%v was rejected whole", e)
		}
	}
}

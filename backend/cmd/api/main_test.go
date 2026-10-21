package main

import (
	"io"
	"os"
	"testing"
	"time"
)

// A supervisor stops the API by closing its standard input (AWWO_STOP_ON_STDIN_CLOSE): the end of the input asks for
// one orderly stop, and a stop already asked for is not doubled.
func TestStopOnCloseAsksForOneOrderlyStop(t *testing.T) {
	r, w := io.Pipe()
	stopped := make(chan os.Signal, 1)
	go stopOnClose(r, stopped)
	select {
	case <-stopped:
		t.Fatal("asked to stop while the input is open")
	case <-time.After(50 * time.Millisecond):
	}
	_ = w.Close()
	select {
	case got := <-stopped:
		if got != os.Interrupt {
			t.Fatal("asked for", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the end of the input did not ask for a stop")
	}
	full := make(chan os.Signal, 1)
	full <- os.Interrupt
	ended, done := io.Pipe()
	_ = done.Close()
	finished := make(chan struct{})
	go func() { stopOnClose(ended, full); close(finished) }()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("blocked on a stop already asked for")
	}
}

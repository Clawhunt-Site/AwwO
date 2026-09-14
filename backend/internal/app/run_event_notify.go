package app

import "sync"

type runEventNotifier struct {
	sync.Mutex
	subscribers map[string]map[chan struct{}]struct{}
}

// subscribeRunEvents provides a process-local fast path from committed event
// writers to live SSE readers. Events remain durable in PostgreSQL, so signals
// may be safely coalesced and reconnects still replay from the persisted cursor.
func (a *App) subscribeRunEvents(runID string) (<-chan struct{}, func()) {
	wake := make(chan struct{}, 1)
	a.runEvents.Lock()
	if a.runEvents.subscribers == nil {
		a.runEvents.subscribers = map[string]map[chan struct{}]struct{}{}
	}
	subscribers := a.runEvents.subscribers[runID]
	if subscribers == nil {
		subscribers = map[chan struct{}]struct{}{}
		a.runEvents.subscribers[runID] = subscribers
	}
	subscribers[wake] = struct{}{}
	a.runEvents.Unlock()

	var once sync.Once
	return wake, func() {
		once.Do(func() {
			a.runEvents.Lock()
			defer a.runEvents.Unlock()
			subscribers := a.runEvents.subscribers[runID]
			delete(subscribers, wake)
			if len(subscribers) == 0 {
				delete(a.runEvents.subscribers, runID)
			}
		})
	}
}

// notifyRunEvent never blocks on subscriber delivery. A one-item subscriber
// buffer coalesces bursts because the reader always reloads every durable event
// after its last cursor. Subscriber channels are never closed, so copying them
// under the registry lock remains safe when an SSE reader concurrently leaves.
func (a *App) notifyRunEvent(runID string) {
	a.runEvents.Lock()
	subscribers := make([]chan struct{}, 0, len(a.runEvents.subscribers[runID]))
	for subscriber := range a.runEvents.subscribers[runID] {
		subscribers = append(subscribers, subscriber)
	}
	a.runEvents.Unlock()
	for _, subscriber := range subscribers {
		select {
		case subscriber <- struct{}{}:
		default:
		}
	}
}

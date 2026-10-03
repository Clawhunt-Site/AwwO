package app

import (
	"encoding/json"
	"os"
	"strings"
)

// An Agent's engine says what executes its runs: a model worker, or the media provider for an
// image or video node. A media node keeps its text runtime on the document (so switching it back
// to a text node needs nothing restored), but its Agent never reaches a model worker.
const (
	agentEngineWorker = "worker"
	agentEngineMedia  = "media"
)

func mediaAgentKind(kind string) bool { return kind == mediaKindImage || kind == mediaKindVideo }

func (c setupConfiguration) engine() string {
	if mediaAgentKind(c.AgentKind) {
		return agentEngineMedia
	}
	return agentEngineWorker
}

// mediaSetupAllowed checks an image or video node's model before its Agent is written: media
// generation must be configured, and the model must be in the catalog, of the node's kind, and
// allowed for the workspace.
func (a *App) mediaSetupAllowed(kind, model string, entitlement modelEntitlement) error {
	if !a.cfg.mediaConfigured() {
		return setupError{"media_unavailable", "Image and video generation is not configured"}
	}
	m, ok := builtinMediaCatalog.model(model)
	if !ok || m.Kind != kind {
		return setupError{"model_unavailable", "Choose an image or video model for this node"}
	}
	if !a.mediaEntitled(entitlement, m.ID) {
		return setupError{"model_not_allowed", "This workspace may not use the selected model"}
	}
	return nil
}

// mediaEntitled grants a media model only explicitly: the workspace's model allowlist names it, or
// the operator opted unrestricted workspaces in. Generations are paid from the operator's key, so
// "no allowlist" does not mean "every paid generator" unless the operator says so.
func (a *App) mediaEntitled(entitlement modelEntitlement, model string) bool {
	if entitlement.unrestricted() {
		return a.cfg.MediaUnrestrictedWorkspaces
	}
	return entitlement.permits(model)
}

// mediaStorageReady reports whether the media directory exists and keeps the configured free
// space, counting downloads already in progress, so a paid generation is never admitted onto a
// full disk.
func (a *App) mediaStorageReady() error {
	if os.MkdirAll(a.cfg.MediaDir, 0o750) != nil {
		return setupError{"media_storage_unavailable", "Generated media cannot be stored right now"}
	}
	release, ok := a.reserveMediaSpace(0)
	if !ok {
		return setupError{"media_storage_full", "The media storage is full"}
	}
	release()
	return nil
}

// reserveMediaSpace holds n bytes of the media filesystem for one download until release is
// called, refusing when free space less what is already held would fall below the floor. One API
// process owns the database lease, so an in-process count covers every concurrent download.
func (a *App) reserveMediaSpace(n int64) (release func(), ok bool) {
	free, known := diskFree(a.cfg.MediaDir)
	a.mu.Lock()
	defer a.mu.Unlock()
	if known && int64(free)-a.mediaReserved-n < a.cfg.MediaMinFreeBytes {
		return nil, false
	}
	a.mediaReserved += n
	return func() {
		a.mu.Lock()
		a.mediaReserved -= n
		a.mu.Unlock()
	}, true
}

// mediaSetupConfig is setupConfig for an image or video node: its Agent records the catalog
// model, while persona, effort and teams do not apply. The node's parameter choices are read
// from the canvas at each run, like a task frame, so changing them never forks the conversation.
func mediaSetupConfig(raw json.RawMessage, id, title, runtime, kind, model string) (setupConfiguration, error) {
	m, ok := builtinMediaCatalog.model(model)
	if !ok || m.Kind != kind {
		return setupConfiguration{}, invalidSetup("Choose an image or video model for this node")
	}
	if !validRuntime(runtime) {
		return setupConfiguration{}, invalidSetup("Node runtime is unavailable")
	}
	document, _ := json.Marshal(map[string]any{"nodes": []json.RawMessage{raw}})
	if team, err := savedNodeTeam(document, id); err != nil || team != nil {
		return setupConfiguration{}, invalidSetup("Image and video nodes cannot run a team")
	}
	name := strings.TrimSpace(title)
	if name == "" {
		name = "Agent " + id
	}
	if !cleanName(name) {
		return setupConfiguration{}, invalidSetup("Node name exceeds the Agent limits")
	}
	return setupConfiguration{Name: name, AgentKind: kind, Runtime: runtime, Model: m.ID}, nil
}

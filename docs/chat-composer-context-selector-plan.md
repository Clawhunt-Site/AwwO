# Chat Composer Context Selector Plan

## Current State

- The SuperClaw desktop/web composer is a plain textarea in `apps/web/src/App.tsx`.
- `/chat`, `/delivery`, `/plugins`, and `/evidence` are static hint buttons below the composer, not a slash-command popup.
- There is no `@` mention parser, no candidate popup, no keyboard selection, and no structured context reference payload.
- `/api/chat/turn` already provides the unified chat entrypoint and delivery can derive bounded context from the same chat session.

## Target State

Typing in the composer should support two trigger families:

- `/` opens a command menu for first-class composer actions.
- `@` opens a context menu for attaching structured SuperClaw context.

Selecting an item should insert a readable token into the composer and preserve a structured reference list that is submitted with the chat turn. The visible text remains useful to the model, while `context_refs` gives the backend stable object identity.

## Non-Goals For This Iteration

- Do not build a full command palette outside the composer.
- Do not add filesystem browsing or arbitrary file attachment unless a current API already exists.
- Do not replace the existing context rail.
- Do not redesign chat/delivery routing.

## UX Contract

### Slash Commands

Initial command set:

- `/chat`: switch composer to normal chat mode.
- `/delivery`: switch composer to delivery mode and use the existing default delivery prompt when the composer is empty.
- `/new`: start a new chat session.
- `/plugins`: open the plugin marketplace surface.
- `/evidence`: open the context rail.
- `/settings`: open settings and local agents.
- `/clawhunt`: open ClawHunt settings.

Behavior:

- Typing `/` at the start of a token opens a popup anchored near the composer.
- Filtering narrows commands by label and description.
- Enter selects, Escape closes, ArrowUp/ArrowDown move focus.
- Mouse click selects.
- Static hint buttons can remain as quick affordances, but they should share the same command definitions as the popup.

### At-Mentions

Initial context source set:

- Current chat session.
- Recent backend/local chat sessions.
- Most recent run from the active session.
- Recent direct-chat turns with `run_id`.
- Evidence/context rail entry for the current run when available.
- Run artifacts and artifact-backed file references from the current evidence bundle.
- Installed plugins and marketplace plugins.

Behavior:

- Typing `@` at the start of a token opens a popup anchored near the composer.
- Filtering narrows by title, id, type, and description.
- Selecting inserts a compact token such as `@session:Current session` or `@run:abc123`.
- The selected item is added to a `context_refs` array.
- Removing the visible token from the composer should remove the matching structured ref before submit.
- `@` should stay scoped to referenceable objects. It should not execute actions.
- `@file` is limited to artifact-backed files from the evidence bundle. It does not browse or resolve arbitrary local file paths, and it injects only bounded text excerpts for non-sensitive text artifacts that pass the run artifact-root guard.

## API Contract

Extend `ChatTurnRequest`:

```python
class ChatContextRef(BaseModel):
    type: Literal["chat_session", "run", "evidence", "plugin", "message", "artifact", "file"]
    id: str = Field(..., min_length=1)
    label: str | None = None
    source: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

class ChatTurnRequest(BaseModel):
    ...
    context_refs: list[ChatContextRef] = Field(default_factory=list)
```

Backend handling:

- Preserve `context_refs` in chat-session message state and delivery `GoalSpec.metadata`.
- For delivery turns, include a concise "Selected context references" section in the generated goal description.
- Do not trust labels as authority; labels are display hints only.
- Resolve only refs that are already available in local server state. Unknown refs should be retained in metadata, should not block the request, and should be rendered as `Reference not found: <type>:<id>` instead of letting the model infer missing context.

## State Persistence Contract

Context references are part of the user turn, not only the HTTP request:

- Add a serializable `context_refs: list[dict[str, Any]]` field to `ChatMessage` in `packages/superclaw/src/superclaw/models.py`.
- Keep `ChatSession.metadata` unchanged for session-level facts; do not overload it for per-message refs.
- Update `ChatSession.to_dict()` / `from_dict()` compatibility so older chat messages without refs load as `context_refs=[]`.
- Update `StateStore.append_chat_message()` in `packages/superclaw/src/superclaw/state.py` to accept `context_refs` and persist them with user messages.
- Assistant messages may keep `context_refs=[]` unless they are explicitly linked to a run through `run_id`.

## Context Resolution Contract

Add a small backend resolver that converts selected refs into bounded prompt text:

- `chat_session`: resolve from `StateStore.get_chat_session()` and summarize title plus the latest bounded messages.
- `run`: resolve from `StateStore.get_run()` and include run id, status, goal id, and dry-run flag.
- `evidence`: resolve from `StateStore.get_evidence()` and include verdict plus bounded findings/summary.
- `message`: resolve only if the message is present in the selected chat session state.
- `plugin`: retain metadata for now unless a local plugin registry lookup is already available in the API layer.
- `artifact`: resolve by `metadata.run_id` + `metadata.artifact_id` against the local evidence bundle and include bounded artifact metadata.
- `file`: resolve only through a matching evidence artifact. Inject a bounded text excerpt only when the artifact is non-sensitive, text-like, and inside the run artifact root.

Resolver rules:

- Apply strict per-ref and total character limits.
- Include unresolved refs explicitly as `Reference not found: <type>:<id>`.
- Never treat frontend labels as authoritative content.
- Return both `serialized_refs` for metadata and `resolved_context_text` for prompt/description injection.

## Frontend Implementation Plan

1. Add typed definitions:
   - `ComposerTrigger`
   - `ComposerCommand`
   - `ComposerContextRef`
   - `ComposerSuggestion`
2. Add composer state:
   - `composerSelection`
   - `composerQuery`
   - `composerSuggestions`
   - `selectedSuggestionIndex`
   - `selectedContextRefs`
3. Add token detection from textarea value and caret:
   - Trigger only when the caret is inside the active token.
   - Support token starts at line start or after whitespace.
4. Build source lists:
   - Commands from the existing static hint actions.
   - Context refs from current session, recent sessions, current run/evidence, and recent turns.
5. Add popup rendering:
   - Accessible listbox/menu semantics.
   - Keyboard and mouse selection.
   - Empty-state row when no match exists.
   - Render the popup inside the composer card between the textarea and footer so it cannot overlap the empty-chat hero, status chips, or surrounding content.
   - Do not implement caret-coordinate positioning or introduce a caret-positioning library unless this simpler anchor proves unusable.
6. Implement selection:
   - Slash commands execute existing actions and replace the typed command token when appropriate.
   - At-mentions insert a visible token and update `selectedContextRefs`.
   - Each inserted mention must have a stable visible token string stored on the ref, for example `@run:abc123`.
7. Synchronize refs on every textarea change:
   - Filter `selectedContextRefs` against the current textarea value.
   - Send only refs whose exact visible token is still present.
   - If a token is partially edited or deleted, drop that structured ref.
8. Submit payload:
   - Include `context_refs: selectedContextRefs`.
   - Clear consumed context refs only after successful submit.
9. Keep static hint buttons:
   - Make them call the same command handlers as the slash popup.

## Backend Implementation Plan

1. Add `ChatContextRef` model and `context_refs` field to `ChatTurnRequest`.
2. Add `context_refs` persistence to `ChatMessage` and `StateStore.append_chat_message()`.
3. Add bounded serializer and resolver for selected refs.
4. Pass refs into `store.append_chat_message(..., context_refs=...)` for user turns.
5. Add selected refs to `GoalSpec.metadata`.
6. Add resolved selected refs to delivery descriptions.
7. Extend `direct_chat_prompt()` / `execute_direct_chat_turn()` in `packages/superclaw/src/superclaw/chat_turn.py` so direct chat receives a bounded "Context References" section when refs are selected.
8. Add tests that verify refs survive `/api/chat/turn`, appear in delivery goal metadata/description, and are injected into direct chat prompts.

## Test Plan

Frontend:

- Typing `/` opens command suggestions.
- Filtering `/del` selects `/delivery`.
- Keyboard navigation selects a slash command.
- Typing `@` opens context suggestions.
- Selecting a context suggestion inserts a token.
- Submitting sends `context_refs`.
- Deleting the mention token removes the submitted ref.

Backend:

- `ChatTurnRequest` accepts valid `context_refs`.
- `ChatMessage` and `StateStore.append_chat_message()` persist refs.
- Delivery branch copies refs into goal metadata.
- Delivery description includes selected refs.
- Direct chat prompt includes resolved refs.
- Unknown refs do not fail the request and render as explicit not-found placeholders.

Regression:

- Existing static slash hint buttons still work.
- Existing chat submit still works with no refs.
- Existing delivery dry-run behavior still works.
- Existing chat context pass-through remains intact.

## Acceptance Criteria

- The composer has real typed `/` and `@` popup behavior, not only static buttons.
- Slash commands and static hint buttons share one command definition.
- At-mention selection produces structured `context_refs`.
- `/api/chat/turn` receives refs and preserves them through chat message state plus delivery metadata.
- Direct chat and delivery both receive bounded resolved context text.
- Unresolved refs are explicit not-found placeholders, never silent hallucination fuel.
- Tests cover keyboard interaction and request payload behavior.
- Desktop/web build remains green before rebuilding the macOS app.

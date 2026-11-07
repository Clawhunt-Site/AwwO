# 多人同屏: people and agents on one canvas at once

Status: design of the first release, 2026-11-06 (the owner: 「针对awwo设计出来一套multiple agent 同时并发协作的模式，就像figma和
notion可以让多个agent同时在一个画布上进行协同合作，能够允许多方agent多端口同时协作」). This document is the contract the API,
the canvas page and the agent endpoints are built against. Where the code and this document disagree, one of them is
wrong and is put right in the same change.

Names. The mode is 「多人同屏」 / "Multiplayer"; its panel is 「同屏」 / "Multiplayer". Bare 协作 already means Agents
working together inside a run (节点协作团队, 互审优化), 成员 means both people and team members, and "presence" names a
transcript row, so none of the three names this mode alone.

## What it is

Several people and several agents work on the same canvas at the same time, as in a design tool or a document editor:

- Every edit reaches everyone on the canvas within about a second. Edits to different nodes or different fields never
  overwrite each other, and nobody is told "the canvas changed in another page, reload" any more.
- Everyone sees who else is there, people and Agents, which nodes each one has selected or is working on, and where
  each person's pointer is.
- An agent takes a node before it works on it (a claim), so several agents divide the canvas instead of writing over
  each other, and people see on each node which agent holds it (on each card the board draws; the 同屏 panel lists
  every claim).
- Participants come in through different ports (端口):
  - **网页 / Web**: a workspace member in the AwwO canvas, signed in as today.
  - **MCP**: an agent tool (Claude Code, Codex, Cursor, any MCP client) on AwwO's MCP endpoint with a canvas agent token.
  - **API**: any program using the same HTTP endpoints with a canvas agent token.
  - **AwwO**: AwwO's own node Agents while they run, shown on the nodes they run (the cards the board draws).

## Prior art and the choice

- Design tools' multiplayer (as Figma has described it publicly): the server is the authority and orders every change,
  the unit of conflict is one property of one object, the last writer at the server wins, and a client keeps its own
  unacknowledged changes over what the server sends until they are acknowledged.
- Block editors (Notion's model): operations on records, applied and broadcast by the server.
- Record stores such as tldraw's sync: per-record put/patch/remove diffs pushed to a server room, which applies or
  rejects them and broadcasts the result.
- CRDTs (Yjs, Automerge): merging without a server order, at the cost of another document model, a Node or Rust service
  beside the Go API, and a migration of every stored canvas.

A canvas is a JSON document of records (nodes, wires, conversations, form fields) whose fields are mostly small
values, and the API already checks and preserves fields of that document on every save. AwwO takes the first model:
**server-ordered, field-level changes on the existing document**, with a durable change log, a live stream, presence and
claims. No canvas is migrated, the document keeps its shape, and every reader of `canvases.document` (runs, node setup,
lessons, evolution, export) keeps working. No library covers a Go API and this document; the engine is small (paths,
three ops, a diff) and both languages run one set of cases (`apps/canvas-change-vectors.json`).

A text field is one value: two people typing into the same field at the same moment keep the later save. Merging long
texts character by character is not in this release.

## Laws

This mode changes what AWWO-LAW-009 demanded. That law is retired and replaced (docs/laws/awwo-laws.md):

- AWWO-LAW-026: a whole-document save stays compare-and-swap on the version it read (pages from before this release).
- AWWO-LAW-027: a canvas change changes only the paths its ops name, applied in the server's order.
- AWWO-LAW-028: every write of a canvas document is in the change log, under its version, before it is streamed.
- AWWO-LAW-029: a canvas agent token reaches only its own canvas, and never more than its creator may do there now.

## Words

- **Participant**: one presence on a canvas: a page (`kind: human`), an agent token (`kind: agent`), or a running AwwO
  node Agent (`kind: awwo`). It has an id, a name, a colour and a port.
- **Change**: one numbered step of a canvas, `{version, actor, label, ops}`. The canvas's `version` column is the change
  number: every write of the document is exactly one change.
- **Op**: one edit inside a change, on one path of the document.
- **Claim**: a participant's hold on a node, until it expires.
- **Live message**: a short line the participants of a canvas write to each other.
- **Canvas agent token**: a secret that lets one agent into one canvas.

## The document change model

### Paths

| Path | Place |
| --- | --- |
| `["nodes", id]` | a node (record) |
| `["nodes", id, key]` | a top-level field of a node (`key` is never `id`) |
| `["nodes", id, "threads", threadId]` | a session node's conversation (record) |
| `["nodes", id, "threads", threadId, key]` | a field of that conversation |
| `["nodes", id, "fields", fieldId]` | a form node's field (record) |
| `["nodes", id, "fields", fieldId, key]` | a field of that form field |
| `["edges", id]` | a wire (record, always whole) |
| `["displays", id]`, `["displays", id, key]` | a 预览展示 window and its fields |
| `["waypoints", slot]` | a saved view (record, always whole; `slot` as a decimal string) |
| `["doc", key]` | another top-level key, such as `execution` |

Three keys are never in a change: `version` (always 2), `updatedAt` (each page's own clock) and `view` (each person's
own camera). Each page keeps its own; the stored document keeps what an older page last saved.

### Ops

```json
{"op": "set",   "path": [...], "value": <any JSON value>}
{"op": "del",   "path": [...]}
{"op": "order", "path": ["nodes"] | ["edges"] | ["displays"] | ["nodes", id, "threads"] | ["nodes", id, "fields"], "ids": [...]}
```

Applied the same way by the server and by every page (`canvas_changes.go`, `apps/web/src/canvas/multiplayer/changes.ts`):

- `set` on a record path replaces the first record with that id, or appends the value to its collection when there is
  none. The value is an object whose `id` (a waypoint's `slot`) is the path's.
- `set` on a field path sets the field when its record exists, and otherwise does nothing.
- `del` on a record path removes the record; on a field path it removes the key. Missing is not an error.
- `order` puts the listed records that exist first, in the listed order, and keeps every other record after them.
- A missing collection is created by the first record set into it.

### Diff

`diff(a, b)` gives the ops that turn `a` into `b`: records match by id; a record on one side only is a record `set` or
`del`; a record on both is compared key by key (a node's conversations and form fields one level deeper, by id); wires
and waypoints are compared whole; values are compared as JSON values. When the shared records' order differs, one
`order` op follows. Within a collection the deletions come first, then the sets in `b`'s order, then the order op;
within a record the keys go in sorted order. The server works out every change's **effective ops** this way, from the
document before and after it, so applying a change's ops gives the server's document exactly.

### What the server keeps true on every change

One transaction: the workspace row (`mutationRole`), then the canvas row `FOR UPDATE`; then:

- A wire whose node is gone is removed (its `del` is in the change).
- The rules of a whole-document save hold: the preserved skills and task frames, the skill and task-frame checks, the
  400-node and 2,000-wire bounds, distinct node ids, and the 8 MiB document bound.
- The evolution change a save settles is settled (canvas_evolution.go), as after a whole-document save.
- One audit row `canvas.changed` (`canvas.agent_changed` for a token's).
- The change log row, then the commit, then the wake-up of the canvas's live streams.

## Concurrency

### Order and the last writer

The server applies changes in the order they reach it; for one field, the later change stays; changes to different
records or fields all stay. A change names the version its sender had (`baseVersion`). The server applies it to the
current document, whatever that is, and answers with every change after `baseVersion` (others' and this one), so the
sender's copy of the server's document is exact again. A change carries its sender's `changeId`: the same change sent
again under it is answered with the change already made and each op's result as first answered (an op the fence held
back stays held), never applied twice; the same id with other ops is refused `409 idempotency_conflict`.

### A page's own edits win until they are sent

A page holds the server's document as it knows it (`confirmed`) and the document it shows (`working`). When others'
changes come, for each op: where the working document still holds the confirmed value at that path (this page has not
changed it), the page takes the op; otherwise the page's own edit stays, to go with its next save. A record someone else
deleted goes from the working document too. The undo and redo steps are carried over the same way, so an undo never
takes back someone else's edit.

When the page's own change is answered, each path it sent takes the server's value, unless the page has changed it again
since. So a field the server keeps (a preserved skill list, a refused op) never loops back as an endless save.

### Running nodes stay fenced

A node in an active run (a canvas run's scope, or a node's own conversation running) can be edited only by the person
who started that run: the page that runs a node has always fenced it, and the server now holds the same fence for
everyone. Free during a run, for everyone: a node's place, size and drawer (`x`, `y`, `w`, `h`, `deliverablesOpen`),
and its results (`lastOutput`, `preview`, `issueId`, a conversation's `lastOutput`, `outputValues`, `preview`, `issueId`,
and a contract whose only change is its outputs' values), which every page watching the run publishes alike. A wire into
a fenced node is fenced with it. An op the fence refuses is answered `node_running`; the rest of the change stays.

### Claims

- A claim holds one node for one participant until it expires (15 s to 10 min; claiming again renews it) or is let go.
- An agent changes only nodes it has claimed or created: an op on a node another participant holds is refused
  `claimed`. An agent's new node is claimed for it at once.
- People are never blocked by a claim: the node shows who holds it, and a person's edit goes through and reaches the
  agent in the live stream.
- A claim ends when it expires, when its participant lets it go, when its token is revoked, or with its node.

## Presence

A page is on a canvas while its live stream is open, and for 30 s after it closes, so a reconnect does not flicker. An
agent is there while its stream is open or for 90 s after its last request. Its state, sent by `POST …/live/presence`
and broadcast to everyone on the canvas:

```json
{"selection": ["nodeId"], "focus": "nodeId" | null, "cursor": {"x": 0, "y": 0} | null, "status": "short text" | null}
```

`cursor` is in world coordinates (people; at most 4 updates a second are sent, none while the page's tab is hidden).
`status` is one line an agent shows (「正在写后端接口」), at most 140 characters. AwwO's running node Agents appear as
`kind: awwo` participants on their nodes, from the runs the server holds. A participant shows a name, never an email
address. The API lets readers (只读成员) watch (the stream, role 1) and refuses them messages and claims; in this
release a reader's page still shows the canvas as it was when it opened, and is not on the canvas for the others (a
live reader's page is not in this release).

Colours come from one palette by participant id, so everyone sees a participant in the same colour.

## Wire format

```ts
type CanvasOp = { op: 'set'; path: string[]; value: unknown } | { op: 'del'; path: string[] } | { op: 'order'; path: string[]; ids: string[] };
interface ChangeActor { kind: 'human' | 'agent' | 'awwo'; userId?: string; tokenId?: string; name: string; clientId: string }
interface CanvasChange { version: number; actor: ChangeActor; label: string; ops: CanvasOp[]; at: string }
interface LiveState { selection: string[]; focus: string | null; cursor: { x: number; y: number } | null; status: string | null }
interface LiveParticipant {
  id: string;            // a page's client id, 't_' + token id, or 'run_' + run id
  kind: 'human' | 'agent' | 'awwo';
  port: 'web' | 'mcp' | 'api' | 'awwo';
  name: string;
  color: string;         // '#rrggbb'
  userId?: string;       // the person (for an agent: who made its token)
  role?: 'reader' | 'member' | 'admin' | 'owner';
  model?: string;        // kind awwo: the node's model
  state: LiveState;
  since: string;         // ISO time it came
}
interface LiveClaim { nodeId: string; participantId: string; holderKind: 'human' | 'agent'; name: string; note: string; expiresAt: string }
// A message's participantId is 'u_' + the person's user id (any of their pages) or 't_' + token id; color is the
// author's, kept for when they have left.
interface LiveMessage { id: string; authorKind: 'human' | 'agent'; participantId: string; name: string; color: string; nodeId: string; text: string; createdAt: string }
interface AgentTokenItem { id: string; name: string; prefix: string; scope: 'edit' | 'read'; createdAt: string; expiresAt: string;
  lastUsedAt: string | null; revokedAt: string | null; createdBy: { id: string; name: string } }
```

A page's `clientId` matches `^[A-Za-z0-9_-]{8,64}$` and never begins `t_` (the ids the server gives tokens, so no page
passes for an agent); a `changeId` matches the same pattern. A page picks its id at random, and every participant sees it,
so the server binds an id to the person (or token) it first came with: another member who sends it is refused the
stream (`409 client_taken`), moves no presence under it and cannot renew, take or release a claim held under it.

## The API

Under `/api/v1/tenants/{tenantId}/canvases/{id}` (reads: a member of any role or a token; writes: a member or above, or
an edit token):

| Method and path | Body | Answer |
| --- | --- | --- |
| `PATCH` (the canvas itself) | `{baseVersion, changeId, clientId, ops, label?}` | `{version, results, reasons?, changes}`: `results[i]` is `ok`, `gone`, `claimed`, `node_running` or `forbidden` for `ops[i]`; when any op is refused, `reasons[i]` says in one sentence why (`""` for an op done; see Ports); `changes` holds every change after `baseVersion`; or `{version, results, reasons?, reset: true, document}` when the log no longer reaches back |
| `GET /changes?after=v` | | `{version, changes}`, or `{version, reset: true, document}` |
| `GET /live/events?after=v&client=c` | | the live stream |
| `POST /live/presence` | `{clientId, state}` | 204 |
| `POST /live/claims` | `{clientId, nodeIds, ttlSeconds?, note?}` | `{claims, refused: [{nodeId, holder}]}` |
| `DELETE /live/claims` | `{clientId, nodeIds?}` | `{claims}` |
| `GET /live/messages?before=id` | | `{items}` (the newest first, 50) |
| `POST /live/messages` | `{clientId, text, nodeId?}` | `{message}` |
| `GET /agent-tokens` | | `{items}` (never a secret) |
| `POST /agent-tokens` | `{name, days?, scope?}` | `{token, item}`: the secret, shown once |
| `DELETE /agent-tokens/{tokenId}` | | 204; that token's streams end with `bye` |

`PATCH` shares the canvas's own URL so the edge's 9 MB body rule for canvas saves covers it; the stream's path ends in
`/events`, which the API's 30 s request deadline leaves alone. The `X-Awwo-Canvas-Features: market` header goes with a
`PATCH` as with a `PUT`.

The whole-document `PUT` stays for pages from before this release: it keeps its strict version check
(`409 version_conflict`, AWWO-LAW-026) and also records its change, so everyone live sees it. `POST /initialize` records
its change too. A page of this release that is refused `version_conflict` by node setup or by a canvas run's start
catches up with the changes it missed and asks again.

### The live stream

| Event | Data |
| --- | --- |
| `hello` | `{you, version, participants, claims, messages}` (the 30 newest messages) |
| `changes` | a `CanvasChange`; one event per version after `after`, in order |
| `reset` | `{version}`: the changes after `after` are no longer kept; read them with `GET /changes` (which then sends the document) |
| `presence` | `{participant}` (came or changed) or `{left: id}` |
| `claims` | `{claims}` (the canvas's whole list, whenever it changes) |
| `message` | `{message}` |
| `bye` | `{reason}`: `revoked`, `access`, `deleted` or `restart`; the stream ends |

A `: ping` comment goes every 15 s. Access is checked again every 15 s (a page's session, membership and ClawHunt sign-in,
or a token's liveness), as the run event stream does. Changes are durable before they are streamed; a process-local
signal wakes the streams at once, and each stream reads the log again on every ping. A page reconnects with `after` set
to its confirmed version and misses nothing. When the API stops, every stream ends at once with `bye: restart`.

### Limits

- A change: at most 500 ops; a body of at most 8 MiB; and at most 4,000,000 records and keys the engine must read to
  apply it (`canvasChangeWork`: each op its list, an op on a node's field that node): far above a canvas of 400 nodes
  and 2,000 wires, it refuses (413 `canvas_change_too_large`) a change over a document grown past what the canvas draws
  before any of it is done. The engine sorts and orders in about linear time.
- An MCP request: at most 1.9 MB, below the hosted edge's 2 MB on `/api/v1/mcp` (its general API rule), so an agent
  is told why in JSON-RPC; a larger result goes by `PATCH` on the canvas's URL (9 MB at the edge), with the same token.
- A token: 120 requests a minute, 4 open streams (an MCP `canvas_wait` is none). A person: 8 streams per canvas, and
  as many participants (those still in their grace counted: a new page id at the cap takes the place of their own
  oldest page with no stream).
- A canvas: 10 live tokens; 64 participants.
- Presence: at most 10 updates a second per participant are taken; a page paces itself below that, sends its pointer
  at most 4 times a second, and only while someone else is on the canvas and its tab is in view. A selection is
  carried as at most 100 node ids.
- The log keeps what a reader can be sent (the newest 300 changes, about 4 MiB of their stored ops), always the newest
  10, and nothing older than a day beyond those; it is pruned at each write of the canvas.

## Agents

### Tokens

A member (or above) makes a canvas agent token in the canvas's 同屏 panel (邀请 Agent), names it after the agent ("Claude
Code") and copies it once. A token is `awwo_ct_<16 hex id>_<43 characters>`; the database keeps only its SHA-256 and its
prefix `awwo_ct_<id>`. A token reaches one canvas of one workspace, expires (1 to 90 days, 30 by default), and is revoked
from the same panel, when its maker leaves the workspace or becomes a reader, and when its maker's password changes.

A token acts for the person who made it and never beyond what they may do now: their membership is checked again on
every request, and at most their role. It cannot start runs, spend credits, read other canvases, change settings or make
tokens. A request with a token must carry no `Origin` header (a page cannot use a pasted token) and is never read for a
cookie. A `scope: read` token only watches.

### What an agent may change

- Make, move, resize and delete nodes of kind `session` and `form`; delete any node it may change.
- Set a node's `title`, `persona`, `x`, `y`, `w`, `h`, `deliverablesOpen`; a form's `fields`; an assemble node's
  `template` and `fileName`; an edit node's `timeline`.
- Write a node's `lastOutput`: the server keeps it as `source: "manual"`, at the time it came, with `by` naming the
  agent, so it is never shown as AwwO's engine's result.
- Add and remove wires, checked against the nodes' ports and types (graph_contracts.go `nodePort`, `edgeTypesFit`).
- Each value is checked (`agentFieldValue`): a title is text of at most 200 bytes (UTF-8, so about 66 Chinese
  characters), a persona 32,000 bytes, a template or a timeline 1 MiB, a file name 200 bytes without `/` or `\`; `x` and
  `y` lie within ±10,000,000, `w` and `h` from 40 to 100,000; a form's fields set whole are at most 100 (one added at
  its own path is not counted), each with an id of 1 to 80 of `[A-Za-z0-9_.:-]` (ASCII only) of its own, a label of at most 200 bytes and a value of at most 20,000 (set alone,
  at its own path `nodes/<id>/fields/<field id>/label`, a label may take up to 20,000 bytes); a result's text is 1 byte
  to 4 MiB.

After every change, for everyone, the server keeps each wire as a page reads it and a canvas run checks it
(`reconcileCanvasWires`): its type is its source port's where the port rules know both ends and the types fit, and a
wire into or out of a contract field the node no longer has goes. A wire the rules cannot judge stays as it is. (A
fence that refuses a wire op while its node's op passes, or two writers at once, could otherwise leave a mistyped wire
every page reads fixed and every canvas run refuses.)

An agent's write takes the nodes it wrote for 60 s, or renews its own claim, never shortening it or blanking its note.
- Not: bindings, conversations, Agent references, skills, teams, task frames, contracts, models, runtimes, efforts,
  media settings, evolution marks, `execution`. A new session node has no runtime or model chosen; a person picks them.

### Ports

- **HTTP**: the endpoints above with `Authorization: Bearer <token>`.
- **MCP**: `POST /api/v1/mcp` (Streamable HTTP with JSON answers; the token as a bearer header). Its tools, with their
  annotations (R read-only, D destructive, I idempotent; none reaches beyond the canvas, `openWorldHint: false`):

| Tool | What it does | Hints |
| --- | --- | --- |
| `canvas_overview` | the canvas: nodes (id, kind, title, place, a short brief, the start of its result), wires, participants, claims | R I |
| `canvas_read_node` | one node in full | R I |
| `canvas_wait` | waits up to 25 s for someone else's change, message or claim after a version, and says what happened (the agent's own changes are listed but do not end the wait) | R I |
| `canvas_add_node` | adds a session or form node, claimed for the caller | |
| `canvas_update_node` | sets the fields an agent may set | D |
| `canvas_delete_node` | deletes a node | D I |
| `canvas_connect`, `canvas_disconnect` | adds or removes a wire (ports worked out when not given; a wire already there is left as it is) | I; D I |
| `canvas_claim`, `canvas_release` | takes or lets go of nodes | none; I |
| `canvas_set_status` | the caller's one-line status and focus | I |
| `canvas_say`, `canvas_messages` | writes and reads the live messages | none; R I |
| `canvas_apply` | raw ops, for programs that build their own | D |

Clients such as Codex weigh the annotations when they decide what to ask a person before a call, so each tool sends all
four (and its title), never leaving one to a client's default: a tool a client is told nothing of counts as destructive
and open-world. A read changes nothing on the canvas (it shows the agent as present). The destructive tools can lose
what someone made: a node, a wire, a field's or a result's earlier text; the others only add, or change the caller's own
claims, status and messages. (The server's own retention is not counted: every write prunes the canvas's change log,
and a message the oldest beyond the 200 kept, whoever sends it.) `canvas_connect` only adds, judged in its change
under the canvas's lock (`canvasAddOnlyWires`). Where a wire with the id its ports make is on the canvas already, a
data wire joining the same ports counts as done (`ok`, nothing changed). A feedback wire of those ports, or another wire
whose ends spell the same id (node ids and ports may hold `:`), refuses it (`forbidden`, with its reason), and the wire
there is left as it is. Pages name wires the same way, and setting the wire again used to turn a person's or the
planner's feedback wire into a data wire. A call is idempotent where repeating it with the same arguments changes
nothing more: the reads, connecting, deleting a node, removing a wire, letting go and the status. Any other write renews
the writer's claim, adds again or stamps its result anew.

On 2026-11-07 the real clients were run against a local API with these hints. Codex 0.162.1, with no tools approval
mode set for the server and no approval prompts possible (`codex exec`), ran the reads and `canvas_add_node` and
refused `canvas_update_node` and `canvas_delete_node` as needing approval; without annotations it had refused every
tool. Claude Code 2.1.317 asked permission for every tool, read-only or not, in its default permission mode: there, the
tools its line allows decide.

A refused op says why. `results[i]` keeps its code as before. When any op of a change is refused, the answer (the tool's
and `PATCH`'s alike, for people's ops too) also carries `reasons`: one sentence per op (`""` for an op done) that names
what the op would have changed, the rule and what to do instead, for example `node f1's persona: a form has no persona
(only a session does)` or `wire n1:result->c1:in:brief: node c1's in:brief takes one wire and has one already
(f1:data->c1:in:brief); wire another input or, if that wire may go, remove it first`. The reason for a claim names its
holder and when it ends; the reason for a port lists the node's own ports (at most 12, whole, and says when there are
more). Both real clients quoted the reasons and followed them; Codex then removed a person's wire to make room on a
single input, which is why that reason asks whether the wire may go. Only the sender is told, and nothing keeps the
sentences, so a change sent again under its id is answered with what its codes meant then. The MCP instructions and
every tool that makes ops say where to look, and a tool's text content is its JSON as written (a wire's `->` and a
path's `<id>` are not escaped for HTML).

A wire joins an output port to an input port (`nodePort`). Outputs: a form's `data`, a session's or an edit's `result`,
`out:<field id>` of a node with a contract. Inputs: a session's `context`; `reference` (a picture) of an image, video or
3D session; `audio` of a video session; `in:<field id>` of a node with a contract; an edit's `timeline`, `clips`,
`sounds` and `pictures`. An output feeds an input of its own type, and an image, video, audio or 3D result also a text
input. An input takes one wire, except `context`, a video's `reference` and `audio`, and an edit's `clips`, `sounds`
and `pictures`. `canvas_connect`'s description names them.

Connecting Claude Code and Codex (the 邀请 Agent panel shows these lines with the token filled in):

```
claude mcp add --transport http awwo-canvas https://<AwwO host>/api/v1/mcp --header "Authorization: Bearer <token>"
```

```
# ~/.codex/config.toml
[mcp_servers.awwo_canvas]
url = "https://<AwwO host>/api/v1/mcp"
bearer_token_env_var = "AWWO_CANVAS_TOKEN"
```

Unattended (in the same folder as the `claude mcp add`):

```
claude -p "<task>" --allowedTools mcp__awwo-canvas
```

```
export AWWO_CANVAS_TOKEN="<token>"
codex exec --skip-git-repo-check -c 'mcp_servers.awwo_canvas.default_tools_approval_mode="approve"' "<task>"
```

Both CLIs ask before a server's tools, and a headless run can answer no prompt. `claude -p` is denied every canvas tool
("Claude requested permissions to use mcp__awwo-canvas__canvas_overview, but you haven't granted it yet"), and
`codex exec` answers "MCP tool call requires approval, but approval policy is never" for each tool its annotations do
not let it run by itself: since the tools carry annotations (above), the destructive ones (changing or deleting a node,
removing a wire, raw ops), while the reads and the tools that only add run without the allowance. The `claude -p` and
`codex exec` lines are therefore the unattended runs. They allow the canvas's tools on their own command line, never in a config file:
- an interactive session still asks first;
- a `[mcp_servers.awwo_canvas]` table added before stays as it is (a second one would stop Codex from loading the file);
- an edit token's allowance covers every tool of the canvas, deleting nodes included, and the run acts on what others
  write on the canvas (the panel says to run it in a folder with nothing private); a read token's run can only look.

Details of the lines:
- The task comes before `--allowedTools`, which takes a list and would swallow a task placed after it.
- `claude -p` finds the server only in the folder where `claude mcp add` ran, its default (local) scope.
- `codex exec` refuses to start outside a Git repository or a trusted folder without `--skip-git-repo-check`, and a canvas
  task needs no repository.
- The lines are written for bash or zsh, as the export line is.

Checked on 2026-11-07 with the real CLIs, Claude Code 2.1.317 and Codex 0.162.1, on a local stack: the panel's lines as
shown made their calls, and the same runs without their allowance were refused as quoted above.

## The canvas page

- **The people bar** in the canvas header: the participants' avatars in their colours (an Agent with an Agent mark),
  each with its port; a click opens the 同屏 panel.
- **The 同屏 panel**: who is here (name, kind, port, status, what they have selected), the claims, the live messages and a
  box to write one, the latest changes (「Claude Code 添加了节点「后端接口」」), and 邀请 Agent: make a token, copy the
  connection lines for Claude Code, Codex and Cursor, see and revoke the canvas's tokens.
- **On the board**: a ring in each participant's colour around the nodes they have selected, with their name; a claim's
  badge on its node; each person's pointer with their name; a short glow on a node another participant just changed.
  These mark the cards the board draws: a component inside a converged icon (收敛成一个图标, one person's own way of
  looking) wears none of them, so none of them crosses the icon's face. The 同屏 panel still says who is on it and who
  holds it (the people bar, who is here), and naming it there draws its cards again with every mark in place. The icon
  shows the runs this page started or found running when it opened (its working face, its arcs, its rows); a run
  another page starts later shows in the people bar's AwwO Agents and the 同屏 panel, not yet on the icon. Pointers are
  drawn wherever people's hands are, over an icon too.
- **Saving**: a page sends only what it changed (`PATCH`), at autosave's pace. 已同步 means the server holds every edit
  of this page.

## Release and fallback

1. The API with migration 056 (at an idle moment: its switch waits for one). The website already live keeps its
   whole-document saves under the same rules; the live endpoints wait for the next website and for agents.
2. The website, at once after it: changes, the live stream, presence and the 同屏 panel. (The other order would leave
   every canvas opened while the API switch waits for idle in whole-document mode until it is reloaded.)

A page from before the website release keeps saving whole documents and is told, as today, when the canvas changed in
another page. The website rolls back alone (the API answers both kinds of page). The API rolls back with no SQL: the
API before it starts and saves canvases on schema 56 (rehearsed before the release), and the API of this
release, started again later, answers a page across the old API's saves with a reset. Never drop the four tables:
schema 56 stays recorded, so the next start would not make them again. Before starting this release's API again after
such a rollback, revoke the tokens whose makers lost their access meanwhile (the old API revokes none):

```sql
UPDATE canvas_agent_tokens t SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL AND NOT EXISTS
  (SELECT 1 FROM memberships m WHERE m.tenant_id=t.tenant_id AND m.user_id=t.created_by AND m.role<>'reader');
```

## Tests

- Shared cases (`apps/canvas-change-vectors.json`) run by the Go and the web tests; `apply(a, diff(a, b)) == b` over
  random documents in both.
- Go: changes against PostgreSQL (concurrent writers, the fence, claims, the save rules, limits, the log and its reset,
  resends), the stream (resume, re-checks, revocation, shutdown), tokens, the MCP endpoint (its tools' annotations, and
  the reason of every kind of refusal).
- Web: rebasing confirmed and working documents, undo over others' edits, the save path, the panel and the board.
- Locally: several agents (HTTP and MCP) and two browsers on one canvas at once; every copy equal to the server's
  document at the end; recorded on video.
- Live: the same with the test account on a test canvas of its own, deleted afterwards.

## Not in this release

- Agents starting runs or spending credits.
- Merging long texts character by character.
- Comments pinned to nodes (a live message may name a node).
- More than one API process (the hub and presence live in the one process the API's database lock allows).

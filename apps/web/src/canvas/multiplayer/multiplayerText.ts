// The words of 多人同屏 / Multiplayer (docs/awwo-canvas-live-collaboration.md), in both languages. Kept beside the
// mode's views (not in the shared catalogue) so the mode is one set of files, as the 预览展示 node's words are
// (displayCopy.ts). Names: the mode is 「多人同屏」 / "Multiplayer", its panel 「同屏」 / "Multiplayer"; the ports are
// 网页 / Web, MCP, API and AwwO. Bare 协作 already names Agents working together inside a run, so it never names this.
import { useMemo } from 'react';
import type { UiLocale } from '../../locale';
import { SaaSApiError, saasErrorMessage } from '../../saas/api';
import { useCanvasI18n } from '../i18n';
import type { LiveDevice } from './types';

const EN = {
  'mode.name': 'Multiplayer',
  'panel.title': 'Multiplayer',
  'panel.close': 'Close Multiplayer',
  'panel.count': '{count} here',
  // The header's button: its accessible name says how many are here, or what the connection is doing.
  'bar.live': 'Multiplayer · {count} here',
  'bar.connecting': 'Multiplayer · connecting',
  'bar.offline': 'Multiplayer · offline',
  'bar.more': '{count} more here',
  'more.count': '+{count}',
  'status.live': 'Connected: edits reach everyone here within a second',
  'status.connecting': 'Connecting…',
  'status.offline': 'Not connected: others’ edits arrive once the connection is back',
  'self.name': '{name} (you)',
  'someone': 'Someone',
  'kind.human': 'Person',
  'kind.agent': 'Agent',
  'kind.awwo': 'AwwO Agent',
  'port.web': 'Web',
  'port.mcp': 'MCP',
  'port.api': 'API',
  'port.awwo': 'AwwO',
  'role.reader': 'Read only',
  'avatar.title': '{name} · {port}',
  'avatar.titleStatus': '{name} · {port} · {status}',
  'node.untitled': 'Untitled node',
  'node.missing': 'Deleted node',
  'node.show': 'Show “{node}” on the canvas',
  // AwwO's own Agent on a node it runs: its run's state, and the node's model when it can be named.
  'awwo.queued': 'Queued',
  'awwo.running': 'Running',
  'awwo.withModel': '{state} · {model}',
  // What went wrong, after “Couldn’t …: ”.
  'error.retry': 'try again',
  'error.network': 'AwwO could not be reached. Check your connection and try again.',
  'error.request': 'The request did not go through ({status}). Try again.',
  'error.agentTokenLimit': 'A canvas holds at most 10 live Agent tokens. Revoke one first.',
  'error.tooManyStreams': 'Too many connections are open on this canvas. Try again shortly.',
  // Who is here.
  'section.people': 'People · {count}',
  'section.agents': 'Agents · {count}',
  'section.awwo': 'AwwO Agents running · {count}',
  'participants.alone': 'Only you are here. Invite an Agent below to work on this canvas with you.',
  'participants.aloneBare': 'Only you are here.',
  'participants.aloneShare': 'Only you are here. Share this canvas to work on it together.',
  'participant.selected': 'Selected',
  'participant.viewing': 'Viewing',
  'participant.working': 'Working on',
  // Claims: an Agent takes a node before it works on it.
  'section.claims': 'Claimed nodes · {count}',
  'claims.empty': 'No node is claimed. An Agent claims a node before it works on it.',
  'claim.left': '{time} left',
  'claim.ending': 'Ending',
  'claim.release': 'Release',
  'claim.releaseLabel': 'Release “{node}”',
  'claim.releaseAll': 'Release all mine',
  'claim.releasing': 'Releasing…',
  'claim.releaseFailed': 'Couldn’t release: {detail}',
  'time.minutes': '{m} min {s} s',
  'time.seconds': '{s} s',
  // Live messages: short lines the participants write to each other.
  'section.messages': 'Messages',
  'messages.empty': 'No messages yet.',
  'messages.readOnly': 'You can read the messages but not write one (read only).',
  'messages.box': 'Message everyone here',
  'messages.placeholder': 'Write to everyone here. Enter sends, Shift+Enter adds a line.',
  'messages.send': 'Send',
  'messages.sending': 'Sending…',
  'messages.failed': 'Couldn’t send: {detail}',
  'messages.about': 'About “{node}”',
  'messages.detach': 'Don’t attach “{node}”',
  'messages.count': '{count}/{max}',
  // The latest changes, one line each (activity.ts).
  'section.activity': 'Recent changes',
  'activity.empty': 'No changes yet.',
  'act.one': '{who} {a}',
  'act.two': '{who} {a} and {b}',
  'act.moreOne': '{who} {a}, {b} and made one more change',
  'act.more': '{who} {a}, {b} and made {count} more changes',
  'act.addedOne': 'added the node “{node}”',
  'act.addedMany': 'added {count} nodes',
  'act.removedOne': 'removed the node “{node}”',
  'act.removedSome': 'removed a node',
  'act.removedMany': 'removed {count} nodes',
  'act.resultOne': 'wrote a result into “{node}”',
  'act.resultMany': 'wrote results into {count} nodes',
  'act.renamedOne': 'renamed a node to “{node}”',
  'act.renamedMany': 'renamed {count} nodes',
  'act.settingsOne': 'changed the settings of “{node}”',
  'act.settingsMany': 'changed the settings of {count} nodes',
  'act.contractOne': 'updated the inputs and outputs of “{node}”',
  'act.contractMany': 'updated the inputs and outputs of {count} nodes',
  'act.formOne': 'edited the form “{node}”',
  'act.formMany': 'edited {count} forms',
  'act.threadOne': 'changed the conversations of “{node}”',
  'act.threadMany': 'changed the conversations of {count} nodes',
  'act.connectedOne': 'connected “{from}” → “{to}”',
  'act.connectedMany': 'added {count} wires',
  'act.disconnectedOne': 'removed a wire',
  'act.disconnectedMany': 'removed {count} wires',
  'act.resizedOne': 'resized “{node}”',
  'act.resizedMany': 'resized {count} nodes',
  'act.movedOne': 'moved “{node}”',
  'act.movedMany': 'moved {count} nodes',
  'act.displays': 'changed the preview displays',
  'act.waypoints': 'changed the saved viewpoints',
  'act.canvas': 'changed the canvas settings',
  'act.order': 'rearranged the canvas',
  'act.generic': 'changed the canvas',
  // On the board.
  'board.claim': '{name} · working',
  // 邀请 Agent: a canvas agent token, shown once, and the canvas's tokens.
  'invite.toggle': 'Invite an Agent',
  'invite.intro': 'With a token, an Agent such as Claude Code, Codex or Cursor joins this canvas through MCP, and any program through the API. It reaches only this canvas, never does more than you may do here, and never runs nodes or spends credits.',
  'invite.name': 'Agent name',
  'invite.nameHint': 'Everyone here sees the Agent under this name.',
  'invite.days': 'Expires after',
  'invite.daysOne': '1 day',
  'invite.daysMany': '{days} days',
  'invite.scope': 'Access',
  'invite.scopeEdit': 'Edit',
  'invite.scopeRead': 'Read only',
  'invite.scopeEditHint': 'Adds, changes, wires and deletes nodes.',
  'invite.scopeReadHint': 'Watches the canvas and is seen; changes nothing.',
  'invite.create': 'Create a token',
  'invite.creating': 'Creating…',
  'invite.failed': 'Couldn’t create the token: {detail}',
  'invite.secretTitle': 'Token for “{name}”',
  'invite.secretOnce': 'Shown only this once: after you close it nobody can see it again. Keep it like a password, and never paste it into a chat or a repository.',
  'invite.tokenLabel': 'Token',
  'invite.copy': 'Copy',
  'invite.copyLabel': 'Copy: {what}',
  'invite.copied': 'Copied',
  'invite.copyFailed': 'Couldn’t copy. Select the text and copy it by hand.',
  'invite.forClaude': 'Claude Code',
  'invite.forClaudeUnattended': 'Claude Code · unattended (claude -p)',
  'invite.forCodex': 'Codex · ~/.codex/config.toml',
  'invite.forCodexEnv': 'Then, in the shell that starts Codex:',
  'invite.forCodexUnattended': 'Codex · unattended (codex exec)',
  'invite.unattendedHint': 'Put what the Agent should do in place of <task>, and start claude -p in the folder where you ran claude mcp add. These two unattended runs use all of this canvas’s tools without asking, deleting nodes included, and act on what others write on the canvas, so run them in a folder with nothing private. Used interactively, Claude Code still asks before using a canvas tool, and Codex before the ones that can lose someone’s work (changing or deleting a node, removing a wire, raw ops). You can revoke the token below at any time.',
  'invite.unattendedHintRead': 'Put what the Agent should do in place of <task>, and start claude -p in the folder where you ran claude mcp add. These two unattended runs use this canvas’s tools without asking; the token is read only, so they can look but change nothing. You can revoke the token below at any time.',
  'invite.forCursor': 'Cursor · .cursor/mcp.json',
  'invite.forHttp': 'HTTP',
  'invite.done': 'Done, I saved it',
  'invite.list': 'Tokens of this canvas',
  'invite.listEmpty': 'No tokens yet.',
  'invite.loading': 'Loading the tokens…',
  'invite.loadFailed': 'Couldn’t load the tokens: {detail}',
  'invite.madeBy': 'made by {name}',
  'invite.expires': 'expires {date}',
  'invite.expired': 'expired {date}',
  'invite.lastUsed': 'last used {date}',
  'invite.neverUsed': 'never used',
  'invite.revoked': 'revoked {date}',
  'invite.revoke': 'Revoke',
  'invite.revokeLabel': 'Revoke the token “{name}”',
  'invite.revokeConfirm': 'Revoke “{name}”? The Agent using it is disconnected at once and the token stops working.',
  'invite.revoking': 'Revoking…',
  'invite.revokeFailed': 'Couldn’t revoke: {detail}',
  'invite.cancel': 'Cancel',
  // treg in 邀请 Agent: lines with no credential that give the connected Agent treg's tools too.
  'treg.toggle': 'Add treg: live data for your Agent',
  'treg.intro': 'treg (treg.to, a third-party tool catalog by Superdesign) lets the Claude Code, Codex or Cursor you connect here search the web and read pages, look up keywords and backlinks, social trends, and company and market data, then write what it found onto this canvas. AwwO’s own Agents have no live web: your Agent brings it.',
  'treg.billing': 'treg charges per call, to your own treg team, and shows the price before a call. AwwO takes no part of that money and never sees or keeps your treg sign-in. What you send to treg leaves AwwO.',
  'treg.stepsLabel': 'How to add it',
  'treg.step1': 'Sign up at treg.to and create a team: the team pays for the calls.',
  'treg.step2': 'Add treg to the same Agent with a line below, and sign in when it asks.',
  'treg.step3': 'Ask the Agent to look things up with treg, then write them onto the canvas with its canvas tools.',
  'treg.forClaude': 'Claude Code · then /mcp, pick treg and sign in',
  'treg.forCodex': 'Codex · it opens the sign-in at once (later: codex mcp login treg)',
  'treg.forCursor': 'Cursor · add it inside mcpServers in .cursor/mcp.json, beside awwo-canvas',
  'treg.forTask': 'A task to give it',
  'treg.task': 'Use treg to research <topic>: keep the source link beside every fact, then write the findings into the node “<node>” with the AwwO canvas tools.',
  'treg.caution': 'A paid treg call never happens unattended: Codex asks before one, and the unattended lines (claude -p, codex exec) cannot approve it unless you allow treg yourself, so set a spending cap in treg before you do. Codex may still look things up in treg’s free catalog by itself, which sends what it asks to treg. Send treg public things only: never a private link or a page behind a sign-in.',
  'treg.site': 'Open treg.to',
  'treg.siteLabel': 'Open treg.to (a third-party site) in a new tab',
  // You.com in 邀请 Agent: lines with no credential that give the connected Agent You.com's web search too.
  'you.toggle': 'Add You.com: web search for your Agent',
  'you.intro': 'You.com (you.com, a third-party search API) lets the Claude Code, Codex or Cursor you connect here search the live web and, with a full line, read the pages it finds, then write what it found onto this canvas.',
  'you.free': 'The free lines need no account: 100 searches a day, search only (no page reads).',
  'you.billing': 'A full line signs you in to your own You.com account, which pays for each call. AwwO takes no part of that money and never sees or keeps your You.com sign-in. What you send to You.com leaves AwwO.',
  'you.stepsLabel': 'How to add it',
  'you.step1': 'Claude Code or Cursor: add its free line below to the same Agent. It works at once, with no account.',
  'you.step2': 'To read pages too, or on Codex (it signs in even for the free profile), add a full line instead and sign in to You.com when it asks.',
  'you.step3': 'Ask the Agent to look things up with You.com, then write them onto the canvas with its canvas tools.',
  'you.forClaudeFree': 'Claude Code · free, no account',
  'you.forCursorFree': 'Cursor · free, add it inside mcpServers in .cursor/mcp.json, beside awwo-canvas',
  'you.forClaude': 'Claude Code · full, then /mcp, pick you and sign in',
  'you.forCodex': 'Codex · full, it opens the sign-in at once (later: codex mcp login you)',
  'you.forTask': 'A task to give it',
  'you.task': 'Use You.com to research <topic>: keep the source link beside every fact, then write the findings into the node “<node>” with the AwwO canvas tools.',
  'you.caution': 'Every call on a full line is billed to your You.com account, and Codex may make them without asking (You.com marks its tools read-only), so set a spending limit at You.com first. Send You.com public things only: never a private link or a page behind a sign-in.',
  'you.site': 'Open you.com',
  'you.siteLabel': 'Open you.com (a third-party site) in a new tab',
  // 分享 / Share: people join the canvas's workspace (ShareDialog.tsx).
  'share.button': 'Share',
  'share.buttonLabel': 'Share this canvas',
  'share.title': 'Share this canvas',
  'share.close': 'Close Share',
  'share.joins': 'People you invite join the workspace “{workspace}”: they can open all of its canvases, and its memory, knowledge, skills and conversations. Those who can edit can also change its Agents.',
  'share.pays': 'When someone who can edit runs an Agent, the workspace owner’s plan pays, as it does for everyone in the workspace.',
  'share.invite': 'Invite people',
  'share.email': 'Email (optional)',
  'share.emailHint': 'With an email, only the account signed in with that email can use the link. Without one, whoever opens it and confirms first joins.',
  'share.emailMember': '{name} is already in this workspace: change their access below.',
  'share.access': 'Access',
  'share.role.reader': 'Can view',
  'share.role.member': 'Can edit',
  'share.role.admin': 'Admin',
  'share.role.owner': 'Owner',
  'share.expires': 'Link expires after',
  'share.daysOne': '1 day',
  'share.daysMany': '{days} days',
  'share.create': 'Create invitation link',
  'share.creating': 'Creating…',
  'share.createFailed': 'Couldn’t create the link: {detail}',
  'share.linkFor': 'Only for {email}, until {date}. It works once.',
  'share.linkAnyone': 'For whoever opens it and confirms first, until {date}. It works once.',
  'share.linkSend': 'Send it to them: once they accept it, this canvas opens for them.',
  'share.linkLabel': 'Invitation link',
  'share.pending': 'Waiting to be accepted · {count}',
  'share.inviteAnyone': 'Anyone with the link',
  'share.inviteMeta': '{access} · expires {date}',
  'share.inviteHere': 'opens this canvas',
  'share.inviteThere': 'opens “{canvas}”',
  'share.revoke': 'Revoke',
  'share.revokeLabel': 'Revoke the invitation for {who}',
  'share.revoking': 'Revoking…',
  'share.revokeFailed': 'Couldn’t revoke: {detail}',
  'share.whoInvites': 'Only the workspace’s owner and admins invite people: {names}.',
  'share.whoInvitesBare': 'Only the workspace’s owner and admins invite people.',
  'share.people': 'People in “{workspace}” · {count}',
  'share.morePeople': 'and more in Settings → Members and workspaces',
  'share.loading': 'Loading…',
  'share.loadFailed': 'Couldn’t load: {detail}',
  'share.here': 'Here now',
  'share.roleFor': 'Access for {name}',
  'share.changeFailed': 'Couldn’t change the access: {detail}',
  'share.remove': 'Remove',
  'share.removeLabel': 'Remove {name} from the workspace',
  'share.removeConfirm': 'Remove {name} from “{workspace}”? They can no longer open any of its canvases.',
  'share.removing': 'Removing…',
  'share.removeFailed': 'Couldn’t remove {name}: {detail}',
  'share.cancel': 'Cancel',
  'share.canvasLink': 'Link to this canvas',
  'share.canvasLinkHint': 'People in the workspace open this canvas with it.',
  'share.advanced': 'Advanced: connect an Agent or a program (MCP / API)',
  'share.advancedMembers': 'Only the workspace’s owner and admins connect Agents and programs to its canvases.',
  // The live lane: what a person's pages run in, following them, viewers and editing marks.
  'device.browser': 'Browser',
  'device.mac': 'Mac',
  'device.windows': 'Windows',
  'device.phone': 'Phone',
  'device.tablet': 'Tablet',
  'devices.join': ', ',
  'avatar.person': '{name} · {devices}',
  'avatar.personViewer': '{name} · {devices} · can view',
  'viewer.mark': 'Can view',
  'follow.start': 'Follow {name}',
  'follow.chip': 'Following {name}',
  'follow.stop': 'Stop following (Esc)',
  'editing.board': '{name} · editing',
  'editing.field': '{name} is typing here',
  'editing.inspector': '{name} is editing this component',
} as const;

export type MultiplayerTextKey = keyof typeof EN;
export type MultiplayerTextValues = Record<string, string | number>;

const ZH: Record<MultiplayerTextKey, string> = {
  'mode.name': '多人同屏',
  'panel.title': '同屏',
  'panel.close': '关闭同屏',
  'panel.count': '{count} 人在线',
  'bar.live': '同屏 · {count} 人在线',
  'bar.connecting': '同屏 · 正在连接',
  'bar.offline': '同屏 · 未连接',
  'bar.more': '还有 {count} 位在线',
  'more.count': '+{count}',
  'status.live': '已连接：每处改动约一秒内到达同屏的每个人',
  'status.connecting': '正在连接…',
  'status.offline': '未连接：连接恢复后会收到别人的改动',
  'self.name': '{name}（你）',
  'someone': '有人',
  'kind.human': '人',
  'kind.agent': 'Agent',
  'kind.awwo': 'AwwO Agent',
  'port.web': '网页',
  'port.mcp': 'MCP',
  'port.api': 'API',
  'port.awwo': 'AwwO',
  'role.reader': '只读',
  'avatar.title': '{name} · {port}',
  'avatar.titleStatus': '{name} · {port} · {status}',
  'node.untitled': '未命名节点',
  'node.missing': '已删除的节点',
  'node.show': '在画布上找到「{node}」',
  'awwo.queued': '排队中',
  'awwo.running': '运行中',
  'awwo.withModel': '{state} · {model}',
  'error.retry': '请重试',
  'error.network': '连不上 AwwO，请检查网络后重试。',
  'error.request': '请求没有完成（{status}），请重试。',
  'error.agentTokenLimit': '一张画布最多同时有 10 个有效的 Agent 令牌，请先撤销一个。',
  'error.tooManyStreams': '这张画布上打开的连接太多，请稍后再试。',
  'section.people': '人 · {count}',
  'section.agents': 'Agent · {count}',
  'section.awwo': 'AwwO 运行中的 Agent · {count}',
  'participants.alone': '现在只有你在这张画布上。可以在下面邀请一个 Agent 一起改。',
  'participants.aloneBare': '现在只有你在这张画布上。',
  'participants.aloneShare': '现在只有你在这张画布上。分享给同事，一起编辑。',
  'participant.selected': '选中了',
  'participant.viewing': '正在看',
  'participant.working': '正在处理',
  'section.claims': '已认领的节点 · {count}',
  'claims.empty': '还没有节点被认领。Agent 开始处理一个节点前会先认领它。',
  'claim.left': '还剩 {time}',
  'claim.ending': '即将到期',
  'claim.release': '释放',
  'claim.releaseLabel': '释放「{node}」',
  'claim.releaseAll': '释放我认领的全部',
  'claim.releasing': '正在释放…',
  'claim.releaseFailed': '没能释放：{detail}',
  'time.minutes': '{m} 分 {s} 秒',
  'time.seconds': '{s} 秒',
  'section.messages': '留言',
  'messages.empty': '还没有留言。',
  'messages.readOnly': '你是只读成员，可以看留言，不能发送。',
  'messages.box': '给同屏的人和 Agent 留言',
  'messages.placeholder': '写给同屏的每个人。Enter 发送，Shift+Enter 换行。',
  'messages.send': '发送',
  'messages.sending': '正在发送…',
  'messages.failed': '没能发送：{detail}',
  'messages.about': '关于「{node}」',
  'messages.detach': '不关联「{node}」',
  'messages.count': '{count}/{max}',
  'section.activity': '最近的改动',
  'activity.empty': '还没有改动。',
  'act.one': '{who} {a}',
  'act.two': '{who} {a}，{b}',
  'act.moreOne': '{who} {a}，{b}，另有 1 处改动',
  'act.more': '{who} {a}，{b}，另有 {count} 处改动',
  'act.addedOne': '添加了节点「{node}」',
  'act.addedMany': '添加了 {count} 个节点',
  'act.removedOne': '删除了节点「{node}」',
  'act.removedSome': '删除了 1 个节点',
  'act.removedMany': '删除了 {count} 个节点',
  'act.resultOne': '把结果写进了「{node}」',
  'act.resultMany': '把结果写进了 {count} 个节点',
  'act.renamedOne': '把节点改名为「{node}」',
  'act.renamedMany': '改了 {count} 个节点的名称',
  'act.settingsOne': '修改了「{node}」的设置',
  'act.settingsMany': '修改了 {count} 个节点的设置',
  'act.contractOne': '更新了「{node}」的输入和输出',
  'act.contractMany': '更新了 {count} 个节点的输入和输出',
  'act.formOne': '修改了表单「{node}」',
  'act.formMany': '修改了 {count} 个表单',
  'act.threadOne': '修改了「{node}」的对话',
  'act.threadMany': '修改了 {count} 个节点的对话',
  'act.connectedOne': '连接了「{from}」→「{to}」',
  'act.connectedMany': '添加了 {count} 条连线',
  'act.disconnectedOne': '删除了 1 条连线',
  'act.disconnectedMany': '删除了 {count} 条连线',
  'act.resizedOne': '调整了「{node}」的大小',
  'act.resizedMany': '调整了 {count} 个节点的大小',
  'act.movedOne': '移动了「{node}」',
  'act.movedMany': '移动了 {count} 个节点',
  'act.displays': '修改了预览展示',
  'act.waypoints': '修改了保存的视点',
  'act.canvas': '修改了画布设置',
  'act.order': '调整了画布上的顺序',
  'act.generic': '修改了画布',
  'board.claim': '{name} 正在处理',
  'invite.toggle': '邀请 Agent',
  'invite.intro': '有了令牌，Claude Code、Codex、Cursor 这类 Agent 可以通过 MCP 进入这张画布，任何程序也可以通过 API 进入。它只能进这一张画布，能做的从不超过你在这里能做的，也不会运行节点或花费额度。',
  'invite.name': 'Agent 名称',
  'invite.nameHint': '同屏的人会看到它用这个名字。',
  'invite.days': '有效期',
  'invite.daysOne': '1 天',
  'invite.daysMany': '{days} 天',
  'invite.scope': '权限',
  'invite.scopeEdit': '编辑',
  'invite.scopeRead': '只读',
  'invite.scopeEditHint': '可以添加、修改、连接和删除节点。',
  'invite.scopeReadHint': '只看画布、也被大家看到，不做任何改动。',
  'invite.create': '生成令牌',
  'invite.creating': '正在生成…',
  'invite.failed': '没能生成令牌：{detail}',
  'invite.secretTitle': '「{name}」的令牌',
  'invite.secretOnce': '令牌只显示这一次，关掉后谁也看不到。请像密码一样保管，不要贴进聊天或代码仓库。',
  'invite.tokenLabel': '令牌',
  'invite.copy': '复制',
  'invite.copyLabel': '复制：{what}',
  'invite.copied': '已复制',
  'invite.copyFailed': '没能复制，请手动选中后复制。',
  'invite.forClaude': 'Claude Code',
  'invite.forClaudeUnattended': 'Claude Code · 无人值守（claude -p）',
  'invite.forCodex': 'Codex · ~/.codex/config.toml',
  'invite.forCodexEnv': '再在启动 Codex 的终端里设置令牌：',
  'invite.forCodexUnattended': 'Codex · 无人值守（codex exec）',
  'invite.unattendedHint': '把 <task> 换成要 Agent 做的事；claude -p 要在运行过 claude mcp add 的文件夹里启动。这两条无人值守命令不经询问就使用这张画布的全部工具，包括删除节点，也会照画布上别人写的内容去做，所以请在没有私密文件的文件夹里运行。交互使用时，Claude Code 用画布工具前仍会先问你，Codex 则在可能弄丢别人工作的工具前问你（改动或删除节点、拆掉连线、原始操作）。随时可以在下面撤销令牌。',
  'invite.unattendedHintRead': '把 <task> 换成要 Agent 做的事；claude -p 要在运行过 claude mcp add 的文件夹里启动。这两条无人值守命令不经询问就使用这张画布的工具；这个令牌只读，它们只能看，改不了任何东西。随时可以在下面撤销令牌。',
  'invite.forCursor': 'Cursor · .cursor/mcp.json',
  'invite.forHttp': 'HTTP',
  'invite.done': '已保存，关闭',
  'invite.list': '这张画布的令牌',
  'invite.listEmpty': '还没有令牌。',
  'invite.loading': '正在读取令牌…',
  'invite.loadFailed': '没能读取令牌：{detail}',
  'invite.madeBy': '{name} 创建',
  'invite.expires': '{date} 到期',
  'invite.expired': '{date} 已过期',
  'invite.lastUsed': '上次使用 {date}',
  'invite.neverUsed': '从未使用',
  'invite.revoked': '{date} 已撤销',
  'invite.revoke': '撤销',
  'invite.revokeLabel': '撤销令牌「{name}」',
  'invite.revokeConfirm': '撤销「{name}」？正在用它的 Agent 会立刻断开，令牌从此失效。',
  'invite.revoking': '正在撤销…',
  'invite.revokeFailed': '没能撤销：{detail}',
  'invite.cancel': '取消',
  'treg.toggle': '加上 treg：让 Agent 查实时数据',
  'treg.intro': 'treg（treg.to，Superdesign 出品的第三方工具目录）能让你接进来的 Claude Code、Codex 或 Cursor 联网搜索、读网页，查关键词与外链、社媒趋势、公司与市场数据，再把查到的写进这张画布。AwwO 自己的 Agent 不联网，实时资料交给你自己的 Agent。',
  'treg.billing': 'treg 按次计费，记在你自己的 treg 团队账户上，调用前会先给出价格。AwwO 不收这笔钱，也不经手、不保存你的 treg 登录。发给 treg 的内容会离开 AwwO。',
  'treg.stepsLabel': '怎么加上',
  'treg.step1': '先在 treg.to 注册并建一个团队：调用的费用由这个团队付。',
  'treg.step2': '用下面的一行命令把 treg 加进同一个 Agent，按提示登录。',
  'treg.step3': '让 Agent 用 treg 查资料，再用画布工具把结果写进节点。',
  'treg.forClaude': 'Claude Code · 加好后输入 /mcp，选 treg 登录',
  'treg.forCodex': 'Codex · 会马上打开浏览器登录（以后可用 codex mcp login treg）',
  'treg.forCursor': 'Cursor · 加进 .cursor/mcp.json 的 mcpServers 里，和 awwo-canvas 并列',
  'treg.forTask': '可以这样交代',
  'treg.task': '用 treg 查「<主题>」的最新资料，每条事实附上来源链接，再用 AwwO 画布工具写进「<节点>」。',
  'treg.caution': 'treg 的付费调用不会在无人值守时自己发生：Codex 调用前会先问你，无人值守命令（claude -p、codex exec）也批不了，除非你自己放开，放开前请先在 treg 里设好花费上限。Codex 仍可能自己查 treg 的免费目录，查的内容会发给 treg。只把公开内容交给 treg：不要发私密链接或需要登录的页面。',
  'treg.site': '打开 treg.to',
  'treg.siteLabel': '在新标签页打开 treg.to（第三方网站）',
  'you.toggle': '加上 You.com：让 Agent 联网搜索',
  'you.intro': 'You.com（you.com，第三方搜索 API）能让你接进来的 Claude Code、Codex 或 Cursor 联网搜索；用完整版的那几行，还能读搜到的网页，再把查到的写进这张画布。',
  'you.free': '免注册的几行不用账户：每天 100 次搜索，只能搜索（不能读全文）。',
  'you.billing': '完整版要登录你自己的 You.com 账户，每次调用都记在这个账户上。AwwO 不收这笔钱，也不经手、不保存你的 You.com 登录。发给 You.com 的内容会离开 AwwO。',
  'you.stepsLabel': '怎么加上',
  'you.step1': 'Claude Code 或 Cursor：把下面对应的免注册一行加进同一个 Agent，不用账户，马上能用。',
  'you.step2': '要读全文，或者用的是 Codex（它连免费版也要登录），改用完整版那一行，按提示登录 You.com。',
  'you.step3': '让 Agent 用 You.com 查资料，再用画布工具把结果写进节点。',
  'you.forClaudeFree': 'Claude Code · 免注册',
  'you.forCursorFree': 'Cursor · 免注册，加进 .cursor/mcp.json 的 mcpServers 里，和 awwo-canvas 并列',
  'you.forClaude': 'Claude Code · 完整版，加好后输入 /mcp，选 you 登录',
  'you.forCodex': 'Codex · 完整版，会马上打开浏览器登录（以后可用 codex mcp login you）',
  'you.forTask': '可以这样交代',
  'you.task': '用 You.com 查「<主题>」的最新资料，每条事实附上来源链接，再用 AwwO 画布工具写进「<节点>」。',
  'you.caution': '完整版的每次调用都记到你的 You.com 账户上，Codex 可能不问你就调用（You.com 把它的工具标为只读），所以先在 You.com 设好花费上限。只把公开内容交给 You.com：不要发私密链接或需要登录的页面。',
  'you.site': '打开 you.com',
  'you.siteLabel': '在新标签页打开 you.com（第三方网站）',
  'share.button': '分享',
  'share.buttonLabel': '分享这张画布',
  'share.title': '分享画布',
  'share.close': '关闭分享',
  'share.joins': '受邀的人会加入工作区「{workspace}」：能打开其中所有画布，以及它的记忆、知识、技能和对话；可编辑的人还能改动其中的 Agent。',
  'share.pays': '可编辑的人运行 Agent 时，费用记在工作区所有者的套餐上，和工作区里的每个人一样。',
  'share.invite': '邀请成员',
  'share.email': '邮箱（可选）',
  'share.emailHint': '填了邮箱，只有用这个邮箱登录的账号能用这个链接；不填，第一个打开链接并确认的人加入。',
  'share.emailMember': '{name} 已经在这个工作区里：在下面调整权限即可。',
  'share.access': '权限',
  'share.role.reader': '可查看',
  'share.role.member': '可编辑',
  'share.role.admin': '管理员',
  'share.role.owner': '所有者',
  'share.expires': '链接有效期',
  'share.daysOne': '1 天',
  'share.daysMany': '{days} 天',
  'share.create': '生成邀请链接',
  'share.creating': '正在生成…',
  'share.createFailed': '没能生成链接：{detail}',
  'share.linkFor': '只给 {email} 用，{date} 前有效，用一次就失效。',
  'share.linkAnyone': '第一个打开并确认的人加入，{date} 前有效，用一次就失效。',
  'share.linkSend': '把链接发给对方：对方接受邀请后，会直接打开这张画布。',
  'share.linkLabel': '邀请链接',
  'share.pending': '等待接受的邀请 · {count}',
  'share.inviteAnyone': '任何拿到链接的人',
  'share.inviteMeta': '{access} · {date} 到期',
  'share.inviteHere': '打开这张画布',
  'share.inviteThere': '打开「{canvas}」',
  'share.revoke': '撤销',
  'share.revokeLabel': '撤销给 {who} 的邀请',
  'share.revoking': '正在撤销…',
  'share.revokeFailed': '没能撤销：{detail}',
  'share.whoInvites': '只有工作区的所有者和管理员能邀请人：{names}。',
  'share.whoInvitesBare': '只有工作区的所有者和管理员能邀请人。',
  'share.people': '工作区「{workspace}」里的人 · {count}',
  'share.morePeople': '更多成员在 设置 → 成员与工作区',
  'share.loading': '正在读取…',
  'share.loadFailed': '没能读取：{detail}',
  'share.here': '正在这张画布上',
  'share.roleFor': '{name} 的权限',
  'share.changeFailed': '没能修改权限：{detail}',
  'share.remove': '移除',
  'share.removeLabel': '把 {name} 移出工作区',
  'share.removeConfirm': '把 {name} 移出工作区「{workspace}」？之后对方打不开其中任何画布。',
  'share.removing': '正在移除…',
  'share.removeFailed': '没能移除 {name}：{detail}',
  'share.cancel': '取消',
  'share.canvasLink': '这张画布的链接',
  'share.canvasLinkHint': '工作区里的人用这个链接直接打开这张画布。',
  'share.advanced': '高级：连接 Agent 或程序（MCP / API）',
  'share.advancedMembers': '只有工作区的所有者和管理员能把 Agent 或程序接进它的画布。',
  'device.browser': '浏览器',
  'device.mac': 'Mac',
  'device.windows': 'Windows',
  'device.phone': '手机',
  'device.tablet': '平板',
  'devices.join': '、',
  'avatar.person': '{name} · {devices}',
  'avatar.personViewer': '{name} · {devices} · 可查看',
  'viewer.mark': '可查看',
  'follow.start': '跟随 {name}',
  'follow.chip': '正在跟随 {name}',
  'follow.stop': '停止跟随（Esc）',
  'editing.board': '{name} 正在编辑',
  'editing.field': '{name} 正在这里输入',
  'editing.inspector': '{name} 正在编辑这个组件',
};

/** Both tables, for the parity check (tests/saas-multiplayer-ui.test.tsx). */
export const MULTIPLAYER_TEXT: Readonly<Record<UiLocale, Readonly<Record<MultiplayerTextKey, string>>>> = { en: EN, zh: ZH };

/** One string of the mode, with each {name} replaced by its value; a name with no value stays as written. */
export function mt(locale: UiLocale, key: MultiplayerTextKey, values: MultiplayerTextValues = {}): string {
  return MULTIPLAYER_TEXT[locale][key].replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token);
}

export type MultiplayerTranslate = (key: MultiplayerTextKey, values?: MultiplayerTextValues) => string;

/** The mode's words in the canvas's language (the canvas's LocaleProvider). */
export function useMultiplayerText(): { locale: UiLocale; t: MultiplayerTranslate } {
  const { locale } = useCanvasI18n();
  return useMemo(() => ({ locale, t: (key: MultiplayerTextKey, values?: MultiplayerTextValues) => mt(locale, key, values) }), [locale]);
}

export type LivePort = 'web' | 'mcp' | 'api' | 'awwo';
export type LiveKind = 'human' | 'agent' | 'awwo';

const PORT_KEYS: Record<LivePort, MultiplayerTextKey> = { web: 'port.web', mcp: 'port.mcp', api: 'port.api', awwo: 'port.awwo' };
const KIND_KEYS: Record<LiveKind, MultiplayerTextKey> = { human: 'kind.human', agent: 'kind.agent', awwo: 'kind.awwo' };

/** A port's name: 网页 / Web, MCP, API, AwwO; an unknown one as the server wrote it. */
export function portLabel(locale: UiLocale, port: string): string {
  return Object.hasOwn(PORT_KEYS, port) ? mt(locale, PORT_KEYS[port as LivePort]) : port;
}

export function kindLabel(locale: UiLocale, kind: string): string {
  return Object.hasOwn(KIND_KEYS, kind) ? mt(locale, KIND_KEYS[kind as LiveKind]) : kind;
}

const DEVICE_KEYS: Record<LiveDevice, MultiplayerTextKey> = { browser: 'device.browser', mac: 'device.mac', windows: 'device.windows', phone: 'device.phone', tablet: 'device.tablet' };

/** A person's devices in one phrase: 浏览器、手机 / Browser, Phone. None: a browser. */
export function devicesLabel(locale: UiLocale, devices: readonly LiveDevice[]): string {
  const named = devices.filter(device => Object.hasOwn(DEVICE_KEYS, device)).map(device => mt(locale, DEVICE_KEYS[device]));
  return named.length ? named.join(mt(locale, 'devices.join')) : mt(locale, 'device.browser');
}

/** At most this many characters of a node's title go into one line; the rest is an ellipsis. */
const TITLE_CLIP = 40;

/** A node's title as a line shows it: a missing node and an untitled one are named, a long title is cut. */
export function shownTitle(locale: UiLocale, title: string | undefined): string {
  if (title === undefined) return mt(locale, 'node.missing');
  const trimmed = title.trim();
  if (!trimmed) return mt(locale, 'node.untitled');
  const chars = Array.from(trimmed);
  return chars.length > TITLE_CLIP ? `${chars.slice(0, TITLE_CLIP - 1).join('')}…` : trimmed;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** What an avatar shows: the first letters of a name's first two words (CC for Claude Code), the first character of a
 *  CJK name (张 for 张三), '?' for no name. */
export function participantInitials(name: string): string {
  const words = name.trim().split(/[\s._·-]+/u).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0];
  if (CJK.test(first) || words.length < 2) return first.toUpperCase();
  return `${first}${Array.from(words[1])[0]}`.toUpperCase();
}

/** How long a claim still holds: 2 min 05 s, 45 s; at or under zero it is ending. */
export function timeLeft(locale: UiLocale, ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return mt(locale, 'claim.ending');
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const time = minutes > 0
    ? mt(locale, 'time.minutes', { m: minutes, s: String(seconds).padStart(2, '0') })
    : mt(locale, 'time.seconds', { s: seconds });
  return mt(locale, 'claim.left', { time });
}

function parsed(iso: string): Date | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : new Date(at);
}

/** A message's time of day (14:05); '' for a time that does not parse. */
export function clockTime(locale: UiLocale, iso: string): string {
  const at = parsed(iso);
  return at ? new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }).format(at) : '';
}

/** A token's dates: the day and time (Nov 6, 14:05 / 11月6日 14:05); '' for a time that does not parse. */
export function shortDate(locale: UiLocale, iso: string): string {
  const at = parsed(iso);
  return at ? new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at) : '';
}

/** The mode's own refusals (canvas_agent_tokens.go, canvas_live.go), by their code. */
const MULTIPLAYER_CODES: Readonly<Record<string, MultiplayerTextKey>> = {
  agent_token_limit: 'error.agentTokenLimit',
  too_many_streams: 'error.tooManyStreams',
};

/** What went wrong, for the line that says so, in the reader's language: the mode's own refusals by their code, the
 *  service's other codes as the app says them (saasErrorMessage, which keeps the service's own words only for a code
 *  it does not know), a request that never reached AwwO as that. A caller's own words (a string) are shown as they
 *  are; an error that is neither the service's answer nor fetch's is not worded for people, so it reads "try again". */
export function failureDetail(locale: UiLocale, error: unknown): string {
  if (error instanceof SaaSApiError) {
    if (Object.hasOwn(MULTIPLAYER_CODES, error.code)) return mt(locale, MULTIPLAYER_CODES[error.code]);
    // api()'s name for an answer that carried no refusal of the service's (an edge's 502, say); its words are Chinese only.
    if (error.code === 'request_failed') return error.status > 0 ? mt(locale, 'error.request', { status: error.status }) : mt(locale, 'error.network');
    return saasErrorMessage(error, locale).trim() || mt(locale, 'error.retry');
  }
  // fetch rejects with a TypeError when the request never got an answer.
  if (error instanceof TypeError) return mt(locale, 'error.network');
  if (typeof error === 'string' && error.trim()) return error.trim();
  return mt(locale, 'error.retry');
}

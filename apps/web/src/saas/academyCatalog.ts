/** The AwwO Academy (Academy.tsx): the tutorial videos, each recorded on the live AwwO. Six short how-tos to start with
 * (Chinese narration), then a walk through each flagship case and a build of each other homepage case (English narration);
 * every video has Chinese and English subtitles burned in. The files are too large for a release: each is staged once on
 * the host, outside every release, under /showcase/staged/academy/<first 16 hex digits of its sha256>.mp4, and the dev
 * server serves them from AWWO_STAGED_SHOWCASE (docs/academy.md). */
import type { UiLocale } from '../locale';

export type AcademySection = 'start' | 'flagship' | 'build';
export const ACADEMY_SECTIONS: ReadonlyArray<AcademySection> = ['start', 'flagship', 'build'];

/** Something the live AwwO now does differently from what a span of a video shows, until that span is recorded again. */
export interface AcademyNote {
  /** Where the span starts, in whole seconds of the video: the note plays it from there. */
  at: number;
  /** The day the live AwwO changed. */
  since: string;
  text: Readonly<Record<UiLocale, string>>;
}

export interface AcademyVideo {
  /** Its address: ?academy=<id>. A case's videos take the case's id. */
  id: string;
  section: AcademySection;
  /** The homepage case it walks through (productionCatalog.ts). */
  caseId?: string;
  /** The narration's language. */
  voice: UiLocale;
  /** The day it was recorded on the live AwwO. */
  recordedOn: string;
  title: Readonly<Record<UiLocale, string>>;
  summary: Readonly<Record<UiLocale, string>>;
  seconds: number;
  src: string;
  bytes: number;
  sha256: string;
  /** Its own poster; a case's video has its case's cover (`/showcase/<footage>.jpg`) instead. */
  poster: string | null;
  /** What has changed since it was recorded, in the video's order (docs/academy.md). */
  notes?: ReadonlyArray<AcademyNote>;
  /** How the video was updated after it was first published, newest first: recorded again, whole or a span of it. */
  changes?: ReadonlyArray<AcademyChange>;
}

/** One update of a published video: the day it was published again, and what changed in it. */
export interface AcademyChange {
  on: string;
  text: Readonly<Record<UiLocale, string>>;
}

/** A how-to's assistant reply or empty canvas, recorded with the links that switched between a direct task and a plan
 *  for the canvas, which went on 2026-10-19; a correction in words hands a request over the other way. */
const switchLinksNote = (at: number): AcademyNote => ({ at, since: '2026-10-19', text: {
  en: 'The links shown here to switch between doing a task directly and adjusting the canvas are gone: the canvas assistant decides by itself, and you can tell it otherwise in words, such as “don’t change the canvas, just write it” or “put it on the canvas instead”.',
  zh: '视频里在「直接执行」和「调整画布」之间切换的链接已经移除：画布助手会自己判断；想换一种方式，直接用文字告诉它，比如「别改画布，直接帮我写」或「还是放到画布上吧」。' } });

export const ACADEMY_VIDEOS: ReadonlyArray<AcademyVideo> = [
  { id: 'start-code', section: 'start', voice: 'zh', recordedOn: '2026-10-17',
    title: { en: 'Code: one sentence, and it’s written', zh: '写代码：一句话，直接写好' },
    summary: { en: 'What one call is, then one sentence: the canvas assistant writes a working Python sales-report tool itself. Preview the report, say “continue” and check the usage.',
      zh: '先讲清「1 次」是什么，再用一句话让画布助手直接写出能用的 Python 销售报告工具：预览报告，说「继续」接着改，再看用量。' },
    seconds: 154, src: '/showcase/staged/academy/07803132ff5c7f16.mp4', bytes: 17416804, sha256: '07803132ff5c7f1654e97708692921dbb5fb8d16ae3f08c04c9499c74c784891',
    poster: '/showcase/academy/start-code-2.jpg', notes: [
      switchLinksNote(56),
      // The recap's 「平台原因失败会退还」: since 2026-10-19 a platform time limit gives back only the call it cut.
      { at: 152, since: '2026-10-19', text: {
        en: 'A call a platform time limit cut short now gives back that one call, not every call of its task; other platform failures still give back all of them, up to 32 a day.',
        zh: '被平台时限中断的调用，现在只退还这一次，而不是整个任务的次数；其他平台原因的失败仍会全部退还，每天最多 32 次。' } },
    ] },
  { id: 'start-image', section: 'start', voice: 'zh', recordedOn: '2026-10-17',
    title: { en: 'Image: an event poster', zh: '生图：做一张活动海报' },
    summary: { en: 'One sentence for a café’s autumn poster: the assistant sets up a copy node and an image node on the canvas, you run the canvas and find the poster in Results.',
      zh: '一句话做咖啡店的秋季海报：助手在画布上搭好文案和图像两个节点，运行整张画布，在成果里看海报。' },
    seconds: 106, src: '/showcase/staged/academy/87ad377098a1ce0b.mp4', bytes: 12757417, sha256: '87ad377098a1ce0b5471bb4ae7b8c38f3affc974de8ba366f691a2f7313603be',
    poster: '/showcase/academy/start-image-2.jpg', notes: [switchLinksNote(42)] },
  { id: 'start-web', section: 'start', voice: 'zh', recordedOn: '2026-10-17',
    title: { en: 'Web design: a complete website', zh: '网页设计：做一个完整官网' },
    summary: { en: 'Switch to Claude Opus 5.5 and ask for a pottery studio’s one-page site: about three minutes later, preview it full screen and check the usage.',
      zh: '换成 Claude Opus 5.5，一句话做陶艺工作室的单页官网：约三分钟后全屏预览，再看用量。' },
    seconds: 104, src: '/showcase/staged/academy/8bca3281173a3123.mp4', bytes: 17859188, sha256: '8bca3281173a3123887af7e09a2778ca80c743a4cd25a348e295ba832659bc83',
    poster: '/showcase/academy/start-web-2.jpg', notes: [switchLinksNote(37)] },
  { id: 'start-plan', section: 'start', voice: 'zh', recordedOn: '2026-10-17',
    title: { en: 'Product plan: let a team write it', zh: '产品方案：让团队分工来写' },
    summary: { en: 'Name a team of three, a user researcher, a product manager and a writer, and run the canvas: the whole plan arrives as one document in Results. Setting up a canvas uses no calls.',
      zh: '点名用户研究、产品经理、方案撰写三人团队，运行画布，在成果里拿到一份完整的产品方案文档；搭画布不占次数。' },
    seconds: 118, src: '/showcase/staged/academy/5d1faa082c4ec4cd.mp4', bytes: 17816781, sha256: '5d1faa082c4ec4cd5120edb1d102a9becb1a8017017ce86030eb2bebd37b890a',
    poster: '/showcase/academy/start-plan-2.jpg', notes: [switchLinksNote(39)] },
  { id: 'start-node', section: 'start', voice: 'zh', recordedOn: '2026-10-25',
    title: { en: 'Inside a node: what it was asked, and how to change it', zh: '看懂节点：它被要求做什么，怎么改' },
    summary: { en: 'Open a node of a three-node team: its Task names the model, the job, its criteria and constraints. Change with the assistant writes your change into them, and the nodes left run again.',
      zh: '打开三人小团队里的一个节点：「任务」写着模型、要做的事、验收标准和约束。点「让助手修改」说出要改什么，助手把它写进去，再运行剩下的节点。' },
    seconds: 123, src: '/showcase/staged/academy/a2bc503c752f381b.mp4', bytes: 21377874, sha256: 'a2bc503c752f381b0d9d4138e234be9aad484457b2d72d61af64f1da99b6ae85',
    poster: '/showcase/academy/start-node-1.jpg' },
  { id: 'start-settings', section: 'start', voice: 'zh', recordedOn: '2026-10-25',
    title: { en: 'Settings: everything for your account in one place', zh: '设置中心：账号的设置都在这里' },
    summary: { en: 'More options, then Settings: one page, grouped on the left. The language and the mode stay in this browser; the default model and task alerts follow your account. Export your data before you ask to delete your account.',
      zh: '更多选项里的「设置」：一个页面，左边分好了组。语言和使用模式只在这个浏览器，默认模型和任务提醒跟着账号走；申请删除账号前，先导出数据。' },
    seconds: 149, src: '/showcase/staged/academy/37521d1747351aec.mp4', bytes: 15766545, sha256: '37521d1747351aec59623a768bfed962add63e9caaf75dc9dfe2e08677f4f6d5',
    poster: '/showcase/academy/start-settings-1.jpg' },
  { id: 'pallward', section: 'flagship', caseId: 'pallward', voice: 'en', recordedOn: '2026-10-24',
    title: { en: 'PALLWARD: a dark-fantasy game built by twenty-six agents', zh: 'PALLWARD：二十六个 Agent 做出的黑暗奇幻动作游戏' },
    summary: { en: 'Open the case, play the game right in How it was made, see what the twenty agents in sandbox computers wrote, and copy the canvas as a draft.',
      zh: '打开案例，在「How it was made」里直接玩游戏，看二十个在沙箱电脑里写代码的 Agent 各交了什么，再把画布复制成草稿。' },
    seconds: 409, src: '/showcase/staged/academy/405974c9de49a763.mp4', bytes: 98519739, sha256: '405974c9de49a763b7790d99a415efc67452c66074559df8e7c3c70065025c54',
    poster: null,
    changes: [{ on: '2026-10-24', text: {
      en: 'Recorded again on the live AwwO. A fresh copy’s Next card now counts the 48 nodes its first run still makes, 43 of them media nodes.',
      zh: '在线上 AwwO 重新录制：新副本的「接下来」卡片会提示首次运行还要生成的 48 个节点，其中 43 个是媒体节点。' } }] },
  { id: 'the-long-chord', section: 'flagship', caseId: 'the-long-chord', voice: 'en', recordedOn: '2026-10-24',
    title: { en: 'THE LONG CHORD: a space opera made on one canvas', zh: 'THE LONG CHORD：一张画布做出的太空歌剧电影' },
    summary: { en: 'Watch the film in the case, see how its lip sync was measured and its reels were cut, then copy its canvas as a draft.',
      zh: '在案例里看影片，看口型同步怎么测、片子一卷卷怎么剪，再把画布复制成草稿。' },
    seconds: 438, src: '/showcase/staged/academy/efc0ebb313f19c39.mp4', bytes: 90055554, sha256: 'efc0ebb313f19c3928d99a6ff32fc8243f5fd5e9044b35a3ced3dde3dc589f09',
    poster: null,
    // What a copy makes and costs is now in the narration: the case canvas's 282 media nodes at their own settings,
    // priced by mediaCreditsFor (plans.go), 64,460 credits; Max grants 10,000 a month and makes 100 generations a day.
    changes: [{ on: '2026-10-24', text: {
      en: 'Recorded again on the live AwwO, on the whole of Episode I: its 298 nodes in six stages, 93 runs, six editors and ten edits, three acts on one canvas, and what a copy makes again and costs.',
      zh: '在线上 AwwO 重新录制，讲的是完整的第一集：298 个节点、六个阶段、93 次运行、六个剪辑智能体和十个剪辑节点、一张画布上的三幕，以及副本要重新生成什么、要花多少。' } }] },
  { id: 'umber-photo', section: 'flagship', caseId: 'umber-photo', voice: 'en', recordedOn: '2026-10-24',
    title: { en: 'Umber: a photo editor built by twelve agents', zh: 'Umber：十二个 Agent 做出的网页图片编辑器' },
    summary: { en: 'A layered photo editor in one web page: how its twelve agents wrote it in a clean room, how to copy its canvas, and the editor at work in Results.',
      zh: '一个网页里的分层图片编辑器：十二个 Agent 怎么在净室里写出它，怎么复制这张画布，以及在成果里直接用它。' },
    seconds: 379, src: '/showcase/staged/academy/76c910325364cbf6.mp4', bytes: 61915580, sha256: '76c910325364cbf6b835da8340c27a76139ac77b4eefa45968318cef9fd59e41',
    poster: null,
    changes: [{ on: '2026-10-24', text: {
      en: 'Recorded again on the live AwwO. A fresh copy’s Next card now counts the one node its first run still makes, the assembly, and the narration says so.',
      zh: '在线上 AwwO 重新录制：新副本的「接下来」卡片会提示首次运行还要生成的 1 个节点（组装节点），讲解也随之更新。' } }] },
  { id: 'backprop-lab', section: 'flagship', caseId: 'backprop-lab', voice: 'en', recordedOn: '2026-10-24',
    title: { en: 'Backprop: a neural-network lab built by thirteen agents', zh: 'Backprop：十三个 Agent 做出的神经网络训练工作台' },
    summary: { en: 'Build and train small neural networks in the browser: how thirteen agents made the workbench, and a model trained in Results.',
      zh: '在浏览器里搭建并训练小型神经网络：十三个 Agent 怎么做出这个工作台，以及在成果里训练一个模型。' },
    seconds: 406, src: '/showcase/staged/academy/f6ef4c7f255120d3.mp4', bytes: 68372123, sha256: 'f6ef4c7f255120d3760f5b832633cdb0f216036abe52e50a05308355405924ca',
    poster: null,
    changes: [{ on: '2026-10-24', text: {
      en: 'Recorded again on the live AwwO. A fresh copy’s Next card now counts the one node its first run still makes, the assembly, and the narration says so.',
      zh: '在线上 AwwO 重新录制：新副本的「接下来」卡片会提示首次运行还要生成的 1 个节点（组装节点），讲解也随之更新。' } }] },
  { id: 'errand-agent', section: 'flagship', caseId: 'errand-agent', voice: 'en', recordedOn: '2026-10-24',
    title: { en: 'Errand: an agent workspace built by fifteen agents', zh: 'Errand：十五个 Agent 做出的智能体工作台' },
    summary: { en: 'Watch an AI agent work on its own computer, replayed from real sessions, in a page fifteen agents built, and see how the canvas ran.',
      zh: '在十五个 Agent 做出的页面里，回放 AI Agent 在自己电脑上干活的真实过程，再看这张画布是怎么跑的。' },
    seconds: 438, src: '/showcase/staged/academy/88dcf77b2ce61f57.mp4', bytes: 75691610, sha256: '88dcf77b2ce61f5731dad970d89f8ddbb70eff9f2407949eada0521789691c7a',
    poster: null,
    changes: [{ on: '2026-10-24', text: {
      en: 'Recorded again on the live AwwO. A fresh copy’s Next card now counts the two nodes its first run still makes, the session recorder and the assembly, and the narration says so.',
      zh: '在线上 AwwO 重新录制：新副本的「接下来」卡片会提示首次运行还要生成的 2 个节点（会话记录器和组装节点），讲解也随之更新。' } }] },
  { id: 'roost-team', section: 'flagship', caseId: 'roost-team', voice: 'en', recordedOn: '2026-10-24',
    title: { en: 'Roost: a home for a bot team built by seventeen agents', zh: 'Roost：十七个 Agent 做出的机器人团队之家' },
    summary: { en: 'AI bots sharing one computer and a group chat, replayed from a real team session: how seventeen agents built the page, step by step.',
      zh: '几个 AI 机器人共用一台电脑和一个群聊，回放一次真实的团队协作：十七个 Agent 怎么一步步做出这个页面。' },
    seconds: 445, src: '/showcase/staged/academy/f77fd2d913e61303.mp4', bytes: 80294458, sha256: 'f77fd2d913e61303ae73e3384f4fd6837c76a8aa21e55c48411eedd816a3f30a',
    poster: null,
    changes: [{ on: '2026-10-24', text: {
      en: 'Recorded again on the live AwwO. A fresh copy’s Next card now counts the six nodes its first run still makes, the turn recorder, the four turns and the assembly, and the narration says so.',
      zh: '在线上 AwwO 重新录制：新副本的「接下来」卡片会提示首次运行还要生成的 6 个节点（轮次记录器、四个轮次和组装节点），讲解也随之更新。' } }] },
  { id: 'neon-city', section: 'build', caseId: 'neon-city', voice: 'en', recordedOn: '2026-10-15',
    title: { en: 'Build a cinematic brand page with a team of agents', zh: '用 Agent 团队和媒体节点，做一个电影感品牌页' },
    summary: { en: 'A brand page, its pictures and its clip, by two agents and four media nodes.',
      zh: '一个品牌页连同它的图片和视频，由两个 Agent 和四个媒体节点做出。' },
    seconds: 412, src: '/showcase/staged/academy/6f7770790cc26f09.mp4', bytes: 93939073, sha256: '6f7770790cc26f09815bea650df26acbfd1debbbb63b0129c98dd0cfaa401dcd',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'shanhai-vn', section: 'build', caseId: 'shanhai-vn', voice: 'en', recordedOn: '2026-10-15',
    title: { en: 'Build a visual-novel chapter with a team of agents', zh: '用 Agent 团队和媒体节点，做一章视觉小说' },
    summary: { en: 'A visual-novel chapter, its pictures and its clip, by three agents and six media nodes.',
      zh: '一章视觉小说连同它的图片和视频，由三个 Agent 和六个媒体节点做出。' },
    seconds: 416, src: '/showcase/staged/academy/7723029eb63af64b.mp4', bytes: 95739472, sha256: '7723029eb63af64b97f557ebc6201131feccec3703f6475d511038ec68b3036a',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'aurora-gt', section: 'build', caseId: 'aurora-gt', voice: 'en', recordedOn: '2026-10-15',
    title: { en: 'Build a car launch site with a team of agents', zh: '用 Agent 团队和媒体节点，做一个新车发布站' },
    summary: { en: 'A car launch site, its pictures and its clip, by two agents and four media nodes.',
      zh: '一个新车发布站连同它的图片和视频，由两个 Agent 和四个媒体节点做出。' },
    seconds: 376, src: '/showcase/staged/academy/d3da6fb0530331f4.mp4', bytes: 68359410, sha256: 'd3da6fb0530331f458fe3616df1cf1929931da06d9937b814917f16d66e23724',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'car-plant', section: 'build', caseId: 'car-plant', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a live 3D digital twin with a team of agents', zh: '用一支 Agent 团队，做一个实时 3D 工厂数字孪生' },
    summary: { en: 'A live 3D digital twin of an EV plant, by eight agents.',
      zh: '一个实时 3D 电动车工厂数字孪生，由八个 Agent 做出。' },
    seconds: 431, src: '/showcase/staged/academy/a00f467432e0175c.mp4', bytes: 81527886, sha256: 'a00f467432e0175cb338565b481629cdd87b8e30265a790ac8165a337a3bf090',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so. The closing line now says the home-page case is a later version of this team.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。结尾也已说明：首页的这个案例是这支团队的后续版本。' } }] },
  { id: 'neon-circuit', section: 'build', caseId: 'neon-circuit', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D racing game with a team of agents', zh: '用一支 Agent 团队，做一款 3D 赛车游戏' },
    summary: { en: 'A 3D racing game, by ten agents.',
      zh: '一款 3D 赛车游戏，由十个 Agent 做出。' },
    seconds: 433, src: '/showcase/staged/academy/757481fbfe61937b.mp4', bytes: 90288684, sha256: '757481fbfe61937b2d624038b3d028d2ddc9bad6482b67712b8cd7d97a205d7a',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so. The closing line now says the home-page case is a later version of this team.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。结尾也已说明：首页的这个案例是这支团队的后续版本。' } }] },
  { id: 'crystal-keep', section: 'build', caseId: 'crystal-keep', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D tower-defense game with a team of agents', zh: '用一支 Agent 团队，做一款 3D 塔防游戏' },
    summary: { en: 'A 3D tower-defense game, by ten agents.',
      zh: '一款 3D 塔防游戏，由十个 Agent 做出。' },
    seconds: 472, src: '/showcase/staged/academy/0f4f4559253398de.mp4', bytes: 91205373, sha256: '0f4f4559253398de32771066045fc8a74e20c50b1d7e541835827ff3becaa81e',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'mars-mission', section: 'build', caseId: 'mars-mission', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a Mars mission control with a team of agents', zh: '用一支 Agent 团队，做一个火星任务控制中心' },
    summary: { en: 'A Mars mission you plan and fly, by eight agents.',
      zh: '一个可以规划和驾驶的火星任务，由八个 Agent 做出。' },
    seconds: 440, src: '/showcase/staged/academy/f826ae94d61f7ddd.mp4', bytes: 85430324, sha256: 'f826ae94d61f7dddf7deebec2c8e9df15011ca8326810b48e0d0a3675e076e2c',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'beat-studio', section: 'build', caseId: 'beat-studio', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a browser music workstation with a team of agents', zh: '用一支 Agent 团队，做一个浏览器音乐工作站' },
    summary: { en: 'A music workstation in the browser, by ten agents.',
      zh: '一个浏览器里的音乐工作站，由十个 Agent 做出。' },
    seconds: 419, src: '/showcase/staged/academy/0e97e8459328fc94.mp4', bytes: 77206975, sha256: '0e97e8459328fc94e53a357b575d408a422cb814ea3bc857127fdb3879f2f164',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'knowledge-base', section: 'build', caseId: 'knowledge-base', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a team knowledge-base app with a team of agents', zh: '用一支 Agent 团队，做一个团队知识库应用' },
    summary: { en: 'A team knowledge-base app on simulated data, by seven agents.',
      zh: '一个用模拟数据的团队知识库应用，由七个 Agent 做出。' },
    seconds: 388, src: '/showcase/staged/academy/1c4bd61339917703.mp4', bytes: 64179294, sha256: '1c4bd6133991770365c18a43f2ace8b9642af4a902b8757f8221e8db967fd9a7',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'pixel-platformer', section: 'build', caseId: 'pixel-platformer', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a pixel-art platformer with a team of agents', zh: '用一支 Agent 团队，做一款像素平台跳跃游戏' },
    summary: { en: 'A pixel-art platformer level, by six agents.',
      zh: '一关像素平台跳跃游戏，由六个 Agent 做出。' },
    seconds: 325, src: '/showcase/staged/academy/be412981fabf1601.mp4', bytes: 63854992, sha256: 'be412981fabf1601e094ffff38b8a3335709f38ad637c48b95077419c171eee7',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: '3d-configurator', section: 'build', caseId: '3d-configurator', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D product configurator with a team of agents', zh: '用一支 Agent 团队，做一个 3D 产品配置器' },
    summary: { en: 'A 3D e-bike configurator, by five agents.',
      zh: '一个 3D 电动自行车配置器，由五个 Agent 做出。' },
    seconds: 397, src: '/showcase/staged/academy/f7ccc97b239b7a48.mp4', bytes: 65168575, sha256: 'f7ccc97b239b7a48694d47376b80c13dbdee337ec108610a62d0dfe555413328',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'papercraft-puzzle', section: 'build', caseId: 'papercraft-puzzle', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a papercraft puzzle with a team of agents', zh: '用一支 Agent 团队，做一款纸艺解谜游戏' },
    summary: { en: 'A papercraft puzzle game, by seven agents.',
      zh: '一款纸艺解谜游戏，由七个 Agent 做出。' },
    seconds: 384, src: '/showcase/staged/academy/a34fdc3b399fa98f.mp4', bytes: 72857675, sha256: 'a34fdc3b399fa98f433bb803c56a3d8285078a10313256895989e23b0f09d8fa',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'summer-ad', section: 'build', caseId: 'summer-ad', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Pre-produce a 30-second ad with a team of agents', zh: '用一支 Agent 团队，预制一支 30 秒广告' },
    summary: { en: 'A 30-second ad’s animatic, by six agents.',
      zh: '一支 30 秒广告的动态分镜，由六个 Agent 做出。' },
    seconds: 382, src: '/showcase/staged/academy/7938cb4e94ead2b5.mp4', bytes: 70251417, sha256: '7938cb4e94ead2b5c5ec8329e7a228fbe092139f1a7d1e9561b2adcddc9293f5',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'port-twin', section: 'build', caseId: 'port-twin', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a live 3D port cockpit with a team of agents', zh: '用一支 Agent 团队，做一个实时 3D 港口驾驶舱' },
    summary: { en: 'A live 3D port cockpit, by six agents.',
      zh: '一个实时 3D 港口驾驶舱，由六个 Agent 做出。' },
    seconds: 427, src: '/showcase/staged/academy/3828dc0dd6d725ab.mp4', bytes: 79949642, sha256: '3828dc0dd6d725ab3df64da51f7659060798f3fd7314bfd50ff07ac929643594',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'glider-adventure', section: 'build', caseId: 'glider-adventure', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D glider adventure with a team of agents', zh: '用一支 Agent 团队，做一款 3D 滑翔冒险游戏' },
    summary: { en: 'A 3D glider adventure, by six agents.',
      zh: '一款 3D 滑翔冒险游戏，由六个 Agent 做出。' },
    seconds: 341, src: '/showcase/staged/academy/0019581977870be6.mp4', bytes: 65364491, sha256: '0019581977870be63c1f4e576911a30e7f2ab4b9f094b787472489bcf92dd0c1',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'party-game', section: 'build', caseId: 'party-game', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a four-player party game with a team of agents', zh: '用一支 Agent 团队，做一款四人派对游戏' },
    summary: { en: 'A four-player party game, by six agents.',
      zh: '一款四人派对游戏，由六个 Agent 做出。' },
    seconds: 361, src: '/showcase/staged/academy/6fba6d0a80b56ce0.mp4', bytes: 61823138, sha256: '6fba6d0a80b56ce01185781f194b549877b84be471b86819d375a7be9a72182d',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
  { id: 'rhythm-runner', section: 'build', caseId: 'rhythm-runner', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a rhythm runner with a team of agents', zh: '用一支 Agent 团队，做一款节奏跑酷游戏' },
    summary: { en: 'A rhythm runner game, by six agents.',
      zh: '一款节奏跑酷游戏，由六个 Agent 做出。' },
    seconds: 358, src: '/showcase/staged/academy/a0960c7f549aa3a2.mp4', bytes: 102558380, sha256: 'a0960c7f549aa3a24a711aaec8a0f372d1ee72fe68c6d12fe54bf545fc1f381f',
    poster: null,
    changes: [{ on: '2026-10-25', text: {
      en: 'Step 3, giving every agent its job, recorded again on the live AwwO: an agent’s Configure now asks only for a model, as AwwO picks the engine that runs it, and the narration says so.',
      zh: '在线上 AwwO 重新录制第 3 步（给每个 Agent 分配工作）：现在 Agent 的「配置」里只需选模型，运行引擎由 AwwO 自动选择，讲解也随之更新。' } }] },
];

/** 6:15, 1:02:03. */
export function academyDuration(seconds: number): string {
  const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** The AwwO Academy (Academy.tsx): the tutorial videos, each recorded on the live AwwO. Four short how-tos to start with
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

/** The Configure step of every build video, recorded before AwwO chose an Agent node's runtime itself (2026-10-15; the
 *  panel's hint now calls it the engine), when an OpenAI Agents run still stopped at ten minutes (25 since 2026-10-19).
 *  Claude Opus 5.5 offers no effort levels (the Bedrock bridge refuses them), so its Configure shows none. `at` is where
 *  the span to record again starts. */
const runtimeNote = (at: number): AcademyNote => ({ at, since: '2026-10-15', text: {
  en: 'AwwO now picks the runtime (the engine an agent runs on) by itself, so an agent’s Configure has no runtime menu: choose only the model, Claude Opus 5.5. Since 19 October each agent may take up to 25 minutes, not ten. Or skip developer mode here and ask the canvas assistant to set each agent’s task, acceptance criteria and model.',
  zh: '现在由 AwwO 自动选择运行时（Agent 所用的执行引擎），Agent 的「配置」里已经没有运行时选项：只需选模型 Claude Opus 5.5。10月19日起，单个 Agent 最长 25 分钟，不再是 10 分钟。这一步也可以不进开发者模式，直接请画布助手为每个 Agent 设定任务、验收标准和模型。' } });
/** The two cases rebuilt on three.js r186 on 2026-10-15, after their videos had been recorded. */
const rebuiltNote = (at: number, en: string, zh: string): AcademyNote => ({ at, since: '2026-10-15', text: { en, zh } });
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
  { id: 'pallward', section: 'flagship', caseId: 'pallward', voice: 'en', recordedOn: '2026-10-24',
    title: { en: 'PALLWARD: a dark-fantasy game built by twenty-six agents', zh: 'PALLWARD：二十六个 Agent 做出的黑暗奇幻动作游戏' },
    summary: { en: 'Open the case, play the game right in How it was made, see what the twenty agents in sandbox computers wrote, and copy the canvas as a draft.',
      zh: '打开案例，在「How it was made」里直接玩游戏，看二十个在沙箱电脑里写代码的 Agent 各交了什么，再把画布复制成草稿。' },
    seconds: 409, src: '/showcase/staged/academy/405974c9de49a763.mp4', bytes: 98519739, sha256: '405974c9de49a763b7790d99a415efc67452c66074559df8e7c3c70065025c54',
    poster: null,
    changes: [{ on: '2026-10-24', text: {
      en: 'Recorded again on the live AwwO. A fresh copy’s Next card now counts the 48 nodes its first run still makes, 43 of them media nodes.',
      zh: '在线上 AwwO 重新录制：新副本的「接下来」卡片会提示首次运行还要生成的 48 个节点，其中 43 个是媒体节点。' } }] },
  { id: 'the-long-chord', section: 'flagship', caseId: 'the-long-chord', voice: 'en', recordedOn: '2026-10-21',
    title: { en: 'THE LONG CHORD: a space opera made on one canvas', zh: 'THE LONG CHORD：一张画布做出的太空歌剧电影' },
    summary: { en: 'Watch the film in the case, see how its lip sync was measured and its reels were cut, then copy its canvas as a draft. Recorded when the case was Act I on 109 nodes; it now holds the whole of Episode I.',
      zh: '在案例里看影片，看口型同步怎么测、片子一卷卷怎么剪，再把画布复制成草稿。录制时案例只有第一幕、109 个节点；现在已是完整的第一集。' },
    seconds: 385, src: '/showcase/staged/academy/f321b641a4adb841.mp4', bytes: 73953494, sha256: 'f321b641a4adb841e067bbe489925f76c963f9949721b6e7ad9f952f42381ef9',
    poster: null, notes: [
      { at: 16, since: '2026-10-22', text: {
        en: 'The case is now the whole of Episode I: three acts and 15 min 52 s, made by 298 nodes over 93 graph runs, with six editor agents and ten edit nodes.',
        zh: '案例现在是完整的第一集：三幕、15 分 52 秒，由 298 个节点经 93 次图运行做成，含 6 个剪辑 Agent 和 10 个剪辑节点。' } },
      // The case canvas's 282 media nodes at their own settings, priced by mediaCreditsFor (plans.go): 64,460 credits;
      // Max grants 10,000 a month and makes 100 generations a day (saas-academy.test reads both from plans.go).
      { at: 357, since: '2026-10-22', text: {
        en: 'A copy now has 282 pictures, clips and sounds to make again, not 104: at the case’s settings, about 64,000 credits of media, more than six months of the Max plan and more than any plan can generate in a day.',
        zh: '现在复制后要重新生成 282 个图片、视频片段和声音，而不是 104 个：按案例的设置，媒体约需 64,000 点数，超过 Max 套餐六个月的点数，也超过任何套餐一天能生成的数量。' } },
    ] },
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
    seconds: 413, src: '/showcase/staged/academy/cf30bb4f9ddfdc86.mp4', bytes: 92793695, sha256: 'cf30bb4f9ddfdc864ffcb8bcf89e7b97eca84aa49cbae0967c7e0d73377360b6',
    poster: null, notes: [runtimeNote(171)] },
  { id: 'shanhai-vn', section: 'build', caseId: 'shanhai-vn', voice: 'en', recordedOn: '2026-10-15',
    title: { en: 'Build a visual-novel chapter with a team of agents', zh: '用 Agent 团队和媒体节点，做一章视觉小说' },
    summary: { en: 'A visual-novel chapter, its pictures and its clip, by three agents and six media nodes.',
      zh: '一章视觉小说连同它的图片和视频，由三个 Agent 和六个媒体节点做出。' },
    seconds: 415, src: '/showcase/staged/academy/720e5820546d3fa4.mp4', bytes: 92624243, sha256: '720e5820546d3fa4e6afdadcedd315f361c6c0612589f2c6585637fb50125655',
    poster: null, notes: [runtimeNote(211)] },
  { id: 'aurora-gt', section: 'build', caseId: 'aurora-gt', voice: 'en', recordedOn: '2026-10-15',
    title: { en: 'Build a car launch site with a team of agents', zh: '用 Agent 团队和媒体节点，做一个新车发布站' },
    summary: { en: 'A car launch site, its pictures and its clip, by two agents and four media nodes.',
      zh: '一个新车发布站连同它的图片和视频，由两个 Agent 和四个媒体节点做出。' },
    seconds: 377, src: '/showcase/staged/academy/a3dde657d514deff.mp4', bytes: 66764286, sha256: 'a3dde657d514deff7d2a74f5087def501249aa7d31499847c05c1e4bc9f18b09',
    poster: null, notes: [runtimeNote(160)] },
  { id: 'car-plant', section: 'build', caseId: 'car-plant', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a live 3D digital twin with a team of agents', zh: '用一支 Agent 团队，做一个实时 3D 工厂数字孪生' },
    summary: { en: 'A live 3D digital twin of an EV plant, by eight agents.',
      zh: '一个实时 3D 电动车工厂数字孪生，由八个 Agent 做出。' },
    seconds: 438, src: '/showcase/staged/academy/5f09c16c095bfc5e.mp4', bytes: 70202733, sha256: '5f09c16c095bfc5e9ac328423ceb86ac6b4c96d9807e18095144bee94e7095d9',
    poster: null, notes: [
      runtimeNote(202),
      rebuiltNote(426,
        'The EV plant digital twin case on the home page is now built by a later version of this team: its page uses a newer three.js (r186) with a glow effect, and a 3D model node makes its cars. A copy of it is that version, not the prompts shown here.',
        '首页的 EV plant digital twin 案例现在由这支团队的更新版本做成：页面用更新的 three.js（r186），带辉光效果，车辆由一个 3D 模型节点生成。复制得到的是这个新版本，而不是视频里的提示词。'),
    ] },
  { id: 'neon-circuit', section: 'build', caseId: 'neon-circuit', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D racing game with a team of agents', zh: '用一支 Agent 团队，做一款 3D 赛车游戏' },
    summary: { en: 'A 3D racing game, by ten agents.',
      zh: '一款 3D 赛车游戏，由十个 Agent 做出。' },
    seconds: 445, src: '/showcase/staged/academy/43851ad021198aa5.mp4', bytes: 78446631, sha256: '43851ad021198aa5c24707ec3b7623cecdeb31d30dce836b5692630ac71ef1aa',
    poster: null, notes: [
      runtimeNote(176),
      rebuiltNote(433,
        'The Neon Circuit racer case on the home page is now built by a later version of this team: its page uses a newer three.js (r186) with a glow effect, and a 3D model node makes its six cars. A copy of it is that version, not the prompts shown here.',
        '首页的 Neon Circuit racer 案例现在由这支团队的更新版本做成：页面用更新的 three.js（r186），带辉光效果，六辆赛车由一个 3D 模型节点生成。复制得到的是这个新版本，而不是视频里的提示词。'),
    ] },
  { id: 'crystal-keep', section: 'build', caseId: 'crystal-keep', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D tower-defense game with a team of agents', zh: '用一支 Agent 团队，做一款 3D 塔防游戏' },
    summary: { en: 'A 3D tower-defense game, by ten agents.',
      zh: '一款 3D 塔防游戏，由十个 Agent 做出。' },
    seconds: 489, src: '/showcase/staged/academy/62732787638751ce.mp4', bytes: 78179292, sha256: '62732787638751cedf55875382b3b9dbf03e08d9bcf1a5517bf5b32ad438e62a',
    poster: null, notes: [runtimeNote(176)] },
  { id: 'mars-mission', section: 'build', caseId: 'mars-mission', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a Mars mission control with a team of agents', zh: '用一支 Agent 团队，做一个火星任务控制中心' },
    summary: { en: 'A Mars mission you plan and fly, by eight agents.',
      zh: '一个可以规划和驾驶的火星任务，由八个 Agent 做出。' },
    seconds: 452, src: '/showcase/staged/academy/46a0ef1263f02d61.mp4', bytes: 71940566, sha256: '46a0ef1263f02d6128d70c0f3169c186bc0967abe058953468236d3a5ce29c47',
    poster: null, notes: [runtimeNote(177)] },
  { id: 'beat-studio', section: 'build', caseId: 'beat-studio', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a browser music workstation with a team of agents', zh: '用一支 Agent 团队，做一个浏览器音乐工作站' },
    summary: { en: 'A music workstation in the browser, by ten agents.',
      zh: '一个浏览器里的音乐工作站，由十个 Agent 做出。' },
    seconds: 430, src: '/showcase/staged/academy/739c60d1371aef5e.mp4', bytes: 63716961, sha256: '739c60d1371aef5efdba8b87194a24eb7f4a840909cd8d86c8252eeac2f90498',
    poster: null, notes: [runtimeNote(208)] },
  { id: 'knowledge-base', section: 'build', caseId: 'knowledge-base', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a team knowledge-base app with a team of agents', zh: '用一支 Agent 团队，做一个团队知识库应用' },
    summary: { en: 'A team knowledge-base app on simulated data, by seven agents.',
      zh: '一个用模拟数据的团队知识库应用，由七个 Agent 做出。' },
    seconds: 389, src: '/showcase/staged/academy/6a24a96b156ed316.mp4', bytes: 55014523, sha256: '6a24a96b156ed3163724555e02b9ef1abe261e685dc441382a270cca30a6fad7',
    poster: null, notes: [runtimeNote(222)] },
  { id: 'pixel-platformer', section: 'build', caseId: 'pixel-platformer', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a pixel-art platformer with a team of agents', zh: '用一支 Agent 团队，做一款像素平台跳跃游戏' },
    summary: { en: 'A pixel-art platformer level, by six agents.',
      zh: '一关像素平台跳跃游戏，由六个 Agent 做出。' },
    seconds: 324, src: '/showcase/staged/academy/7ae71099cbf1d6a7.mp4', bytes: 55348960, sha256: '7ae71099cbf1d6a7e01662f03a8e51dd52ba93b6cdc183efef20bfe00ec0ad96',
    poster: null, notes: [runtimeNote(180)] },
  { id: '3d-configurator', section: 'build', caseId: '3d-configurator', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D product configurator with a team of agents', zh: '用一支 Agent 团队，做一个 3D 产品配置器' },
    summary: { en: 'A 3D e-bike configurator, by five agents.',
      zh: '一个 3D 电动自行车配置器，由五个 Agent 做出。' },
    seconds: 395, src: '/showcase/staged/academy/544295f5aad88354.mp4', bytes: 57674546, sha256: '544295f5aad88354ed973e56940669ac93faa6fe9d3f1d31da1bd898a16771cd',
    poster: null, notes: [runtimeNote(195)] },
  { id: 'papercraft-puzzle', section: 'build', caseId: 'papercraft-puzzle', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a papercraft puzzle with a team of agents', zh: '用一支 Agent 团队，做一款纸艺解谜游戏' },
    summary: { en: 'A papercraft puzzle game, by seven agents.',
      zh: '一款纸艺解谜游戏，由七个 Agent 做出。' },
    seconds: 390, src: '/showcase/staged/academy/e80f6f1f866dec10.mp4', bytes: 64534196, sha256: 'e80f6f1f866dec105930bc4d0fdf2fac99cf8166e097933f37ac3bdd86077471',
    poster: null, notes: [runtimeNote(216)] },
  { id: 'summer-ad', section: 'build', caseId: 'summer-ad', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Pre-produce a 30-second ad with a team of agents', zh: '用一支 Agent 团队，预制一支 30 秒广告' },
    summary: { en: 'A 30-second ad’s animatic, by six agents.',
      zh: '一支 30 秒广告的动态分镜，由六个 Agent 做出。' },
    seconds: 383, src: '/showcase/staged/academy/503f8466f43990aa.mp4', bytes: 62580470, sha256: '503f8466f43990aad3f4908d7288d93c3326c505f348a5e0fdeb6a39047f799a',
    poster: null, notes: [runtimeNote(224)] },
  { id: 'port-twin', section: 'build', caseId: 'port-twin', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a live 3D port cockpit with a team of agents', zh: '用一支 Agent 团队，做一个实时 3D 港口驾驶舱' },
    summary: { en: 'A live 3D port cockpit, by six agents.',
      zh: '一个实时 3D 港口驾驶舱，由六个 Agent 做出。' },
    seconds: 432, src: '/showcase/staged/academy/93c995fe7c04414a.mp4', bytes: 70124991, sha256: '93c995fe7c04414ac505860e14ccbd10763f5e7d176608ca10eabbcb786a628b',
    poster: null, notes: [runtimeNote(218)] },
  { id: 'glider-adventure', section: 'build', caseId: 'glider-adventure', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a 3D glider adventure with a team of agents', zh: '用一支 Agent 团队，做一款 3D 滑翔冒险游戏' },
    summary: { en: 'A 3D glider adventure, by six agents.',
      zh: '一款 3D 滑翔冒险游戏，由六个 Agent 做出。' },
    seconds: 342, src: '/showcase/staged/academy/471e41cc805ca0bd.mp4', bytes: 56079290, sha256: '471e41cc805ca0bdd7e22686a279be5cd234b69807fd09268df045764c2dea16',
    poster: null, notes: [runtimeNote(162)] },
  { id: 'party-game', section: 'build', caseId: 'party-game', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a four-player party game with a team of agents', zh: '用一支 Agent 团队，做一款四人派对游戏' },
    summary: { en: 'A four-player party game, by six agents.',
      zh: '一款四人派对游戏，由六个 Agent 做出。' },
    seconds: 362, src: '/showcase/staged/academy/b615ee461de844b5.mp4', bytes: 52160396, sha256: 'b615ee461de844b5647e8ddb8112ebe347b03c875515b16b033b25addd5c7af2',
    poster: null, notes: [runtimeNote(193)] },
  { id: 'rhythm-runner', section: 'build', caseId: 'rhythm-runner', voice: 'en', recordedOn: '2026-10-14',
    title: { en: 'Build a rhythm runner with a team of agents', zh: '用一支 Agent 团队，做一款节奏跑酷游戏' },
    summary: { en: 'A rhythm runner game, by six agents.',
      zh: '一款节奏跑酷游戏，由六个 Agent 做出。' },
    seconds: 357, src: '/showcase/staged/academy/e7d17cff35d35826.mp4', bytes: 95035202, sha256: 'e7d17cff35d3582637d688c8006a3ba0e0a84d45abb339a067d90bbad8f6e85a',
    poster: null, notes: [runtimeNote(190)] },
];

/** 6:15, 1:02:03. */
export function academyDuration(seconds: number): string {
  const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

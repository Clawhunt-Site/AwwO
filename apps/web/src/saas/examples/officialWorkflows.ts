import type { AgentTemplateId } from '../../canvas/agentTemplates';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../../canvas/canvasDoc';
import type { ContractField } from '../../canvas/nodeContracts';
import { edgeId } from '../../canvas/ports';
import type { UiLocale } from '../../locale';

export type Localized = Readonly<Record<UiLocale, string>>;
export type OfficialWorkflowCategory = 'design' | 'game' | '3d' | 'knowledge' | 'training' | 'operations';
export interface OfficialWorkflowNode {
  readonly id: string;
  readonly title: Localized;
  readonly role: AgentTemplateId;
  readonly task: Localized;
  readonly output: Localized;
  readonly outputType?: 'markdown' | 'html';
  readonly acceptance: ReadonlyArray<Localized>;
  readonly column: number;
  readonly row: number;
}
export interface OfficialWorkflow {
  readonly id: string;
  readonly category: OfficialWorkflowCategory;
  readonly categoryLabel: Localized;
  readonly title: Localized;
  readonly summary: Localized;
  readonly description: Localized;
  readonly pattern: Localized;
  readonly brief: Localized;
  readonly accent: string;
  readonly nodes: ReadonlyArray<OfficialWorkflowNode>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: Localized }>;
  readonly artifacts: ReadonlyArray<Localized>;
  readonly limitations: Localized;
}

const l = (zh: string, en: string): Localized => ({ zh, en });
const n = (id: string, title: Localized, role: AgentTemplateId, column: number, row: number,
  task: Localized, output: Localized, acceptance: ReadonlyArray<Localized>, outputType?: 'html'): OfficialWorkflowNode =>
  ({ id, title, role, column, row, task, output, acceptance, ...(outputType ? { outputType } : {}) });
const e = (from: string, to: string, zh: string, en: string) => ({ from, to, label: l(zh, en) });

/** Authored reference workflows. These describe work to run, not historical execution evidence.
 * All examples start with bounded, local sample data and require no external service credentials. */
export const OFFICIAL_WORKFLOWS: ReadonlyArray<OfficialWorkflow> = [
  {
    id: 'interaction-page', category: 'design', categoryLabel: l('交互页面', 'Interactive page'), accent: '#a78bfa',
    title: l('Orbit / 团队套餐配置器', 'Orbit / Team plan configurator'),
    summary: l('把套餐、人数与账单周期，变成价格实时联动的交互页面。', 'Turn plans, team size and billing cycles into an interactive page with live pricing.'),
    description: l('以虚构产品 Orbit 为样本，并行设计视觉与计价状态。切换方案、人数和月付/年付，实时计算金额并生成本地方案摘要。', 'Use fictional product Orbit to design visuals and pricing states in parallel. Change plan, seats and monthly/yearly billing to compute prices and generate a local proposal summary.'),
    pattern: l('计价边界 → 视觉文案 / 状态计算并行 → 页面汇聚 → 金额验收', 'Pricing scope → parallel visuals and calculations → page assembly → pricing review'),
    brief: l('制作虚构产品 Orbit 的团队套餐配置器。Starter/Studio/Scale 示例单价分别为每人每月 39/69/129；人数 1–30；支持月付和年付，年付为月单价的 8 折。实时展示月均总价和真实周期账单（年付金额乘 12），生成本地方案摘要。标明示例定价、不创建订单、不支付、不持久化。所有 CSS、图形和脚本内嵌。真实延伸：价格批准后接入服务端报价和订单 API，并独立校验金额。', 'Build a team plan configurator for fictional product Orbit. Starter/Studio/Scale sample prices are 39/69/129 per seat per month; support 1–30 seats and monthly/yearly billing with a 20% yearly discount. Show monthly-equivalent totals and the actual billing-period total (yearly multiplied by 12), and generate a local proposal summary. Label sample prices; no orders, payments or persistence. Inline all CSS, graphics and scripts. Extension: approved server-side quotes and order APIs with independent price validation.'),
    nodes: [
      n('brief', l('产品与边界', 'Product and scope'), 'general', 0, 0,
        l('定义方案、人数、账单周期与本地方案生成四条操作路径。注明示例定价和不创建真实订单的边界。', 'Define plan, seat count, billing cycle and local proposal generation paths. Label sample prices and the no-real-orders boundary.'),
        l('配置器 brief 与计价边界', 'Configurator brief and pricing scope'), [l('区分月均价格与实际周期账单', 'Distinguish monthly equivalent from actual billing-period totals')]),
      n('copy', l('文案与视觉语言', 'Copy and visual language'), 'materials', 1, 0,
        l('按 brief 写套餐文案、计价标签与方案摘要；提供色彩、字阶、间距和内联 SVG 图形方案。', 'Write plan copy, pricing labels and proposal summaries; define colors, typography, spacing and inline SVG graphics.'),
        l('文案包与设计变量', 'Copy pack and design tokens'), [l('示例价格明确标识，无虚构客户背书', 'Sample pricing is labeled; no invented customer endorsements')]),
      n('states', l('交互状态机', 'Interaction state model'), 'frontend', 1, 1,
        l('设计套餐、1–30 人、月付/年付状态与计价纯函数；年付月均为单价×人数×0.8，周期金额再乘12。定义键盘和窄屏行为。', 'Design plan, 1–30 seat and billing states with pure price functions. Yearly monthly-equivalent is price×seats×0.8 and the yearly bill multiplies it by 12. Define keyboard and narrow-screen behavior.'),
        l('状态表、计价函数与交互约定', 'State table, pricing functions and interaction contract'), [l('切换后价格、周期和摘要同步', 'Prices, billing periods and summaries update together')]),
      n('build', l('页面合成', 'Page assembly'), 'frontend', 2, 0,
        l('合并文案与状态表，交付完整 HTML。实现所有操作、可见焦点、错误提示与响应式。不可把按钮画成无行为装饰。', 'Combine copy and states into complete HTML. Implement every action, visible focus, error messages and responsive layout; buttons must have behavior.'),
        l('可独立运行的产品页 HTML', 'Standalone interactive product HTML'), [l('完整 html/head/body，脚本与样式内嵌', 'Complete html/head/body with inline scripts and styles')], 'html'),
      n('review', l('体验与实现核对', 'Experience and implementation review'), 'review', 3, 0,
        l('对照 brief、计价函数和 HTML 检查 1人与30人、三套餐和两种周期的金额、摘要及键盘路径。能运行时记录实际步骤，否则只给静态审查和未验证项。', 'Compare brief, price functions and HTML across 1/30 seats, three plans and both billing cycles; check totals, summaries and keyboard paths. Record runtime steps when possible; otherwise report static findings and unverified items.'),
        l('逐项验收记录与修复列表', 'Acceptance record and repair list'), [l('静态检查与实际运行证据分开', 'Static checks and runtime evidence remain distinct')]),
      n('handoff', l('交付与复用指南', 'Delivery and reuse guide'), 'general', 4, 0,
        l('引用上游完整 HTML 和验收记录，写运行方法、可替换内容和真实 API 接入点。未通过项明确留在交付说明中。', 'Use the complete HTML and review record to explain how to run it, replace content and connect a real API. Keep failed checks visible in the handoff.'),
        l('使用说明与上线前检查单', 'Usage guide and pre-launch checklist'), [l('不把本地演示称为已上线产品', 'Do not describe a local demonstration as a launched product')]),
    ],
    edges: [e('brief', 'copy', '定位与套餐', 'Positioning and plans'), e('brief', 'states', '操作与边界', 'Actions and boundaries'), e('copy', 'build', '文案与视觉', 'Copy and visuals'), e('states', 'build', '计价与状态规范', 'Pricing and states'), e('brief', 'review', '验收目标', 'Acceptance goals'), e('states', 'review', '计算与操作路径', 'Calculations and paths'), e('build', 'review', '真实页面源码', 'Actual page source'), e('build', 'handoff', '完整交付页面', 'Complete page'), e('review', 'handoff', '已知问题与证据', 'Findings and evidence')],
    artifacts: [l('团队套餐配置器', 'Team plan configurator'), l('计价与设计规范', 'Pricing and design specification'), l('本地方案摘要', 'Local proposal summary')],
    limitations: l('官方本地示范，示例价格不对应真实报价，不创建订单、不支付、不持久化。复制生成的是待运行工作流，页面演示不是 AwwO 运行成功记录。', 'Official local demonstration with sample prices, no real quotes, orders, payments or persistence. Copying creates a workflow to run; the demonstration is not evidence of a completed AwwO run.'),
  },
  {
    id: 'orbit-game', category: 'game', categoryLabel: l('游戏原型', 'Game prototype'), accent: '#fb7185',
    title: l('Signal Run / 能量路径', 'Signal Run / Energy path'),
    summary: l('把迷宫、移动和能量规则组合成真正可输赢的网格游戏。', 'Combine a maze, movement and energy rules into a grid game you can win or lose.'),
    description: l('7×7 固定迷宫：绕过障碍，收集三枚能量后抵达出口。键盘与触控移动会实际消耗能量，支持重置与胜负反馈。', 'A fixed 7×7 maze: avoid walls, collect three energy nodes and reach the exit. Keyboard and touch moves consume actual energy; reset and win/loss feedback are included.'),
    pattern: l('规则 → 玩法算法 / 视听规范并行 → 游戏构建 → 回归检查', 'Rules → parallel mechanics and visual design → game build → regression checks'),
    brief: l('制作 Signal Run 能量路径网格游戏。固定 7×7 迷宫、障碍、3枚能量和出口；初始22能量，每次有效移动减1，首次采集每枚能量加7；收齐后抵达出口胜利，能量耗尽失败。无效撞墙不移动或扣能量。提供重置、局部棋盘焦点下的方向键/WASD 与触屏按钮，不劫持页面输入。自绘图形，不请求网络。真实延伸：关卡编辑、可达性检查和难度生成。', 'Build Signal Run with a fixed 7×7 maze, walls, three energy nodes and an exit. Start with 22 energy; valid moves cost 1 and collecting each node for the first time adds 7. Win by reaching the exit after collecting all nodes; lose at zero energy. Walls do not move the player or consume energy. Support reset, arrows/WASD only while the board has focus, and touch buttons without hijacking page input. Draw original graphics; no network. Extension: a level editor, reachability checks and difficulty generation.'),
    nodes: [
      n('rules', l('规则与胜负', 'Rules and game states'), 'general', 0, 0,
        l('定义进行、胜利、失败与重置状态，列出22初始能量、有效移动-1和首次采集+7规则，给出可达出口的地图。', 'Define playing, won, lost and reset states, with 22 initial energy, -1 per valid move and +7 per first collection; provide a maze with a reachable exit.'),
        l('游戏规则与状态转换表', 'Game rules and transition table'), [l('胜负与重置没有歧义', 'Game-over and reset behavior are unambiguous')]),
      n('mechanics', l('移动与能量计算', 'Movement and energy calculation'), 'backend', 1, 0,
        l('实现网格移动 reducer，先检查边界和墙，再扣能量、记录首次采集、判断胜负；避免一枚能量重复奖励，计算一条可赢路径。', 'Implement a grid-move reducer: check bounds and walls, then consume energy, record first collection and evaluate win/loss. Prevent repeated collection rewards and calculate a winning path.'),
        l('移动算法与可赢路径', 'Movement algorithm and winning path'), [l('结束后不再移动，撞墙不扣能量', 'End states block movement; walls cost no energy')]),
      n('art', l('场景与手感', 'Scene and feedback'), 'materials', 1, 1,
        l('定义网格、玩家、墙、能量与出口的图形及状态提示；视觉不能只靠颜色传递，给触屏方向键布局。', 'Define grid, player, walls, energy and exit graphics and status cues; do not rely only on color, and specify touch direction controls.'),
        l('视觉规范与反馈清单', 'Visual specification and feedback list'), [l('触控目标易于点击且不遮挡游戏', 'Touch controls are usable and do not obscure the game')]),
      n('build', l('可玩原型', 'Playable prototype'), 'frontend', 2, 0,
        l('实现完整 HTML 网格游戏，合并规则、算法与视觉。方向键/WASD 仅在棋盘聚焦时响应；触屏可玩，重置恢复位置、22能量和全部采集物。', 'Build a complete HTML grid game from rules, algorithms and visuals. Handle arrows/WASD only when the board is focused; support touch and reset position, 22 energy and all collectibles.'),
        l('自包含能量路径游戏 HTML', 'Self-contained energy path game HTML'), [l('移动和采集真实改变状态，胜负后锁定移动', 'Movement and collection change actual state; end states lock movement')], 'html'),
      n('qa', l('玩法回归', 'Gameplay regression'), 'review', 3, 0,
        l('检查原型源码中的墙、边界、首次采集、出口条件、能量耗尽、重置与键盘焦点。能运行时复现获胜与失败路径；无工具时明确未实玩。', 'Review walls, bounds, first collection, exit conditions, energy exhaustion, reset and keyboard focus. Reproduce winning and losing paths when execution is available; otherwise state that it was not play-tested.'),
        l('玩法检查表与问题清单', 'Gameplay checks and issue list'), [l('不把代码审阅写成实玩通过', 'Source review is not reported as passed play-testing')]),
      n('release', l('关卡迭代说明', 'Iteration guide'), 'general', 4, 0,
        l('交代运行方法、地图与能量参数、已知缺陷和下一关修改入口。只有有证据的功能可标已验收。', 'Document how to run the game, modify map and energy parameters, track defects and add levels. Only mark features verified when evidence exists.'),
        l('游戏说明与扩展清单', 'Game guide and extension list'), [l('所有性能或玩法结论有检查依据', 'Performance and gameplay claims have supporting checks')]),
    ],
    edges: [e('rules', 'mechanics', '规则与状态', 'Rules and states'), e('rules', 'art', '体验目标', 'Experience goals'), e('mechanics', 'build', '游戏算法', 'Game mechanics'), e('art', 'build', '画面与反馈', 'Visuals and feedback'), e('rules', 'qa', '验收规则', 'Acceptance rules'), e('build', 'qa', '可玩源代码', 'Playable source'), e('build', 'release', '游戏交付', 'Game deliverable'), e('qa', 'release', '回归结果', 'Regression findings')],
    artifacts: [l('可玩的能量路径游戏', 'Playable energy path game'), l('移动与能量规则', 'Movement and energy rules'), l('关卡扩展说明', 'Level extension guide')],
    limitations: l('本地单人原型，无联网、付费道具或排行榜。复制工作流后需配置可用模型再运行；不宣称已完成商业游戏。', 'Local single-player prototype without networking, purchases or a leaderboard. Configure an available model before running the copied workflow; this is not a finished commercial game.'),
  },
  {
    id: 'spatial-studio', category: '3d', categoryLabel: l('3D 交互', '3D interaction'), accent: '#38bdf8',
    title: l('FIELD / 3D 产品展台', 'FIELD / 3D product stage'),
    summary: l('把几何、相机和材质控制拆开，再合成可旋转的三维展台。', 'Separate geometry, camera and material controls, then combine them into a rotatable 3D product stage.'),
    description: l('用真实三维顶点与透视投影呈现音箱，支持拖拽旋转、缩放、配色和视角切换，并展示遮挡、光照与深度关系。', 'Present a speaker using actual 3D vertices and perspective projection with drag rotation, zoom, colors and view presets, including occlusion, lighting and depth.'),
    pattern: l('场景约束 → 几何 / 交互并行 → 三维投影 → 性能与数学核对', 'Scene constraints → parallel geometry and controls → 3D projection → performance and math review'),
    brief: l('制作 FIELD /01 音箱三维展台。以 SVG 绘制真实三维顶点经旋转与透视投影后的面，包含背面剔除、深度排序、光照、网格、展台与正面孔洞。支持拖拽/键盘旋转、65–125%缩放、岩灰/陶土/苔绿配色、正面/透视/俯视、自动旋转开关；尊重 reduced-motion 并清理 RAF。无外部库或请求，不声称 GPU WebGL 或建模导出。真实延伸：WebGL 渲染器与实际 glTF 资产管线。', 'Build FIELD /01, a 3D speaker stage. Draw real 3D vertices transformed through rotation and perspective as SVG faces with back-face culling, depth sorting, lighting, a grid, stage and front holes. Support drag/keyboard rotation, 65–125% zoom, stone/clay/moss colors, front/perspective/top presets and auto-rotation. Honor reduced motion and clean up RAF. No external libraries or requests; do not claim GPU WebGL or model export. Extension: a WebGL renderer and actual glTF asset pipeline.'),
    nodes: [
      n('scene', l('场景与坐标约定', 'Scene and coordinate contract'), 'general', 0, 0,
        l('确定世界坐标、相机位置、物体尺度和参数范围，写清投影与裁剪约定。', 'Define world coordinates, camera position, object scale, parameter ranges, projection and clipping conventions.'),
        l('场景规格与参数表', 'Scene specification and parameters'), [l('不会投影相机后方或接近零深度的点', 'Do not project points behind the camera or at near-zero depth')]),
      n('geometry', l('几何与透视数学', 'Geometry and perspective math'), 'data', 1, 0,
        l('推导绕 X/Y 轴旋转及透视投影，生成音箱顶点与面，计算法线、背面剔除、光照及深度排序。提供已知坐标检查。', 'Derive X/Y rotation and perspective projection; generate speaker vertices and faces, normals, back-face culling, lighting and depth sorting. Provide known-coordinate checks.'),
        l('投影公式与几何数据', 'Projection formulas and geometry data'), [l('变换检查包含已知坐标和边界值', 'Transform checks include known coordinates and boundaries')]),
      n('controls', l('相机与参数交互', 'Camera and parameter controls'), 'frontend', 1, 1,
        l('定义 pointer 拖拽、65–125%缩放、三色、正面/透视/俯视与自动旋转控制；键盘提供等价旋转，reduced-motion 默认停转。', 'Define pointer drag, 65–125% zoom, three colors, front/perspective/top views and auto-rotation; provide keyboard rotation and default to stopped under reduced motion.'),
        l('控制规范与状态表', 'Control contract and state table'), [l('视角、缩放和配色操作同步更新画面与标签', 'View, zoom and color changes update the scene and labels together')]),
      n('build', l('空间工作台', 'Spatial workbench'), 'frontend', 2, 0,
        l('实现完整 HTML，将真实三维变换绘为 SVG。渲染音箱、展台和网格，背面剔除、按深度排序并根据法线着色，提供全部控制及动画启停。', 'Build complete HTML projecting actual 3D transforms into SVG. Render speaker, stage and grid with back-face culling, depth sorting and normal-based shading, plus all controls and animation start/stop.'),
        l('可交互三维展台 HTML', 'Interactive 3D product stage HTML'), [l('操作确实改变相机或材质，非预渲染图片', 'Controls change camera or material rather than a pre-rendered image')], 'html'),
      n('review', l('数学与渲染核对', 'Math and rendering review'), 'review', 3, 0,
        l('用几何已知值检查实现，核对 resize、指针释放、动画暂停和资源清理。帧率仅在实际测量后报告，否则列待测。', 'Check implementation against known geometry values; inspect resize, pointer release, pause and cleanup. Report frame rate only after measurement; otherwise mark it unmeasured.'),
        l('数学检查与性能证据', 'Math checks and performance evidence'), [l('明确 SVG 透视投影与 WebGL 的区别', 'Clearly distinguish SVG perspective projection from WebGL')]),
      n('handoff', l('场景复用说明', 'Scene reuse guide'), 'general', 4, 0,
        l('说明如何替换几何、扩展相机、迁移到真实资产与 WebGL，并保留已知限制。', 'Explain geometry replacement, camera extension and migration to real assets and WebGL while preserving known limitations.'),
        l('参数说明与资产接入路线', 'Parameter guide and asset integration path'), [l('扩展路线不表述为已经实现', 'Future extensions are not described as implemented')]),
    ],
    edges: [e('scene', 'geometry', '坐标与边界', 'Coordinates and boundaries'), e('scene', 'controls', '可调参数', 'Adjustable parameters'), e('geometry', 'build', '几何与公式', 'Geometry and formulas'), e('controls', 'build', '控制契约', 'Control contract'), e('geometry', 'review', '数学基准', 'Math baseline'), e('build', 'review', '渲染器源码', 'Renderer source'), e('build', 'handoff', '工作台源码', 'Workbench source'), e('review', 'handoff', '验证与限制', 'Checks and limitations')],
    artifacts: [l('可旋转的音箱三维展台', 'Rotatable 3D speaker stage'), l('几何与投影公式', 'Geometry and projection formulas'), l('相机与配色指南', 'Camera and color guide')],
    limitations: l('使用 SVG 对真实三维顶点进行透视投影；不是 GPU WebGL 引擎，不提供建模导出。性能结论需要具体设备实测。', 'SVG projects actual 3D vertices in perspective; this is not a GPU WebGL engine and provides no modeling export. Performance claims require device measurements.'),
  },
  {
    id: 'knowledge-desk', category: 'knowledge', categoryLabel: l('知识库', 'Knowledge base'), accent: '#34d399',
    title: l('Knowledge / 可溯源知识台', 'Knowledge / Traceable knowledge desk'),
    summary: l('从文档索引、词项评分到来源展示，把“为什么命中”变得可检查。', 'Make matches inspectable, from document indexing and term scores to visible sources.'),
    description: l('编辑样本知识文档，调整标题和词项权重，以真实 TF-IDF 余弦评分检索，查看匹配词和来源全文。', 'Edit sample knowledge documents, adjust title and term weights, then retrieve using actual TF-IDF cosine scores with matching terms and source text.'),
    pattern: l('语料 → 文档索引 / 查询评测并行 → 检索界面 → 引用核对', 'Corpus → parallel document indexing and query evaluation → search UI → citation review'),
    brief: l('制作本地知识检索工作台。内置4篇跟随中英文界面的样例文档，含稳定 ID、标题和正文；允许新增至12篇、编辑保存并重建索引。中文使用相邻双字、英文使用词项，以真实 TF-IDF 余弦评分；可调标题权重、强调词及词项权重、最低相关度。展示分数、命中词和来源，点击引用回到原文档。无匹配不编答案，无语义同义词能力、无 LLM。真实延伸：实际接入 embedding/retriever/generator 后，再独立验证召回与引用。', 'Build a local knowledge desk with four sample documents in the selected Chinese/English UI language, stable IDs, titles and bodies. Allow up to 12 documents, editing and saving with index rebuild. Tokenize Chinese into adjacent bigrams and English into terms; compute actual TF-IDF cosine scores. Adjust title weight, emphasized terms and term weight, and minimum relevance. Show scores, matched terms and sources; clicking a citation selects its source. Do not invent no-match answers. No semantic synonym matching or LLM. Extension: integrate actual embedding/retriever/generator components and independently evaluate retrieval and citations.'),
    nodes: [
      n('corpus', l('样本语料与来源', 'Sample corpus and provenance'), 'data', 0, 0,
        l('编写4篇中英文样例知识文档，保留唯一 ID、标题与正文；定义新增上限12篇和编辑保存后重建索引的流程。', 'Write four Chinese/English sample knowledge documents with unique IDs, titles and bodies; define a 12-document limit and index rebuilding after saved edits.'),
        l('版本化 JSON 语料与字段说明', 'Versioned JSON corpus and field specification'), [l('每条记录唯一 ID，无真实个人数据', 'Every record has a unique ID and no real personal data')]),
      n('index', l('文档与词项索引', 'Document and lexical index'), 'backend', 1, 0,
        l('实现中文相邻双字、英文词项分词与 TF-IDF 余弦评分。应用标题权重和强调词权重，最低相关度过滤并稳定排序；编辑保存后重建索引。', 'Implement Chinese bigram and English word tokenization with TF-IDF cosine scoring. Apply title and emphasized-term weights, filter by minimum relevance and sort stably; rebuild after saved edits.'),
        l('索引、评分算法与来源映射', 'Index, scoring algorithm and source mapping'), [l('重复查询结果稳定，来源可回查', 'Repeated queries are stable and sources are traceable')]),
      n('eval', l('查询与召回样本', 'Queries and retrieval checks'), 'general', 1, 1,
        l('基于语料创建明确命中、中英文、标点、空查询、完全未命中和修改文档后检索的问题，注明期望来源，检查权重变化可解释。', 'Create exact-match, Chinese/English, punctuation, empty, no-match and after-edit queries from the corpus; specify expected sources and explain ranking changes under different weights.'),
        l('查询集与期望来源', 'Query set and expected sources'), [l('包含负样本与同分排序场景', 'Include negative cases and score ties')]),
      n('build', l('可溯源检索界面', 'Traceable search interface'), 'frontend', 2, 0,
        l('合并语料、TF-IDF 和评测查询，输出完整 HTML。支持文档增改保存、权重与阈值调节、真实评分排序、引用回跳与无结果反馈；数据仅本地使用。', 'Combine corpus, TF-IDF and test queries into complete HTML. Implement add/edit/save, weights and threshold controls, actual score ranking, citation-to-source navigation and no-result feedback; use data locally only.'),
        l('本地知识检索 HTML', 'Local knowledge search HTML'), [l('结果由查询实际计算，非固定回答', 'Results are computed from queries, not fixed answers')], 'html'),
      n('verify', l('检索与引用核对', 'Retrieval and citation review'), 'review', 3, 0,
        l('用查询集核对源码与来源映射。可执行时逐条运行并计算实际命中数，不可执行时只报告待测；查验无结果不会编造回答。', 'Check source code and provenance against the query set. Execute and count actual matches when possible; otherwise mark tests pending. Verify that no-match queries do not invent answers.'),
        l('查询级验证记录', 'Per-query verification record'), [l('没有执行就不报告召回率', 'Do not report recall without execution')]),
      n('handoff', l('真实知识库接入', 'Real knowledge integration guide'), 'general', 4, 0,
        l('说明如何替换自有语料、保留来源和重建索引，并规划真实向量检索与生成的接口及评测边界。', 'Explain corpus replacement, source preservation and index rebuilding, then define interfaces and evaluation boundaries for future vector retrieval and generation.'),
        l('语料维护与接入说明', 'Corpus maintenance and integration guide'), [l('区分当前词项检索与未来模型能力', 'Distinguish current lexical search from future model capabilities')]),
    ],
    edges: [e('corpus', 'index', '语料与来源 ID', 'Corpus and source IDs'), e('corpus', 'eval', '已知知识范围', 'Known knowledge scope'), e('corpus', 'build', '实际语料', 'Actual corpus'), e('index', 'build', '检索算法', 'Retrieval algorithm'), e('eval', 'build', '示例查询', 'Sample queries'), e('eval', 'verify', '期望来源', 'Expected sources'), e('build', 'verify', '检索源码', 'Search source'), e('index', 'handoff', '索引约定', 'Index contract'), e('verify', 'handoff', '验证结果', 'Verification findings')],
    artifacts: [l('可检索知识工作台', 'Searchable knowledge workbench'), l('样本语料与来源映射', 'Sample corpus and provenance mapping'), l('查询评测与接入指南', 'Query evaluation and integration guide')],
    limitations: l('真实词项检索示范，不调用大模型、不使用向量数据库，也不代表已经拟合企业知识。语料为演示内容。', 'Actual lexical retrieval demonstration without an LLM or vector database. It does not claim to fit enterprise knowledge; the corpus is sample content.'),
  },
  {
    id: 'model-lab', category: 'training', categoryLabel: l('模型训练', 'Model training'), accent: '#fbbf24',
    title: l('Model Lab / 训练实验室', 'Model Lab / Training laboratory'),
    summary: l('用梯度下降训练二维小模型，观察双集损失、概率区域与新样本预测。', 'Train a small 2D model with gradient descent and inspect losses, probability regions and new-sample predictions.'),
    description: l('浏览器里训练二维逻辑回归：调整学习率和训练步数，用保留验证集检查泛化，指标来自当前权重计算。', 'Train 2D logistic regression in the browser: adjust learning rate and steps, check generalization on a held-out set and compute metrics from current weights.'),
    pattern: l('数据生成 → 训练算法 / 验证口径并行 → 实验界面 → 数值核对', 'Data generation → parallel training algorithm and validation protocol → experiment UI → numerical review'),
    brief: l('实现浏览器训练实验室，以 CPU 和队列两个特征的固定种子合成数据做二分类，180条训练、60条留出；只用训练集更新逻辑回归权重。真实计算 sigmoid、二元交叉熵和全批量梯度下降。可调学习率、轮数、噪声，支持训练/停止/重训/重置，显示双集 loss/accuracy、概率区域及新样本预测。不下载模型、不调用 API，不伪称大模型微调，不声明参数导出已实现。真实延伸：参数版本导出、真实数据和离线训练任务需另行接入评测。', 'Implement a browser training lab with seeded synthetic CPU and queue features for binary classification: 180 training examples and 60 held out. Update logistic-regression weights only on training data. Actually compute sigmoid, binary cross-entropy and full-batch gradient descent. Adjust learning rate, epochs and noise; support train/stop/retrain/reset and show both sets’ loss/accuracy, probability regions and new-sample predictions. No model downloads, APIs or claims of LLM fine-tuning or implemented parameter export. Extension: parameter version export, real datasets and offline jobs require separate integration and evaluation.'),
    nodes: [
      n('dataset', l('合成数据与划分', 'Synthetic data and split'), 'data', 0, 0,
        l('生成固定种子的 CPU/队列二维合成样本，预先划分180训练/60留出，定义噪声、特征尺度与标签；留出集不得参与参数更新。', 'Generate seeded synthetic CPU/queue samples, pre-split 180 training/60 held out, define noise, feature scales and labels; held-out data must not update parameters.'),
        l('数据生成器与固定划分', 'Data generator and fixed split'), [l('重置可复现同样样本，无训练验证泄漏', 'Reset reproduces samples without train/validation leakage')]),
      n('trainer', l('逻辑回归与优化器', 'Logistic regression and optimizer'), 'backend', 1, 0,
        l('实现数值稳定 sigmoid、交叉熵、批量梯度更新与预测。限制学习率和 epoch，上下界保护 log；提供简单已知值自检。', 'Implement stable sigmoid, cross-entropy, batch gradients and prediction. Bound learning rate and epochs, protect logarithms and provide known-value checks.'),
        l('训练数学与 JavaScript 核心', 'Training math and JavaScript core'), [l('loss 由当前真实预测计算，非预制曲线', 'Loss uses current predictions, not a precomputed curve')]),
      n('metrics', l('评测与实验约定', 'Evaluation and experiment protocol'), 'review', 1, 1,
        l('定义训练/留出 loss 和 accuracy、新样本概率与0.5分类阈值，处理零样本。定义初始权重、停止与重训语义。', 'Define training/held-out loss and accuracy, new-sample probability and the 0.5 decision threshold, including empty-set handling. Define initial weights, stopping and retraining.'),
        l('指标公式与测试场景', 'Metric formulas and test scenarios'), [l('不承诺固定准确率或商业效果', 'Do not promise a fixed accuracy or business result')]),
      n('build', l('浏览器训练工作台', 'Browser training workbench'), 'frontend', 2, 0,
        l('组合数据、训练算法和指标输出完整 HTML。分帧迭代可停止，实时展示双集损失/准确率和概率区域，允许输入 CPU/队列作真实预测；重训不叠加旧任务。', 'Combine data, training and metrics into complete HTML. Iterate across frames with stop support, show both sets’ loss/accuracy and probability regions, and predict from CPU/queue inputs; retraining must not overlap old jobs.'),
        l('可运行训练实验室 HTML', 'Runnable training laboratory HTML'), [l('重置清空曲线并恢复初始状态，停止后不再更新', 'Reset clears curves and restores initial state; stopping ends updates')], 'html'),
      n('check', l('数值与泄漏复核', 'Numerics and leakage review'), 'review', 3, 0,
        l('对照算法和指标核对实现，检查更新后损失、非有限数值、留出集隔离、停止/重训与新样本预测。实测与理论检查分开报告。', 'Check loss after updates, nonfinite values, held-out isolation, stop/retrain and new-sample prediction against algorithms and metrics. Report measured results separately from theoretical checks.'),
        l('数值检查与实验限制', 'Numerical checks and experiment limitations'), [l('没有实测则不宣称收敛或精度达标', 'Do not claim convergence or target accuracy without measurement')]),
      n('card', l('模型卡与复现说明', 'Model card and reproducibility'), 'general', 4, 0,
        l('写数据范围、模型公式、超参数与复现步骤，汇总已测/未测项，明确小样本线性分类器边界；参数导出单列未来扩展。', 'Write data scope, model formula, hyperparameters and reproducibility steps, summarize measured/unmeasured checks and classifier limits; list parameter export separately as a future extension.'),
        l('模型卡与实验记录模板', 'Model card and experiment log template'), [l('明确不是大模型训练或微调', 'Explicitly state this is not LLM training or fine-tuning')]),
    ],
    edges: [e('dataset', 'trainer', '特征与训练划分', 'Features and training split'), e('dataset', 'metrics', '验证集定义', 'Validation definition'), e('dataset', 'build', '可复现样本', 'Reproducible samples'), e('trainer', 'build', '优化算法', 'Optimization algorithm'), e('metrics', 'build', '指标契约', 'Metric contract'), e('trainer', 'check', '数学基准', 'Math baseline'), e('metrics', 'check', '评测规则', 'Evaluation rules'), e('build', 'check', '训练源码', 'Training source'), e('build', 'card', '实际实现', 'Actual implementation'), e('check', 'card', '数值与验证记录', 'Numerical verification')],
    artifacts: [l('实时训练实验室', 'Live training laboratory'), l('双集指标与样本预测', 'Both-set metrics and sample predictions'), l('模型卡与评测口径', 'Model card and evaluation protocol')],
    limitations: l('本地合成数据上的逻辑回归训练，不是大模型微调或生产模型。界面指标由演示算法计算，不能外推到真实业务数据。', 'Logistic regression trained on local synthetic data, not LLM fine-tuning or a production model. Demo metrics do not generalize to real business data.'),
  },
  {
    id: 'operations-hub', category: 'operations', categoryLabel: l('中台系统', 'Operations hub'), accent: '#818cf8',
    title: l('Control / 预算审批中台', 'Control / Budget approval hub'),
    summary: l('让预算申请、审批状态与汇总指标在同一个操作台中保持一致。', 'Keep budget requests, approval states and aggregate metrics consistent in one console.'),
    description: l('六条模拟预算申请支持搜索、状态筛选、批准、必填原因驳回与批准后完成，自动更新统计和本地操作日志。', 'Six sample budget requests support search, status filters, approval, rejection with a required reason and completion after approval, updating metrics and local activity logs.'),
    pattern: l('业务模型 → 校验与文案 / 状态规则并行 → 中台实现 → 一致性验收', 'Business model → parallel validation/copy and state rules → console build → consistency review'),
    brief: l('制作 Control 本地预算审批中台，内置6条模拟预算申请。实现搜索和状态筛选、待审批申请批准或必填原因驳回、批准后可完成；统计状态数量与已批准预算，保留操作日志并支持重置。所有变更仅本地样例，不做角色权限、后端、通知、付款。真实延伸需服务端授权、事务、版本冲突处理与持久审计，不能把本地原型称为这些能力已完成。', 'Build Control, a local budget approval hub with six sample requests. Implement search and state filters, approve pending requests or reject with a required reason, then complete approved requests. Show state counts and approved budget, keep activity logs and support reset. All changes affect local samples only; no role system, backend, notifications or payments. Real integration needs server authorization, transactions, version-conflict handling and durable audit; do not claim those exist in this prototype.'),
    nodes: [
      n('schema', l('业务实体与样本', 'Entities and sample data'), 'data', 0, 0,
        l('定义预算申请、审批状态、金额和日志字段；生成6条模拟申请与稳定 ID，规定状态枚举和已批准预算的汇总口径。', 'Define budget request, state, amount and log fields; generate six sample requests with stable IDs, state enums and the approved-budget aggregation rule.'),
        l('数据字典与样本 JSON', 'Data dictionary and sample JSON'), [l('无真实个人信息，引用关系有效', 'No real personal data; references are valid')]),
      n('validation', l('审批校验与反馈', 'Approval validation and feedback'), 'general', 1, 0,
        l('定义各状态允许的操作，驳回原因必填与错误提示、空搜索反馈、重置说明；明确这不是授权或支付系统。', 'Define allowed actions per state, required rejection reasons and error messages, empty search feedback and reset explanations; clarify this is not an authorization or payment system.'),
        l('操作校验矩阵与提示文案', 'Action validation matrix and feedback copy'), [l('空白驳回原因不改变状态或日志', 'Blank rejection reasons do not change state or logs')]),
      n('rules', l('状态与汇总规则', 'State and aggregation rules'), 'backend', 1, 1,
        l('实现纯函数状态转移：待审批→批准/驳回，批准→完成；只记录有效变更，定义统计和已批准预算随状态更新的计算。', 'Implement pure transitions: pending→approved/rejected and approved→completed. Log valid mutations only and define state-linked counts and approved-budget calculations.'),
        l('业务规则与 reducer 方案', 'Business rules and reducer plan'), [l('非法转换保持原记录并给明确反馈', 'Invalid transitions retain original records and show feedback')]),
      n('build', l('中台工作界面', 'Operations console'), 'frontend', 2, 0,
        l('结合样本、校验与 reducer 交付完整 HTML。实现搜索/筛选、批准、带原因驳回、批准后完成、联动统计与操作日志；重置恢复六条样本并清空日志。', 'Combine samples, validation and reducer into complete HTML. Implement search/filter, approval, rejection with reasons, completion after approval, linked metrics and logs; reset restores six samples and clears logs.'),
        l('可操作中台 HTML', 'Interactive operations console HTML'), [l('变更后表格、统计与操作记录一致', 'Tables, metrics and events remain consistent after mutations')], 'html'),
      n('qa', l('审批与一致性核对', 'Approval and consistency review'), 'review', 3, 0,
        l('核对非法状态转移、空白驳回原因、筛选后操作、预算汇总、日志与重置。实际运行和静态检查分开报告。', 'Check invalid transitions, blank rejection reasons, actions after filtering, budget aggregation, logs and reset. Report runtime verification separately from static review.'),
        l('操作矩阵验收与风险说明', 'Action matrix review and risk notes'), [l('本地日志不声称持久审计，未接入功能不声称已完成', 'Local logs are not durable audit; unconnected capabilities are not called complete')]),
      n('handoff', l('服务端接入说明', 'Backend integration guide'), 'general', 4, 0,
        l('根据实现整理 API、版本冲突、事务与审计要求。区分已经实现的本地操作和真实系统尚需服务端保障。', 'Document API, version conflicts, transaction and audit requirements from the implementation. Distinguish implemented local behavior from guarantees still needed server-side.'),
        l('接口接入与生产差距清单', 'API integration and production gap checklist'), [l('不宣称已经对接真实订单、支付或生产数据', 'Do not claim connections to actual orders, payments or production data')]),
    ],
    edges: [e('schema', 'validation', '申请与状态', 'Requests and states'), e('schema', 'rules', '状态与口径', 'States and definitions'), e('schema', 'build', '样本与字段', 'Samples and fields'), e('validation', 'build', '操作校验矩阵', 'Action validation matrix'), e('rules', 'build', '状态 reducer', 'State reducer'), e('validation', 'qa', '操作基准', 'Action baseline'), e('rules', 'qa', '业务不变量', 'Business invariants'), e('build', 'qa', '中台源代码', 'Console source'), e('build', 'handoff', '本地实现', 'Local implementation'), e('qa', 'handoff', '验收与差距', 'Review and gaps')],
    artifacts: [l('可操作预算审批台', 'Interactive budget approval desk'), l('状态与汇总规范', 'State and aggregation specification'), l('服务端接入清单', 'Backend integration checklist')],
    limitations: l('六条模拟预算申请仅本地变化；没有角色权限、后端、通知或付款，也没有生产审计。真实服务端能力需另行实现。', 'Six sample budget requests change locally only. No roles, backend, notifications, payments or production audit. Actual server capabilities require separate implementation.'),
  },
];

export function getOfficialWorkflow(id: string): OfficialWorkflow | undefined {
  return OFFICIAL_WORKFLOWS.find(item => item.id === id);
}

/** Mint a clean document, never clone bindings, conversations, credentials or sample results.
 * Each incoming edge has a distinct contract field so fan-in is valid on the SaaS DAG runner.
 * Runtime and model selection are left to the workspace's existing initialization policy. */
export function createOfficialDocument(item: OfficialWorkflow, locale: UiLocale): CanvasDocument {
  const nodes = item.nodes.map((spec): SessionNode => {
    const base = createSessionNode(['frontend', 'backend', 'users'].includes(spec.role) ? 'coding' : 'llm',
      { x: spec.column * 680, y: spec.row * 560 });
    const incoming = item.edges.filter(edge => edge.to === spec.id);
    const inputs: ContractField[] = [{
      id: 'brief', label: locale === 'zh' ? '任务与边界' : 'Task and boundaries', type: 'markdown', required: true,
      value: `${item.brief[locale]}\n\n${spec.task[locale]}`,
    }, ...incoming.map((edge): ContractField => ({
      id: `from_${edge.from}`, label: edge.label[locale], type: 'markdown', required: true, value: '',
      help: locale === 'zh' ? '由上游节点的真实输出提供。' : 'Supplied by the actual upstream output.',
    }))];
    const outputType = spec.outputType ?? 'markdown';
    const evidence = locale === 'zh'
      ? '这是待运行的官方参考工作流。只根据实际输入推进；不要把演示、计划或静态检查冒充成功执行。无法运行或缺少能力时，明确列出未验证项。不要自行部署、发送信息或连接生产数据。'
      : 'This is an official reference workflow awaiting execution. Use actual inputs; never present a demo, plan or static check as successful execution. List unverified items when execution or capabilities are unavailable. Do not deploy, send messages or connect production data.';
    const html = outputType === 'html' ? (locale === 'zh'
      ? '\n交付完整、自包含 HTML 文档（html、head、body）。CSS、JavaScript、图形和演示数据全部内嵌；不使用外部脚本、模块导入、字体、图片或网络请求。交互必须真的更新状态。'
      : '\nDeliver a complete self-contained HTML document (html, head, body). Inline CSS, JavaScript, graphics and sample data; no external scripts, module imports, fonts, images or network requests. Interactions must update real state.') : '';
    return { ...base, title: spec.title[locale], w: 560, h: 420,
      // These nodes have purpose-built contracts; assigning a built-in templateId would display
      // that template's unrelated guide instead of the official case's task and acceptance.
      persona: `${spec.task[locale]}\n\n${locale === 'zh' ? '验收要求' : 'Acceptance'}:\n${spec.acceptance.map(check => `- ${check[locale]}`).join('\n')}\n\n${evidence}${html}`,
      contract: { version: 1, inputs, outputs: [{ id: 'result', label: spec.output[locale], type: outputType, required: true, value: '',
        help: spec.acceptance.map(check => check[locale]).join('\n') }] },
    };
  });
  const byId = new Map(item.nodes.map((spec, index) => [spec.id, nodes[index]]));
  const edges = item.edges.map(link => {
    const source = byId.get(link.from);
    const target = byId.get(link.to);
    if (!source || !target) throw new Error(`Invalid official workflow edge: ${link.from} -> ${link.to}`);
    const from = { nodeId: source.id, portId: 'out:result' };
    const to = { nodeId: target.id, portId: `in:from_${link.from}` };
    return { id: edgeId(from, to), fromNode: from.nodeId, fromPort: from.portId,
      toNode: to.nodeId, toPort: to.portId, dataType: 'text' as const };
  });
  return { ...emptyDocument(), nodes, edges };
}

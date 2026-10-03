import type { UiLocale } from '../locale';

/** Cases for the homepage, each laid out the AwwO way: the brief, a team of agents in stages, and
 * the deliverable. Every case has a real canvas (productionWorkflows.ts, or for the knowledge base
 * the 2026-09-04 canvas) that ran in AwwO; its record is in production-runs/ and the case dialog
 * shows what each agent delivered. The cover footage is a recording of the delivery only for the
 * knowledge base (`recording`); the others are AI-generated illustrations, and the cards say so. */
export type ProductionKind = 'product' | 'game' | 'interactive' | 'film' | 'twin';
type Localized = Readonly<Record<UiLocale, string>>;
type Stage = ReadonlyArray<Localized>;

export interface ProductionCase {
  id: string;
  kind: ProductionKind;
  /** The cover footage records what the run delivered, not an illustration. */
  recording?: true;
  title: Localized;
  brief: Localized;
  /** Short role names of the canvas's agents, stage by stage; the roles in one stage work in parallel. */
  stages: ReadonlyArray<Stage>;
  /** What the canvas delivers; the card marks it delivered only when the published run did. */
  deliverable: Localized;
  facts?: ReadonlyArray<Localized>;
  /** File stem under /showcase/ (.mp4 loop and .jpg poster); `footageEn` where the footage shows UI text. */
  footage: string;
  footageEn?: string;
}

export const PRODUCTION_KIND_LABELS: Readonly<Record<ProductionKind, Localized>> = {
  product: { zh: 'SaaS 产品', en: 'SaaS product' },
  game: { zh: '游戏', en: 'Game' },
  interactive: { zh: '互动', en: 'Interactive' },
  film: { zh: '成片', en: 'Film' },
  twin: { zh: '数字孪生', en: 'Digital twin' },
};

const role = (zh: string, en: string): Localized => ({ zh, en });
const DESIGN = role('策划', 'Design'), ART = role('美术', 'Art'), LEVELS = role('关卡', 'Levels'), CODE = role('程序', 'Code');
const SOUND = role('音效', 'Sound'), PHYSICS = role('物理', 'Physics'), MODELLING = role('建模', 'Modelling');
const RENDERING = role('渲染', 'Rendering'), FRONT_END = role('前端', 'Front end'), PRODUCT = role('产品', 'Product');
const REVIEW = role('验收', 'Review'), BACKEND = role('后端', 'Backend');

export const PRODUCTION_CASES: ReadonlyArray<ProductionCase> = [
  {
    id: 'knowledge-base', kind: 'product', recording: true, footage: 'kb-real', footageEn: 'kb-real-en',
    title: { zh: '团队知识库 SaaS', en: 'Team knowledge-base SaaS' },
    brief: { zh: '搭建团队知识库 SaaS：登录、权限、数据治理、后端接口、检索看板、上线物料、验收。', en: 'Build a team knowledge-base SaaS: login, permissions, data governance, the API, search and dashboards, launch assets, review.' },
    stages: [[role('架构', 'Architecture')], [role('权限', 'Access'), role('数据', 'Data'), role('物料', 'Assets')],
      [BACKEND], [role('前端', 'Frontend')], [REVIEW]],
    deliverable: { zh: '能跑起来的知识库 Web 工作台', en: 'A runnable knowledge-base web workspace' },
    facts: [{ zh: '42/42 测试通过', en: '42/42 tests passing' }, { zh: '独立验收退回 2 处缺陷 → 复验通过', en: 'Independent review sent back 2 defects → re-verified' }],
  },
  {
    id: 'pixel-platformer', kind: 'game', footage: 'pixel',
    title: { zh: '像素平台跳跃', en: 'Pixel platformer' },
    brief: { zh: '做一款像素风平台跳跃：狐狸邮差在空中集市里送信。', en: 'A pixel-art platformer: a fox courier delivering letters across a sky market.' },
    stages: [[DESIGN], [ART, LEVELS, SOUND], [CODE], [REVIEW]],
    deliverable: { zh: '网页可玩的试玩关', en: 'A playable web level' },
  },
  {
    id: '3d-configurator', kind: 'interactive', footage: 'config',
    title: { zh: '3D 配置器', en: '3D configurator' },
    brief: { zh: '做一个 3D 配置器：电动单车换颜色、换零件，实时看效果。', en: 'A 3D configurator: change the e-bike’s colour and parts, see it live.' },
    stages: [[PRODUCT], [MODELLING], [RENDERING], [FRONT_END], [REVIEW]],
    deliverable: { zh: '网页 3D 配置器', en: 'A web 3D configurator' },
  },
  {
    id: 'papercraft-puzzle', kind: 'game', footage: 'paper',
    title: { zh: '纸艺解谜', en: 'Papercraft puzzle' },
    brief: { zh: '做一款纸艺解谜：转动纸雕世界，把小球送回家。', en: 'A papercraft puzzle: turn the paper world, roll the marble home.' },
    stages: [[DESIGN], [ART, LEVELS, SOUND], [PHYSICS], [CODE], [REVIEW]],
    deliverable: { zh: '可玩的解谜关卡', en: 'Playable puzzle levels' },
  },
  {
    id: 'summer-ad', kind: 'film', footage: 'film-ad',
    title: { zh: '夏日气泡水广告', en: 'Summer sparkling-drink ad' },
    brief: { zh: '一支 30 秒的夏日气泡水广告：血橙色，要有冲击力。', en: 'A 30-second summer ad for a sparkling drink: blood orange, all impact.' },
    stages: [[role('脚本', 'Script')], [role('分镜', 'Boards')], [role('剪辑', 'Edit'), role('调色', 'Grade')], [role('动态分镜', 'Animatic')], [REVIEW]],
    deliverable: { zh: '脚本、分镜、剪辑表与 30 秒动态分镜', en: 'Script, storyboard, edit sheet and a 30-second animatic' },
  },
  {
    id: 'port-twin', kind: 'twin', footage: 'port-twin',
    title: { zh: '港口三维驾驶舱', en: '3D port cockpit' },
    brief: { zh: '把港口做成三维驾驶舱：船、吊机、集装箱，状态实时可见。', en: 'Turn the port into a 3D cockpit: ships, cranes, containers, live status.' },
    stages: [[MODELLING, role('数据', 'Data')], [RENDERING], [FRONT_END], [REVIEW]],
    deliverable: { zh: '实时三维驾驶舱', en: 'A real-time 3D cockpit' },
  },
  {
    id: 'glider-adventure', kind: 'game', footage: 'glider',
    title: { zh: '云海滑翔冒险', en: 'Cloud-sea glider adventure' },
    brief: { zh: '做一款能玩的滑翔冒险：云海、浮岛、会发光的风。', en: 'A playable glider adventure: a sea of clouds, floating islands, glowing wind.' },
    stages: [[DESIGN], [ART, SOUND], [CODE], [REVIEW]],
    deliverable: { zh: '能玩的试玩版', en: 'A playable build' },
  },
  {
    id: 'party-game', kind: 'game', footage: 'party',
    title: { zh: '四人派对游戏', en: 'Party game' },
    brief: { zh: '做一款四人同屏的派对游戏：小企鹅在冰面上抢鱼。', en: 'A four-player couch party game: penguins scrambling for fish on the ice.' },
    stages: [[DESIGN], [role('角色', 'Characters'), PHYSICS, SOUND], [CODE], [REVIEW]],
    deliverable: { zh: '四人同屏可玩版', en: 'A four-player build' },
  },
  {
    id: 'rhythm-runner', kind: 'game', footage: 'rhythm',
    title: { zh: '节奏跑酷', en: 'Rhythm runner' },
    brief: { zh: '做一款节奏跑酷：跟着鼓点，在巨型琴键上奔跑。', en: 'A rhythm runner: race the beat across giant piano keys.' },
    stages: [[DESIGN], [ART, role('音乐', 'Music')], [CODE], [role('测试', 'Testing')], [REVIEW]],
    deliverable: { zh: '能玩的节奏关卡', en: 'A playable rhythm level' },
  },
];

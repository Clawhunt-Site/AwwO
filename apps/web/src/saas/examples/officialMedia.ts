import type { MediaParams } from '../../canvas/canvasDoc';
import type { Localized } from './officialWorkflows';

/** An image, video or 3D node of an official example: it generates from its own prompt (its draft) when the canvas
 * runs, or alone when a member presses Send, and its result is wired into the pages that show it (`feeds`): each of
 * those nodes gets a text input that reads the stored files as `<node id>/<file name>` paths, which the page uses in
 * its img, video or CSS. The wire is soft: a picture that was not made (a workspace whose allowance refuses it, a
 * failed generation) leaves the page a note instead, and the page is made without it. */
export interface OfficialMediaNode {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'model3d';
  readonly title: Localized;
  readonly prompt: Localized;
  readonly model: string;
  readonly params?: MediaParams;
  readonly column: number;
  readonly row: number;
  /** The example's nodes whose page shows this asset (a page and the node that repairs it). */
  readonly feeds?: ReadonlyArray<string>;
}

const l = (zh: string, en: string): Localized => ({ zh, en });
const HERO: MediaParams = { aspectRatio: '16:9', resolution: '2K' };
// 3D prompts are English in both languages: the model reads English best.
const same = (text: string): Localized => l(text, text);
const MODEL3D: MediaParams = { texture: true, pbr: true, textureQuality: 'detailed', faceLimit: 12000,
  negativePrompt: 'text, letters, logo, watermark, people, ground plane, pedestal' };

/** The media each example makes in the same run, by example id. The prompts are written for the example's own
 * look; none asks for text in the picture, since generated lettering is unreliable. */
export const OFFICIAL_MEDIA: Readonly<Record<string, ReadonlyArray<OfficialMediaNode>>> = {
  'interaction-page': [{
    id: 'hero', kind: 'image', title: l('产品主视觉', 'Product key visual'), model: 'xt.seedream-5-pro', params: HERO, column: 2, row: 1, feeds: ['build'],
    prompt: l('虚构团队协作 SaaS「Orbit」定价页的产品主视觉。深靛蓝到紫罗兰的渐变空间里，一颗半透明、发光的玻璃质感球体被三条细光环环绕，光环上点缀着代表团队成员的小光点，像一支小团队围绕同一个目标协作。画面干净克制，左侧大面积留白便于放标题，柔和体积光与细微颗粒，高端科技品牌广告质感，2K 横幅。不要出现任何文字、字母、Logo、水印或界面截图。',
      'Product key visual for the pricing page of Orbit, a fictional team-collaboration SaaS. In a deep indigo-to-violet gradient space, a translucent, glowing glass sphere is circled by three fine light rings dotted with small points of light, like a small team working around one goal. Clean and restrained, generous negative space on the left for a headline, soft volumetric light and fine grain, premium tech-brand advertising quality, 2K banner. No text, letters, logos, watermarks or interface screenshots.'),
  }],
  'orbit-game': [{
    id: 'key-art', kind: 'image', title: l('关卡宣传图', 'Level key art'), model: 'xt.seedream-5-pro', params: HERO, column: 2, row: 1, feeds: ['build'],
    prompt: l('网格解谜游戏《Signal Run 能量路径》的关卡宣传图。7×7 霓虹网格悬浮在深色宇宙中，俯视 45 度；一个青色发光的小探测器沿着一条亮起的路径穿过墙块，三枚琥珀色能量晶体散落在格子里，远端是一扇绿色光门出口。赛博霓虹配色，清晰的明暗层次，体积光与辉光，精致的游戏美术宣传图质感。不要出现任何文字、字母、数字、Logo 或水印。',
      'Key art for the grid puzzle game Signal Run. A 7×7 neon grid floats in deep space, seen from a 45-degree top-down angle; a small cyan glowing probe follows a lit path between wall blocks, three amber energy crystals sit on the cells, and a green light gate waits at the far end as the exit. Cyber-neon palette, clear contrast and depth, volumetric light and glow, polished game key-art quality. No text, letters, numbers, logos or watermarks.'),
  }],
  'spatial-studio': [{
    id: 'speaker-model', kind: 'model3d', title: l('音箱 3D 模型', 'Speaker 3D model'), model: 'tripo.p1', params: MODEL3D, column: 2, row: 1, feeds: ['build'],
    prompt: same('A compact modern bookshelf speaker called FIELD/01: a rounded rectangular cabinet in matte rock grey, a large woofer and a small tweeter on the front behind perforated metal grilles, a thin walnut base plate, minimal Scandinavian product design, clean geometry, realistic product proportions, a single object.'),
  }],
  'colony-command': [{
    id: 'outpost-art', kind: 'image', title: l('星球前哨概念图', 'Outpost concept art'), model: 'xt.seedream-5-pro', params: HERO, column: 1, row: 3, feeds: ['build', 'repair'],
    prompt: l('回合策略游戏《KEPLER 殖民地指挥官》的星球前哨概念图。荒凉的系外行星地表，赭红色岩原上分布着冰原与一座巨大陨坑；一座小型殖民前哨：中央指挥中心穹顶、矿站钻塔、一排光伏板和温室舱，彼此由发光的管线正交相连。天空悬着巨大的气态行星与两颗卫星，低角度的冷暖对比光，薄尘与雾，电影级科幻概念美术。不要出现任何文字、字母、Logo 或水印。',
      'Concept art for the turn-based strategy game KEPLER Colony Command: a barren exoplanet surface with ochre rock plains, ice fields and a huge crater, and a small colony outpost — a central command dome, a mining drill tower, a row of solar panels and greenhouse modules, linked at right angles by glowing conduits. A giant gas planet and two moons hang in the sky; low-angle warm-cold contrast light, thin dust and haze, cinematic sci-fi concept art. No text, letters, logos or watermarks.'),
  }],
  'habitat-twin': [{
    id: 'building-model', kind: 'model3d', title: l('园区建筑 3D 模型', 'Campus building 3D model'), model: 'tripo.p1', params: MODEL3D, column: 0, row: 2, feeds: ['build', 'repair'],
    prompt: same('A low-poly architectural model of a modern eco office building: four floors with glass curtain walls, horizontal sun-shading fins, a rooftop solar array and a small rooftop garden, an entrance canopy, a clean white and light grey facade with warm wood accents, game-ready architectural visualization, a single building.'),
  }],
  'studio-pipeline': [{
    id: 'storyboard', kind: 'image', title: l('四格分镜板', 'Four-panel storyboard'), model: 'xt.seedream-5-pro', params: HERO, column: 2, row: 2, feeds: ['build', 'repair'],
    prompt: l('原创短片《FRAME》的一张 2×2 四宫格电影分镜板，四格依次是：左上，黎明的港湾，渔船与起重机剪影，低机位广角；右上，雨后的夜晚城市街道，霓虹倒影，中景；左下，晨雾中的森林小径，光束穿过树冠；右下，黄昏山脊上一人远眺的逆光剪影。统一的分镜画风：干净的铅笔线稿加淡彩水彩，细白边分隔四格，构图清晰，16:9。不要出现任何文字、字母、数字、Logo 或水印。',
      'A 2×2 film storyboard sheet for the original short film FRAME, four panels: top left, a harbour at dawn with fishing boats and crane silhouettes, low wide angle; top right, a city street at night after rain with neon reflections, medium shot; bottom left, a forest path in morning mist with light beams through the canopy; bottom right, a lone figure on a mountain ridge at dusk, backlit silhouette. One consistent storyboard style: clean pencil line art with light watercolour washes, thin white gutters between the panels, clear compositions, 16:9. No text, letters, numbers, logos or watermarks.'),
  }, {
    id: 'sample-shot', kind: 'video', title: l('5 秒样片镜头', '5-second sample shot'), model: 'xt.xtasy-v3', column: 2, row: 3, feeds: ['build', 'repair'],
    params: { aspectRatio: '16:9', duration: 5, resolution: '720p', generateAudio: false, thinking: false },
    prompt: l('原创短片《FRAME》的 5 秒样片镜头：黎明的港湾，镜头从低处缓缓推近，渔船随波轻晃，远处是起重机剪影，海面上薄雾与金色晨光，几只海鸥掠过。电影感调色，柔和光线，稳定的推镜运动。不要出现任何文字、字幕或水印。',
      'A 5-second sample shot for the original short film FRAME: a harbour at dawn, the camera slowly pushes in from a low angle, fishing boats rock gently, crane silhouettes in the distance, thin mist and golden morning light on the water, a few gulls gliding past. Cinematic grade, soft light, a steady push-in. No text, captions or watermarks.'),
  }],
  'stay-revenue': [{
    id: 'room-visual', kind: 'image', title: l('客房主视觉', 'Room key visual'), model: 'xt.seedream-5-pro', params: HERO, column: 1, row: 3, feeds: ['build', 'repair'],
    prompt: l('精品城市酒店「STAY」的客房主视觉。一间温暖的高级大床房，落地窗外是黄昏的城市天际线；床品洁白，胡桃木与暖铜色点缀，床头柔和灯光，窗边小沙发，边几上有一杯茶，空间整洁、有呼吸感。真实摄影质感，35mm 镜头，自然光与室内暖光混合，高端酒店官网头图。不要出现任何文字、Logo、水印或人物。',
      'Room key visual for STAY, a boutique city hotel: a warm premium king room with a dusk city skyline beyond floor-to-ceiling windows, crisp white bedding, walnut and warm brass accents, soft bedside light, a small sofa by the window and a cup of tea on the side table, tidy and airy. Realistic photography, 35 mm lens, natural light mixed with warm interior light, a high-end hotel website hero image. No text, logos, watermarks or people.'),
  }],
};

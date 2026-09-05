import type { Director3DNodeData } from '../types';

export interface SeedancePromptShot {
  title: string;
  transition: string;
  shotSize: string;
  lensMm: number;
  composition: string;
  cameraMove: string;
  focus: string;
  finalComposition: string;
  visibleAction: string;
  sound: string;
}

export interface SeedanceDirectPromptInput {
  subjectReference?: string;
  subjectChange?: string;
  sceneReference?: string;
  sceneRelation?: string;
  shots: SeedancePromptShot[];
}

function referenceToken(reference: string | undefined, fallback: '@主体' | '@场景') {
  const value = reference?.trim();
  return value?.startsWith('@') ? { token: value, missing: false } : { token: fallback, missing: true };
}

function sentence(value: string | undefined, fallback: string): string {
  const text = value?.trim() || fallback;
  return /[。！？!?]$/.test(text) ? text : `${text}。`;
}

export function buildSeedanceDirectPrompt({
  subjectReference,
  subjectChange,
  sceneReference,
  sceneRelation,
  shots,
}: SeedanceDirectPromptInput): string {
  const subject = referenceToken(subjectReference, '@主体');
  const scene = referenceToken(sceneReference, '@场景');
  const preparation = [
    subject.missing ? '- @主体：简单角色表或已建立主体' : null,
    scene.missing ? '- @场景：包含正确空间与人物比例的场景图' : null,
  ].filter(Boolean);
  const preparationText = preparation.length > 0 ? `需准备：\n${preparation.join('\n')}\n\n` : '';
  const shotText = shots.map((shot, index) => [
    `Shot ${index + 1}｜${shot.title}`,
    `镜头：${shot.transition}；${shot.shotSize}，${shot.lensMm}mm，${shot.composition} → ${shot.cameraMove}，${shot.focus} → ${shot.finalComposition}。`,
    `画面：${sentence(shot.visibleAction, '主体完成当前镜头动作并停在落幅位置')}`,
    `音效：${sentence(shot.sound, '延续场景环境底噪')}`,
  ].join('\n')).join('\n\n');

  return `${preparationText}【主体】
${subject.token}。${sentence(subjectChange, '保持主体参考，当前段没有额外外观变化')}

【场景】
${scene.token}。${sentence(sceneRelation, '人物比例以场景参考为准，保持起点与关键物体位置稳定')}

【音乐】
不生成任何 BGM。所有环境声、动作声、台词和呼吸声写入对应 Shot 的“音效”行。

【镜头】
${shotText}

生成建议：Seedance 720p｜15秒｜同一提示词建议生成 3 次，再从约 15 个 Shot 素材中挑选剪辑。`;
}

export function buildDirector3DSeedancePrompt(data: Director3DNodeData): string {
  const names = data.characters.map((character) => character.name).join('、') || '主要人物';
  const mainTitle = data.selectedShotTemplate ?? `${data.shotSize}主镜头`;
  const pairComposition = data.characters.length > 1
    ? '双人构图，人物分别位于画面左右三分线，保持相互距离'
    : '单人构图，主体位于画面中央偏右并留出视线空间';
  return buildSeedanceDirectPrompt({
    subjectChange: `${names}参与本段；人物从各自站位起手，动作过程中保持身份、服装和相对位置连续`,
    sceneRelation: `${data.scenePreset}作为唯一场景；人物站位与关键空间比例按3D舞台保持，镜头距离约${data.cameraDistance.toFixed(1)}米`,
    shots: [
      {
        title: '建立空间',
        transition: '硬切开场',
        shotSize: '大全景',
        lensMm: 24,
        composition: '略高机位，场景边界完整进入画面，人物作为空间比例参照',
        cameraMove: '稳定缓慢推进并在人物站位清楚后减速',
        focus: '焦点由场景纵深移到人物整体',
        finalComposition: '全景落幅，人物和主要空间关系同时清楚',
        visibleAction: `${names}保持起始站位；镜头推进时人物转向彼此或目标方向，最终站稳并建立场面关系`,
        sound: '场景环境底噪、远处空间回声和人物轻微脚步声',
      },
      {
        title: '人物走位',
        transition: '动作匹配剪切',
        shotSize: '中景',
        lensMm: 50,
        composition: pairComposition,
        cameraMove: '横向短距离跟拍人物完成走位后停稳',
        focus: '焦点跟随主动人物，另一人物保持可辨识',
        finalComposition: '中景落幅，人物停在预设站位',
        visibleAction: `主动人物先迈步进入关系位置，另一人物做出可见反应；两人最终保持3D舞台中的相对距离`,
        sound: '延续环境底噪、脚步声、衣料摩擦声和人物呼吸声',
      },
      {
        title: mainTitle,
        transition: '视线引导切',
        shotSize: data.shotSize,
        lensMm: data.lensMm,
        composition: pairComposition,
        cameraMove: `从偏航${Math.round(data.cameraYaw)}度、俯仰${Math.round(data.cameraPitch)}度的机位缓慢推进`,
        focus: '焦点锁定当前动作主体，动作完成时停止推进',
        finalComposition: `${data.shotSize}落幅，主体动作和对手反应位于同一视线关系内`,
        visibleAction: `起手时人物保持3D舞台站位；过程中${data.directorNote}；落幅时动作完成，人物停在最终位置`,
        sound: '延续环境底噪，人物动作对应的脚步、衣料摩擦和呼吸声',
      },
      {
        title: '反应细节',
        transition: '动作过渡剪切',
        shotSize: '特写',
        lensMm: 85,
        composition: '反应人物面部与手部动作居中，背景保持简洁',
        cameraMove: '固定机位，焦点由手部动作平稳移到眼睛',
        focus: '移焦完成后锁定眼睛，不继续变焦',
        finalComposition: '面部特写落幅，视线方向留出少量空间',
        visibleAction: '反应人物先收紧手指，停顿后抬眼看向对方；呼吸放慢，视线最终固定',
        sound: '短暂静默、手指摩擦声和逐渐放轻的呼吸声',
      },
      {
        title: '关系收束',
        transition: '视线匹配剪切',
        shotSize: '全景',
        lensMm: 35,
        composition: '人物与场景纵深同时可见，双方站位形成明确方向线',
        cameraMove: '沿中心轴缓慢后拉并保持水平',
        focus: '焦点保持在人物关系平面，不转移到背景',
        finalComposition: '全景落幅，人物停在画面两侧并保留中间空间',
        visibleAction: '人物从上一镜头的视线状态起手，分别做出最后一个小动作后停住；镜头后拉揭示完整站位并收束',
        sound: '延续场景环境底噪、最后一次脚步或衣料声，落幅时保留短暂静默',
      },
    ],
  });
}

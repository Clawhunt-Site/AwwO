/** Deterministic, local simulation engines. No network, credentials, storage or wall-clock dependency. */
export type Locale = 'zh' | 'en';
export type Text = Readonly<Record<Locale, string>>;
export const text = (zh: string, en: string): Text => ({ zh, en });
export type Result<T> = { state: T; error?: string };
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const round = (value: number) => Math.round(value * 100) / 100;
export const seeded = (seed: number) => { let value = seed >>> 0; return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; }; };

// ── COLONY COMMAND ────────────────────────────────────────────────────────────
export type Resource = 'ore' | 'energy' | 'food' | 'oxygen' | 'science';
export type Resources = Record<Resource, number>;
export type Facility = 'command' | 'solar' | 'mine' | 'farm' | 'recycler' | 'lab' | 'habitat';
export type Technology = 'efficiency' | 'shielding' | 'hydroponics';
export type Terrain = 'plain' | 'ore' | 'ice' | 'crater';
export type Weather = 'clear' | 'storm' | 'radiation';
export interface ColonyCell { id: number; terrain: Terrain; facility: Facility | null; hp: number }
export type ColonyAction = { type: 'build'; cell: number; facility: Facility } | { type: 'turn' } | { type: 'research'; technology: Technology } | { type: 'repair'; cell: number };
export interface ColonyState { seed: number; turn: number; cells: ColonyCell[]; resources: Resources; population: number; technologies: Technology[]; status: 'playing' | 'won' | 'lost'; weather: Weather; log: Text[]; actions: ColonyAction[] }
export const RESOURCE_NAMES: Record<Resource, Text> = { ore: text('矿石', 'Ore'), energy: text('电力', 'Power'), food: text('食物', 'Food'), oxygen: text('氧气', 'Oxygen'), science: text('科研', 'Research') };
export const FACILITIES: Record<Facility, { name: Text; glyph: string; cost: Partial<Resources>; yield: Partial<Resources>; upkeep: number }> = {
  command: { name: text('指挥中心', 'Command'), glyph: '⌘', cost: {}, yield: { energy: 7, food: 3, oxygen: 5 }, upkeep: 0 },
  solar: { name: text('光伏阵列', 'Solar array'), glyph: '▥', cost: { ore: 14 }, yield: { energy: 15 }, upkeep: 0 },
  mine: { name: text('采矿站', 'Mine'), glyph: '◆', cost: { ore: 18, energy: 8 }, yield: { ore: 13 }, upkeep: 5 },
  farm: { name: text('水培温室', 'Hydroponics'), glyph: '❋', cost: { ore: 22, energy: 8 }, yield: { food: 11 }, upkeep: 5 },
  recycler: { name: text('氧气循环站', 'O₂ recycler'), glyph: '◉', cost: { ore: 18, energy: 6 }, yield: { oxygen: 13 }, upkeep: 4 },
  lab: { name: text('科研实验室', 'Laboratory'), glyph: 'λ', cost: { ore: 24, energy: 12 }, yield: { science: 5 }, upkeep: 7 },
  habitat: { name: text('居住舱', 'Habitat'), glyph: '⌂', cost: { ore: 28, energy: 12 }, yield: {}, upkeep: 3 },
};
export const TECHNOLOGIES: Record<Technology, { name: Text; description: Text; cost: Partial<Resources> }> = {
  efficiency: { name: text('高效采掘', 'Efficient extraction'), description: text('矿石和科研产量提升 35%', 'Ore and research yield +35%'), cost: { science: 10, ore: 8 } },
  shielding: { name: text('辐射护盾', 'Radiation shielding'), description: text('阻止辐射事件的设施损伤', 'Prevents facility damage from radiation'), cost: { science: 12, ore: 10 } },
  hydroponics: { name: text('闭环生态', 'Closed-loop ecology'), description: text('温室和氧气产量提升 40%', 'Farm and oxygen yield +40%'), cost: { science: 14, ore: 10 } },
};
export const WEATHER_NAMES: Record<Weather, Text> = { clear: text('晴朗', 'Clear'), storm: text('沙尘暴', 'Dust storm'), radiation: text('辐射潮', 'Radiation') };
export function makeColony(seed = 1701): ColonyState {
  const rng = seeded(seed);
  const cells = Array.from({ length: 36 }, (_, id): ColonyCell => { const roll = rng(); return { id, terrain: roll < .18 ? 'crater' : roll < .4 ? 'ore' : roll < .54 ? 'ice' : 'plain', facility: null, hp: 100 }; });
  for (const id of [8, 9, 13, 14, 15, 16, 19, 20, 21, 22, 26]) cells[id].terrain = 'plain';
  cells[14].facility = 'command'; cells[8].facility = 'solar'; cells[13].terrain = 'ore'; cells[13].facility = 'mine'; cells[22].terrain = 'ore';
  return { seed, turn: 0, cells, resources: { ore: 88, energy: 70, food: 52, oxygen: 58, science: 0 }, population: 6, technologies: [], status: 'playing', weather: 'clear', log: [text('抵达 Kepler-17。18 回合内建立自持殖民地。', 'Landed on Kepler-17. Establish a self-sustaining colony within 18 turns.')], actions: [] };
}
export function colonyConnected(cells: ColonyCell[]): Set<number> {
  const start = cells.find(cell => cell.facility === 'command' && cell.hp > 0)?.id;
  const connected = new Set<number>(); if (start === undefined) return connected;
  const queue = [start];
  while (queue.length) { const id = queue.shift()!; if (connected.has(id)) continue; connected.add(id); for (const next of [id - 6, id + 6, ...(id % 6 ? [id - 1] : []), ...(id % 6 < 5 ? [id + 1] : [])]) if (next >= 0 && next < 36 && cells[next].facility && cells[next].hp > 0 && !connected.has(next)) queue.push(next); }
  return connected;
}
export function colonyWeather(seed: number, turn: number): Weather { const rng = seeded(seed ^ Math.imul(turn, 99877)); const n = rng(); return n < .2 ? 'storm' : n > .8 ? 'radiation' : 'clear'; }
export function colonyProjection(state: ColonyState, weather = colonyWeather(state.seed, state.turn + 1)): Resources {
  const connected = colonyConnected(state.cells);
  const delta: Resources = { ore: 0, energy: 0, food: -state.population, oxygen: -state.population * 1.3, science: 0 };
  for (const cell of state.cells) {
    if (!cell.facility || !connected.has(cell.id)) continue;
    const facility = FACILITIES[cell.facility];
    delta.energy -= facility.upkeep;
    for (const [key, amount] of Object.entries(facility.yield) as [Resource, number][]) {
      let multiplier = cell.hp < 45 ? .5 : 1;
      if (cell.facility === 'solar' && weather === 'storm') multiplier *= .3;
      if ((key === 'ore' || key === 'science') && state.technologies.includes('efficiency')) multiplier *= 1.35;
      if ((cell.facility === 'farm' || cell.facility === 'recycler') && state.technologies.includes('hydroponics')) multiplier *= 1.4;
      delta[key] += amount * multiplier;
    }
  }
  return Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, round(value)])) as Resources;
}
/** Actual reserve changes include storage capacity and depletion floors. */
export function colonyNextChanges(state: ColonyState): Resources {
  const production = colonyProjection(state);
  return Object.fromEntries(Object.entries(production).map(([key, delta]) => [key, round(clamp(state.resources[key as Resource] + delta, 0, 300) - state.resources[key as Resource])])) as Resources;
}
const canPay = (resources: Resources, cost: Partial<Resources>) => Object.entries(cost).every(([key, value]) => resources[key as Resource] >= value);
const pay = (resources: Resources, cost: Partial<Resources>): Resources => ({ ...resources, ...Object.fromEntries(Object.entries(cost).map(([key, value]) => [key, round(resources[key as Resource] - value)])) });
export function actColony(state: ColonyState, action: ColonyAction): Result<ColonyState> {
  if (state.status !== 'playing') return { state, error: 'colony-ended' };
  let next: ColonyState = { ...state, cells: state.cells.map(cell => ({ ...cell })), resources: { ...state.resources }, technologies: [...state.technologies], log: [...state.log], actions: [...state.actions, action] };
  if (action.type === 'build') {
    const cell = next.cells[action.cell];
    if (!cell || cell.facility || cell.terrain === 'crater' || action.facility === 'command') return { state, error: 'invalid-site' };
    if (action.facility === 'mine' && cell.terrain !== 'ore') return { state, error: 'requires-ore' };
    if (!canPay(state.resources, FACILITIES[action.facility].cost)) return { state, error: 'insufficient-resources' };
    next.resources = pay(next.resources, FACILITIES[action.facility].cost); cell.facility = action.facility; cell.hp = 100;
    if (action.facility === 'habitat') next.population += 2;
    next.log.push(text(`已建造${FACILITIES[action.facility].name.zh}，位置 ${action.cell + 1}。`, `${FACILITIES[action.facility].name.en} built at tile ${action.cell + 1}.`));
  } else if (action.type === 'repair') {
    const cell = next.cells[action.cell];
    if (!cell?.facility || cell.hp >= 100) return { state, error: 'nothing-to-repair' };
    if (!canPay(next.resources, { ore: 8, energy: 4 })) return { state, error: 'insufficient-resources' };
    next.resources = pay(next.resources, { ore: 8, energy: 4 }); cell.hp = 100;
    next.log.push(text(`设施 ${action.cell + 1} 修复完成。`, `Facility ${action.cell + 1} repaired.`));
  } else if (action.type === 'research') {
    if (state.technologies.includes(action.technology)) return { state, error: 'already-researched' };
    if (!canPay(next.resources, TECHNOLOGIES[action.technology].cost)) return { state, error: 'insufficient-resources' };
    next.resources = pay(next.resources, TECHNOLOGIES[action.technology].cost); next.technologies.push(action.technology);
    next.log.push(text(`研究完成：${TECHNOLOGIES[action.technology].name.zh}`, `Research complete: ${TECHNOLOGIES[action.technology].name.en}`));
  } else {
    next.turn++; next.weather = colonyWeather(state.seed, next.turn);
    const delta = colonyProjection(state, next.weather);
    for (const resource of Object.keys(delta) as Resource[]) {
      next.resources[resource] = round(clamp(next.resources[resource] + delta[resource], 0, 300));
      delta[resource] = round(next.resources[resource] - state.resources[resource]);
    }
    if (next.weather === 'radiation' && !next.technologies.includes('shielding')) for (const cell of next.cells) if (cell.facility && cell.facility !== 'command') cell.hp = Math.max(0, cell.hp - 18);
    if (next.resources.energy === 0) for (const cell of next.cells) if (cell.facility) cell.hp = Math.max(0, cell.hp - 12);
    if (next.resources.food <= 0 || next.resources.oxygen <= 0 || next.cells[14].hp <= 0) next.status = 'lost';
    else if (next.population >= 8 && next.resources.ore >= 100 && next.resources.science >= 20 && next.resources.food >= 35 && next.resources.oxygen >= 35) next.status = 'won';
    else if (next.turn >= 18) next.status = 'lost';
    next.log.push(text(`回合 ${next.turn} · ${WEATHER_NAMES[next.weather].zh} · 电力 ${delta.energy >= 0 ? '+' : ''}${delta.energy}，食物 ${delta.food >= 0 ? '+' : ''}${delta.food}`, `Turn ${next.turn} · ${WEATHER_NAMES[next.weather].en} · power ${delta.energy >= 0 ? '+' : ''}${delta.energy}, food ${delta.food >= 0 ? '+' : ''}${delta.food}`));
  }
  return { state: next };
}
export function replayColony(seed: number, actions: ReadonlyArray<ColonyAction>): ColonyState { return actions.reduce((state, action) => actColony(state, action).state, makeColony(seed)); }

// ── HABITAT TWIN ──────────────────────────────────────────────────────────────
export const BUILDINGS = [
  { id: 'A', name: text('办公塔楼', 'Office tower'), floors: 6, capacity: 36, x: -2.1, z: -1.65, base: 7, profile: 'office' },
  { id: 'B', name: text('研发中心', 'Research wing'), floors: 5, capacity: 24, x: 1.25, z: -1.65, base: 10, profile: 'office' },
  { id: 'C', name: text('人才公寓', 'Residences'), floors: 4, capacity: 18, x: -2.1, z: 1.75, base: 4, profile: 'home' },
  { id: 'D', name: text('能源站', 'Energy center'), floors: 2, capacity: 8, x: 1.25, z: 1.75, base: 16, profile: 'utility' },
] as const;
export interface TwinState { hour: number; setpoint: number; eco: boolean; occupancy: number; faults: string[]; budget: number; events: Text[] }
export interface TwinAsset { id: string; building: string; floor: number; capacity: number; occupants: number; temperature: number; co2: number; energy: number; fault: boolean; alert: boolean }
export const makeTwin = (): TwinState => ({ hour: 14, setpoint: 22, eco: false, occupancy: 100, faults: ['B-3'], budget: 4800, events: [text('B-3 冷却阀异常，已进入待处理队列。', 'B-3 cooling valve fault added to the maintenance queue.')] });
export function twinAssets(state: TwinState, hour = state.hour): TwinAsset[] {
  const outdoor = 23 + 8 * Math.sin((hour - 6) / 24 * Math.PI * 2);
  return BUILDINGS.flatMap(building => Array.from({ length: building.floors }, (_, index) => {
    const floor = index + 1; const id = `${building.id}-${floor}`;
    const profile = building.profile === 'office' ? (hour >= 8 && hour < 19 ? .76 : .08) : building.profile === 'home' ? (hour >= 18 || hour < 8 ? .86 : .28) : .42;
    const occupants = Math.round(clamp(building.capacity * profile * state.occupancy / 100 * (1 - index * .025), 0, building.capacity));
    const fault = state.faults.includes(id);
    const temperature = round(state.setpoint + (fault ? 6 : .15 * floor) + (state.eco ? .7 : 0));
    const co2 = Math.round(420 + occupants * (state.eco ? 25 : 17) + (fault ? 290 : 0));
    const energy = round((building.base + occupants * .14 + Math.max(0, outdoor - state.setpoint) * .8 + floor * .32) * (state.eco ? .8 : 1) * (fault ? 1.55 : 1));
    return { id, building: building.id, floor, capacity: building.capacity, occupants, temperature, co2, energy, fault, alert: co2 > 1000 || temperature > 27 };
  }));
}
export function twinDaily(state: TwinState) { return Array.from({ length: 24 }, (_, hour) => round(twinAssets(state, hour).reduce((sum, asset) => sum + asset.energy, 0))); }
export function twinComparison(state: TwinState) {
  const baseline = twinDaily({ ...state, setpoint: 22, eco: false }); const proposed = twinDaily(state);
  const before = round(baseline.reduce((a, b) => a + b, 0)); const after = round(proposed.reduce((a, b) => a + b, 0));
  return { baseline, proposed, before, after, savings: round(before - after), carbon: round((before - after) * .57), alerts: twinAssets(state).filter(asset => asset.alert).length };
}
export function twinIncident(state: TwinState, assetId: string): Result<TwinState> {
  if (!twinAssets(state).some(asset => asset.id === assetId)) return { state, error: 'invalid-asset' };
  if (state.faults.includes(assetId)) return { state, error: 'incident-exists' };
  return { state: { ...state, faults: [...state.faults, assetId], events: [...state.events, text(`${assetId} 模拟冷却故障，能耗和温度已联动更新。`, `${assetId} simulated cooling fault; energy and temperature updated.`)] } };
}
export function repairTwin(state: TwinState, assetId: string): Result<TwinState> {
  if (!state.faults.includes(assetId)) return { state, error: 'nothing-to-repair' };
  if (state.budget < 1200) return { state, error: 'maintenance-budget' };
  return { state: { ...state, faults: state.faults.filter(id => id !== assetId), budget: state.budget - 1200, events: [...state.events, text(`${assetId} 更换阀门，预算支出 ¥1,200。`, `${assetId} valve replaced; ¥1,200 maintenance cost.`)] } };
}

// ── STUDIO PIPELINE ───────────────────────────────────────────────────────────
export type Track = 'picture' | 'voice' | 'music' | 'graphics';
export interface StudioClip { id: string; title: Text; track: Track; start: number; duration: number; asset: string; version: number; enabled: boolean }
export interface StudioAsset { id: string; title: Text; tags: Text[]; scene: 'harbor' | 'city' | 'forest' | 'ridge' | 'sound' | 'type'; cleared: boolean; fee: number }
export interface StudioTask { id: string; title: Text; after: string[]; done: boolean; owner: string }
export interface StudioVersion { id: number; clips: StudioClip[]; cleared: string[] }
export interface StudioState { clips: StudioClip[]; assets: StudioAsset[]; tasks: StudioTask[]; budget: number; versions: StudioVersion[]; nextVersion: number; log: Text[] }
export interface StudioIssue { id: string; severity: 'error' | 'warning'; text: Text; clip?: string }
export const TRACK_NAMES: Record<Track, Text> = { picture: text('画面', 'PICTURE'), voice: text('旁白', 'VOICE'), music: text('配乐', 'MUSIC'), graphics: text('字幕 / 图形', 'GRAPHICS') };
const clip = (id: string, zh: string, en: string, track: Track, start: number, duration: number, asset: string): StudioClip => ({ id, title: text(zh, en), track, start, duration, asset, version: 1, enabled: true });
export function makeStudio(): StudioState { return {
  clips: [clip('s1', '01 / 蓝调港湾', '01 / Blue harbor', 'picture', 0, 8, 'harbor'), clip('s2', '02 / 城市呼吸', '02 / City breath', 'picture', 8, 8, 'city'), clip('s3', '03 / 林间微光', '03 / Forest light', 'picture', 16, 10, 'forest'), clip('s4', '04 / 越过山脊', '04 / Beyond the ridge', 'picture', 26, 8, 'ridge'), clip('v1', '旁白 A', 'Narration A', 'voice', 1, 7, 'voice'), clip('v2', '旁白 B', 'Narration B', 'voice', 11, 10, 'voice'), clip('m1', '氛围配乐', 'Ambient score', 'music', 0, 34, 'score'), clip('g1', '片头字卡', 'Opening title', 'graphics', 0, 3, 'title'), clip('g2', '片尾署名', 'End credits', 'graphics', 30, 4, 'title')],
  assets: [
    { id: 'harbor', title: text('晨光码头', 'Dawn harbor'), scene: 'harbor', cleared: true, fee: 340, tags: [text('外景', 'Exterior'), text('清晨', 'Dawn')] },
    { id: 'city', title: text('城市天际线', 'City skyline'), scene: 'city', cleared: true, fee: 520, tags: [text('航拍', 'Aerial'), text('建筑', 'Architecture')] },
    { id: 'forest', title: text('森林光束', 'Forest rays'), scene: 'forest', cleared: true, fee: 260, tags: [text('自然', 'Nature'), text('慢镜', 'Slow motion')] },
    { id: 'ridge', title: text('山脊剪影', 'Ridge silhouette'), scene: 'ridge', cleared: true, fee: 410, tags: [text('远景', 'Wide'), text('日落', 'Sunset')] },
    { id: 'voice', title: text('样本旁白占位', 'Narration placeholder'), scene: 'sound', cleared: true, fee: 280, tags: [text('人声', 'Voice')] },
    { id: 'score', title: text('氛围配乐占位', 'Score placeholder'), scene: 'sound', cleared: false, fee: 650, tags: [text('音乐', 'Music'), text('待确认授权', 'Rights pending')] },
    { id: 'title', title: text('极简标题设计', 'Minimal titles'), scene: 'type', cleared: true, fee: 180, tags: [text('字卡', 'Typography')] },
  ],
  tasks: [
    { id: 'brief', title: text('创意定稿', 'Creative brief'), after: [], done: true, owner: 'NOA' },
    { id: 'boards', title: text('分镜确认', 'Storyboard'), after: ['brief'], done: true, owner: 'MIA' },
    { id: 'rights', title: text('素材授权核验', 'Rights clearance'), after: ['boards'], done: false, owner: 'JUN' },
    { id: 'shoot', title: text('拍摄素材交付', 'Picture delivery'), after: ['rights'], done: false, owner: 'NOA' },
    { id: 'score', title: text('音乐设计交付', 'Score delivery'), after: ['rights'], done: false, owner: 'MIA' },
    { id: 'edit', title: text('剪辑锁版', 'Picture lock'), after: ['shoot', 'score'], done: false, owner: 'JUN' },
    { id: 'grade', title: text('调色与图形', 'Grade and graphics'), after: ['edit'], done: false, owner: 'MIA' },
    { id: 'review', title: text('制作校验', 'Production review'), after: ['grade'], done: false, owner: 'NOA' },
    { id: 'delivery', title: text('制作单交付', 'Manifest handoff'), after: ['review'], done: false, owner: 'JUN' },
  ], budget: 5200, versions: [], nextVersion: 1, log: [text('初始剪辑：34 秒 / 24 fps。配乐授权尚待确认。', 'Initial cut: 34 seconds / 24 fps. Score rights are pending.')] };
}
export const studioDuration = (state: StudioState) => Math.max(0, ...state.clips.filter(clip => clip.track === 'picture' && clip.enabled).map(clip => clip.start + clip.duration));
export function studioCost(state: StudioState) {
  const active = state.clips.filter(clip => clip.enabled); const used = new Set(active.map(clip => clip.asset));
  const licensing = state.assets.filter(asset => used.has(asset.id)).reduce((sum, asset) => sum + asset.fee * (active.some(clip => clip.asset === asset.id && clip.version === 2) ? 1.2 : 1), 0);
  const production = active.filter(clip => clip.track === 'picture').reduce((sum, clip) => sum + 150 + clip.duration * 38, 0);
  return { licensing: round(licensing), production: round(production), total: round(licensing + production) };
}
export function studioIssues(state: StudioState): StudioIssue[] {
  const issues: StudioIssue[] = []; const duration = studioDuration(state); const active = state.clips.filter(clip => clip.enabled);
  const picture = active.filter(clip => clip.track === 'picture').sort((a, b) => a.start - b.start);
  let end = 0;
  for (const clip of picture) { if (clip.start < end) issues.push({ id: `overlap-${clip.id}`, severity: 'error', clip: clip.id, text: text(`${clip.title.zh} 与前镜头重叠 ${round(end - clip.start)} 秒`, `${clip.title.en} overlaps the preceding shot by ${round(end - clip.start)}s`) }); else if (clip.start > end) issues.push({ id: `gap-${clip.id}`, severity: 'error', clip: clip.id, text: text(`画面在 ${end}–${clip.start} 秒有空档`, `Picture gap from ${end}s to ${clip.start}s`) }); end = Math.max(end, clip.start + clip.duration); }
  if (!picture.length) issues.push({ id: 'empty', severity: 'error', text: text('至少需要一个启用的画面片段', 'At least one picture clip must be enabled') });
  for (const clip of active) {
    const asset = state.assets.find(asset => asset.id === clip.asset);
    if (!asset || !asset.cleared) issues.push({ id: `rights-${clip.id}`, severity: 'error', clip: clip.id, text: text(`${clip.title.zh} 的素材授权未确认`, `Rights for ${clip.title.en} are not cleared`) });
    if (clip.track !== 'picture' && clip.start + clip.duration > duration) issues.push({ id: `tail-${clip.id}`, severity: 'warning', clip: clip.id, text: text(`${clip.title.zh} 超过成片时长`, `${clip.title.en} extends beyond the picture cut`) });
  }
  if (studioCost(state).total > state.budget) issues.push({ id: 'budget', severity: 'error', text: text('制作预算超限', 'Production exceeds the budget') });
  return issues;
}
function studioChanged(state: StudioState, log: Text): StudioState { return { ...state, tasks: state.tasks.map(task => ['edit', 'grade', 'review', 'delivery'].includes(task.id) ? { ...task, done: false } : task), log: [...state.log, log] }; }
export function updateStudioClip(state: StudioState, id: string, patch: Partial<Pick<StudioClip, 'start' | 'duration' | 'version' | 'enabled'>>, ripple = false): Result<StudioState> {
  const original = state.clips.find(clip => clip.id === id);
  if (!original || (patch.start !== undefined && (!Number.isFinite(patch.start) || patch.start < 0 || patch.start > 90)) || (patch.duration !== undefined && (!Number.isFinite(patch.duration) || patch.duration < 1 || patch.duration > 60)) || (patch.version !== undefined && ![1, 2].includes(patch.version))) return { state, error: 'invalid-clip' };
  const delta = patch.duration === undefined ? 0 : patch.duration - original.duration;
  const clips = state.clips.map(clip => clip.id === id ? { ...clip, ...patch } : ripple && clip.track === original.track && clip.start >= original.start + original.duration ? { ...clip, start: clip.start + delta } : clip);
  if (clips.some(clip => clip.start < 0 || clip.start > 90)) return { state, error: 'invalid-clip' };
  return { state: studioChanged({ ...state, clips }, text(`${original.title.zh} 已修改；剪辑后续签核已失效。`, `${original.title.en} updated; downstream editorial approvals invalidated.`)) };
}
export function clearStudioAsset(state: StudioState, assetId: string): Result<StudioState> {
  if (!state.assets.some(asset => asset.id === assetId)) return { state, error: 'invalid-asset' };
  return { state: studioChanged({ ...state, assets: state.assets.map(asset => asset.id === assetId ? { ...asset, cleared: true } : asset) }, text(`已模拟确认 ${assetId} 的授权。`, `Rights for ${assetId} marked cleared in this simulation.`)) };
}
export function finishStudioTask(state: StudioState, taskId: string): Result<StudioState> {
  const task = state.tasks.find(task => task.id === taskId);
  if (!task || task.done) return { state, error: 'task-complete' };
  if (task.after.some(id => !state.tasks.find(task => task.id === id)?.done)) return { state, error: 'task-dependency' };
  if (task.id === 'rights' && state.clips.some(clip => clip.enabled && !state.assets.find(asset => asset.id === clip.asset)?.cleared)) return { state, error: 'rights-pending' };
  if (['edit', 'review', 'delivery'].includes(task.id) && studioIssues(state).some(issue => issue.severity === 'error')) return { state, error: 'production-errors' };
  return { state: { ...state, tasks: state.tasks.map(item => item.id === taskId ? { ...item, done: true } : item), log: [...state.log, text(`${task.title.zh} 已完成。`, `${task.title.en} completed.`)] } };
}
export function saveStudioVersion(state: StudioState): StudioState { return { ...state, nextVersion: state.nextVersion + 1, versions: [...state.versions, { id: state.nextVersion, clips: state.clips.map(clip => ({ ...clip })), cleared: state.assets.filter(asset => asset.cleared).map(asset => asset.id) }], log: [...state.log, text(`已保存剪辑 V${state.nextVersion}。`, `Cut V${state.nextVersion} saved.`)] }; }
export function restoreStudioVersion(state: StudioState, versionId: number): Result<StudioState> {
  const version = state.versions.find(item => item.id === versionId); if (!version) return { state, error: 'invalid-version' };
  const restored = studioChanged({ ...state, clips: version.clips.map(clip => ({ ...clip })), assets: state.assets.map(asset => ({ ...asset, cleared: version.cleared.includes(asset.id) })), tasks: state.tasks.map(task => ['rights', 'shoot', 'score'].includes(task.id) ? { ...task, done: false } : task) }, text(`已恢复 V${versionId}；授权及制作签核需重新确认。`, `V${versionId} restored; rights and production approvals need rechecking.`));
  return { state: restored };
}

// ── STAY REVENUE ──────────────────────────────────────────────────────────────
export type RoomType = 'garden' | 'loft' | 'suite';
export type Channel = 'direct' | 'ota' | 'corporate';
export type DemandEvent = 'normal' | 'festival' | 'rain';
export const ROOMS: Record<RoomType, { name: Text; inventory: number; base: number }> = { garden: { name: text('庭院大床', 'Garden king'), inventory: 8, base: 680 }, loft: { name: text('江景复式', 'River loft'), inventory: 5, base: 1080 }, suite: { name: text('露台套房', 'Terrace suite'), inventory: 3, base: 1680 } };
export const CHANNELS: Record<Channel, { name: Text; commission: number }> = { direct: { name: text('官网直订', 'Direct'), commission: .03 }, ota: { name: text('旅行平台', 'OTA'), commission: .18 }, corporate: { name: text('企业协议', 'Corporate'), commission: .08 } };
export const HOTEL_DAYS = Array.from({ length: 14 }, (_, i) => ({ index: i, day: 12 + i, date: `2026-10-${12 + i}`, weekend: [5, 6, 12, 13].includes(i), festival: i >= 6 && i <= 8 }));
export interface Reservation { id: string; room: RoomType; quantity: number; checkIn: number; checkOut: number; channel: Channel; nightly: number[]; gross: number; net: number; status: 'confirmed' | 'cancelled' }
export interface HotelState { rates: Record<RoomType, number>; event: DemandEvent; directShare: number; reservations: Reservation[]; nextId: number; log: Text[] }
export type BookingRequest = Pick<Reservation, 'room' | 'quantity' | 'checkIn' | 'checkOut' | 'channel'>;
export function hotelRate(state: HotelState, room: RoomType, day: number) { const date = HOTEL_DAYS[day]; return round(state.rates[room] * (date.weekend ? 1.2 : 1) * (state.event === 'festival' && date.festival ? 1.15 : 1)); }
export function hotelInventory(state: HotelState, room: RoomType, day: number) { return ROOMS[room].inventory - state.reservations.filter(reservation => reservation.status === 'confirmed' && reservation.room === room && reservation.checkIn <= day && reservation.checkOut > day).reduce((sum, reservation) => sum + reservation.quantity, 0); }
export function quoteHotel(state: HotelState, request: BookingRequest): { nightly: number[]; gross: number; net: number; commission: number } {
  const nightly = Array.from({ length: Math.max(0, request.checkOut - request.checkIn) }, (_, i) => hotelRate(state, request.room, request.checkIn + i));
  const gross = round(nightly.reduce((sum, price) => sum + price, 0) * request.quantity); const commission = round(gross * CHANNELS[request.channel].commission);
  return { nightly, gross, net: round(gross - commission), commission };
}
export function reserveHotel(state: HotelState, request: BookingRequest): Result<HotelState> {
  if (!Number.isInteger(request.checkIn) || !Number.isInteger(request.checkOut) || request.checkIn < 0 || request.checkOut > 14 || request.checkOut <= request.checkIn) return { state, error: 'booking-dates' };
  if (!Number.isInteger(request.quantity) || request.quantity < 1 || request.quantity > ROOMS[request.room].inventory) return { state, error: 'booking-quantity' };
  for (let day = request.checkIn; day < request.checkOut; day++) if (hotelInventory(state, request.room, day) < request.quantity) return { state, error: 'booking-inventory' };
  const quote = quoteHotel(state, request); const id = `ST-${String(state.nextId).padStart(3, '0')}`;
  return { state: { ...state, reservations: [...state.reservations, { ...request, id, nightly: quote.nightly, gross: quote.gross, net: quote.net, status: 'confirmed' }], nextId: state.nextId + 1, log: [...state.log, text(`${id} 已预订 ${request.quantity} 间，${request.checkOut - request.checkIn} 晚。`, `${id} booked: ${request.quantity} rooms, ${request.checkOut - request.checkIn} nights.`)] } };
}
export function cancelHotel(state: HotelState, id: string): Result<HotelState> {
  const reservation = state.reservations.find(item => item.id === id);
  if (!reservation || reservation.status !== 'confirmed') return { state, error: 'booking-cancelled' };
  return { state: { ...state, reservations: state.reservations.map(item => item.id === id ? { ...item, status: 'cancelled' } : item), log: [...state.log, text(`${id} 已取消，全部间夜回补库存；未处理真实退款。`, `${id} cancelled, all room nights returned to inventory; no actual refund processed.`)] } };
}
export function makeHotel(): HotelState {
  let state: HotelState = { rates: { garden: 680, loft: 1080, suite: 1680 }, event: 'normal', directShare: 40, reservations: [], nextId: 1, log: [] };
  for (const request of [
    { room: 'garden', quantity: 4, checkIn: 0, checkOut: 4, channel: 'ota' }, { room: 'loft', quantity: 3, checkIn: 2, checkOut: 6, channel: 'direct' }, { room: 'suite', quantity: 2, checkIn: 5, checkOut: 9, channel: 'corporate' }, { room: 'garden', quantity: 6, checkIn: 6, checkOut: 10, channel: 'ota' }, { room: 'loft', quantity: 2, checkIn: 10, checkOut: 13, channel: 'direct' },
  ] as BookingRequest[]) state = reserveHotel(state, request).state;
  return { ...state, log: [text('已加载 5 笔虚构预订，覆盖 66 个间夜。', 'Loaded five fictional reservations covering 66 room nights.')] };
}
export function forecastHotel(state: HotelState) {
  const capacity = Object.values(ROOMS).reduce((sum, room) => sum + room.inventory, 0) * 14;
  const daily = HOTEL_DAYS.map(date => {
    let expectedRooms = 0; let net = 0;
    for (const room of Object.keys(ROOMS) as RoomType[]) {
      const available = hotelInventory(state, room, date.index); const occupied = ROOMS[room].inventory - available;
      const demandFactor = state.event === 'festival' && date.festival ? 1.4 : state.event === 'rain' ? .72 : 1;
      const target = ROOMS[room].inventory * (date.weekend ? .82 : .59) * demandFactor * Math.pow(hotelRate(state, room, date.index) / (ROOMS[room].base * (date.weekend ? 1.2 : 1)), -1.45);
      const additional = clamp(target - occupied, 0, available);
      const bookedNet = state.reservations.filter(r => r.status === 'confirmed' && r.room === room && r.checkIn <= date.index && r.checkOut > date.index).reduce((sum, r) => sum + r.nightly[date.index - r.checkIn] * r.quantity * (1 - CHANNELS[r.channel].commission), 0);
      expectedRooms += occupied + additional;
      const blendedCommission = state.directShare / 100 * .03 + (1 - state.directShare / 100) * .18;
      net += bookedNet + additional * hotelRate(state, room, date.index) * (1 - blendedCommission);
    }
    return { day: date.index, rooms: round(expectedRooms), net: round(net) };
  });
  const net = round(daily.reduce((sum, day) => sum + day.net, 0));
  const occupied = state.reservations.filter(r => r.status === 'confirmed').reduce((sum, r) => sum + r.quantity * (r.checkOut - r.checkIn), 0);
  return { daily, net, revpar: round(net / capacity), occupancy: round(daily.reduce((sum, day) => sum + day.rooms, 0) / capacity * 100), confirmedNights: occupied, bookedNet: round(state.reservations.filter(r => r.status === 'confirmed').reduce((sum, r) => sum + r.net, 0)) };
}

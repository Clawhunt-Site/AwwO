import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import './creative-demos.css';

type DemoProps = { locale: 'zh' | 'en' };
const copy = (locale: DemoProps['locale'], zh: string, en: string) => locale === 'zh' ? zh : en;
const money = (amount: number) => `¥${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

const PLANS = [
  { id: 'starter', name: 'Starter', price: 39, projects: 5, description: ['让好想法开始发生', 'A home for your next idea'] },
  { id: 'studio', name: 'Studio', price: 69, projects: 30, description: ['给默契协作的团队', 'Made for teams in flow'] },
  { id: 'scale', name: 'Scale', price: 129, projects: 100, description: ['容纳更大的可能性', 'Room for your next chapter'] },
] as const;

/** A complete, local pricing interaction. This fictional product does not initiate a checkout. */
export function InteractionDemo({ locale }: DemoProps) {
  const [planIndex, setPlanIndex] = useState(1);
  const [seats, setSeats] = useState(5);
  const [annual, setAnnual] = useState(true);
  const [savedQuote, setSavedQuote] = useState<string | null>(null);
  const id = useId();
  const plan = PLANS[planIndex];
  const monthly = Math.round(plan.price * seats * (annual ? 0.8 : 1) * 100) / 100;
  const billing = annual ? monthly * 12 : monthly;
  const change = (fn: () => void) => { fn(); setSavedQuote(null); };
  const t = (zh: string, en: string) => copy(locale, zh, en);
  return <section className="official-demo official-demo-orbit" aria-label={t('交互产品页面演示', 'Interactive product page demo')}>
    <header className="official-demo-orbit-nav"><span className="official-demo-orbit-wordmark"><span aria-hidden="true">◒</span> orbit</span><span className="official-demo-eyebrow">A SPACE TO MAKE</span><span className="official-demo-sample">{t('虚构产品 · 交互原型', 'Fictional product · interactive prototype')}</span></header>
    <div className="official-demo-orbit-layout">
      <div className="official-demo-orbit-config">
        <div className="official-demo-eyebrow">YOUR TEAM, IN ORBIT</div>
        <h3>{t('为下一个好想法，', 'Good ideas deserve')}<br /><em>{t('留出空间。', 'a little space.')}</em></h3>
        <p>{t('从两个人的灵感，到整个团队的创作。找到刚刚好的工作空间。', 'From a spark between two people to a whole team in flow. Find your fit.')}</p>
        <div className="official-demo-plans" role="group" aria-label={t('选择方案', 'Choose a plan')}>
          {PLANS.map((item, index) => <button type="button" key={item.id} aria-pressed={planIndex === index} onClick={() => change(() => setPlanIndex(index))}>
            <span>{item.name}</span><small>{money(item.price)}<span> / {t('人月', 'seat/mo')}</span></small>
          </button>)}
        </div>
        <div className="official-demo-team-label"><label htmlFor={`${id}-seats`}>{t('团队人数', 'Team size')}</label><span><strong>{seats}</strong> {t('人', 'people')}</span></div>
        <input id={`${id}-seats`} className="official-demo-range" type="range" min="1" max="30" value={seats} onChange={event => change(() => setSeats(Number(event.target.value)))} />
        <div className="official-demo-range-limits"><span>1 {t('人', 'person')}</span><span>30 {t('人', 'people')}</span></div>
        <div className="official-demo-billing" role="group" aria-label={t('账单周期', 'Billing cycle')}>
          <button type="button" aria-pressed={!annual} onClick={() => change(() => setAnnual(false))}>{t('按月付', 'Monthly')}</button>
          <button type="button" aria-pressed={annual} onClick={() => change(() => setAnnual(true))}>{t('按年付', 'Yearly')} <span>−20%</span></button>
        </div>
      </div>
      <aside className="official-demo-orbit-summary" aria-label={t('方案报价', 'Your quote')}>
        <div className="official-demo-orbit-art" aria-hidden="true"><div className="official-demo-orbit-ring" /><div className="official-demo-orbit-ball">o.</div><span className="official-demo-orbit-satellite">✦</span><span className="official-demo-orbit-smallball" /></div>
        <div className="official-demo-quote-top"><span>{plan.name}</span><span>{t('你的工作空间', 'YOUR WORKSPACE')}</span></div>
        <div className="official-demo-price"><output aria-label={t('每月总价', 'Monthly total')}>{money(monthly)}</output><span> / {t('月', 'mo')}</span></div>
        <p className="official-demo-quote-desc">{plan.description[locale === 'zh' ? 0 : 1]}</p>
        <ul className="official-demo-inclusions"><li><span>↗</span>{seats} {t('个团队席位', 'team seats')}</li><li><span>↗</span>{plan.projects} {t('个协作项目', 'shared projects')}</li><li><span>↗</span>{t('完整创作空间与版本历史', 'Creative workspace & version history')}</li></ul>
        <div className="official-demo-invoice"><span>{annual ? t('年度账单', 'Annual invoice') : t('月度账单', 'Monthly invoice')}</span><output aria-label={t('账单总额', 'Invoice total')}>{money(billing)}</output></div>
        <button type="button" className="official-demo-quote-cta" onClick={() => setSavedQuote(`${plan.name} · ${seats} ${t('人', 'seats')} · ${money(billing)} / ${annual ? t('年', 'year') : t('月', 'month')}`)}>{t('生成我的方案', 'Build my plan')}<span aria-hidden="true">↗</span></button>
        <p className="official-demo-quote-note" role="status" aria-label={t('方案状态', 'Plan status')}>{savedQuote ? `${t('本地方案已生成：', 'Local plan ready: ')}${savedQuote}` : t('演示报价，可自由调整，不产生订单。', 'Sample pricing. Explore freely; no order is placed.')}</p>
      </aside>
    </div>
  </section>;
}

const GAME_MAP = ['S..#...', '.#.#.#.', '.E...#.', '##.#...', '...#E#.', '.#...#.', 'E..#..X'];
const GAME_SIZE = GAME_MAP.length;
const CHARGES = GAME_MAP.flatMap((row, y) => [...row].flatMap((cell, x) => cell === 'E' ? [`${x},${y}`] : []));
type Direction = 'up' | 'right' | 'down' | 'left';
type GameState = { x: number; y: number; energy: number; moves: number; collected: string[]; status: 'playing' | 'won' | 'lost'; message: 'ready' | 'wall' | 'charge' | 'locked' | 'move' };
const freshGame = (): GameState => ({ x: 0, y: 0, energy: 22, moves: 0, collected: [], status: 'playing', message: 'ready' });
const DIRECTIONS: Record<Direction, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };

function moveGame(state: GameState, direction: Direction): GameState {
  if (state.status !== 'playing') return state;
  const [dx, dy] = DIRECTIONS[direction];
  const x = state.x + dx; const y = state.y + dy;
  if (x < 0 || y < 0 || x >= GAME_SIZE || y >= GAME_SIZE || GAME_MAP[y][x] === '#') return { ...state, message: 'wall' };
  const collectedCharge = CHARGES.includes(`${x},${y}`) && !state.collected.includes(`${x},${y}`);
  const collected = collectedCharge ? [...state.collected, `${x},${y}`] : state.collected;
  const energy = state.energy - 1 + (collectedCharge ? 7 : 0);
  const won = GAME_MAP[y][x] === 'X' && collected.length === CHARGES.length;
  return { x, y, collected, energy, moves: state.moves + 1, status: won ? 'won' : energy <= 0 ? 'lost' : 'playing', message: collectedCharge ? 'charge' : GAME_MAP[y][x] === 'X' ? 'locked' : 'move' };
}

/** A small deterministic puzzle with walls, pickups, a finite move budget and a real win condition. */
export function GameDemo({ locale }: DemoProps) {
  const [game, setGame] = useState<GameState>(freshGame);
  const arena = useRef<HTMLDivElement>(null);
  const id = useId();
  const t = (zh: string, en: string) => copy(locale, zh, en);
  const move = (direction: Direction) => setGame(previous => moveGame(previous, direction));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || document.activeElement !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = ({ ArrowUp: 'up', w: 'up', ArrowRight: 'right', d: 'right', ArrowDown: 'down', s: 'down', ArrowLeft: 'left', a: 'left' } as Record<string, Direction>)[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!direction) return;
    event.preventDefault(); move(direction);
  };
  const message = game.status === 'won' ? t('信号已连接。全部能量节点收集完成！', 'Signal connected. Every energy node recovered!')
    : game.status === 'lost' ? t('能量耗尽。重新规划路线，再试一次。', 'Out of energy. Rethink your route and try again.')
      : ({ ready: t('收集 3 个能量节点，抵达右下角出口。', 'Collect 3 energy nodes, then reach the bottom-right exit.'), wall: t('这里无法通过。换一条路线。', 'Path blocked. Try another route.'), charge: t('能量节点已收集，补充 7 点能量。', 'Node recovered. +7 energy.'), locked: t('出口尚未解锁，先收集全部能量节点。', 'Exit locked. Recover every energy node first.'), move: t('继续前进，每移动一格消耗 1 点能量。', 'Keep going. Every step costs 1 energy.') } satisfies Record<GameState['message'], string>)[game.message];
  return <section className="official-demo official-demo-game" aria-label={t('Signal Run 游戏原型', 'Signal Run game prototype')}>
    <header className="official-demo-game-header"><div><div className="official-demo-eyebrow"><span className="official-demo-signal-dot" /> SECTOR 07 / LOGIC PUZZLE</div><h3>Signal<span>Run</span><span className="official-demo-title-dot">.</span></h3></div><span className="official-demo-game-badge">{t('可玩原型', 'PLAYABLE')}</span></header>
    <div className="official-demo-game-layout">
      <div className="official-demo-game-arena" ref={arena} tabIndex={0} role="group" aria-label={t('游戏区域，使用方向键或 WASD 移动', 'Game area. Use arrow keys or WASD to move')} aria-describedby={`${id}-game-instructions`} onKeyDown={onKeyDown} onClick={() => arena.current?.focus()}>
        <div className="official-demo-game-grid" role="img" aria-label={t(`7 乘 7 迷宫，角色位于第 ${game.y + 1} 行第 ${game.x + 1} 列，已收集 ${game.collected.length} 个节点`, `7 by 7 maze. Player at row ${game.y + 1}, column ${game.x + 1}. ${game.collected.length} nodes collected`)}>
          {GAME_MAP.flatMap((row, y) => [...row].map((cell, x) => {
            const player = x === game.x && y === game.y;
            const charge = cell === 'E' && !game.collected.includes(`${x},${y}`);
            return <div key={`${x},${y}`} aria-hidden="true" className={`official-demo-game-cell${cell === '#' ? ' official-demo-cell-wall' : ''}${cell === 'X' ? ' official-demo-cell-exit' : ''}${game.collected.includes(`${x},${y}`) ? ' official-demo-cell-collected' : ''}`}>
              {player ? <span className={`official-demo-player${game.status === 'lost' ? ' official-demo-player-lost' : ''}`}>✦</span> : charge ? <span className="official-demo-charge">◆</span> : cell === 'X' ? <span className={game.collected.length === CHARGES.length ? 'official-demo-exit-open' : ''}>↗</span> : cell === 'S' ? <span className="official-demo-start">·</span> : null}
            </div>;
          }))}
        </div>
        <div className="official-demo-grid-coordinates" aria-hidden="true"><span>00 : 00</span><span>06 : 06</span></div>
      </div>
      <div className="official-demo-game-console">
        <div className="official-demo-mission-title">01 / {t('恢复信号', 'RESTORE THE SIGNAL')}</div>
        <p id={`${id}-game-instructions`}>{t('点击棋盘后，用方向键 / WASD，或下方方向按钮移动。收集 ◆ 补充能量，再前往 ↗。', 'Focus the board to use arrows / WASD, or use the direction buttons. Collect ◆ for energy, then reach ↗.')}</p>
        <div className="official-demo-game-stats"><div><span>{t('能量', 'ENERGY')}</span><output aria-label={t('剩余能量', 'Energy left')}>{game.energy.toString().padStart(2, '0')}</output><div className="official-demo-energy-track"><span style={{ width: `${Math.min(100, game.energy / 22 * 100)}%` }} /></div></div><div><span>{t('节点', 'NODES')}</span><output aria-label={t('已收集节点', 'Collected nodes')}>{game.collected.length}<small> / 3</small></output></div><div><span>{t('步数', 'STEPS')}</span><output aria-label={t('移动步数', 'Move count')}>{game.moves.toString().padStart(2, '0')}</output></div></div>
        <div className={`official-demo-game-status official-demo-game-status-${game.status}`} role="status" aria-label={t('游戏状态', 'Game status')}>{message}</div>
        <div className="official-demo-game-actions"><div className="official-demo-dpad" role="group" aria-label={t('方向控制', 'Movement controls')}>{(['up', 'left', 'down', 'right'] as const).map(direction => <button type="button" key={direction} className={`official-demo-direction-${direction}`} aria-label={t(({ up: '向上', left: '向左', down: '向下', right: '向右' })[direction], `Move ${direction}`)} disabled={game.status !== 'playing'} onClick={() => move(direction)}>{({ up: '↑', left: '←', down: '↓', right: '→' })[direction]}</button>)}</div><button type="button" className="official-demo-game-reset" onClick={() => { setGame(freshGame()); arena.current?.focus(); }}>{t('重新开始', 'Restart')} <span aria-hidden="true">↺</span></button></div>
        <div className="official-demo-game-legend"><span><i>◆</i> +7 {t('能量', 'energy')}</span><span><i>↗</i> {t('出口', 'exit')}</span><span><i>▦</i> {t('障碍', 'wall')}</span></div>
      </div>
    </div>
  </section>;
}

type Vec3 = [number, number, number];
type Face = { id: string; vertices: Vec3[]; normal: Vec3; kind: 'body' | 'base'; front?: boolean; top?: boolean };
const PRODUCT_RING: [number, number][] = [[-.72, -.68], [.72, -.68], [.94, -.46], [.94, .46], [.72, .68], [-.72, .68], [-.94, .46], [-.94, -.46]];
const PRODUCT_FACES: Face[] = [
  ...PRODUCT_RING.map(([x, z], index): Face => {
    const [nx, nz] = PRODUCT_RING[(index + 1) % PRODUCT_RING.length];
    return { id: `body-${index}`, vertices: [[x, -1.42, z], [nx, -1.42, nz], [nx, 1.42, nz], [x, 1.42, z]], normal: [x + nx, 0, z + nz], kind: 'body', front: index === 4 };
  }),
  { id: 'top', vertices: PRODUCT_RING.map(([x, z]) => [x, 1.42, z]), normal: [0, 1, 0], kind: 'body', top: true },
  { id: 'bottom', vertices: PRODUCT_RING.map(([x, z]) => [x, -1.42, z]), normal: [0, -1, 0], kind: 'body' },
  { id: 'base-top', vertices: Array.from({ length: 48 }, (_, i) => [Math.cos(i * Math.PI / 24) * 2.2, -1.7, Math.sin(i * Math.PI / 24) * 2.2] as Vec3), normal: [0, 1, 0], kind: 'base' },
  ...Array.from({ length: 48 }, (_, i): Face => {
    const a = i * Math.PI / 24; const b = (i + 1) * Math.PI / 24;
    return { id: `base-${i}`, vertices: [[Math.cos(a) * 2.2, -1.7, Math.sin(a) * 2.2], [Math.cos(b) * 2.2, -1.7, Math.sin(b) * 2.2], [Math.cos(b) * 2.2, -1.9, Math.sin(b) * 2.2], [Math.cos(a) * 2.2, -1.9, Math.sin(a) * 2.2]], normal: [Math.cos(a + Math.PI / 48), 0, Math.sin(a + Math.PI / 48)], kind: 'base' };
  }),
];
const FINISHES = [{ name: ['岩灰', 'Graphite'], color: '#5a6567' }, { name: ['陶土', 'Terracotta'], color: '#bc795e' }, { name: ['苔绿', 'Moss'], color: '#87997e' }] as const;
const rotatePoint = ([x, y, z]: Vec3, yaw: number, pitch: number): Vec3 => {
  const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
  const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
  return [rx, y * Math.cos(pitch) - rz * Math.sin(pitch), y * Math.sin(pitch) + rz * Math.cos(pitch)];
};
const shade = (hex: string, brightness: number) => `rgb(${[1, 3, 5].map(start => Math.min(255, Math.round(parseInt(hex.slice(start, start + 2), 16) * brightness))).join(',')})`;

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Perspective projection of actual 3D geometry, with face culling, lighting and orbit controls. */
export function SceneDemo({ locale }: DemoProps) {
  const [camera, setCamera] = useState({ yaw: -.55, pitch: .3 });
  const [zoom, setZoom] = useState(100);
  const [finish, setFinish] = useState(1);
  const [autoRotate, setAutoRotate] = useState(false);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number; pointerId: number } | null>(null);
  const reduced = useReducedMotion();
  const id = useId();
  const t = (zh: string, en: string) => copy(locale, zh, en);
  const spinning = autoRotate && !reduced;
  useEffect(() => {
    if (!spinning) return;
    let frame = 0; let previous: number | undefined;
    const tick = (now: number) => {
      if (previous !== undefined) { const delta = Math.min(now - previous, 40); setCamera(value => ({ ...value, yaw: value.yaw + delta * .00025 })); }
      previous = now; frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [spinning]);
  const scene = useMemo(() => {
    const rotate = (point: Vec3) => rotatePoint(point, camera.yaw, camera.pitch);
    const project = (point: Vec3): [number, number] => { const [x, y, z] = rotate(point); const scale = (zoom / 100) * 560 / (7 - z); return [300 + x * scale, 218 - y * scale]; };
    const points = (vertices: Vec3[]) => vertices.map(vertex => project(vertex).map(n => n.toFixed(2)).join(',')).join(' ');
    const faces = PRODUCT_FACES.map(face => {
      const center = face.vertices.reduce<Vec3>((result, point) => [result[0] + point[0] / face.vertices.length, result[1] + point[1] / face.vertices.length, result[2] + point[2] / face.vertices.length], [0, 0, 0]);
      const [x, y, z] = rotate(center); const [nx, ny, nz] = rotate(face.normal);
      const visible = nx * -x + ny * -y + nz * (7 - z) > 0;
      const length = Math.hypot(nx, ny, nz);
      const light = .68 + .32 * Math.max(0, (-nx * .45 + ny * .65 + nz * .6) / length);
      return { ...face, visible, depth: z, points: points(face.vertices), fill: shade(face.kind === 'base' ? '#e2ded5' : FINISHES[finish].color, light) };
    }).filter(face => face.visible).sort((a, b) => a.depth - b.depth);
    return { faces, project, points };
  }, [camera, zoom, finish]);
  const pointerStart = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    setAutoRotate(false); event.currentTarget.focus();
    drag.current = { x: event.clientX, y: event.clientY, ...camera, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setCamera({ yaw: start.yaw + (event.clientX - start.x) * .009, pitch: Math.max(-.45, Math.min(.8, start.pitch + (event.clientY - start.y) * .007)) });
  };
  const cameraKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); setAutoRotate(false);
    setCamera(value => ({ yaw: value.yaw + (event.key === 'ArrowLeft' ? -.15 : event.key === 'ArrowRight' ? .15 : 0), pitch: Math.max(-.45, Math.min(.8, value.pitch + (event.key === 'ArrowUp' ? .1 : event.key === 'ArrowDown' ? -.1 : 0))) }));
  };
  const frontDots = Array.from({ length: 112 }, (_, index) => {
    const x = -.55 + (index % 8) * .157; const y = -.93 + Math.floor(index / 8) * .158;
    return Array.from({ length: 8 }, (_, i) => [x + Math.cos(i * Math.PI / 4) * .022, y + Math.sin(i * Math.PI / 4) * .022, .684] as Vec3);
  });
  return <section className="official-demo official-demo-scene" aria-label={t('三维产品展台', '3D product showcase')}>
    <header className="official-demo-scene-header"><div><span className="official-demo-eyebrow">OBJECTS FOR QUIET MOMENTS</span><h3>FIELD <span>/ 01</span></h3></div><span className="official-demo-scene-tag">{t('交互式 3D 展台', 'INTERACTIVE 3D')}</span></header>
    <div className="official-demo-scene-layout"><div className="official-demo-scene-stage">
      <svg viewBox="0 0 600 470" role="img" aria-label={t('三维音箱，可拖拽或使用方向键旋转', '3D speaker. Drag or use arrow keys to rotate')} aria-describedby={`${id}-scene-help`} tabIndex={0} onPointerDown={pointerStart} onPointerMove={pointerMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={cameraKey}>
        <defs><radialGradient id={`${id}-shadow`}><stop offset="0" stopColor="#605443" stopOpacity=".2" /><stop offset="1" stopColor="#605443" stopOpacity="0" /></radialGradient></defs>
        <ellipse cx="300" cy="360" rx="210" ry="68" fill={`url(#${id}-shadow)`} />
        <g stroke="#d9d5cb" strokeWidth=".7" opacity=".6">{Array.from({ length: 9 }, (_, i) => i - 4).flatMap(i => [<polyline key={`x${i}`} fill="none" points={scene.points([[i, -1.94, -4], [i, -1.94, 4]])} />, <polyline key={`z${i}`} fill="none" points={scene.points([[-4, -1.94, i], [4, -1.94, i]])} />])}</g>
        {scene.faces.map(face => <g key={face.id} data-face={face.id}><polygon points={face.points} fill={face.fill} stroke={face.fill} strokeWidth=".6" />
          {face.front && <g>{frontDots.map((vertices, index) => <polygon key={index} points={scene.points(vertices)} fill="#1e2a2b" opacity=".48" />)}<polygon points={scene.points([[-.17, -1.21, .685], [.17, -1.21, .685], [.17, -1.15, .685], [-.17, -1.15, .685]])} fill="#edebde" opacity=".85" /></g>}
          {face.top && <g>{[-.28, 0, .28].map((x, index) => <polygon key={x} points={scene.points(Array.from({ length: 16 }, (_, i) => [x + Math.cos(i * Math.PI / 8) * .064, 1.424, Math.sin(i * Math.PI / 8) * .064] as Vec3))} fill={index === 1 ? '#dfe7cd' : '#33403b'} opacity=".8" />)}</g>}
        </g>)}
        <text x="28" y="442" fill="#858378" fontSize="10" letterSpacing="2">PERSPECTIVE / 3D MESH</text><text x="572" y="442" textAnchor="end" fill="#858378" fontSize="10" letterSpacing="1">{zoom}%</text>
      </svg>
      <p id={`${id}-scene-help`} className="official-demo-scene-help">↔ {t('拖拽旋转 · 聚焦后用方向键调整视角', 'Drag to orbit · Focus and use arrow keys')}</p>
    </div><aside className="official-demo-scene-controls">
      <span className="official-demo-eyebrow">PORTABLE SOUND</span><h4>{t('把声音，', 'Sound for')}<br />{t('放回生活。', 'slower days.')}</h4><p>{t('一个可触摸、可探索的产品故事。每个面，都来自真实三维坐标。', 'An object to turn, explore and make your own. Every face is projected from 3D coordinates.')}</p>
      <div className="official-demo-finish-label">{t('材质配色', 'FINISH')}<output>{FINISHES[finish].name[locale === 'zh' ? 0 : 1]}</output></div>
      <div className="official-demo-swatches" role="group" aria-label={t('选择配色', 'Choose a finish')}>{FINISHES.map((item, index) => <button key={item.color} type="button" aria-label={item.name[locale === 'zh' ? 0 : 1]} aria-pressed={index === finish} style={{ '--official-demo-swatch': item.color } as CSSProperties} onClick={() => setFinish(index)}><span /></button>)}</div>
      <label className="official-demo-zoom-label" htmlFor={`${id}-zoom`}>{t('缩放', 'ZOOM')}<output>{zoom}%</output></label><input className="official-demo-range" id={`${id}-zoom`} type="range" min="65" max="125" value={zoom} onChange={event => setZoom(Number(event.target.value))} />
      <div className="official-demo-views" role="group" aria-label={t('预设视角', 'Camera presets')}>{([{ zh: '正面', en: 'Front', yaw: 0, pitch: 0 }, { zh: '透视', en: 'Perspective', yaw: -.55, pitch: .3 }, { zh: '俯视', en: 'Above', yaw: -.55, pitch: .78 }] as const).map(view => <button key={view.en} type="button" onClick={() => { setAutoRotate(false); setCamera({ yaw: view.yaw, pitch: view.pitch }); }}>{locale === 'zh' ? view.zh : view.en}</button>)}</div>
      <button className="official-demo-spin" type="button" disabled={reduced} aria-pressed={spinning} onClick={() => setAutoRotate(value => !value)}>{spinning ? 'Ⅱ' : '↻'} {reduced ? t('已遵循减少动态效果设置', 'Reduced motion enabled') : spinning ? t('暂停旋转', 'Pause rotation') : t('自动旋转', 'Auto rotate')}</button>
      <p className="official-demo-scene-footnote">{t('本地三维渲染 · 无需下载模型', 'Rendered locally · no model download')}</p>
    </aside></div>
  </section>;
}

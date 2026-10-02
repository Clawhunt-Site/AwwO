import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdvancedCreativeDemo } from '../src/saas/examples/advanced/AdvancedCreativeDemos';
import { CREATIVE_CASES } from '../src/saas/examples/advanced/creativeCatalog';
import { actColony, BUILDINGS, cancelHotel, clearStudioAsset, colonyConnected, colonyNextChanges, colonyProjection, colonyWeather, finishStudioTask, forecastHotel, hotelInventory, makeColony, makeHotel, makeStudio, makeTwin, quoteHotel, repairTwin, replayColony, reserveHotel, restoreStudioVersion, saveStudioVersion, studioCost, studioDuration, studioIssues, twinAssets, twinComparison, twinIncident, updateStudioClip } from '../src/saas/examples/advanced/creativeEngine';
import type { BookingRequest, ColonyAction, ColonyState, RoomType } from '../src/saas/examples/advanced/creativeEngine';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// This path uses only valid player actions from the public initial state, including
// expansion, two research investments, a dust storm and the actual win evaluator.
const winningActions: ColonyAction[] = [
  { type: 'build', cell: 15, facility: 'lab' }, { type: 'build', cell: 20, facility: 'farm' },
  { type: 'build', cell: 21, facility: 'recycler' }, { type: 'build', cell: 9, facility: 'solar' },
  { type: 'turn' }, { type: 'build', cell: 22, facility: 'mine' }, { type: 'turn' },
  { type: 'research', technology: 'efficiency' }, { type: 'turn' },
  { type: 'build', cell: 19, facility: 'habitat' }, { type: 'turn' },
  { type: 'research', technology: 'shielding' }, { type: 'turn' }, { type: 'turn' }, { type: 'turn' },
];

describe('official creative workflow contract', () => {
  it.each(CREATIVE_CASES)('$id has a connected, bounded industry DAG with concrete HTML and bilingual contracts', item => {
    expect(item.capabilities.length).toBeGreaterThanOrEqual(6);
    expect(item.datasets.length).toBeGreaterThanOrEqual(2);
    expect(item.steps.length).toBeGreaterThanOrEqual(11);
    expect(item.steps.length).toBeLessThanOrEqual(14);
    const seen = new Set<string>(); const dependencies = new Map<string, number>();
    for (const step of item.steps) {
      expect(seen.has(step.id)).toBe(false);
      for (const parent of step.after) { expect(seen.has(parent)).toBe(true); dependencies.set(parent, (dependencies.get(parent) ?? 0) + 1); }
      seen.add(step.id);
      for (const field of [step.title, step.task, step.output, ...step.acceptance]) {
        expect(field.zh.length).toBeGreaterThan(0); expect(field.en.length).toBeGreaterThan(0);
      }
    }
    expect(item.steps.filter(step => step.after.length === 0)).toHaveLength(1);
    expect(item.steps.some(step => step.after.length > 1)).toBe(true);
    expect([...dependencies.values()].some(count => count > 1)).toBe(true);
    expect(item.steps.filter(step => step.outputType === 'html').length).toBeGreaterThanOrEqual(2);
    expect(item.brief.zh.length).toBeGreaterThan(150);
  });
});

describe('colony: deterministic strategy and resource integrity', () => {
  it('wins through legal actions and reconstructs the entire result by replay', () => {
    let state = makeColony(1701);
    for (const action of winningActions) { const result = actColony(state, action); expect(result.error).toBeUndefined(); state = result.state; }
    expect(state).toMatchObject({ turn: 7, status: 'won', population: 8, resources: { ore: 160.5, energy: 73, food: 100, oxygen: 119, science: 21.75 } });
    expect(state.technologies).toEqual(['efficiency', 'shielding']);
    expect(replayColony(1701, JSON.parse(JSON.stringify(state.actions)))).toEqual(state);
    expect(actColony(state, { type: 'turn' })).toEqual({ state, error: 'colony-ended' });
    expect(makeColony(1702).cells).not.toEqual(makeColony(1701).cells);
  });
  it('rejects invalid builds and unpaid research without charging or recording an action', () => {
    const state = makeColony();
    for (const action of [{ type: 'build', cell: 14, facility: 'lab' }, { type: 'build', cell: 15, facility: 'mine' }, { type: 'research', technology: 'shielding' }, { type: 'repair', cell: 14 }] as ColonyAction[]) {
      const result = actColony(state, action); expect(result.error).toBeTruthy(); expect(result.state).toBe(state);
    }
    expect(state.resources.ore).toBe(88); expect(state.actions).toHaveLength(0);
  });
  it('does not wrap a row or produce from isolated/dead infrastructure', () => {
    const state = makeColony(); const cells = state.cells.map(cell => ({ ...cell, facility: null, hp: 100 })) as ColonyState['cells'];
    cells[5].facility = 'command'; cells[6].facility = 'lab'; cells[4].facility = 'solar'; cells[3].facility = 'lab'; cells[3].hp = 0;
    expect([...colonyConnected(cells)].sort()).toEqual([4, 5]);
    const projection = colonyProjection({ ...state, cells }, 'clear');
    expect(projection.science).toBe(0); expect(projection.energy).toBe(22);
  });
  it('reduces solar in a storm and honors damage-before-next-yield and shielding', () => {
    const initial = makeColony();
    expect(colonyProjection(initial, 'clear').energy - colonyProjection(initial, 'storm').energy).toBe(10.5);
    const radiationTurn = Array.from({ length: 18 }, (_, i) => i + 1).find(turn => colonyWeather(1701, turn) === 'radiation')!;
    expect(radiationTurn).toBeDefined();
    const state = { ...initial, turn: radiationTurn - 1 };
    const unprotected = actColony(state, { type: 'turn' }).state;
    const protectedState = actColony({ ...state, technologies: ['shielding'] }, { type: 'turn' }).state;
    expect(unprotected.cells[8].hp).toBe(82); expect(protectedState.cells[8].hp).toBe(100);
    const repaired = actColony(unprotected, { type: 'repair', cell: 8 }).state;
    expect(repaired.cells[8].hp).toBe(100); expect(repaired.resources.ore).toBe(unprotected.resources.ore - 8);
    const damaged = { ...initial, cells: initial.cells.map(cell => cell.id === 13 ? { ...cell, hp: 44 } : cell) };
    expect(colonyProjection(damaged, 'clear').ore).toBe(6.5);
  });
  it('prioritizes survival loss and bounds every resource over repeated no-build runs', () => {
    for (const seed of [1, 23, 1701, 8431, 999999]) {
      let state = makeColony(seed); for (let turn = 0; turn < 18 && state.status === 'playing'; turn++) state = actColony(state, { type: 'turn' }).state;
      expect(state.status).toBe('lost'); expect(state.turn).toBeLessThanOrEqual(18);
      for (const resource of Object.values(state.resources)) { expect(resource).toBeGreaterThanOrEqual(0); expect(resource).toBeLessThanOrEqual(300); }
    }
    const initial = makeColony();
    expect(actColony({ ...initial, resources: { ...initial.resources, food: 1, ore: 300, science: 300 }, population: 8 }, { type: 'turn' }).state.status).toBe('lost');
  });
  it('forecasts actual reserve changes at the storage cap and depletion floor', () => {
    const initial = makeColony(); const state = { ...initial, resources: { ...initial.resources, ore: 297, energy: 300, food: 1 } };
    const changes = colonyNextChanges(state); const next = actColony(state, { type: 'turn' }).state;
    expect(changes.ore).toBe(3); expect(changes.energy).toBe(0); expect(changes.food).toBe(-1);
    for (const key of Object.keys(changes) as Array<keyof typeof changes>) expect(changes[key]).toBeCloseTo(next.resources[key] - state.resources[key], 2);
  });
});

describe('campus twin: coupled assets, energy and maintenance', () => {
  it('projects every building floor into independent sensor assets and uses occupancy schedules', () => {
    const state = makeTwin(); const assets = twinAssets(state);
    expect(assets).toHaveLength(17); expect(new Set(assets.map(asset => asset.id)).size).toBe(17);
    expect(assets.reduce((sum, asset) => sum + asset.capacity, 0)).toBe(424);
    expect(BUILDINGS.map(building => assets.filter(asset => asset.building === building.id).length)).toEqual([6, 5, 4, 2]);
    expect(twinAssets(state, 3).find(asset => asset.id === 'A-1')!.occupants).toBeLessThan(assets.find(asset => asset.id === 'A-1')!.occupants);
    expect(twinAssets(state, 3).find(asset => asset.id === 'C-1')!.occupants).toBeGreaterThan(assets.find(asset => asset.id === 'C-1')!.occupants);
  });
  it('compares equal-occupancy/fault scenarios and expresses the energy/air-quality tradeoff', () => {
    const baseline = makeTwin(); const eco = { ...baseline, eco: true, setpoint: 24 };
    const initial = twinComparison(baseline); const proposal = twinComparison(eco);
    expect(initial.savings).toBe(0); expect(proposal.baseline).toEqual(initial.baseline);
    expect(proposal.savings).toBeGreaterThan(0); expect(proposal.proposed).toHaveLength(24);
    expect(twinAssets(eco)[0].co2).toBeGreaterThan(twinAssets(baseline)[0].co2);
    expect(twinAssets(eco)[0].temperature).toBeGreaterThan(twinAssets(baseline)[0].temperature);
    expect(proposal.carbon).toBeCloseTo(proposal.savings * .57, 1);
  });
  it('repairs exactly once and rejects faults and budget overspend atomically', () => {
    let state = makeTwin(); const faulty = twinAssets(state).find(asset => asset.id === 'B-3')!;
    expect(twinIncident(state, 'B-3')).toEqual({ state, error: 'incident-exists' });
    state = repairTwin(state, 'B-3').state;
    const repaired = twinAssets(state).find(asset => asset.id === 'B-3')!;
    expect(state.budget).toBe(3600); expect(repaired.energy).toBeLessThan(faulty.energy); expect(repaired.co2).toBe(faulty.co2 - 290);
    expect(repairTwin(state, 'B-3').state).toBe(state);
    for (const id of ['A-1', 'A-2', 'A-3']) { state = twinIncident(state, id).state; state = repairTwin(state, id).state; }
    state = twinIncident(state, 'D-1').state;
    expect(repairTwin(state, 'D-1')).toEqual({ state, error: 'maintenance-budget' });
    expect(state.budget).toBe(0); expect(state.faults).toContain('D-1');
  });
});

const approvedStudio = () => {
  let state = clearStudioAsset(makeStudio(), 'score').state;
  for (const id of ['rights', 'shoot', 'score', 'edit', 'grade', 'review', 'delivery']) { const result = finishStudioTask(state, id); expect(result.error).toBeUndefined(); state = result.state; }
  return state;
};
describe('film production: editorial topology, costs and invalidation', () => {
  it('enforces rights and two parallel delivery dependencies before picture lock', () => {
    let state = makeStudio();
    expect(finishStudioTask(state, 'rights').error).toBe('rights-pending');
    expect(finishStudioTask(state, 'edit').error).toBe('task-dependency');
    state = clearStudioAsset(state, 'score').state; state = finishStudioTask(state, 'rights').state; state = finishStudioTask(state, 'shoot').state;
    expect(finishStudioTask(state, 'edit').error).toBe('task-dependency');
    expect(approvedStudio().tasks.every(task => task.done)).toBe(true);
  });
  it('ripples only later clips on the same track and recalculates budget without double-counting assets', () => {
    const initial = makeStudio(); const state = updateStudioClip(initial, 's1', { duration: 11 }, true).state;
    expect(state.clips.filter(clip => clip.track === 'picture').map(clip => clip.start)).toEqual([0, 11, 19, 29]);
    expect(state.clips.find(clip => clip.id === 'v2')!.start).toBe(11); expect(studioDuration(state)).toBe(37);
    expect(studioCost(initial)).toEqual({ licensing: 2640, production: 1892, total: 4532 });
    expect(studioCost(state).total - studioCost(initial).total).toBe(3 * 38);
    expect(studioCost(updateStudioClip(initial, 'v1', { version: 2 }).state).licensing).toBe(2696);
    expect(studioIssues(state).some(issue => issue.id.startsWith('gap-') || issue.id.startsWith('overlap-'))).toBe(false);
  });
  it('detects gaps, overlaps, budget overruns and out-of-cut audio and blocks erroneous approval', () => {
    const state = clearStudioAsset(makeStudio(), 'score').state;
    expect(studioIssues(updateStudioClip(state, 's2', { start: 7 }).state).some(issue => issue.id === 'overlap-s2')).toBe(true);
    expect(studioIssues(updateStudioClip(state, 's2', { start: 9 }).state).some(issue => issue.id === 'gap-s2')).toBe(true);
    const short = updateStudioClip(state, 's4', { duration: 2 }).state;
    expect(studioIssues(short).some(issue => issue.id === 'tail-m1' && issue.severity === 'warning')).toBe(true);
    let ready = approvedStudio(); ready = { ...ready, budget: 2000, tasks: ready.tasks.map(task => task.id === 'review' ? { ...task, done: false } : task) };
    expect(finishStudioTask(ready, 'review').error).toBe('production-errors');
    expect(updateStudioClip(state, 's1', { duration: NaN }).state).toBe(state);
    const long = updateStudioClip(state, 's1', { duration: 60 }, true).state;
    expect(updateStudioClip(long, 's2', { duration: 60 }, true)).toEqual({ state: long, error: 'invalid-clip' });
  });
  it('invalidates editorial approvals after edits and restores independent snapshots with renewed rights approval', () => {
    const initial = approvedStudio(); const saved = saveStudioVersion(initial);
    const changed = updateStudioClip(saved, 's1', { duration: 12 }, true).state;
    expect(changed.tasks.filter(task => ['edit', 'grade', 'review', 'delivery'].includes(task.id)).every(task => !task.done)).toBe(true);
    expect(changed.tasks.find(task => task.id === 'shoot')!.done).toBe(true);
    const restored = restoreStudioVersion(changed, 1).state;
    expect(restored.clips).toEqual(initial.clips); expect(restored.clips[0]).not.toBe(saved.versions[0].clips[0]);
    expect(restored.tasks.filter(task => !['brief', 'boards'].includes(task.id)).every(task => !task.done)).toBe(true);
    expect(saved.versions[0].clips[0].duration).toBe(8);
  });
});

describe('hotel operations: inventory, settled quotes and forecast bounds', () => {
  const request: BookingRequest = { room: 'garden', quantity: 3, checkIn: 4, checkOut: 7, channel: 'direct' };
  it('rejects a whole stay when only its last night is sold out, preserving all other nights and sequence', () => {
    const state = makeHotel(); expect(forecastHotel(state).confirmedNights).toBe(66);
    expect(hotelInventory(state, 'garden', 4)).toBe(8); expect(hotelInventory(state, 'garden', 6)).toBe(2);
    expect(reserveHotel(state, request)).toEqual({ state, error: 'booking-inventory' });
    expect(state.nextId).toBe(6); expect(state.reservations).toHaveLength(5);
    expect(reserveHotel(state, { ...request, checkOut: 4 }).error).toBe('booking-dates');
    expect(reserveHotel(state, { ...request, quantity: 1.5 }).error).toBe('booking-quantity');
  });
  it('uses exclusive checkout, restores every cancelled night exactly once and freezes booked quotes', () => {
    const initial = makeHotel(); const first = reserveHotel(initial, { ...request, quantity: 8, checkOut: 6 }).state;
    expect(hotelInventory(first, 'garden', 4)).toBe(0); expect(hotelInventory(first, 'garden', 5)).toBe(0); expect(hotelInventory(first, 'garden', 6)).toBe(2);
    const booked = first.reservations.at(-1)!; expect(booked.gross).toBe((680 + 816) * 8); expect(booked.net).toBeCloseTo(booked.gross * .97, 2);
    const repriced = { ...first, rates: { ...first.rates, garden: 1100 }, event: 'festival' as const };
    expect(repriced.reservations.at(-1)).toEqual(booked); expect(forecastHotel(repriced).bookedNet).toBe(forecastHotel(first).bookedNet);
    const cancelled = cancelHotel(repriced, booked.id).state;
    expect(hotelInventory(cancelled, 'garden', 4)).toBe(8); expect(hotelInventory(cancelled, 'garden', 5)).toBe(8);
    expect(cancelHotel(cancelled, booked.id)).toEqual({ state: cancelled, error: 'booking-cancelled' });
  });
  it('prices festival weekends, calculates commission and confines predictions to inventory', () => {
    const state = makeHotel(); const festival = { ...state, event: 'festival' as const };
    const quote = quoteHotel(festival, { ...request, checkIn: 6, checkOut: 7, quantity: 1, channel: 'ota' });
    expect(quote.nightly).toEqual([938.4]); expect(quote.net + quote.commission).toBeCloseTo(quote.gross, 2);
    const normal = forecastHotel(state); const rain = forecastHotel({ ...state, event: 'rain' });
    expect(rain.occupancy).toBeLessThan(normal.occupancy);
    const expensive = forecastHotel({ ...state, rates: { garden: 1150, loft: 1800, suite: 2800 } });
    expect(expensive.occupancy).toBeLessThan(normal.occupancy);
    expect(forecastHotel({ ...state, directShare: 100 }).net).toBeGreaterThan(forecastHotel({ ...state, directShare: 0 }).net);
    for (const event of ['normal', 'rain', 'festival'] as const) for (const multiplier of [.65, 1, 1.7]) {
      const varied = { ...state, event, rates: { garden: 680 * multiplier, loft: 1080 * multiplier, suite: 1680 * multiplier } };
      const forecast = forecastHotel(varied); expect(forecast.occupancy).toBeLessThanOrEqual(100); expect(forecast.confirmedNights).toBe(66);
      for (const day of forecast.daily) { expect(day.rooms).toBeLessThanOrEqual(16); expect(day.rooms).toBeGreaterThanOrEqual(0); expect(day.net).toBeGreaterThanOrEqual(0); }
      for (const room of ['garden', 'loft', 'suite'] as RoomType[]) for (let day = 0; day < 14; day++) expect(hotelInventory(varied, room, day)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('creative workbenches: actual cross-view controls', () => {
  it('constructs a lab, updates projected research, advances and resets using an accessible map', () => {
    render(<AdvancedCreativeDemo id="colony-command" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: /Build here/ }));
    expect(screen.getByLabelText('Ore')).toHaveTextContent('64');
    expect(screen.getByRole('button', { name: /Tile 16: Laboratory/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Advance one turn/ }));
    expect(screen.getByLabelText('Research')).toHaveTextContent('5');
    fireEvent.click(screen.getByRole('button', { name: /Reset colony/ }));
    expect(screen.getByLabelText('Ore')).toHaveTextContent('88'); expect(screen.getByLabelText('Research')).toHaveTextContent('0');
  });
  it('links a real 3D projection to floor slicing, asset inspection, fault repair and energy strategy', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    const { container } = render(<AdvancedCreativeDemo id="habitat-twin" locale="en" />);
    const scene = screen.getByRole('img', { name: /^3D campus floors/ }); const initialFaces = scene.querySelectorAll('polygon').length;
    expect(initialFaces).toBeGreaterThan(25); const initialPoints = scene.querySelector('polygon')!.getAttribute('points');
    scene.focus(); fireEvent.keyDown(scene, { key: 'ArrowRight' }); expect(scene.querySelector('polygon')!.getAttribute('points')).not.toBe(initialPoints);
    Object.defineProperty(scene, 'setPointerCapture', { value: vi.fn() });
    fireEvent.pointerDown(scene.querySelector('[data-campus-asset="A-1"]')!, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(scene, { clientX: 100, clientY: 100 });
    expect(screen.getByRole('combobox', { name: 'Select floor asset' })).toHaveValue('A-1');
    fireEvent.pointerDown(scene.querySelector('[data-campus-asset="B-1"]')!, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(scene, { clientX: 160, clientY: 120 }); fireEvent.pointerUp(scene, { clientX: 160, clientY: 120 });
    expect(screen.getByRole('combobox', { name: 'Select floor asset' })).toHaveValue('A-1');
    fireEvent.change(screen.getByRole('combobox', { name: 'Select floor asset' }), { target: { value: 'B-3' } });
    fireEvent.change(screen.getByRole('combobox', { name: /FLOOR SLICE/ }), { target: { value: '2' } }); expect(scene.querySelectorAll('polygon').length).toBeLessThan(initialFaces);
    fireEvent.click(screen.getByRole('button', { name: /Replace valve/ })); expect(container.querySelector('.ac-asset-inspector')).toHaveTextContent('Operational');
    fireEvent.click(screen.getByRole('button', { name: /Energy scenarios/ }));
    expect(screen.getByRole('slider', { name: 'Temperature setpoint' })).toHaveValue('22');
    fireEvent.click(screen.getByRole('checkbox', { name: /Low-airflow eco mode/ }));
    expect(container.querySelectorAll('.ac-line-chart polyline')[0].getAttribute('points')).not.toBe(container.querySelectorAll('.ac-line-chart polyline')[1].getAttribute('points'));
    fireEvent.click(screen.getByRole('button', { name: /Reset campus/ }));
    expect(screen.getByRole('checkbox', { name: /Low-airflow eco mode/ })).not.toBeChecked();
  });
  it('ripples the timeline, saves and restores a cut, then exposes real prerequisite errors', () => {
    render(<AdvancedCreativeDemo id="studio-pipeline" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: /Assets & versions/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save cut version/ }));
    fireEvent.click(screen.getByRole('button', { name: /Edit timeline/ }));
    fireEvent.change(screen.getByRole('spinbutton', { name: /Duration \/ seconds/ }), { target: { value: '11' } });
    expect(screen.getByRole('button', { name: '02 / City breath, 11–19s' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Assets & versions/ })); fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: /Production tasks/ }));
    const rights = screen.getByRole('heading', { name: 'Rights clearance' }).closest('article')!;
    fireEvent.click(within(rights).getByRole('button', { name: /Complete & approve/ })); expect(screen.getByRole('alert')).toHaveTextContent('rights clearance');
    fireEvent.click(screen.getByRole('button', { name: /Edit timeline/ })); expect(screen.getByRole('button', { name: '02 / City breath, 8–16s' })).toBeInTheDocument();
  });
  it('stops storyboard animation on unmount and honors reduced motion', () => {
    const frame = vi.fn(() => 42); const cancel = vi.fn(); const remove = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frame); vi.stubGlobal('cancelAnimationFrame', cancel);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: remove }));
    const { unmount } = render(<AdvancedCreativeDemo id="studio-pipeline" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Play storyboard' })); expect(frame).toHaveBeenCalled();
    unmount(); expect(cancel).toHaveBeenCalledWith(42); expect(remove).toHaveBeenCalled();
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<AdvancedCreativeDemo id="studio-pipeline" locale="en" />); expect(screen.getByRole('button', { name: 'Play storyboard' })).toBeDisabled();
  });
  it('reserves real inventory, cancels in the ledger and restores the same room nights', () => {
    render(<AdvancedCreativeDemo id="stay-revenue" locale="en" />);
    const cellName = /Garden king 2026-10-16, 8 rooms available/;
    expect(screen.getByRole('button', { name: cellName })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Confirm sample booking/ }));
    expect(screen.getByRole('button', { name: /Garden king 2026-10-16, 7 rooms available/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reservation ledger/ }));
    const row = screen.getByText('ST-006').closest('tr')!; fireEvent.click(within(row).getByRole('button', { name: /Cancel & replenish/ }));
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Availability & booking/ })); expect(screen.getByRole('button', { name: cellName })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Check-out' }), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm sample booking/ })); expect(screen.getByRole('alert')).toHaveTextContent('Checkout must follow');
  });
  it('names every revenue slider and keeps native range values aligned with the shown rates', () => {
    render(<AdvancedCreativeDemo id="stay-revenue" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: /Revenue scenarios/ }));
    for (const [name, value] of [['Garden king', '680'], ['River loft', '1080'], ['Terrace suite', '1680'], ['Direct share of future sales', '40']]) {
      const range = screen.getByRole('slider', { name }) as HTMLInputElement;
      expect(range).toHaveValue(value);
      expect((Number(value) - Number(range.min)) % Number(range.step || 1)).toBe(0);
    }
    fireEvent.change(screen.getByRole('slider', { name: 'Garden king' }), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: /Availability & booking/ }));
    expect(screen.getByRole('button', { name: /Garden king 2026-10-16/ })).toHaveTextContent('700');
  });
  it('exports local state and revokes object URLs on repeated export and unmount', () => {
    vi.useFakeTimers(); const revoke = vi.fn(); let sequence = 0;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:creative-${++sequence}`) });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { unmount } = render(<AdvancedCreativeDemo id="stay-revenue" locale="zh" />);
    fireEvent.click(screen.getByRole('button', { name: /导出经营单/ })); fireEvent.click(screen.getByRole('button', { name: /导出经营单/ }));
    expect(click).toHaveBeenCalledTimes(2); expect(revoke).toHaveBeenCalledWith('blob:creative-1');
    unmount(); expect(revoke).toHaveBeenCalledWith('blob:creative-2');
    act(() => vi.runAllTimers()); expect(revoke).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AdvancedOperationsDemo } from '../src/saas/examples/advanced/AdvancedOperationsDemos';
import { OPERATIONS_CASES } from '../src/saas/examples/advanced/operationsCatalog';
import { DELIVERIES, ROADS, shortestRoute, planDispatch, initialRetail, retailAction, availableStock, retailTotals, FACTORY_ORDERS, INITIAL_MATERIALS, BOM, scheduleFactory, INITIAL_GRID, simulateGrid, type Material } from '../src/saas/examples/advanced/operationsEngine';
afterEach(cleanup);

describe('directed dispatch planning', () => {
  it('finds shortest directed routes and detours, rejects unreachable targets', () => {
    expect(shortestRoute('B', 'C')?.minutes).toBe(14);
    const detour = shortestRoute('B', 'C', new Set(['r4a']));
    expect(detour!.minutes).toBeGreaterThan(14); expect(detour!.roads.some(r => r.id === 'r4a')).toBe(false);
    const directed = [{ id: 'one', from: 'X', to: 'Y', km: 3, minutes: 5 }];
    expect(shortestRoute('X', 'Y', new Set(), directed)?.minutes).toBe(5);
    expect(shortestRoute('Y', 'X', new Set(), directed)).toBeNull();
    expect(shortestRoute('X', 'X', new Set(), directed)).toEqual({ roads: [], minutes: 0, km: 0 });
  });
  it.each(['deadline', 'nearest'] as const)('%s enforces payload/depot/time constraints and accounts for every order', strategy => {
    const result = planDispatch(DELIVERIES, new Set(), strategy);
    const ids = result.trucks.flatMap(p => p.stops.map(s => s.delivery.id)).concat(result.unassigned.map(o => o.id));
    expect(ids.sort()).toEqual(DELIVERIES.map(o => o.id).sort()); expect(new Set(ids).size).toBe(DELIVERIES.length);
    for (const truck of result.trucks) {
      expect(truck.load).toBeLessThanOrEqual(truck.truck.capacity);
      expect(truck.load).toBe(truck.stops.reduce((sum, s) => sum + s.delivery.kg, 0));
      expect(truck.stops.every(s => s.delivery.depot === truck.truck.depot && s.arrival >= s.delivery.ready)).toBe(true);
      truck.stops.forEach((stop, i) => { if (i) expect(stop.arrival).toBeGreaterThanOrEqual(truck.stops[i - 1].arrival + 6); });
    }
    expect(result.cost).toBeCloseTo(result.trucks.reduce((sum, t) => sum + t.stops.reduce((s, stop) => s + stop.km * t.truck.costKm, 0), 0));
  });
  it('exposes isolated and oversized orders without invented routes', () => {
    const blocked = new Set(ROADS.filter(r => r.to === 'E' || r.from === 'E').map(r => r.id));
    const plan = planDispatch(DELIVERIES, blocked);
    expect(plan.unassigned.filter(o => o.destination === 'E')).toHaveLength(2);
    expect(plan.trucks.flatMap(t => t.stops).some(s => s.path.some(r => blocked.has(r.id)))).toBe(false);
    expect(planDispatch([{ ...DELIVERIES[0], kg: 5000 }]).unassigned).toHaveLength(1);
  });
  it('waits for window opening and measures lateness from arrival', () => {
    const plan = planDispatch([{ ...DELIVERIES[0], ready: 150, deadline: 160 }]);
    expect(plan.trucks.flatMap(t => t.stops)[0].arrival).toBe(150); expect(plan.onTime).toBe(1);
    expect(planDispatch([{ ...DELIVERIES[0], deadline: 1 }]).onTime).toBe(0);
  });
  it('invalidates visible dispatch progress after road changes and resets', () => {
    render(<AdvancedOperationsDemo id="dispatch-network" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Simulate dispatch' }));
    expect(screen.getByRole('button', { name: 'Complete route' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Road scenario'), { target: { value: 'isolate' } });
    expect(screen.getByRole('button', { name: 'Simulate dispatch' })).toBeEnabled(); expect(screen.getByRole('alert')).toHaveTextContent('DL-102');
    fireEvent.click(screen.getByRole('tab', { name: 'Policy comparison' })); expect(screen.getByText('Current scenario / alternate policy')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset system/ })); expect(screen.getByLabelText('Road scenario')).toHaveValue('normal'); expect(screen.getByRole('alert')).toHaveTextContent('DL-108'); expect(screen.getByRole('alert')).not.toHaveTextContent('DL-102');
  });
});

describe('retail atomic inventory and state machine', () => {
  it('rejects a whole insufficient multi-SKU reservation with no partial allocation', () => {
    const initial = initialRetail(); const created = retailAction(initial, { type: 'create', warehouse: 'SH', channel: 'WEB', coupon: false, lines: [{ sku: 'LAMP', quantity: 1 }, { sku: 'BAG', quantity: 6 }] }).state;
    const before = availableStock(created, 'SH', 'LAMP'); const result = retailAction(created, { type: 'transition', id: 'RT-1004', to: 'reserved' });
    expect(result.error).toBe('INSUFFICIENT_STOCK'); expect(result.state).toBe(created); expect(availableStock(result.state, 'SH', 'LAMP')).toBe(before); expect(initial.orders).toHaveLength(3);
  });
  it('ships, restocks once and refunds without duplicating goods', () => {
    const initial = initialRetail(); let state = retailAction(initial, { type: 'transition', id: 'RT-1001', to: 'approved' }).state;
    state = retailAction(state, { type: 'transition', id: 'RT-1001', to: 'shipped' }).state; expect(state.stock.SH.LAMP).toBe(initial.stock.SH.LAMP - 2);
    state = retailAction(state, { type: 'transition', id: 'RT-1001', to: 'returned' }).state; expect(state.stock).toEqual(initial.stock);
    expect(retailAction(state, { type: 'transition', id: 'RT-1001', to: 'returned' }).error).toBe('INVALID_TRANSITION');
    state = retailAction(state, { type: 'transition', id: 'RT-1001', to: 'refunded' }).state; expect(state.stock).toEqual(initial.stock);
    expect(retailAction(state, { type: 'transition', id: 'RT-1001', to: 'refunded' }).error).toBe('INVALID_TRANSITION'); expect(initial.orders[0].status).toBe('reserved');
  });
  it('releases cancellation reservations and forbids shipment before approval', () => {
    const initial = initialRetail(); expect(availableStock(initial, 'SH', 'LAMP')).toBe(16);
    expect(retailAction(initial, { type: 'transition', id: 'RT-1001', to: 'shipped' }).error).toBe('INVALID_TRANSITION');
    const state = retailAction(initial, { type: 'transition', id: 'RT-1001', to: 'cancelled' }).state;
    expect(availableStock(state, 'SH', 'LAMP')).toBe(18); expect(state.stock).toBe(initial.stock);
  });
  it('transfers free stock only and conserves totals', () => {
    const state = initialRetail(); expect(retailAction(state, { type: 'transfer', from: 'SH', to: 'HZ', sku: 'LAMP', quantity: 17 }).error).toBe('TRANSFER_UNAVAILABLE');
    const moved = retailAction(state, { type: 'transfer', from: 'HZ', to: 'SH', sku: 'BAG', quantity: 8 }); expect(moved.error).toBeUndefined();
    expect(moved.state.stock.HZ.BAG + moved.state.stock.SH.BAG).toBe(state.stock.HZ.BAG + state.stock.SH.BAG);
    expect(retailAction(state, { type: 'transfer', from: 'HZ', to: 'HZ', sku: 'BAG', quantity: 1 }).error).toBe('TRANSFER_UNAVAILABLE');
  });
  it('rejects empty, duplicate and invalid quantities', () => {
    for (const lines of [[], [{ sku: 'MUG', quantity: 0 }], [{ sku: 'MUG', quantity: 1.5 }], [{ sku: 'MUG', quantity: 1 }, { sku: 'MUG', quantity: 1 }]]) expect(retailAction(initialRetail(), { type: 'create', warehouse: 'SH', channel: 'WEB', coupon: false, lines }).error).toBe('INVALID_ORDER');
  });
  it('calculates discounts, tax, shipping and margin from SKU costs', () => {
    const low = retailTotals({ lines: [{ sku: 'LAMP', quantity: 2 }], coupon: true }); expect(low.subtotal).toBe(498); expect(low.discount).toBe(0); expect(low.shipping).toBe(18); expect(low.tax).toBe(29.88);
    const high = retailTotals({ lines: [{ sku: 'BAG', quantity: 2 }], coupon: true }); expect(high.discount).toBeCloseTo(79.8); expect(high.shipping).toBe(0); expect(high.margin).toBeCloseTo(798 - 79.8 - 370 - 18); expect(high.total).toBeCloseTo(high.subtotal - high.discount + high.shipping + high.tax);
  });
  it('executes the visible fulfillment/return lifecycle and resets', () => {
    render(<AdvancedOperationsDemo id="commerce-ops" locale="en" />);
    for (const name of ['Approve order', 'Ship order', 'Return & restock', 'Issue refund']) fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByText('RT-1001 / Refunded')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Issue refund' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Finance & events' })); expect(screen.getByText('RT-1001 · returned → refunded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset system/ })); expect(screen.getByRole('button', { name: 'Approve order' })).toBeInTheDocument();
  });
  it('creates a multi-SKU draft and exposes insufficient-stock failure', () => {
    render(<AdvancedOperationsDemo id="commerce-ops" locale="en" />);
    fireEvent.click(screen.getByRole('tab', { name: 'New basket' })); fireEvent.change(screen.getByLabelText('City pack quantity'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create order draft' })); expect(screen.getByText('RT-1004 / Draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reserve stock' })); expect(screen.getByRole('alert')).toHaveTextContent('Insufficient available stock'); expect(screen.getByText('RT-1004 / Draft')).toBeInTheDocument();
  });
});

describe('factory material, calendar and quality constraints', () => {
  it.each([8, 10, 12])('%ih shifts respect precedence, machine exclusion and downtime', shift => {
    const outage = { machine: 'CUT-1', start: 3, end: 28 }; const result = scheduleFactory({ alloy: 500, board: 500, fastener: 500 }, shift, [outage]); expect(result.blocked).toHaveLength(0);
    for (const op of result.operations) {
      expect(op.end - op.start).toBeGreaterThan(0); expect(op.end).toBeLessThanOrEqual(Math.floor(op.start / 24) * 24 + shift + 1e-8);
      for (const parent of op.after) expect(op.start).toBeGreaterThanOrEqual(result.operations.find(o => o.id === parent)!.end);
      if (op.machine === outage.machine) expect(op.start >= outage.end || op.end <= outage.start).toBe(true);
      for (const other of result.operations.filter(o => o.machine === op.machine && o.id !== op.id)) expect(op.start >= other.end || op.end <= other.start).toBe(true);
    }
  });
  it('consumes BOM only for accepted orders, with no negative stock', () => {
    const result = scheduleFactory(); expect(result.blocked.length).toBeGreaterThan(0);
    for (const m of Object.keys(INITIAL_MATERIALS) as Material[]) {
      const used = result.completion.filter(c => c.end !== null).reduce((sum, c) => sum + BOM[c.order.product][m] * c.order.quantity, 0);
      expect(result.remaining[m]).toBe(INITIAL_MATERIALS[m] - used); expect(result.remaining[m]).toBeGreaterThanOrEqual(0);
    }
    const empty = scheduleFactory({ alloy: 0, board: 0, fastener: 0 }); expect(empty.operations).toEqual([]); expect(empty.blocked).toHaveLength(6); expect(empty.makespan).toBe(0);
  });
  it('blocks oversized operations without consuming material', () => {
    const result = scheduleFactory(INITIAL_MATERIALS, 1, [], [FACTORY_ORDERS[0]]); expect(result.blocked[0].reason).toBe('SHIFT_CAPACITY'); expect(result.remaining).toEqual(INITIAL_MATERIALS); expect(result.operations).toEqual([]);
  });
  it('gates release on quality and invalidates it on replanning', () => {
    render(<AdvancedOperationsDemo id="factory-orchestrator" locale="en" />); fireEvent.click(screen.getByRole('tab', { name: 'Quality & delivery' }));
    const row = screen.getByText('MO-201', { selector: 'td' }).closest('tr')!; expect(within(row).getByRole('button', { name: 'Release' })).toBeDisabled();
    fireEvent.click(within(row).getByRole('button', { name: 'Fail', exact: true })); expect(within(row).getByText('Batch quarantined')).toBeInTheDocument(); expect(within(row).getByRole('button', { name: 'Release' })).toBeDisabled();
    fireEvent.click(within(row).getByRole('button', { name: 'Pass', exact: true })); fireEvent.click(within(row).getByRole('button', { name: 'Release' })); expect(within(row).getByText('Released')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Daily shift'), { target: { value: '12' } }); expect(within(row).getByText('Pending sample')).toBeInTheDocument(); expect(within(row).getByRole('button', { name: 'Release' })).toBeDisabled();
  });
  it('recalculates Gantt after breakdown and restores deterministic reset', () => {
    render(<AdvancedOperationsDemo id="factory-orchestrator" locale="en" />); const before = screen.getByRole('img', { name: /Operation Gantt/ }).innerHTML;
    fireEvent.click(screen.getByRole('checkbox', { name: /CUT-1 outage/ })); expect(screen.getByRole('img', { name: /Operation Gantt/ }).innerHTML).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: /Reset system/ })); expect(screen.getByRole('img', { name: /Operation Gantt/ }).innerHTML).toBe(before);
  });
});

describe('microgrid physical accounting', () => {
  it.each(['self', 'tariff'] as const)('%s conserves hourly energy and obeys SOC/power at extreme inputs', strategy => {
    for (const capacity of [20, 90, 200]) for (const solar of [0, 1.6]) for (const outage of [false, true]) {
      const input = { ...INITIAL_GRID, capacity, solar, outage, demand: 1.8, initialSOC: .1 }; const result = simulateGrid(input, strategy); let previous = capacity * .1;
      for (const h of result.hours) {
        expect(Math.abs(h.balanceError)).toBeLessThan(1e-8); expect(h.soc).toBeGreaterThanOrEqual(capacity * .1 - 1e-8); expect(h.soc).toBeLessThanOrEqual(capacity + 1e-8);
        expect(h.charge).toBeLessThanOrEqual(input.power + 1e-8); expect(h.discharge).toBeLessThanOrEqual(input.power + 1e-8); expect(h.charge === 0 || h.discharge === 0).toBe(true);
        expect(h.soc).toBeCloseTo(previous + h.charge * .95 - h.discharge / .95, 8); previous = h.soc;
        if (outage && h.hour >= 18 && h.hour <= 20) expect(h.grid).toBe(0);
      }
      expect(result.carbon).toBeCloseTo(result.imported * .52); expect(result.cost).toBeCloseTo(result.hours.reduce((sum, h) => sum + h.cost, 0));
    }
  });
  it('exposes outage shortfalls and finite zero-power/zero-PV results', () => {
    const result = simulateGrid({ ...INITIAL_GRID, solar: 0, power: 0, outage: true }, 'tariff'); expect(result.unserved).toBeGreaterThan(100); expect(result.hours).toHaveLength(24); expect(result.hours.every(h => h.charge === 0 && h.discharge === 0 && Number.isFinite(h.soc) && Number.isFinite(h.cost))).toBe(true);
  });
  it('compares calculated policies and responds deterministically to demand', () => {
    const self = simulateGrid(INITIAL_GRID, 'self'); const tariff = simulateGrid(INITIAL_GRID, 'tariff'); expect(self.hours).not.toEqual(tariff.hours); expect(self.cost).not.toBe(tariff.cost); expect(simulateGrid({ ...INITIAL_GRID, demand: 1.8 }, 'tariff').imported).toBeGreaterThan(tariff.imported); expect(simulateGrid(INITIAL_GRID, 'tariff')).toEqual(tariff);
  });
  it('links outage inputs to curves, ledger and comparison then resets', () => {
    render(<AdvancedOperationsDemo id="grid-balance" locale="en" />); fireEvent.change(screen.getByRole('slider', { name: 'Charge/discharge power' }), { target: { value: '0' } }); fireEvent.click(screen.getByRole('checkbox', { name: /Grid outage/ })); expect(screen.getByRole('alert')).toHaveTextContent('unserved');
    fireEvent.click(screen.getByRole('tab', { name: 'Hourly ledger' })); expect(screen.getAllByRole('row')).toHaveLength(25); fireEvent.click(screen.getByRole('tab', { name: 'Policy comparison' })); expect(screen.getByText('ONE SCENARIO, THREE OUTCOMES')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset system/ })); expect(screen.getByRole('slider', { name: 'Charge/discharge power' })).toHaveValue('24'); expect(screen.getByRole('checkbox', { name: /Grid outage/ })).not.toBeChecked();
  });
});

describe('workflow and bilingual coverage', () => {
  it.each(OPERATIONS_CASES)('$id has connected parallel work and reviewed final artifacts', item => {
    expect(item.steps).toHaveLength(12); expect(item.capabilities.length).toBeGreaterThanOrEqual(6); expect(item.datasets.length).toBeGreaterThanOrEqual(3);
    const seen = new Set<string>(); const consumed = new Set(item.steps.flatMap(s => [...s.after]));
    for (const step of item.steps) { expect(seen.has(step.id)).toBe(false); expect(step.after.every(id => seen.has(id))).toBe(true); seen.add(step.id); expect(step.task.zh.length).toBeGreaterThan(10); expect(step.task.en.length).toBeGreaterThan(10); }
    expect(item.steps.filter(s => !consumed.has(s.id)).map(s => s.id)).toEqual(['guide']); expect(item.steps.at(-1)!.after).toHaveLength(3); expect(item.steps.find(s => s.id === 'build')?.outputType).toBe('html'); expect(item.steps.find(s => s.id === 'repair')?.after).toContain('checks'); expect(item.steps.find(s => s.id === 'deliver')?.after).toContain('recheck'); expect(item.steps.filter(s => s.role === 'review')).toHaveLength(2);
  });
  it.each(['dispatch-network', 'commerce-ops', 'factory-orchestrator', 'grid-balance'])('%s renders both languages with multi-view interactions', id => {
    const view = render(<AdvancedOperationsDemo id={id} locale="zh" />); expect(screen.getByRole('button', { name: /重置系统/ })).toBeInTheDocument(); expect(screen.getAllByRole('tab').length).toBeGreaterThanOrEqual(3); view.rerender(<AdvancedOperationsDemo id={id} locale="en" />); expect(screen.getByRole('button', { name: /Reset system/ })).toBeInTheDocument();
  });
});

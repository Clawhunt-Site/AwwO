/** Deterministic local models. These are planning demonstrations, not production optimizers. */
export interface RoadNode { id: string; x: number; y: number; depot?: boolean }
export interface Road { id: string; from: string; to: string; minutes: number; km: number }
export interface Delivery { id: string; depot: string; destination: string; kg: number; ready: number; deadline: number }
export interface Truck { id: string; depot: string; capacity: number; costKm: number }
export const ROAD_NODES: readonly RoadNode[] = [
  { id: 'WEST', x: 65, y: 210, depot: true }, { id: 'NORTH', x: 330, y: 45, depot: true },
  { id: 'A', x: 190, y: 100 }, { id: 'B', x: 225, y: 260 }, { id: 'C', x: 380, y: 165 },
  { id: 'D', x: 490, y: 80 }, { id: 'E', x: 525, y: 270 }, { id: 'F', x: 370, y: 350 },
];
const links: Array<[string, string, number, number]> = [
  ['WEST', 'A', 18, 12], ['WEST', 'B', 16, 10], ['A', 'NORTH', 20, 14], ['A', 'C', 25, 16],
  ['B', 'C', 14, 9], ['B', 'F', 20, 15], ['NORTH', 'D', 17, 11], ['NORTH', 'C', 15, 10],
  ['C', 'D', 16, 12], ['C', 'E', 19, 14], ['D', 'E', 26, 18], ['F', 'E', 18, 13],
];
export const ROADS: readonly Road[] = links.flatMap(([from, to, minutes, km], i) => [
  { id: `r${i}a`, from, to, minutes, km }, { id: `r${i}b`, from: to, to: from, minutes: minutes + 3, km },
]);
export const DELIVERIES: readonly Delivery[] = [
  { id: 'DL-101', depot: 'WEST', destination: 'C', kg: 260, ready: 0, deadline: 48 },
  { id: 'DL-102', depot: 'WEST', destination: 'E', kg: 320, ready: 20, deadline: 78 },
  { id: 'DL-103', depot: 'WEST', destination: 'F', kg: 180, ready: 15, deadline: 62 },
  { id: 'DL-104', depot: 'WEST', destination: 'A', kg: 220, ready: 0, deadline: 30 },
  { id: 'DL-105', depot: 'NORTH', destination: 'D', kg: 160, ready: 0, deadline: 28 },
  { id: 'DL-106', depot: 'NORTH', destination: 'E', kg: 250, ready: 10, deadline: 57 },
  { id: 'DL-107', depot: 'NORTH', destination: 'B', kg: 270, ready: 0, deadline: 45 },
  { id: 'DL-108', depot: 'NORTH', destination: 'F', kg: 210, ready: 20, deadline: 80 },
];
export const TRUCKS: readonly Truck[] = [
  { id: 'EV-01', depot: 'WEST', capacity: 600, costKm: 2.2 }, { id: 'EV-02', depot: 'WEST', capacity: 500, costKm: 2.6 },
  { id: 'EV-03', depot: 'NORTH', capacity: 500, costKm: 2.2 }, { id: 'EV-04', depot: 'NORTH', capacity: 450, costKm: 2.6 },
];
export function shortestRoute(from: string, to: string, blocked: ReadonlySet<string> = new Set(), roads: readonly Road[] = ROADS) {
  const distance = new Map<string, number>([[from, 0]]); const previous = new Map<string, Road>(); const visited = new Set<string>();
  while (true) {
    const next = [...distance].filter(([id]) => !visited.has(id)).sort((a, b) => a[1] - b[1])[0];
    if (!next) return null;
    const [at, cost] = next; if (at === to) break; visited.add(at);
    for (const road of roads.filter(r => r.from === at && !blocked.has(r.id))) {
      const candidate = cost + road.minutes;
      if (candidate < (distance.get(road.to) ?? Infinity)) { distance.set(road.to, candidate); previous.set(road.to, road); }
    }
  }
  const path: Road[] = []; let at = to;
  while (at !== from) { const road = previous.get(at); if (!road) return null; path.unshift(road); at = road.from; }
  return { roads: path, minutes: distance.get(to) ?? 0, km: path.reduce((sum, r) => sum + r.km, 0) };
}
export interface PlannedStop { delivery: Delivery; arrival: number; late: number; path: Road[]; km: number }
export interface TruckPlan { truck: Truck; load: number; stops: PlannedStop[]; cost: number }
export interface DispatchPlan { trucks: TruckPlan[]; unassigned: Delivery[]; onTime: number; total: number; cost: number; km: number }
export function planDispatch(orders: readonly Delivery[] = DELIVERIES, blocked: ReadonlySet<string> = new Set(), strategy: 'deadline' | 'nearest' = 'deadline', trucks: readonly Truck[] = TRUCKS): DispatchPlan {
  const plans: TruckPlan[] = trucks.map(truck => ({ truck, load: 0, stops: [], cost: 0 })); const unassigned: Delivery[] = [];
  const ordered = [...orders].sort((a, b) => strategy === 'deadline' ? a.deadline - b.deadline : (shortestRoute(a.depot, a.destination, blocked)?.minutes ?? Infinity) - (shortestRoute(b.depot, b.destination, blocked)?.minutes ?? Infinity));
  for (const delivery of ordered) {
    const candidates = plans.flatMap(plan => {
      if (plan.truck.depot !== delivery.depot || plan.load + delivery.kg > plan.truck.capacity || delivery.kg <= 0) return [];
      const last = plan.stops.at(-1); const path = shortestRoute(last?.delivery.destination ?? delivery.depot, delivery.destination, blocked);
      if (!path) return [];
      const arrival = Math.max(delivery.ready, (last?.arrival ?? 0) + (last ? 6 : 0) + path.minutes);
      return [{ plan, path, arrival, score: Math.max(0, arrival - delivery.deadline) * 20 + path.km * plan.truck.costKm }];
    }).sort((a, b) => a.score - b.score);
    const best = candidates[0]; if (!best) { unassigned.push(delivery); continue; }
    best.plan.load += delivery.kg; best.plan.cost += best.path.km * best.plan.truck.costKm;
    best.plan.stops.push({ delivery, arrival: best.arrival, late: Math.max(0, best.arrival - delivery.deadline), path: best.path.roads, km: best.path.km });
  }
  const stops = plans.flatMap(p => p.stops);
  return { trucks: plans, unassigned, onTime: stops.filter(s => s.late === 0).length, total: orders.length, cost: plans.reduce((s, p) => s + p.cost, 0), km: stops.reduce((s, p) => s + p.km, 0) };
}

export interface SKU { id: string; zh: string; en: string; price: number; cost: number }
export const SKUS: readonly SKU[] = [
  { id: 'LAMP', zh: '折叠台灯', en: 'Fold lamp', price: 249, cost: 110 }, { id: 'MUG', zh: '温控杯', en: 'Thermal mug', price: 129, cost: 48 },
  { id: 'BAG', zh: '城市背包', en: 'City pack', price: 399, cost: 185 }, { id: 'HUB', zh: '桌面扩展坞', en: 'Desk hub', price: 329, cost: 170 },
];
export const WAREHOUSES = ['SH', 'HZ', 'CD'] as const;
export type OrderStatus = 'draft' | 'reserved' | 'approved' | 'shipped' | 'returned' | 'refunded' | 'cancelled';
export interface RetailLine { sku: string; quantity: number }
export interface RetailOrder { id: string; channel: string; warehouse: string; lines: RetailLine[]; coupon: boolean; status: OrderStatus }
export interface RetailState { stock: Record<string, Record<string, number>>; orders: RetailOrder[]; log: string[]; sequence: number }
export function initialRetail(): RetailState {
  return { stock: { SH: { LAMP: 18, MUG: 30, BAG: 5, HUB: 12 }, HZ: { LAMP: 9, MUG: 20, BAG: 16, HUB: 4 }, CD: { LAMP: 6, MUG: 14, BAG: 8, HUB: 10 } }, orders: [
    { id: 'RT-1001', channel: 'WEB', warehouse: 'SH', lines: [{ sku: 'LAMP', quantity: 2 }, { sku: 'MUG', quantity: 1 }], coupon: true, status: 'reserved' },
    { id: 'RT-1002', channel: 'STORE', warehouse: 'HZ', lines: [{ sku: 'BAG', quantity: 3 }], coupon: false, status: 'approved' },
    { id: 'RT-1003', channel: 'MARKET', warehouse: 'CD', lines: [{ sku: 'HUB', quantity: 1 }], coupon: false, status: 'draft' },
  ], log: ['SEED · 3 orders / 3 warehouses / 4 SKUs'], sequence: 1004 };
}
export function retailTotals(order: Pick<RetailOrder, 'lines' | 'coupon'>) {
  // Keep the ledger in integer cents; round each billed tax/discount once.
  const subtotal = order.lines.reduce((sum, l) => sum + (SKUS.find(s => s.id === l.sku)?.price ?? 0) * 100 * l.quantity, 0);
  const goodsCost = order.lines.reduce((sum, l) => sum + (SKUS.find(s => s.id === l.sku)?.cost ?? 0) * 100 * l.quantity, 0);
  const discount = order.coupon && subtotal >= 50000 ? Math.round(subtotal * 0.1) : 0; const net = subtotal - discount;
  const shipping = net >= 60000 ? 0 : 1800; const tax = Math.round(net * 0.06);
  return { subtotal: subtotal / 100, discount: discount / 100, shipping: shipping / 100, tax: tax / 100, total: (net + shipping + tax) / 100, margin: (net + shipping - goodsCost - 1800) / 100 };
}
export function availableStock(state: RetailState, warehouse: string, sku: string) {
  const reserved = state.orders.filter(o => o.warehouse === warehouse && ['reserved', 'approved'].includes(o.status)).flatMap(o => o.lines).filter(l => l.sku === sku).reduce((s, l) => s + l.quantity, 0);
  return (state.stock[warehouse]?.[sku] ?? 0) - reserved;
}
export type RetailAction = { type: 'create'; warehouse: string; channel: string; lines: RetailLine[]; coupon: boolean } | { type: 'transition'; id: string; to: OrderStatus } | { type: 'transfer'; from: string; to: string; sku: string; quantity: number };
export function retailAction(state: RetailState, action: RetailAction): { state: RetailState; error?: string } {
  const fail = (error: string) => ({ state, error });
  if (action.type === 'create') {
    if (!state.stock[action.warehouse] || !action.lines.length || action.lines.some(l => !SKUS.some(s => s.id === l.sku) || !Number.isInteger(l.quantity) || l.quantity < 1) || new Set(action.lines.map(l => l.sku)).size !== action.lines.length) return fail('INVALID_ORDER');
    const order: RetailOrder = { ...action, id: `RT-${state.sequence}`, status: 'draft', lines: action.lines.map(l => ({ ...l })) };
    return { state: { ...state, orders: [...state.orders, order], sequence: state.sequence + 1, log: [`${order.id} · CREATE`, ...state.log] } };
  }
  if (action.type === 'transfer') {
    if (action.from === action.to || !state.stock[action.to] || !SKUS.some(s => s.id === action.sku) || !Number.isInteger(action.quantity) || action.quantity < 1 || availableStock(state, action.from, action.sku) < action.quantity) return fail('TRANSFER_UNAVAILABLE');
    return { state: { ...state, stock: { ...state.stock, [action.from]: { ...state.stock[action.from], [action.sku]: state.stock[action.from][action.sku] - action.quantity }, [action.to]: { ...state.stock[action.to], [action.sku]: state.stock[action.to][action.sku] + action.quantity } }, log: [`${action.from} → ${action.to} · ${action.sku} ×${action.quantity}`, ...state.log] } };
  }
  const order = state.orders.find(o => o.id === action.id); if (!order) return fail('ORDER_NOT_FOUND');
  const transitions: Record<OrderStatus, OrderStatus[]> = { draft: ['reserved', 'cancelled'], reserved: ['approved', 'cancelled'], approved: ['shipped', 'cancelled'], shipped: ['returned'], returned: ['refunded'], refunded: [], cancelled: [] };
  if (!transitions[order.status].includes(action.to)) return fail('INVALID_TRANSITION');
  if (action.to === 'reserved' && order.lines.some(l => availableStock(state, order.warehouse, l.sku) < l.quantity)) return fail('INSUFFICIENT_STOCK');
  let stock = state.stock;
  if (action.to === 'shipped' || action.to === 'returned') {
    const next = { ...stock[order.warehouse] }; for (const line of order.lines) next[line.sku] += line.quantity * (action.to === 'shipped' ? -1 : 1);
    if (Object.values(next).some(value => value < 0)) return fail('INSUFFICIENT_STOCK');
    stock = { ...stock, [order.warehouse]: next };
  }
  return { state: { ...state, stock, orders: state.orders.map(o => o.id === order.id ? { ...o, status: action.to } : o), log: [`${order.id} · ${order.status} → ${action.to}`, ...state.log] } };
}

export type Material = 'alloy' | 'board' | 'fastener';
export const BOM: Record<string, Record<Material, number>> = { SENSOR: { alloy: 2, board: 2, fastener: 4 }, DRIVE: { alloy: 5, board: 1, fastener: 8 }, PANEL: { alloy: 3, board: 3, fastener: 6 } };
export interface FactoryOrder { id: string; product: string; quantity: number; due: number }
export const FACTORY_ORDERS: readonly FactoryOrder[] = [
  { id: 'MO-201', product: 'SENSOR', quantity: 6, due: 30 }, { id: 'MO-202', product: 'DRIVE', quantity: 4, due: 33 },
  { id: 'MO-203', product: 'PANEL', quantity: 5, due: 36 }, { id: 'MO-204', product: 'SENSOR', quantity: 8, due: 54 },
  { id: 'MO-205', product: 'DRIVE', quantity: 7, due: 58 }, { id: 'MO-206', product: 'PANEL', quantity: 4, due: 60 },
];
export const INITIAL_MATERIALS: Record<Material, number> = { alloy: 100, board: 54, fastener: 180 };
export const MACHINES = ['CUT-1', 'CELL-A', 'CELL-B', 'QA-1'] as const;
export interface Downtime { machine: string; start: number; end: number }
export interface ScheduledOperation { id: string; order: string; stage: string; machine: string; start: number; end: number; after: string[] }
function productionSlot(earliest: number, duration: number, shift: number, machine: string, outages: readonly Downtime[]) {
  if (duration > shift || shift < 1 || shift > 24) return null;
  let start = Math.max(0, earliest);
  for (let attempt = 0; attempt < 300; attempt++) {
    const day = Math.floor(start / 24); if (start + duration > day * 24 + shift + 1e-8) { start = (day + 1) * 24; continue; }
    const conflict = outages.filter(d => d.machine === machine && start < d.end && start + duration > d.start).sort((a, b) => a.end - b.end)[0];
    if (conflict) { start = conflict.end; continue; } return start;
  }
  return null;
}
export function scheduleFactory(materials: Record<Material, number> = INITIAL_MATERIALS, shift = 8, outages: readonly Downtime[] = [], orders: readonly FactoryOrder[] = FACTORY_ORDERS) {
  const remaining = { ...materials }; const available: Record<string, number> = Object.fromEntries(MACHINES.map(m => [m, 0]));
  const operations: ScheduledOperation[] = []; const blocked: Array<{ order: FactoryOrder; reason: string }> = [];
  for (const order of [...orders].sort((a, b) => a.due - b.due)) {
    const bom = BOM[order.product];
    if (!bom || order.quantity <= 0 || !Number.isInteger(order.quantity)) { blocked.push({ order, reason: 'INVALID_ORDER' }); continue; }
    const shortage = (Object.keys(bom) as Material[]).filter(m => remaining[m] < bom[m] * order.quantity);
    if (shortage.length) { blocked.push({ order, reason: shortage.join(', ') }); continue; }
    const durations = [order.quantity * 0.32 + 0.5, order.quantity * 0.48 + 0.5, order.quantity * 0.2 + 0.3];
    if (durations.some(d => d > shift)) { blocked.push({ order, reason: 'SHIFT_CAPACITY' }); continue; }
    const tentative: ScheduledOperation[] = []; const nextAvailable = { ...available }; let earliest = 0;
    for (let index = 0; index < 3; index++) {
      const machines = index === 0 ? ['CUT-1'] : index === 1 ? ['CELL-A', 'CELL-B'] : ['QA-1'];
      const candidates = machines.map(machine => ({ machine, start: productionSlot(Math.max(earliest, nextAvailable[machine]), durations[index], shift, machine, outages) })).filter((c): c is { machine: string; start: number } => c.start !== null).sort((a, b) => a.start - b.start);
      const chosen = candidates[0]; if (!chosen) break;
      const op: ScheduledOperation = { id: `${order.id}-${index}`, order: order.id, stage: ['CUT', 'ASSEMBLE', 'TEST'][index], machine: chosen.machine, start: chosen.start, end: chosen.start + durations[index], after: index ? [`${order.id}-${index - 1}`] : [] };
      tentative.push(op); nextAvailable[op.machine] = op.end; earliest = op.end;
    }
    if (tentative.length !== 3) { blocked.push({ order, reason: 'NO_CAPACITY' }); continue; }
    for (const material of Object.keys(bom) as Material[]) remaining[material] -= bom[material] * order.quantity;
    Object.assign(available, nextAvailable); operations.push(...tentative);
  }
  const completion = orders.map(order => ({ order, end: operations.find(o => o.order === order.id && o.stage === 'TEST')?.end ?? null }));
  return { operations, blocked, remaining, completion, late: completion.filter(c => c.end !== null && c.end > c.order.due).length, makespan: Math.max(0, ...operations.map(o => o.end)) };
}

export interface GridScenario { demand: number; solar: number; capacity: number; power: number; initialSOC: number; outage: boolean }
export const INITIAL_GRID: GridScenario = { demand: 1, solar: 1, capacity: 90, power: 24, initialSOC: 0.5, outage: false };
export interface GridHour { hour: number; load: number; pv: number; tariff: number; charge: number; discharge: number; grid: number; exported: number; unserved: number; soc: number; cost: number; balanceError: number }
export function simulateGrid(input: GridScenario, strategy: 'self' | 'tariff'): { hours: GridHour[]; cost: number; carbon: number; imported: number; unserved: number; peak: number } {
  const capacity = Math.max(1, input.capacity); const power = Math.max(0, input.power); const reserve = capacity * 0.1; const efficiency = 0.95;
  let soc = Math.min(capacity, Math.max(reserve, input.initialSOC * capacity)); const hours: GridHour[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const load = (20 + (hour >= 8 && hour <= 17 ? 12 : 0) + (hour >= 18 && hour <= 21 ? 25 : 0) + Math.sin(hour * 0.9) * 3) * Math.max(0, input.demand);
    const pv = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI)) * (hour >= 6 && hour <= 18 ? 58 : 0) * Math.max(0, input.solar);
    const tariff = hour < 7 ? 0.38 : hour >= 17 && hour <= 21 ? 1.45 : 0.78; const outage = input.outage && hour >= 18 && hour <= 20;
    let charge = 0; let discharge = 0; let grid = 0; let exported = 0; let unserved = 0;
    if (pv >= load) { charge = Math.min(pv - load, power, (capacity - soc) / efficiency); exported = outage ? 0 : pv - load - charge; }
    else {
      const deficit = load - pv;
      if (strategy === 'self' || tariff > 1 || outage) discharge = Math.min(deficit, power, (soc - reserve) * efficiency);
      if (outage) unserved = Math.max(0, deficit - discharge); else grid = deficit - discharge;
      if (strategy === 'tariff' && tariff < 0.4 && !outage && discharge === 0) { charge = Math.min(power, Math.max(0, capacity * 0.9 - soc) / efficiency); grid += charge; }
    }
    // During an outage excess PV is curtailed, represented as export/curtailment in the balance.
    if (outage && pv > load + charge) exported = pv - load - charge;
    soc += charge * efficiency - discharge / efficiency;
    const cost = grid * tariff - (outage ? 0 : exported * 0.2);
    const balanceError = pv + grid + discharge - (load - unserved + charge + exported);
    hours.push({ hour, load, pv, tariff, charge, discharge, grid, exported, unserved, soc, cost, balanceError });
  }
  return { hours, cost: hours.reduce((s, h) => s + h.cost, 0), carbon: hours.reduce((s, h) => s + h.grid * 0.52, 0), imported: hours.reduce((s, h) => s + h.grid, 0), unserved: hours.reduce((s, h) => s + h.unserved, 0), peak: Math.max(...hours.map(h => h.grid)) };
}

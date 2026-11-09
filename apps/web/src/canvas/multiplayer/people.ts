// 多人同屏: the participants on a canvas as people (docs/awwo-canvas-live-collaboration.md, Presence). The stream lists
// pages: one person with three tabs, or a laptop and a phone, is three participants. The people bar, the 同屏 panel and
// following show one person, with every device their pages run in; an agent's token and each run of AwwO's Agents stay
// one each.
import type { LiveDevice, LiveParticipant } from './types';

/** The devices in the order they are named. */
export const DEVICE_ORDER: readonly LiveDevice[] = ['browser', 'mac', 'windows', 'phone', 'tablet'];

export interface LivePerson {
  /** 'u_' + user id for a person; for an agent or a run of AwwO's Agents, its participant id. */
  key: string;
  kind: LiveParticipant['kind'];
  /** The page heard from last (or this page): its name, colour, role and port stand for the person's. */
  lead: LiveParticipant;
  /** Every page of theirs on the canvas, the one heard from last first. */
  pages: readonly LiveParticipant[];
  /** The devices their pages run in, each once (a page that says none is a browser's). */
  devices: readonly LiveDevice[];
  /** This page is one of theirs. */
  self: boolean;
}

/** The person (or agent) a participant is. */
export function personKey(participant: Pick<LiveParticipant, 'id' | 'kind' | 'userId'>): string {
  return participant.kind === 'human' && participant.userId ? `u_${participant.userId}` : participant.id;
}

/**
 * The people on a canvas: this page's person first, then the others in the order they came, people before agents, and
 * AwwO's running Agents last. `heard` says when this page last heard of each participant (canvasLive's snapshot).
 */
export function peopleOf(participants: readonly LiveParticipant[], selfId: string, heard?: ReadonlyMap<string, number>): LivePerson[] {
  const groups = new Map<string, LiveParticipant[]>();
  for (const participant of participants) {
    if (!participant || typeof participant.id !== 'string') continue;
    const key = personKey(participant);
    const pages = groups.get(key);
    if (pages) pages.push(participant); else groups.set(key, [participant]);
  }
  const at = (participant: LiveParticipant) => participant.id === selfId ? Number.POSITIVE_INFINITY : heard?.get(participant.id) ?? 0;
  const people: LivePerson[] = [];
  for (const [key, pages] of groups) {
    const ordered = [...pages].sort((a, b) => at(b) - at(a));
    const seen = new Set<LiveDevice>();
    for (const page of pages) if (page.kind === 'human') seen.add(DEVICE_ORDER.includes(page.device as LiveDevice) ? page.device as LiveDevice : 'browser');
    people.push({ key, kind: ordered[0].kind, lead: ordered[0], pages: ordered, devices: DEVICE_ORDER.filter(device => seen.has(device)),
      self: pages.some(page => page.id === selfId) });
  }
  const rank = (person: LivePerson) => person.self ? 0 : person.kind === 'human' ? 1 : person.kind === 'agent' ? 2 : 3;
  return people.map((person, index) => ({ person, index })).sort((a, b) => rank(a.person) - rank(b.person) || a.index - b.index).map(entry => entry.person);
}

/** How many are on the canvas, as people: this page's person counts while its stream is open, before the server lists
 *  it. */
export function peopleCount(people: readonly LivePerson[]): number {
  return people.some(person => person.self) ? people.length : people.length + 1;
}

/** The page of a person a follower sees through: the one heard from last that says what its screen shows. */
export function followedPage(person: LivePerson | undefined): LiveParticipant | undefined {
  return person?.pages.find(page => page.state?.viewport);
}

import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  CONTEXT_PANEL_DEFAULT_WIDTH,
  CONTEXT_PANEL_MAX_WIDTH,
  CONTEXT_PANEL_MIN_WIDTH,
  clampContextPanelWidth,
  contextPanelInteraction,
  contextPanelUpperBound,
  effectiveContextPanelWidth,
} from '../src/lib/contextPanelGeometry';

// A roomy desktop where the panel can reach its full nominal range.
const WIDE = 1920;
const SIDEBAR = 300;

describe('clampContextPanelWidth', () => {
  it('clamps into the nominal [MIN, MAX] range and rounds', () => {
    expect(clampContextPanelWidth(10_000)).toBe(CONTEXT_PANEL_MAX_WIDTH);
    expect(clampContextPanelWidth(-50)).toBe(CONTEXT_PANEL_MIN_WIDTH);
    expect(clampContextPanelWidth(500.6)).toBe(501);
    expect(clampContextPanelWidth(CONTEXT_PANEL_DEFAULT_WIDTH)).toBe(CONTEXT_PANEL_DEFAULT_WIDTH);
  });
});

describe('contextPanelUpperBound', () => {
  it('is capped at MAX when the viewport is roomy', () => {
    expect(contextPanelUpperBound(WIDE, SIDEBAR)).toBe(CONTEXT_PANEL_MAX_WIDTH);
  });

  it('equals exactly the space left after sidebar + chat floor when cramped', () => {
    // 1145 - 300 - 420 = 425 (below MAX, above MIN)
    expect(contextPanelUpperBound(1145, SIDEBAR)).toBe(1145 - SIDEBAR - CHAT_MIN_WIDTH);
  });

  it('is allowed to fall below the nominal minimum so the panel can fit (no clip)', () => {
    // 950 - 300 - 420 = 230, deliberately < CONTEXT_PANEL_MIN_WIDTH
    const bound = contextPanelUpperBound(950, SIDEBAR);
    expect(bound).toBe(230);
    expect(bound).toBeLessThan(CONTEXT_PANEL_MIN_WIDTH);
  });

  it('never returns a negative track in an extreme window', () => {
    expect(contextPanelUpperBound(400, 460)).toBe(0);
  });

  it('shrinks as the sidebar grows (collapsed vs expanded footprint)', () => {
    expect(contextPanelUpperBound(1100, 84)).toBeGreaterThan(contextPanelUpperBound(1100, 300));
  });
});

describe('effectiveContextPanelWidth — chat is never crushed, panel never clips', () => {
  it('honors the preferred width when it fits', () => {
    expect(effectiveContextPanelWidth(560, WIDE, SIDEBAR)).toBe(560);
  });

  it('clamps a stored-too-wide preference down to fit the viewport', () => {
    // Preference 760 stored on a wide screen, now viewed at 1145 → must shrink to 425.
    expect(effectiveContextPanelWidth(760, 1145, SIDEBAR)).toBe(425);
  });

  it('GUARANTEE: the panel never eats into the chat floor (chat keeps >= CHAT_MIN_WIDTH)', () => {
    for (const viewport of [861, 900, 950, 1000, 1080, 1145, 1280, 1440, 1920]) {
      for (const sidebar of [84, 300, 460]) {
        for (const preferred of [CONTEXT_PANEL_MIN_WIDTH, 500, CONTEXT_PANEL_MAX_WIDTH]) {
          const eff = effectiveContextPanelWidth(preferred, viewport, sidebar);
          // The panel is never wider than the slack left after sidebar + chat floor, so
          // the chat column always retains at least CHAT_MIN_WIDTH. (When sidebar + chat
          // floor alone already exceed the viewport — an extreme max-sidebar + tiny-
          // window corner below the mobile breakpoint — the panel correctly collapses
          // to 0; the unavoidable overflow there is sidebar/chat, never the panel.)
          expect(eff).toBeLessThanOrEqual(Math.max(0, viewport - sidebar - CHAT_MIN_WIDTH));
        }
      }
    }
  });

  it('never renders wider than MAX even on an enormous screen', () => {
    expect(effectiveContextPanelWidth(CONTEXT_PANEL_MAX_WIDTH, 5000, SIDEBAR)).toBe(CONTEXT_PANEL_MAX_WIDTH);
  });
});

describe('contextPanelInteraction — gesture/ARIA origin matches the visible panel', () => {
  it('roomy viewport: bounds are the nominal range and effective honors preference', () => {
    const { lowerBound, upperBound, effective } = contextPanelInteraction(560, WIDE, SIDEBAR);
    expect(lowerBound).toBe(CONTEXT_PANEL_MIN_WIDTH);
    expect(upperBound).toBe(CONTEXT_PANEL_MAX_WIDTH);
    expect(effective).toBe(560);
  });

  it('cramped viewport: effective + bounds all reflect the fitted width, NOT the preference', () => {
    // The exact regression both advisors flagged: stored 760, but only 230 fits at 950.
    // effective (the gesture origin) must be 230 — never 760 — or the handle desyncs.
    const { lowerBound, upperBound, effective } = contextPanelInteraction(760, 950, SIDEBAR);
    expect(upperBound).toBe(230);
    expect(lowerBound).toBe(230); // collapses to the upper bound: no room to resize
    expect(effective).toBe(230);
  });

  it('moderate cramp: preference above the fit clamps effective to the fit (handle pinned)', () => {
    // 1200 - 300 - 420 = 480 fits; a stored 760 must show as 480 so a drag starts there.
    const { upperBound, effective } = contextPanelInteraction(760, 1200, SIDEBAR);
    expect(upperBound).toBe(480);
    expect(effective).toBe(480);
  });

  it('effectiveContextPanelWidth is the interaction.effective field', () => {
    for (const [vp, sb, pref] of [[WIDE, SIDEBAR, 560], [950, SIDEBAR, 760], [1200, 84, 700]] as const) {
      expect(effectiveContextPanelWidth(pref, vp, sb)).toBe(contextPanelInteraction(pref, vp, sb).effective);
    }
  });
});

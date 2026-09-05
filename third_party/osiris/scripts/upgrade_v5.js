/**
 * OSIRIS v5 Upgrade Script
 * ─────────────────────────
 * 1. Fix submarine cables data pipeline (page.tsx never fetches the static JSON)
 * 2. Upgrade cable rendering to multi-layer glow (3 layers like the target)
 * 3. Fix the ENTITIES count in the bottom HUD (was counting submarine_cables as entities)
 * 4. Add clickable cable popups with real cable metadata
 * 5. Improve cable glow opacity so dense trunks really pop
 */

const fs = require('fs');

// ═══════════════════════════════════════════════════════
// 1. PATCH page.tsx — Add submarine cables fetch
// ═══════════════════════════════════════════════════════
let page = fs.readFileSync('src/app/page.tsx', 'utf8');

// 1a. Add cable fetch inside the layer-aware data loading effect
if (!page.includes('/data/submarine-cables.json')) {
  const anchor = `// Global Incidents (GDELT)
    if (activeLayers.global_incidents && !layerFetchedRef.current.has('gdelt')) {
      fetchEndpoint('/api/gdelt', d => ({ gdelt: d.events }));
      layerFetchedRef.current.add('gdelt');
    }`;

  const cableFetch = `// Submarine Cables (static GeoJSON from TeleGeography)
    if (activeLayers.cables && !layerFetchedRef.current.has('cables')) {
      (async () => {
        try {
          const res = await fetch('/data/submarine-cables.json');
          if (res.ok) {
            const cablesData = await res.json();
            dataRef.current = { ...dataRef.current, submarine_cables: cablesData.features || [] };
            setDataVersion(v => v + 1);
          }
        } catch (e) { console.warn('[OSIRIS] Cables fetch failed:', e); }
      })();
      layerFetchedRef.current.add('cables');
    }`;

  if (page.includes(anchor)) {
    page = page.replace(anchor, anchor + '\n\n    ' + cableFetch);
    console.log('[page.tsx] ✓ Added submarine cables fetch');
  } else {
    console.log('[page.tsx] ✗ Could not find GDELT anchor for cable fetch injection');
  }
}

fs.writeFileSync('src/app/page.tsx', page);

// ═══════════════════════════════════════════════════════
// 2. PATCH OsirisMap.tsx — Upgrade cable rendering
// ═══════════════════════════════════════════════════════
let map = fs.readFileSync('src/components/OsirisMap.tsx', 'utf8');

// 2a. Replace the 2-layer cable rendering with a proper 3-layer glow stack
const oldCableLayers = `map.addLayer({ id: 'submarine-cables-line', type: 'line', source: 'submarine-cables', paint: {
          'line-color': '#4FC3F7',
          'line-width': ['interpolate',['linear'],['zoom'], 1, 0.5, 5, 1.0, 10, 2.0],
          'line-opacity': 0.15
        }});
        map.addLayer({ id: 'submarine-cables-glow', type: 'line', source: 'submarine-cables', paint: {
          'line-color': '#4FC3F7',
          'line-width': ['interpolate',['linear'],['zoom'], 1, 1.5, 5, 3.0, 10, 6.0],
          'line-opacity': 0.05
        }});`;

const newCableLayers = `// ══ SUBMARINE CABLES — TeleGeography real-world data ══
        // Layer 1: Wide outer glow (diffuse halo)
        map.addLayer({ id: 'submarine-cables-halo', type: 'line', source: 'submarine-cables', paint: {
          'line-color': '#29B6F6',
          'line-width': ['interpolate',['linear'],['zoom'], 1, 4, 3, 8, 6, 14, 10, 22],
          'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.015, 3, 0.025, 6, 0.04],
          'line-blur': 6,
        }});
        // Layer 2: Mid glow (visible trunk)
        map.addLayer({ id: 'submarine-cables-glow', type: 'line', source: 'submarine-cables', paint: {
          'line-color': '#4FC3F7',
          'line-width': ['interpolate',['linear'],['zoom'], 1, 1.5, 3, 3, 6, 5, 10, 8],
          'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.04, 3, 0.06, 6, 0.1],
          'line-blur': 2,
        }});
        // Layer 3: Core line (sharp, bright)
        map.addLayer({ id: 'submarine-cables-line', type: 'line', source: 'submarine-cables', paint: {
          'line-color': '#B3E5FC',
          'line-width': ['interpolate',['linear'],['zoom'], 1, 0.3, 3, 0.6, 6, 1.0, 10, 1.8],
          'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.08, 3, 0.15, 6, 0.25, 10, 0.4],
        }});`;

if (map.includes(oldCableLayers)) {
  map = map.replace(oldCableLayers, newCableLayers);
  console.log('[OsirisMap.tsx] ✓ Upgraded cable rendering to 3-layer glow stack');
} else {
  console.log('[OsirisMap.tsx] ✗ Could not find old cable layers to replace');
}

// 2b. Fix the visibility toggle to include the new halo layer
const oldVis = "setVis(['submarine-cables-line', 'submarine-cables-glow'], activeLayers.cables);";
const newVis = "setVis(['submarine-cables-halo', 'submarine-cables-glow', 'submarine-cables-line'], activeLayers.cables);";

if (map.includes(oldVis)) {
  map = map.replace(oldVis, newVis);
  console.log('[OsirisMap.tsx] ✓ Fixed visibility toggle for 3 cable layers');
}

// 2c. Add click handler for submarine cables (with cable name popup)
const hoverAnchor = "['conflict-icons','cctv-dots','eq-circles','sat-dots','fires-heat','gdelt-dots','weather-dots','infra-dots','maritime-dots','choke-dots','news-dots','sigint-news-dots','balloon-dots','rad-dots','ship-dots','sweep-device-dots','scan-targets-dots','sdk-sea','sdk-sea-glow','sdk-air','sdk-air-glow','sdk-intel','sdk-intel-glow']";
if (map.includes(hoverAnchor) && !map.includes('submarine-cables-line')) {
  // Add cable layers to hover list
  const newHover = hoverAnchor.replace("'sdk-intel-glow']", "'sdk-intel-glow','submarine-cables-line','submarine-cables-glow']");
  map = map.replace(hoverAnchor, newHover);
  console.log('[OsirisMap.tsx] ✓ Added cable hover cursors');
}

// 2d. Add cable click popup
if (!map.includes("'submarine-cables-line', e =>")) {
  const cablePopup = `
    // ── Submarine Cables ──
    map.on('click', 'submarine-cables-line', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = e.lngLat;
      const name = p.name || p.Name || 'Unknown Cable';
      const owners = p.owners || p.Owners || '';
      const rfs = p.rfs || p.RFS || '';
      const length_km = p.length || p['length km'] || '';
      popup([coords.lng, coords.lat], \`<div style="\${pStyle}border:1px solid rgba(79,195,247,0.4);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <div style="width:8px;height:8px;border-radius:50%;background:#4FC3F7;box-shadow:0 0 8px #4FC3F7;"></div>
          <span style="color:#4FC3F7;font-size:12px;font-weight:700;letter-spacing:0.1em;">⚡ SUBSEA CABLE</span>
        </div>
        <div style="color:#B3E5FC;font-size:11px;font-weight:700;margin-bottom:6px;">\${name}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px;">
          \${owners ? \`<div><span style="color:#5C5A54;">OWNER</span><br/><span style="color:#E8E6E0;">\${owners}</span></div>\` : ''}
          \${rfs ? \`<div><span style="color:#5C5A54;">RFS</span><br/><span style="color:#E8E6E0;">\${rfs}</span></div>\` : ''}
          \${length_km ? \`<div><span style="color:#5C5A54;">LENGTH</span><br/><span style="color:#E8E6E0;">\${length_km} km</span></div>\` : ''}
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">\${coords.lat.toFixed(3)}°, \${coords.lng.toFixed(3)}°</span></div>
        </div>
        <a href="https://www.submarinecablemap.com/" target="_blank" style="\${linkStyle}color:#4FC3F7;border:1px solid rgba(79,195,247,0.4);background:rgba(79,195,247,0.1);display:inline-block;margin-top:8px;">🌐 TELEGEOGRAPHY MAP</a>
      </div>\`);
    });
`;

  // Insert before the generic hover section
  const insertBefore = "    // ── Generic hover for clickables ──";
  if (map.includes(insertBefore)) {
    map = map.replace(insertBefore, cablePopup + '\n' + insertBefore);
    console.log('[OsirisMap.tsx] ✓ Added submarine cable click popup');
  }
}

fs.writeFileSync('src/components/OsirisMap.tsx', map);

// ═══════════════════════════════════════════════════════
// 3. PATCH LayerPanel.tsx — Exclude cables from entity total
// ═══════════════════════════════════════════════════════
let panel = fs.readFileSync('src/components/LayerPanel.tsx', 'utf8');

// The totalEntities line sums ALL layer dataKeys including submarine_cables
// Fix: exclude 'submarine_cables' and 'day_night' from entity count
const oldTotal = "const totalEntities = ALL_LAYERS.reduce((s: number, l: any) => s + (getCount(l.dataKey) || 0), 0);";
const newTotal = "const totalEntities = ALL_LAYERS.filter((l: any) => l.dataKey && l.dataKey !== 'submarine_cables').reduce((s: number, l: any) => s + (getCount(l.dataKey) || 0), 0);";

if (panel.includes(oldTotal)) {
  panel = panel.replace(oldTotal, newTotal);
  console.log('[LayerPanel.tsx] ✓ Fixed entity count to exclude submarine cables');
}

fs.writeFileSync('src/components/LayerPanel.tsx', panel);

console.log('\n══════════════════════════════════════');
console.log('  OSIRIS v5 Upgrade Complete');
console.log('══════════════════════════════════════');

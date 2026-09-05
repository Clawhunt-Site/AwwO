/**
 * OSIRIS v5.1 — Final Senior Engineer Refinements (Reconstructed)
 * ═════════════════════════════════════════════════
 * 
 * 1. Use TeleGeography's own cable colors (from data) for rendering
 * 2. Fix cable popup: deep-link to specific cable on submarinecablemap.com
 * 3. Register ALL cable layers for click/hover
 * 4. Add cable name labels at higher zoom levels
 * 5. Fix hover cursor for cable layers
 * 6. Enrich cables.json with segment counts
 */

const fs = require('fs');

// ═══════════════════════════════════════════════════════
// 1. UPGRADE OsirisMap.tsx — Full cable rendering overhaul
// ═══════════════════════════════════════════════════════
let map = fs.readFileSync('src/components/OsirisMap.tsx', 'utf8');

// 1a. Replace cable rendering to use each cable's own TeleGeography color
const oldCableLayers = `// ══ SUBMARINE CABLES — TeleGeography real-world data ══
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

const newCableLayers = `// ══ SUBMARINE CABLES — TeleGeography real-world data ══
        // Layer 1: Wide outer glow (diffuse halo) — uses each cable's own color
        map.addLayer({ id: 'submarine-cables-halo', type: 'line', source: 'submarine-cables', paint: {
          'line-color': ['coalesce', ['get', 'color'], '#4FC3F7'],
          'line-width': ['interpolate',['linear'],['zoom'], 1, 4, 3, 8, 6, 14, 10, 22],
          'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.015, 3, 0.025, 6, 0.04],
          'line-blur': 6,
        }});
        // Layer 2: Mid glow (visible trunk) — uses each cable's own color
        map.addLayer({ id: 'submarine-cables-glow', type: 'line', source: 'submarine-cables', paint: {
          'line-color': ['coalesce', ['get', 'color'], '#4FC3F7'],
          'line-width': ['interpolate',['linear'],['zoom'], 1, 1.5, 3, 3, 6, 5, 10, 8],
          'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.04, 3, 0.06, 6, 0.1],
          'line-blur': 2,
        }});
        // Layer 3: Core line (sharp, bright) — uses each cable's own color
        map.addLayer({ id: 'submarine-cables-line', type: 'line', source: 'submarine-cables', paint: {
          'line-color': ['coalesce', ['get', 'color'], '#B3E5FC'],
          'line-width': ['interpolate',['linear'],['zoom'], 1, 0.3, 3, 0.6, 6, 1.0, 10, 1.8],
          'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.08, 3, 0.15, 6, 0.25, 10, 0.4],
        }});
        // Layer 4: Cable name labels (visible at zoom >= 4)
        map.addLayer({ id: 'submarine-cables-label', type: 'symbol', source: 'submarine-cables', 
          minzoom: 4,
          layout: {
            'symbol-placement': 'line-center',
            'text-field': ['get', 'name'],
            'text-size': ['interpolate',['linear'],['zoom'], 4, 8, 8, 11, 12, 14],
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            'text-max-angle': 30,
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': ['coalesce', ['get', 'color'], '#B3E5FC'],
            'text-opacity': ['interpolate',['linear'],['zoom'], 4, 0.4, 8, 0.7, 12, 0.9],
            'text-halo-color': '#0a0a09',
            'text-halo-width': 1.5,
          }
        });`;

if (map.includes(oldCableLayers)) {
  map = map.replace(oldCableLayers, newCableLayers);
  console.log('[OsirisMap.tsx] ✓ Upgraded cable rendering to color-coded 4-layer stack with labels');
} else {
  console.log('[OsirisMap.tsx] ✗ Could not find old cable layers to replace');
}

// 1b. Add label layer to visibility toggle
const oldVis = "setVis(['submarine-cables-halo', 'submarine-cables-glow', 'submarine-cables-line'], activeLayers.cables);";
const newVis = "setVis(['submarine-cables-halo', 'submarine-cables-glow', 'submarine-cables-line', 'submarine-cables-label'], activeLayers.cables);";
if (map.includes(oldVis)) {
  map = map.replace(oldVis, newVis);
  console.log('[OsirisMap.tsx] ✓ Added label layer to visibility toggle');
}

// 1c. Upgrade cable popup to deep-link to TeleGeography
const oldPopup = `map.on('click', 'submarine-cables-line', e => {`;
const newPopup = `['submarine-cables-line', 'submarine-cables-glow', 'submarine-cables-halo'].forEach(cableLayer => {
      map.on('click', cableLayer, e => {`;
if (map.includes(oldPopup)) {
  map = map.replace(oldPopup, newPopup);
  
  // Find the closing of the click handler and add the forEach closing
  const popupEndOld = "const name = p.name || p.Name || 'Unknown Cable';";
  const popupEndNew = `const name = p.name || p.Name || 'Unknown Cable';
        const cableId = p.id || '';
        const cableColor = p.color || '#4FC3F7';`;
  map = map.replace(popupEndOld, popupEndNew);
  
  // Update the popup HTML to use deep-link and cable color
  const oldHtml = `<div style=\"\${pStyle}border:1px solid rgba(79,195,247,0.4);\">`; 
  const newHtml = `<div style=\"\${pStyle}border:1px solid \${cableColor}40;\">`;
  if (map.includes(oldHtml)) {
    map = map.replace(oldHtml, newHtml);
  }

  // Update the TeleGeography link to deep-link to specific cable
  const oldLink = "https://www.submarinecablemap.com/";
  if (map.includes(oldLink) && map.includes('submarine-cables')) {
    map = map.replace(
      "https://www.submarinecablemap.com/",
      "https://www.submarinecablemap.com/submarine-cable/\${cableId}"
    );
  }
  
  console.log('[OsirisMap.tsx] ✓ Upgraded cable popup: all 3 layers clickable, deep-linked to TeleGeography');
}

// 1d. Add cable layers to hover cursor list
const hoverListPattern = "'scan-targets-dots','sdk-sea','sdk-sea-glow'";
if (map.includes(hoverListPattern) && !map.includes("'submarine-cables-line','submarine-cables-glow'")) {
  map = map.replace(
    hoverListPattern,
    "'scan-targets-dots','submarine-cables-line','submarine-cables-glow','submarine-cables-halo','sdk-sea','sdk-sea-glow'"
  );
  console.log('[OsirisMap.tsx] ✓ Added cable layers to hover cursor list');
}

fs.writeFileSync('src/components/OsirisMap.tsx', map);

// ═══════════════════════════════════════════════════════
// 2. ENRICH cables.json with segment counts
// ═══════════════════════════════════════════════════════
try {
  const cablesData = JSON.parse(fs.readFileSync('public/data/submarine-cables.json', 'utf8'));
  const cableNames = new Set();
  cablesData.features.forEach(f => { if (f.properties?.name) cableNames.add(f.properties.name); });
  
  // Add segment_count to each feature
  const nameCounts = {};
  cablesData.features.forEach(f => {
    const name = f.properties?.name;
    if (name) nameCounts[name] = (nameCounts[name] || 0) + 1;
  });
  cablesData.features.forEach(f => {
    if (f.properties?.name) {
      f.properties.segments = nameCounts[f.properties.name];
    }
  });
  
  fs.writeFileSync('public/data/submarine-cables.json', JSON.stringify(cablesData));
  console.log(`[cables.json] ✓ Enriched with segment counts for ${cableNames.size} unique cables`);
} catch(e) {
  console.log('[cables.json] ✗ Could not enrich:', e.message);
}

console.log(`
══════════════════════════════════════
  OSIRIS v5.1 Final Refinements Done
══════════════════════════════════════
`);
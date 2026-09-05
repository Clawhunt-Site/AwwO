const fs = require('fs');

// Patch OsirisMap.tsx
let mapContent = fs.readFileSync('src/components/OsirisMap.tsx', 'utf8');

if (!mapContent.includes("'submarine-cables'")) {
  // Add source
  mapContent = mapContent.replace("'scan-targets', 'sdk-entities', 'sdk-links'];", "'scan-targets', 'sdk-entities', 'sdk-links', 'submarine-cables'];");
  
  // Add layer
  const layerStr = `
        map.addLayer({ id: 'submarine-cables-line', type: 'line', source: 'submarine-cables', paint: {
          'line-color': '#4FC3F7',
          'line-width': ['interpolate',['linear'],['zoom'], 1, 0.5, 5, 1.0, 10, 2.0],
          'line-opacity': 0.15
        }});
        map.addLayer({ id: 'submarine-cables-glow', type: 'line', source: 'submarine-cables', paint: {
          'line-color': '#4FC3F7',
          'line-width': ['interpolate',['linear'],['zoom'], 1, 1.5, 5, 3.0, 10, 6.0],
          'line-opacity': 0.05
        }});
`;
  mapContent = mapContent.replace("map.addLayer({ id: 'sdk-intel',", layerStr + "        map.addLayer({ id: 'sdk-intel',");

  // Add data sync
  const geoStr = `
    useEffect(() => {
      if (!mapReady) return;
      setGeo('submarine-cables', activeLayers.cables && data.submarine_cables ? data.submarine_cables : []);
      setVis(['submarine-cables-line', 'submarine-cables-glow'], activeLayers.cables);
    }, [mapReady, data.submarine_cables, activeLayers.cables, setGeo, setVis]);
`;
  mapContent = mapContent.replace("return <div ref={containerRef}", geoStr + "  return <div ref={containerRef}");
  
  fs.writeFileSync('src/components/OsirisMap.tsx', mapContent);
  console.log('Patched OsirisMap.tsx');
}

// Patch LayerPanel.tsx
let panelContent = fs.readFileSync('src/components/LayerPanel.tsx', 'utf8');

if (!panelContent.includes("key: 'cables'")) {
  const cableItemStr = `      { key: 'cables', label: 'Subsea Data Cables', icon: Network, color: '#4FC3F7', dataKey: 'submarine_cables' },\n`;
  panelContent = panelContent.replace("{ key: 'maritime', label: 'Maritime / Naval', icon: Anchor, color: '#4FC3F7', dataKey: 'maritime_ships' },", cableItemStr + "        { key: 'maritime', label: 'Maritime / Naval', icon: Anchor, color: '#4FC3F7', dataKey: 'maritime_ships' },");
  
  fs.writeFileSync('src/components/LayerPanel.tsx', panelContent);
  console.log('Patched LayerPanel.tsx');
}

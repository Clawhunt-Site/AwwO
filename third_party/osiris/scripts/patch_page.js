const fs = require('fs');
let c = fs.readFileSync('src/app/page.tsx', 'utf8');

if (!c.includes('cables: true')) {
  c = c.replace('day_night: true,', 'day_night: true,\n    cables: true,');
}

const fetchAnchor = "layerFetchedRef.current.add('gdelt');\n    }";
const fetchStr = `

    // Submarine Cables
    if (activeLayers.cables && !layerFetchedRef.current.has('cables')) {
      (async () => {
        try {
          const res = await fetch('/data/submarine-cables.json');
          if (res.ok) {
             const cablesData = await res.json();
             dataRef.current = { ...dataRef.current, submarine_cables: cablesData.features };
             setDataVersion(v => v + 1);
          }
        } catch (e) { console.warn('Cables fetch failed'); }
      })();
      layerFetchedRef.current.add('cables');
    }
`;

if (!c.includes('/data/submarine-cables.json')) {
  c = c.replace(fetchAnchor, fetchAnchor + fetchStr);
}

fs.writeFileSync('src/app/page.tsx', c);
console.log('Fixed page.tsx');

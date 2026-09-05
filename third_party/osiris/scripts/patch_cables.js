const fs = require('fs');
let c = fs.readFileSync('src/app/page.tsx', 'utf8');

if (!c.includes('cables: true')) {
  c = c.replace('day_night: true,', 'day_night: true,\n    cables: true,');
}

if (!c.includes('/data/submarine-cables.json')) {
  const fetchStr = `
      try {
        const res = await fetch('/data/submarine-cables.json');
        if (res.ok) {
           const cablesData = await res.json();
           dataRef.current = { ...dataRef.current, submarine_cables: cablesData.features };
        }
      } catch (e) { console.warn('Cables fetch failed'); }
`;
  c = c.replace("try {\n        const res = await fetch(`/api/region-dossier", fetchStr + "      try {\n        const res = await fetch(`/api/region-dossier");
}

fs.writeFileSync('src/app/page.tsx', c);
console.log('Patched page.tsx for cables');

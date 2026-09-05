const fs = require('fs');
let c = fs.readFileSync('src/components/LayerPanel.tsx', 'utf8');

if (!c.includes('cables')) {
  const search = `{ key: 'maritime', label: 'Maritime / Naval', icon: Ship, color: '#00BCD4', dataKey: 'maritime_ships,maritime_ports,maritime_chokepoints' },`;
  const replace = `{ key: 'cables', label: 'Subsea Data Cables', icon: Network, color: '#4FC3F7', dataKey: 'submarine_cables' },\n        ` + search;
  c = c.replace(search, replace);
  fs.writeFileSync('src/components/LayerPanel.tsx', c);
  console.log('Patched');
}

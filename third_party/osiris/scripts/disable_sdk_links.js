const fs = require('fs');
let c = fs.readFileSync('src/components/OsirisMap.tsx', 'utf8');

c = c.replace(/setGeo\('sdk-links', links\);/g, "// setGeo('sdk-links', links);");

fs.writeFileSync('src/components/OsirisMap.tsx', c);
console.log('Disabled sdk-links rendering in OsirisMap.tsx');

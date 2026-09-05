const fs = require('fs');
let c = fs.readFileSync('src/app/page.tsx', 'utf8');

// Ensure PolybolosClient is imported
if (!c.includes('PolybolosClient')) {
    c = c.replace("import { useEffect", "import { PolybolosClient } from '@/lib/sdk/PolybolosClient';\nimport { useEffect");
}

// Find the start of the useEffect
const startToken = '// â”€â”€ OSIRIS SDK';
const startIdx = c.indexOf('OSIRIS SDK');

// Let's use a regex to replace the entire useEffect
const replaced = c.replace(/\/\/[ \t]*[^\n]*OSIRIS SDK.*?dataRef\.current = \{ \.\.\.dataRef\.current, sdk_entities: sdkEntities \};\n[ \t]*\}, \[dataVersion, activeLayers\.sdk_stream\]\);/s, `// ── OSIRIS SDK - Polybolos Client Integration ──
    const polybolosRef = useRef<PolybolosClient | null>(null);

    useEffect(() => {
      polybolosRef.current = new PolybolosClient({ osirisBaseUrl: '' });
      polybolosRef.current.initialize();
      return () => { polybolosRef.current?.destroy(); };
    }, []);

    useEffect(() => {
      if (!activeLayers.sdk_stream) {
        dataRef.current = { ...dataRef.current, sdk_entities: [] };
        return;
      }
      if (polybolosRef.current && dataRef.current) {
        polybolosRef.current.ingestOsirisData(dataRef.current);
        const geoJSON = polybolosRef.current.toGeoJSON();
        dataRef.current = { ...dataRef.current, sdk_entities: geoJSON.features };
      }
    }, [dataVersion, activeLayers.sdk_stream]);`);

fs.writeFileSync('src/app/page.tsx', replaced);
console.log('Patched page.tsx');

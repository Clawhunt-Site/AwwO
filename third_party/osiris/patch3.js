const fs = require('fs');
let c = fs.readFileSync('src/app/page.tsx', 'utf8');

// Ensure PolybolosClient is imported
if (!c.includes('PolybolosClient')) {
    c = c.replace("import { useEffect", "import { PolybolosClient } from '@/lib/sdk/PolybolosClient';\nimport { useEffect");
}

const lines = c.split('\n');
let startIdx = -1;
let endIdx = -1;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('OSIRIS SDK') && lines[i].includes('Intelligence Fusion Layer')) {
        startIdx = i;
    }
    if (startIdx > -1 && i > startIdx && lines[i].includes('}, [dataVersion, activeLayers.sdk_stream]);')) {
        endIdx = i;
        break;
    }
}

if (startIdx > -1 && endIdx > -1) {
    const replacement = `    // ── OSIRIS SDK - Polybolos Client Integration ──
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
    }, [dataVersion, activeLayers.sdk_stream]);`;
    
    lines.splice(startIdx, endIdx - startIdx + 1, replacement);
    fs.writeFileSync('src/app/page.tsx', lines.join('\n'));
    console.log('Patched page.tsx successfully');
} else {
    console.log('Failed to find bounds:', startIdx, endIdx);
}

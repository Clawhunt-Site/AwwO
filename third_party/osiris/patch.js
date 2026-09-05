const fs = require('fs');
let c = fs.readFileSync('src/app/page.tsx', 'utf8');
const start = c.indexOf('    // -- OSIRIS SDK — Intelligence Fusion Layer');
const endStr = '    }, [dataVersion, activeLayers.sdk_stream]);\n';
const end = c.indexOf(endStr, start);
if (start > -1 && end > -1) {
    const replacement =     // -- OSIRIS SDK - Polybolos Client Integration --
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
    }, [dataVersion, activeLayers.sdk_stream]);\n;
    c = c.substring(0, start) + replacement + c.substring(end + endStr.length);
    fs.writeFileSync('src/app/page.tsx', c);
    console.log('Patched');
} else {
    console.log('Failed to find bounds');
}

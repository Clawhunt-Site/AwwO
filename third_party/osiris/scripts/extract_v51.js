const fs = require('fs');
const data = fs.readFileSync('C:/Users/mrads/.gemini/antigravity/brain/3d9dabed-3818-4731-b2a2-68678fb1406c/.system_generated/logs/transcript.jsonl', 'utf8');
const lines = data.split('\n');
for (const line of lines) {
  if (line.includes('"step_index":16181')) {
    try {
      const obj = JSON.parse(line);
      const rawCode = obj.tool_calls[0].args.CodeContent;
      // The CodeContent might be a JSON-escaped string (wrapped in quotes)
      let code;
      if (rawCode.startsWith('"') && rawCode.endsWith('"')) {
        code = JSON.parse(rawCode);
      } else {
        code = rawCode;
      }
      fs.writeFileSync('scripts/upgrade_v5_1.js', code);
      console.log('Written upgrade_v5_1.js, length:', code.length);
    } catch(e) {
      console.error('Parse error:', e.message);
    }
    break;
  }
}

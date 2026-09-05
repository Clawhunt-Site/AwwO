const fs = require('fs');
const readline = require('readline');

async function extract() {
  const fileStream = fs.createReadStream('C:\\Users\\mrads\\.gemini\\antigravity\\brain\\3d9dabed-3818-4731-b2a2-68678fb1406c\\.system_generated\\logs\\transcript.jsonl');
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lastContent = null;

  for await (const line of rl) {
    if (line.includes('OsirisMap.tsx') && line.includes('TargetFile')) {
        // We're looking for tool inputs and outputs.
        // Actually, let's just find the last time I viewed the file successfully.
        if (line.includes('VIEW_FILE')) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.content && parsed.content.includes('OsirisMap.tsx') && parsed.content.includes('File Path:')) {
                    lastContent = parsed.content;
                }
            } catch (e) {}
        }
    }
  }

  if (lastContent) {
    fs.writeFileSync('OsirisMap.tsx.recovered.txt', lastContent);
    console.log('Recovered successfully.');
  } else {
    console.log('Not found.');
  }
}
extract();

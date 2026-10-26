import fs from 'node:fs';
import path from 'node:path';

export function stageWindowsBackend(source, target, appEnv) {
  // Validate before replacing an existing resource tree.
  if (!fs.statSync(path.join(source, 'superclaw-backend.exe')).isFile()
      || !fs.statSync(path.join(source, '_internal')).isDirectory()) {
    throw new Error('Windows backend must be an onedir distribution');
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  fs.writeFileSync(path.join(target, 'build-profile.json'), `${JSON.stringify({ app_env: appEnv }, null, 2)}\n`);
}

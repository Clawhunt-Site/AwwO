import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** What scripts/awwo-local-package-macos.mjs writes beside a complete payload (awwo-local-payload.json). */
export type PayloadManifest = {
  format: number; system: string; revision: string; dirty: boolean; packagedAt: string; files: number; bytes: number;
  signed?: string[];
};

/** The manifest's format this app's build reads (MAC_MANIFEST_FORMAT of the packager). */
export const PAYLOAD_FORMAT = 1;
/** What a payload must hold for the app to start its runtime (LocalPaths in AwwOLocal.swift). */
export const PAYLOAD_ENTRIES = Object.freeze(['app/scripts/awwo-local.mjs', 'build/node/bin/node', 'build/awwo-api', 'build/pgsql/bin/postgres', 'licenses/LICENSE']);

/**
 * The payload of a folder (AWWO_MAC_LOCAL_PAYLOAD), checked before the app is built around it: assembled completely
 * for this app's system by the packager of this format, from the commit the app is built from (revision), without
 * changes unless a build to test allows them, and holding what the app starts. Throws with what is wrong.
 */
export function readPayload(folder: string, { revision, allowDirty = false }: { revision: string; allowDirty?: boolean }): PayloadManifest {
  if (!path.isAbsolute(folder)) throw new Error('AWWO_MAC_LOCAL_PAYLOAD must be the absolute path of a payload folder.');
  const file = path.join(folder, 'awwo-local-payload.json');
  if (!existsSync(file)) throw new Error(`${folder} holds no payload: run node scripts/awwo-local-package-macos.mjs --out <folder> first.`);
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a payload's manifest.`);
  const manifest = value as Partial<PayloadManifest> & { assembling?: boolean };
  if (manifest.assembling || typeof manifest.revision !== 'string') throw new Error(`The payload in ${folder} is not complete: assemble it again.`);
  if (manifest.format !== PAYLOAD_FORMAT) throw new Error(`The payload in ${folder} is of format ${manifest.format}, not ${PAYLOAD_FORMAT}: assemble it again with this checkout's packager.`);
  if (manifest.system !== 'macos-arm64') throw new Error(`The payload in ${folder} is for ${manifest.system}, not this app (macos-arm64).`);
  if (manifest.revision !== revision) throw new Error(`The payload was assembled from ${manifest.revision}, not ${revision}, which this app is built from: assemble it again.`);
  if (manifest.dirty && !allowDirty) throw new Error('The payload was assembled from a checkout with changes: commit them and assemble it again.');
  for (const entry of PAYLOAD_ENTRIES) {
    const target = path.join(folder, ...entry.split('/'));
    if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error(`The payload lacks ${entry}.`);
  }
  return manifest as PayloadManifest;
}

import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_REF_PREFIX, clearSaaSCanvas, configureSaaSCanvas, storedArtifactUrl } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } as const;
const id = 'a' + 'B'.repeat(32);

afterEach(() => clearSaaSCanvas());

describe('stored file deliverables resolve to a real download', () => {
  it('builds a tenant-scoped download URL for a stored reference', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    expect(storedArtifactUrl(`${ARTIFACT_REF_PREFIX}${id}`)).toBe(`/api/v1/tenants/tenant-a/artifacts/${id}`);
  });

  it('resolves nothing without a cloud workspace, so a native canvas keeps its local reference', () => {
    expect(storedArtifactUrl(`${ARTIFACT_REF_PREFIX}${id}`)).toBeNull();
  });

  it('refuses values that are not a well-formed stored reference', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    for (const value of [
      '', './local/path.txt', 'C:/Users/report.docx', ARTIFACT_REF_PREFIX, `${ARTIFACT_REF_PREFIX}   `,
      // An id is never interpolated unvalidated: traversal, a foreign absolute URL and a query
      // must not be able to redirect the request somewhere else.
      `${ARTIFACT_REF_PREFIX}../../auth/me`, `${ARTIFACT_REF_PREFIX}${id}/../../tenants/other/artifacts/x`,
      `${ARTIFACT_REF_PREFIX}https://evil.test/x`, `${ARTIFACT_REF_PREFIX}${id}?raw=1`, `${ARTIFACT_REF_PREFIX}short`,
    ]) {
      expect(storedArtifactUrl(value)).toBeNull();
    }
    expect(storedArtifactUrl(undefined as unknown as string)).toBeNull();
  });

  it('stays inside the active workspace when the workspace changes', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const first = storedArtifactUrl(`${ARTIFACT_REF_PREFIX}${id}`);
    configureSaaSCanvas({ tenant: { ...tenant, id: 'tenant-b' }, canvasId: 'canvas-b' });
    const second = storedArtifactUrl(`${ARTIFACT_REF_PREFIX}${id}`);
    expect(first).toContain('/tenants/tenant-a/');
    expect(second).toContain('/tenants/tenant-b/');
  });
});

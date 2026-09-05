import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readStudioDispatchSession,
  STUDIO_DISPATCH_SESSION_KEY,
} from '../src/features/studio/session/studioSession.ts';

function installWindowWithStorage(value) {
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return key === STUDIO_DISPATCH_SESSION_KEY ? value : null;
      },
    },
  };
  return () => {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  };
}

test('readStudioDispatchSession restores dispatch context without a project id', () => {
  const restoreWindow = installWindowWithStorage(JSON.stringify({
    sessionId: 'dispatch_session_contract',
    targetId: 'dispatch:explore',
    pageId: 'explore',
    pageName: 'Explore',
    navigationPath: '/',
    studioReturnPath: '/dreamy',
    updatedAt: '2026-06-02T00:00:00.000Z',
  }));

  try {
    const session = readStudioDispatchSession();

    assert.equal(session?.projectId, '');
    assert.equal(session?.sessionId, 'dispatch_session_contract');
    assert.equal(session?.targetId, 'dispatch:explore');
    assert.equal(session?.pageId, 'explore');
  } finally {
    restoreWindow();
  }
});

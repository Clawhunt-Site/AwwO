import catalog from '../../../backend/internal/app/appearance_catalog.json';

/** Explicit companion GET response for tests focused on another SaaS capability.
 * Appearance behavior is exercised separately; the real scope still mounts here. */
export const appearanceFixture = { ...catalog, active_preset: 'default', custom: { light: {}, dark: {} }, version: 0 };

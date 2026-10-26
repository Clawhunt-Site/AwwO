import assert from "node:assert/strict";

import { normalizeAppEnv, resolveBuildAppEnv } from "../scripts/app-env.mjs";

// Aliases normalize to canonical APP_ENV values (so the baked profile is never an alias).
// Development remains separate from online acceptance.
assert.equal(normalizeAppEnv("prod"), "production");
assert.equal(normalizeAppEnv("stage"), "staging");
assert.equal(normalizeAppEnv("DEV"), "development");
assert.equal(normalizeAppEnv("development"), "development");
assert.equal(normalizeAppEnv("  Staging "), "staging");
assert.equal(normalizeAppEnv(""), "");
assert.equal(normalizeAppEnv(undefined), "");
assert.throws(() => normalizeAppEnv("pruduction"), /APP_ENV must be one of/);

// No selectors → staging (the default non-production identity).
assert.equal(resolveBuildAppEnv(undefined, undefined), "staging");
// Single selector wins.
assert.equal(resolveBuildAppEnv("staging", undefined), "staging");
assert.equal(resolveBuildAppEnv(undefined, "production"), "production");
// Aliases that resolve to the same canonical env do NOT count as a mismatch.
assert.equal(resolveBuildAppEnv("prod", "production"), "production");
assert.equal(resolveBuildAppEnv("staging", "stage"), "staging");
// A genuine mismatch fails closed (no hybrid-identity bundle).
assert.throws(
  () => resolveBuildAppEnv("production", "staging"),
  /environment mismatch/,
);

console.log("desktop-app-env.test.mjs ok");

assert.equal(resolveBuildAppEnv("local", "development"), "development");
assert.throws(() => resolveBuildAppEnv("development", "staging"), /environment mismatch/);

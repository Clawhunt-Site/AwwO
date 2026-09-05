import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Upstream migration/recovery artifacts are preserved for provenance but
    // are not part of the runnable Next app surface.
    "announce_upgrade.js",
    "diff.txt",
    "fix_*.py",
    "fork.diff",
    "generate_*.js",
    "ito69_fork.diff",
    "make_pdf.js",
    "patch*.js",
    "recover.js",
    "scripts/**/*.js",
    "temp_routes.txt",
  ]),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // Osiris upstream uses dynamic OSINT payloads extensively. Runtime
      // confidence comes from Next build plus SuperClaw permission gates.
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;

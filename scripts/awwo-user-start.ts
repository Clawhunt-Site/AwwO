import { exists, root, run } from "./awwo-saas-lib.mjs";

// One command for the account-based product. Existing data and keys stay in
// .local/awwo-saas; this launcher never signs up or buys provider credits.
try {
  const dependencies = [
    "apps/web/node_modules/vite/bin/vite.js",
    "apps/pi-worker/node_modules/@earendil-works/pi-ai/package.json",
    "apps/openai-agents-worker/node_modules/@openai/agents/package.json",
  ];
  if (
    !(
      await Promise.all(dependencies.map((file) => exists(`${root}/${file}`)))
    ).every(Boolean)
  ) {
    await run(process.execPath, ["scripts/awwo-saas-setup.mjs"]);
  }
  const { runDevelopment } = await import("./awwo-saas-dev.mjs");
  await runDevelopment();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "AwwO could not start",
  );
  process.exitCode = 1;
}

/**
 * Fault-injection extension for the REAL-binary integration spike.
 *
 * Writes ~256KB of distinctive noise to stderr, then throws at load time so the
 * governance handler never registers and no ready file is written — the run
 * never activates governance. SuperClaw's _spawn_rpc surfaces the DRAINED
 * child stderr in its ungoverned output.
 *
 * Scope: this fixture proves stderr CAPTURE on the real binary (the noise must
 * appear in the surfaced output). The ~32KB tail BOUNDING is rigorously
 * unit-tested separately (test_clawwork_spawn_rpc_bounds_captured_stderr_tail)
 * with a long-lived blocking child; here the Node child exits on the throw, so
 * only ~one pipe-load reaches the parent. (We assert on the noise pattern, not
 * a trailing marker: the child exits on the throw and Node's async stderr
 * buffer does not flush its final write before exit, so a last-line marker
 * would be lost — itself an observed real-binary behavior.)
 */
const line = "clawwork-flood-noise " + "x".repeat(200) + "\n";
for (let i = 0; i < 1100; i++) {
	process.stderr.write(line);
}
throw new Error("fault-stderr-flood-then-throw: simulated load failure after flood");

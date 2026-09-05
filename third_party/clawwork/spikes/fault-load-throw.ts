/**
 * Fault-injection extension for the REAL-binary integration spike.
 *
 * Writes a distinctive marker to stderr, then throws at load time. clawwork's
 * loader catches the throw and CONTINUES (the governance handler never
 * registers, so no ready file is written) — the handshake must time out.
 *
 * The marker proves whether the child's stderr actually reaches SuperClaw's
 * _spawn_rpc timeout path. If it does NOT, the "surface stderr on handshake
 * timeout" diagnostic fix is useless on the real binary — exactly the kind of
 * wrong assumption a mock subprocess can hide.
 */
process.stderr.write("FAULT_LOAD_MARKER: governance extension failed to load (simulated)\n");
throw new Error("FAULT_LOAD_MARKER simulated governance load failure");

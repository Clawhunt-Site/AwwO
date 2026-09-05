import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Host extension point: an external "capability store" opener, delivered via React
 * context (NOT a module-level singleton) so a board page reads the host mode
 * SYNCHRONOUSLY on its very first render.
 *
 * When the board is embedded inside a host shell (SuperClaw's apps/web) that owns a
 * richer capability store for acquiring plugins/skills/companies (the Capability
 * Workshop, backed by the signed `~/.superclaw/plugins` library + workshop
 * distribution), the host wraps the board in `CapabilityStoreProvider` with an opener,
 * and board pages delegate their "get more plugins" entry point to it — instead of the
 * board's own standalone npm-install dialog.
 *
 * Standalone Paperclip (no provider) inherits the default `{ available: false }`, so
 * the board keeps its own install flow unchanged — this never removes a standalone
 * capability, it only lets a host override the entry point.
 *
 * Why context, not a registered singleton: an effect-registered global opener is
 * `null` on the first render, so a page that mounts together with the board (e.g. a
 * deep link straight to the plugins settings page) would render the standalone branch
 * and fire its fetch for one frame before the effect runs — and StrictMode's
 * double-invoke amplifies it. A provider supplies the value during render, before any
 * child effect, so there is no flash and no wrong-endpoint fetch. It is also naturally
 * scoped per board instance (no cross-instance unmount races).
 *
 * Lives in `server/ui` because the board pages must import it and `server/ui` cannot
 * import from `apps/web`; the host (apps/web) CAN import this module via the board's
 * `@/` alias, the same way it imports the board's React Query client / context providers.
 */

export interface CapabilityStoreApi {
  /** True when a host provided an opener (the board is embedded in a host capability store). */
  available: boolean;
  /** Open the host capability store; a no-op returning false when unavailable. */
  open: () => boolean;
}

const NOOP_CAPABILITY_STORE: CapabilityStoreApi = {
  available: false,
  open: () => false,
};

const CapabilityStoreContext = createContext<CapabilityStoreApi>(NOOP_CAPABILITY_STORE);

/**
 * Host-side provider. Wrap the embedded board in this with `opener` set to open the
 * host capability store; pass `null`/omit (standalone) to leave the board on its own
 * install flow.
 */
export function CapabilityStoreProvider({
  opener,
  children,
}: {
  opener?: (() => void) | null;
  children: ReactNode;
}) {
  const value = useMemo<CapabilityStoreApi>(
    () =>
      opener
        ? {
            available: true,
            open: () => {
              opener();
              return true;
            },
          }
        : NOOP_CAPABILITY_STORE,
    [opener],
  );
  return <CapabilityStoreContext.Provider value={value}>{children}</CapabilityStoreContext.Provider>;
}

/** Read the host capability store. Returns `{ available: false }` outside a provider. */
export function useCapabilityStore(): CapabilityStoreApi {
  return useContext(CapabilityStoreContext);
}

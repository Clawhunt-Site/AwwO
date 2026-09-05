import { createContext, useContext, type ReactNode } from "react";

export interface EmbeddedHostIntegration {
  onCreateCompany: () => void;
}

const EmbeddedHostContext = createContext<EmbeddedHostIntegration | null>(null);

export function EmbeddedHostProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: EmbeddedHostIntegration | null;
}) {
  return (
    <EmbeddedHostContext.Provider value={value ?? null}>
      {children}
    </EmbeddedHostContext.Provider>
  );
}

export function useEmbeddedHost() {
  return useContext(EmbeddedHostContext);
}

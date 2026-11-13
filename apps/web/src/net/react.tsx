import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { GameClient } from './client';
import type { ClientState } from './store';

const ClientContext = createContext<GameClient | null>(null);

export function ClientProvider({ client, children }: { client: GameClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): GameClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useClient outside <ClientProvider>');
  return client;
}

/** The whole client state; components re-render on every store change (state is small). */
export function useClientState(): ClientState {
  const { store } = useClient();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

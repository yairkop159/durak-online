import {
  DEFAULT_GAME_CONFIG,
  type Card,
  type ClientToServerEvents,
  type GameConfig,
  type GamePhase,
  type GameStatePayload,
  type PlayerView,
  type Rank,
  type RoomStatePayload,
  type ServerToClientEvents,
  type Suit,
} from '@durak/shared';
import { act, render } from '@testing-library/react';
import { App } from '../src/App';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage, type KeyValueStorage } from '../src/net/sessionStore';
import type { Transport } from '../src/net/transport';

type ServerEvent = keyof ServerToClientEvents;
type ClientEvent = keyof ClientToServerEvents;

/** In-memory transport: records emits, lets tests play the server. */
export class FakeTransport implements Transport {
  connected = false;
  readonly emitted: { event: ClientEvent; payload: unknown }[] = [];
  reconnects = 0;
  private readonly handlers = new Map<string, ((payload: never) => void)[]>();
  private connectListeners: (() => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  onConnect(listener: () => void): void {
    this.connectListeners.push(listener);
  }
  onDisconnect(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }
  on<E extends ServerEvent>(event: E, listener: ServerToClientEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as (payload: never) => void);
    this.handlers.set(event, list);
  }
  emit<E extends ClientEvent>(event: E, payload: Parameters<ClientToServerEvents[E]>[0]): void {
    this.emitted.push({ event, payload });
  }
  reconnect(): void {
    this.reconnects++;
  }
  close(): void {
    this.connected = false;
  }

  // ---- test controls ----
  connect(): void {
    this.connected = true;
    for (const l of this.connectListeners) l();
  }
  disconnect(): void {
    this.connected = false;
    for (const l of this.disconnectListeners) l();
  }
  serverSends<E extends ServerEvent>(event: E, payload: Parameters<ServerToClientEvents[E]>[0]): void {
    for (const h of this.handlers.get(event) ?? []) (h as (p: typeof payload) => void)(payload);
  }
  emittedOf(event: ClientEvent): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

const RANKS: Record<string, Rank> = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };

/** "10H" -> { rank: 10, suit: 'H' } */
export function c(label: string): Card {
  const rank = RANKS[label.slice(0, -1)];
  if (rank === undefined) throw new Error(`bad card ${label}`);
  return { rank, suit: label.slice(-1) as Suit };
}

export function cards(labels: string): Card[] {
  return labels.trim() ? labels.trim().split(/\s+/).map(c) : [];
}

export interface ViewSpec {
  viewer?: string | null;
  hand?: string;
  counts?: Record<string, number>;
  trump?: string;
  table?: [string, string | null][];
  attacker?: string;
  defender?: string;
  phase?: GamePhase;
  boutNumber?: number;
  deckCount?: number;
  finished?: string[];
  config?: Partial<GameConfig>;
}

/** A hand-built PlayerView. Players: keys of `counts` (default me/bob), seated in that order. */
export function makeView(spec: ViewSpec = {}): PlayerView {
  const counts = spec.counts ?? { me: 6, bob: 6 };
  const ids = Object.keys(counts);
  const table = (spec.table ?? []).map(([a, d]) => ({ attack: c(a), defense: d ? c(d) : null }));
  const trumpCard = c(spec.trump ?? '6D');
  return {
    viewerId: spec.viewer === undefined ? 'me' : spec.viewer,
    hand: spec.viewer === null ? [] : cards(spec.hand ?? ''),
    players: ids.map((id) => ({ id, handCount: counts[id]!, finished: spec.finished?.includes(id) ?? false })),
    deckCount: spec.deckCount ?? 10,
    trumpCard,
    trumpSuit: trumpCard.suit,
    discardCount: 0,
    table,
    attackerId: spec.attacker ?? ids[0]!,
    defenderId: spec.defender ?? ids[1]!,
    phase: spec.phase ?? (table.length ? { kind: 'bout', taking: false, passed: [] } : { kind: 'awaitingAttack' }),
    boutNumber: spec.boutNumber ?? 2,
    finishOrder: spec.finished ?? [],
    config: { ...DEFAULT_GAME_CONFIG, ...spec.config },
    lastBout: null,
  };
}

export const ROOM_ID = 'room1234';

export function roomState(status: RoomStatePayload['status'], ids: string[] = ['me', 'bob']): RoomStatePayload {
  return {
    roomId: ROOM_ID,
    hostId: ids[0]!,
    maxPlayers: ids.length,
    members: ids.map((id) => ({ playerId: id, nickname: id.toUpperCase(), connected: true, isBot: false, afk: false })),
    spectatorCount: 0,
    status,
  };
}

export function gameState(view: PlayerView, version = 3, extra: Partial<GameStatePayload> = {}): GameStatePayload {
  return { roomId: ROOM_ID, version, view, turnDeadline: null, serverTime: 1_000, ...extra };
}

/**
 * Renders the whole app at /room/ROOM_ID with a session for `playerId`, the room playing,
 * and `view` as the current game state.
 */
export function renderTable(view: PlayerView, options: { version?: number; storage?: KeyValueStorage } = {}) {
  window.history.replaceState(null, '', `/room/${ROOM_ID}`);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage: options.storage ?? new MemoryStorage(), now: () => 1_000 });
  const utils = render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
  act(() => {
    transport.connect();
    const ids = view.players.map((p) => p.id);
    const me = view.viewerId ?? 'watcher';
    transport.serverSends('session:issued', { sessionToken: 'x'.repeat(43), playerId: me, roomId: ROOM_ID });
    transport.serverSends('room:state', roomState('playing', ids));
    transport.serverSends('game:state', gameState(view, options.version ?? 3));
  });
  return { ...utils, transport, client };
}

/**
 * Browser-test fixture (served by the Vite dev server, never built): the real app on a table, fed
 * by an in-page fake server. Two consecutive states — carl transfers bob's attack to me — so the
 * real animation pipeline shows a moment banner and a seat effect, then reactions arrive (bubbles
 * over my seat, right above the hand). I am the defender: hand cards are playable and "Take" is
 * legal. `window.__fixture.ready` turns true once both states and the reactions were delivered.
 */
import {
  DEFAULT_GAME_CONFIG,
  type Card,
  type ClientToServerEvents,
  type PlayerView,
  type ServerToClientEvents,
} from '@durak/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../../src/App';
import '../../../src/index.css';
import { GameClient } from '../../../src/net/client';
import { ClientProvider } from '../../../src/net/react';
import { MemoryStorage } from '../../../src/net/sessionStore';
import type { Transport } from '../../../src/net/transport';

type ServerEvent = keyof ServerToClientEvents;

class PageTransport implements Transport {
  connected = false;
  private readonly handlers = new Map<string, ((payload: never) => void)[]>();
  private connectListeners: (() => void)[] = [];
  readonly emitted: { event: keyof ClientToServerEvents; payload: unknown }[] = [];
  onConnect(listener: () => void): void {
    this.connectListeners.push(listener);
  }
  onDisconnect(): void {}
  on<E extends ServerEvent>(event: E, listener: ServerToClientEvents[E]): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener as (payload: never) => void]);
  }
  emit<E extends keyof ClientToServerEvents>(event: E, payload: Parameters<ClientToServerEvents[E]>[0]): void {
    this.emitted.push({ event, payload });
  }
  reconnect(): void {}
  close(): void {}
  connect(): void {
    this.connected = true;
    for (const l of this.connectListeners) l();
  }
  send<E extends ServerEvent>(event: E, payload: Parameters<ServerToClientEvents[E]>[0]): void {
    for (const h of this.handlers.get(event) ?? []) (h as (p: typeof payload) => void)(payload);
  }
}

const ROOM = 'room1234';
const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
const hand: Card[] = [card(7, 'H'), card(9, 'H'), card(12, 'H'), card(8, 'S'), card(10, 'C'), card(14, 'D')];

function view(step: 1 | 2): PlayerView {
  const table =
    step === 1 ? [{ attack: card(6, 'S'), defense: null }] : [{ attack: card(6, 'S'), defense: null }, { attack: card(6, 'H'), defense: null }];
  return {
    viewerId: 'me',
    hand,
    players: [
      { id: 'me', handCount: 6, finished: false },
      { id: 'bob', handCount: 5, finished: false },
      { id: 'carl', handCount: step === 1 ? 6 : 5, finished: false },
    ],
    deckCount: 12,
    trumpCard: card(6, 'D'),
    trumpSuit: 'D',
    discardCount: 0,
    table,
    attackerId: step === 1 ? 'bob' : 'carl',
    defenderId: step === 1 ? 'carl' : 'me',
    phase: { kind: 'bout', taking: false, passed: [] },
    boutNumber: 2,
    finishOrder: [],
    config: { ...DEFAULT_GAME_CONFIG, mode: 'perevodnoy' },
    lastBout: null,
  };
}

window.history.replaceState(null, '', `/room/${ROOM}`);
const transport = new PageTransport();
const storage = new MemoryStorage();
storage.setItem('durak:sessions', JSON.stringify({ [ROOM]: 'x'.repeat(43) }));
const client = new GameClient({ transport, storage });
const fixture = { ready: false, emitted: transport.emitted };
(window as unknown as { __fixture: typeof fixture }).__fixture = fixture;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClientProvider client={client}>
      <App />
    </ClientProvider>
  </StrictMode>,
);

const members = ['me', 'bob', 'carl'].map((id) => ({
  playerId: id,
  nickname: id.toUpperCase(),
  connected: true,
  isBot: false,
  botDifficulty: null,
  afk: false,
  leftGame: false,
}));
const game = (step: 1 | 2) => ({ roomId: ROOM, gameId: 'g1', version: step, view: view(step), turnDeadline: Date.now() + 60_000, serverTime: Date.now() });

transport.connect();
transport.send('session:issued', { sessionToken: 'x'.repeat(43), playerId: 'me', roomId: ROOM });
transport.send('room:state', { roomId: ROOM, hostId: 'me', maxPlayers: 3, members, spectatorCount: 0, status: 'playing', restartVote: null });
transport.send('game:state', game(1));
setTimeout(() => {
  transport.send('game:state', game(2));
  transport.send('room:reaction', { roomId: ROOM, playerId: 'me', reactionId: 'again' });
  transport.send('room:reaction', { roomId: ROOM, playerId: 'carl', reactionId: 'laugh' });
  fixture.ready = true;
}, 300);

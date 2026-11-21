/**
 * Browser-test fixture (served by the Vite dev server, never built): the real app on a table, fed
 * by an in-page fake server. Two consecutive states — carl transfers bob's attack to me — so the
 * real animation pipeline shows a moment banner and a seat effect, then reactions arrive (bubbles
 * over my seat, right above the hand). I am the defender: hand cards are playable and "Take" is
 * legal. `window.__fixture.ready` turns true once both states and the reactions were delivered.
 *
 * `?scenario=crowded`: the worst case for the layout. Six pairs on the table (three uncovered) and a
 * 15-card hand; the second state still reads as a transfer (the defender changes), so the banner shows.
 * `?scenario=crowded6`: the same with six players (five opponent seats, long nicknames).
 * Crowded scenarios: `window.__fixture.advance()` then sends three more states: I cover 7C, then 6H,
 * then 8D closes the bout (beaten), so the table cards fly to the discard pile (anchors after a resize).
 * `?scenario=lobby`: the host's lobby (two bots, one free seat). `?scenario=gameover`: a finished
 * six-player game (a reload into it: no reveal, the game-over overlay right away), rated: I lost 32.
 * `?scenario=gameover-reload`: the same after a real reload: no game:over (so no stats table), only
 * the finished view and the re-sent game:ratings (my change plus the five others as a list).
 * 2v2 team mode (seats 0+2 vs 1+3: me + carl vs bob + dana): `?scenario=teams` is the crowded table
 * in a team game (carl, my partner, attacks dana; dana transfers to me); `?scenario=teams-lobby` the
 * host's team lobby (three members, one free seat, swap buttons); `?scenario=teams-gameover` a
 * finished, rated team game that my team lost (carl is the durak).
 */
import {
  DEFAULT_GAME_CONFIG,
  cardId,
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
const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'default';
const gameOverScenario = scenario === 'gameover' || scenario === 'gameover-reload';
const teams = scenario === 'teams' || scenario === 'teams-lobby' || scenario === 'teams-gameover';
const crowded = scenario === 'crowded' || scenario === 'crowded6' || gameOverScenario || teams;
const six = scenario === 'crowded6' || gameOverScenario;
const OTHERS = six ? ['bob', 'carl', 'dana', 'eli', 'fay'] : teams ? ['bob', 'carl', 'dana'] : ['bob', 'carl'];
/** Step 1's attacker and defender; the defender transfers to me in step 2. Teams: always opponents. */
const FIRST_ATTACKER = teams ? 'carl' : 'bob';
const TRANSFERRER = teams ? 'dana' : 'carl';
const PLAYERS = ['me', ...OTHERS];
const hand: Card[] = crowded
  ? [
      ...([8, 9, 12, 13, 14] as const).map((r) => card(r, 'S')),
      ...([8, 9, 11, 12] as const).map((r) => card(r, 'C')),
      ...([8, 9, 10, 11] as const).map((r) => card(r, 'H')),
      card(8, 'D'),
      card(9, 'D'),
    ]
  : [card(7, 'H'), card(9, 'H'), card(12, 'H'), card(8, 'S'), card(10, 'C'), card(14, 'D')];

const CROWDED_TABLE = [
  { attack: card(6, 'S'), defense: card(10, 'S') },
  { attack: card(6, 'C'), defense: card(10, 'C') },
  { attack: card(7, 'S'), defense: card(11, 'S') },
  { attack: card(7, 'C'), defense: null },
  { attack: card(6, 'H'), defense: null },
  { attack: card(7, 'D'), defense: null },
];

/** Steps 3-5 (crowded): I cover 7C with 8C, 6H with 8H, then 7D with 8D, which beats the bout. */
type Step = 1 | 2 | 3 | 4 | 5;
const DEFENSES = [card(8, 'C'), card(8, 'H'), card(8, 'D')];
/** The step-2 table with the first `k` uncovered cards covered (in table order). */
const coveredTable = (k: number) =>
  CROWDED_TABLE.map((p, i) => (p.defense || i - 3 >= k ? p : { ...p, defense: DEFENSES[i - 3]! }));
const handWithout = (k: number) => {
  const gone = new Set(DEFENSES.slice(0, k).map(cardId));
  return hand.filter((c) => !gone.has(cardId(c)));
};

function view(step: Step): PlayerView {
  if (step >= 3) {
    const v = view(2);
    const k = step - 2;
    const myHand = handWithout(k);
    const players = v.players.map((p) => (p.id === 'me' ? { ...p, handCount: myHand.length } : p));
    if (step < 5) return { ...v, hand: myHand, players, table: coveredTable(k) };
    const beaten = coveredTable(3);
    return {
      ...v,
      hand: myHand,
      players,
      table: [],
      discardCount: beaten.length * 2,
      attackerId: 'me',
      defenderId: OTHERS[0]!,
      phase: { kind: 'awaitingAttack' },
      boutNumber: 3,
      lastBout: { table: beaten, outcome: 'beaten', defenderId: 'me' },
    };
  }
  const table = crowded
    ? CROWDED_TABLE.slice(0, step === 1 ? 5 : 6)
    : step === 1
      ? [{ attack: card(6, 'S'), defense: null }]
      : [{ attack: card(6, 'S'), defense: null }, { attack: card(6, 'H'), defense: null }];
  return {
    viewerId: 'me',
    hand,
    players: PLAYERS.map((id) => ({
      id,
      handCount: id === 'me' ? hand.length : id === TRANSFERRER && step === 1 ? 6 : 5,
      finished: false,
    })),
    deckCount: crowded ? 0 : 12,
    trumpCard: card(6, 'D'),
    trumpSuit: 'D',
    discardCount: 0,
    table,
    attackerId: step === 1 ? FIRST_ATTACKER : TRANSFERRER,
    defenderId: step === 1 ? TRANSFERRER : 'me',
    phase: { kind: 'bout', taking: false, passed: [] },
    boutNumber: 2,
    finishOrder: [],
    config: teams ? { ...DEFAULT_GAME_CONFIG, mode: 'perevodnoy', teams: true } : { ...DEFAULT_GAME_CONFIG, mode: 'perevodnoy' },
    lastBout: null,
  };
}

window.history.replaceState(null, '', `/room/${ROOM}`);
const transport = new PageTransport();
const storage = new MemoryStorage();
storage.setItem('durak:sessions', JSON.stringify({ [ROOM]: 'x'.repeat(43) }));
const client = new GameClient({ transport, storage });
const fixture = {
  ready: false,
  emitted: transport.emitted,
  /** Steps 3-5, 400 ms apart (each one its own animation step). */
  advance: () => ([3, 4, 5] as const).forEach((step, i) => setTimeout(() => transport.send('game:state', game(step)), i * 400)),
};
(window as unknown as { __fixture: typeof fixture }).__fixture = fixture;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClientProvider client={client}>
      <App />
    </ClientProvider>
  </StrictMode>,
);

const NICKNAMES: Record<string, string> = {
  me: 'ME',
  bob: 'BOB',
  carl: 'CARL',
  dana: 'Dana the Long-Named',
  eli: 'אליעזר בן יהודה',
  fay: 'FAY',
};
const member = (id: string, bot = false) => ({
  playerId: id,
  nickname: bot ? `Bot ${id}` : NICKNAMES[id]!,
  connected: true,
  isBot: bot,
  botDifficulty: bot ? ('medium' as const) : null,
  afk: false,
  leftGame: false,
});
const members = PLAYERS.map((id) => member(id));
const game = (step: Step) => ({ roomId: ROOM, gameId: 'g1', version: step, view: view(step), turnDeadline: Date.now() + 60_000, serverTime: Date.now() });
const room = (status: 'lobby' | 'playing' | 'finished', list = members) => ({
  roomId: ROOM,
  hostId: 'me',
  maxPlayers: teams ? 4 : Math.max(3, list.length + (status === 'lobby' ? 1 : 0)),
  config: { mode: 'perevodnoy' as const, teams },
  members: list,
  spectatorCount: 0,
  status,
  restartVote: null,
  tournamentSetup: null,
  tournament: null,
});

transport.connect();
transport.send('session:issued', { sessionToken: 'x'.repeat(43), playerId: 'me', roomId: ROOM });
if (scenario === 'teams-lobby') {
  // Seats: me (team 0), the bot (team 1), carl (team 0); seat 3 (team 1) is free.
  transport.send('room:state', room('lobby', [member('me'), member('b1', true), member('carl')]));
  fixture.ready = true;
} else if (scenario === 'teams-gameover') {
  // bob and dana went out: my team lost, carl (my partner, more cards) is the durak.
  const over: PlayerView = {
    ...view(2),
    table: [],
    players: PLAYERS.map((id) => ({ id, handCount: id === 'me' ? 2 : id === 'carl' ? 4 : 0, finished: id === 'bob' || id === 'dana' })),
    phase: { kind: 'finished', durak: 'carl' },
    finishOrder: ['bob', 'dana'],
  };
  const stat = (n: number) => ({ boutsAttacked: n, boutsDefended: n, defenses: n - 1, takes: 1, cardsTaken: 3 * n, throwIns: n, transfers: n % 3, cardsPlayed: 10 * n });
  transport.send('room:state', room('finished'));
  transport.send('game:state', { ...game(2), view: over, turnDeadline: null });
  transport.send('game:over', {
    roomId: ROOM,
    durakId: 'carl',
    finishOrder: ['bob', 'dana'],
    endReason: 'normal',
    botAssisted: [],
    forfeits: [],
    stats: Object.fromEntries(PLAYERS.map((id, i) => [id, stat(i + 2)])),
  });
  // Four rated humans, pairwise team ELO: each of us loses 16, each of them gains 16.
  const befores: Record<string, number> = { me: 1012, bob: 1100, carl: 990, dana: 1000 };
  const deltas: Record<string, number> = { me: -16, bob: 16, carl: -16, dana: 16 };
  transport.send('game:ratings', {
    roomId: ROOM,
    gameId: 'g1',
    status: 'rated',
    entries: PLAYERS.map((id) => ({ playerId: id, before: befores[id]!, after: befores[id]! + deltas[id]!, delta: deltas[id]! })),
  });
  fixture.ready = true;
} else if (scenario === 'lobby') {
  transport.send('room:state', room('lobby', [member('me'), member('b1', true), member('b2', true)]));
  fixture.ready = true;
} else if (gameOverScenario) {
  const finishOrder = ['bob', 'carl', 'dana', 'eli', 'fay'];
  const over: PlayerView = {
    ...view(2),
    table: [],
    players: PLAYERS.map((id) => ({ id, handCount: id === 'me' ? 4 : 0, finished: id !== 'me' })),
    phase: { kind: 'finished', durak: 'me' },
    finishOrder,
  };
  const stat = (n: number) => ({ boutsAttacked: n, boutsDefended: n, defenses: n - 1, takes: 1, cardsTaken: 3 * n, throwIns: n, transfers: n % 3, cardsPlayed: 10 * n });
  transport.send('room:state', room('finished'));
  transport.send('game:state', { ...game(2), view: over, turnDeadline: null });
  if (scenario === 'gameover') {
    transport.send('game:over', {
      roomId: ROOM,
      durakId: 'me',
      finishOrder: [...finishOrder, 'me'],
      endReason: 'normal',
      botAssisted: [],
      forfeits: [],
      stats: Object.fromEntries(PLAYERS.map((id, i) => [id, stat(i + 2)])),
    });
  }
  // Six rated humans: the durak loses 32, every other player gains about 32/5.
  const befores: Record<string, number> = { me: 1012, bob: 1100, carl: 990, dana: 1000, eli: 1203, fay: 950 };
  const deltas: Record<string, number> = { me: -32, bob: 6, carl: 7, dana: 6, eli: 5, fay: 8 };
  transport.send('game:ratings', {
    roomId: ROOM,
    gameId: 'g1',
    status: 'rated',
    entries: PLAYERS.map((id) => ({ playerId: id, before: befores[id]!, after: befores[id]! + deltas[id]!, delta: deltas[id]! })),
  });
  fixture.ready = true;
} else {
  transport.send('room:state', room('playing'));
  transport.send('game:state', game(1));
  setTimeout(() => {
    transport.send('game:state', game(2));
    transport.send('room:reaction', { roomId: ROOM, playerId: 'me', reactionId: 'again' });
    transport.send('room:reaction', { roomId: ROOM, playerId: 'carl', reactionId: 'laugh' });
    fixture.ready = true;
  }, 300);
}

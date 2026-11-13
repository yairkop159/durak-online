import type { Room, Session, StoredGame } from '../../src/domain/types.js';
import type { Repositories } from '../../src/repositories/interfaces.js';
import { createInMemoryRepositories } from '../../src/repositories/inMemory/index.js';
import { GameService } from '../../src/services/GameService.js';
import { KeyedMutex } from '../../src/services/KeyedMutex.js';
import type { RoomNotifier } from '../../src/services/ports.js';
import { RoomService } from '../../src/services/RoomService.js';
import { DEFAULT_TIMER_SETTINGS, TurnTimerService, type TimerSettings } from '../../src/services/TurnTimerService.js';
import { FakeTime } from './fakeTime.js';

export interface NotifierEvent {
  readonly kind: 'room' | 'game' | 'over' | 'gameTo';
  readonly version?: number;
  readonly to?: string;
  readonly room: Room;
  readonly game?: StoredGame;
}

export class RecordingNotifier implements RoomNotifier {
  readonly events: NotifierEvent[] = [];
  roomState(room: Room): void {
    this.events.push({ kind: 'room', room });
  }
  gameState(room: Room, game: StoredGame): void {
    this.events.push({ kind: 'game', version: game.version, room, game });
  }
  gameOver(room: Room, game: StoredGame): void {
    this.events.push({ kind: 'over', room, game });
  }
  sendGameStateTo(room: Room, game: StoredGame, viewer: Session): void {
    this.events.push({ kind: 'gameTo', version: game.version, to: viewer.id, room, game });
  }
  of(kind: NotifierEvent['kind']): NotifierEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

/** Services wired exactly like buildServer, on in-memory repos and fake time, without sockets. */
export function setupServices(
  options: { repos?: Repositories; time?: FakeTime; settings?: Partial<TimerSettings>; seed?: number } = {},
) {
  const time = options.time ?? new FakeTime();
  const repos = options.repos ?? createInMemoryRepositories(() => time.now());
  const mutex = new KeyedMutex();
  const notifier = new RecordingNotifier();
  const settings: TimerSettings = { ...DEFAULT_TIMER_SETTINGS, ...options.settings };
  const timers = new TurnTimerService({
    repos,
    mutex,
    notifier,
    clock: time,
    scheduler: time,
    settings,
    log: { error: () => undefined },
  });
  const seed = options.seed ?? 42;
  const rooms = new RoomService({ repos, mutex, notifier, seedSource: () => seed, now: () => time.now(), timers });
  const games = new GameService({ repos, mutex, notifier, timers });
  return { repos, rooms, games, timers, notifier, time, settings };
}

export const noBind = (): void => undefined;

export async function unwrap<T>(
  p: Promise<{ ok: true; value: T } | { ok: false; error: { code: string } }>,
): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

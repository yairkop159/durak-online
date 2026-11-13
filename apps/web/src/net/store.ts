import type {
  ErrorPayload,
  GameOverPayload,
  GameStatePayload,
  PlayerView,
  RoomStatePayload,
  SessionIssuedPayload,
} from '@durak/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface ClientGame {
  readonly roomId: string;
  readonly version: number;
  readonly view: PlayerView;
  readonly turnDeadline: number | null;
  readonly serverTime: number;
  /** Local `Date.now()` when the payload arrived; with `serverTime` it cancels out clock skew. */
  readonly receivedAt: number;
}

export interface ClientError {
  readonly code: ErrorPayload['code'];
  readonly message: string;
  /** Increments on every error so the UI can re-show an identical one. */
  readonly id: number;
}

export interface ClientState {
  readonly connection: ConnectionStatus;
  readonly session: SessionIssuedPayload | null;
  /** `pending` while a `session:resume` is in flight; `failed` when the stored token was rejected. */
  readonly resumeStatus: 'idle' | 'pending' | 'failed';
  readonly roomNotFound: boolean;
  readonly room: RoomStatePayload | null;
  readonly game: ClientGame | null;
  readonly gameOver: GameOverPayload | null;
  readonly lastError: ClientError | null;
}

export type ClientAction =
  | { readonly type: 'connection'; readonly status: ConnectionStatus }
  | { readonly type: 'session:issued'; readonly payload: SessionIssuedPayload }
  | { readonly type: 'room:state'; readonly payload: RoomStatePayload }
  | { readonly type: 'game:state'; readonly payload: GameStatePayload; readonly receivedAt: number }
  | { readonly type: 'game:over'; readonly payload: GameOverPayload }
  | { readonly type: 'error'; readonly payload: ErrorPayload }
  | { readonly type: 'resume:start' }
  /** Left the room (or switched rooms): forget everything about it. */
  | { readonly type: 'left' }
  | { readonly type: 'dismissError' };

export const initialState: ClientState = {
  connection: 'connecting',
  session: null,
  resumeStatus: 'idle',
  roomNotFound: false,
  room: null,
  game: null,
  gameOver: null,
  lastError: null,
};

/** Errors that mean "your stored session is no good": drop it and ask for a nickname. */
const RESUME_FAILURES: ReadonlySet<string> = new Set(['INVALID_SESSION', 'ROOM_NOT_FOUND']);

export function reducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case 'connection':
      return {
        ...state,
        connection: action.status,
        // A resume in flight dies with the connection; the next connect starts a new one.
        resumeStatus: action.status === 'disconnected' && state.resumeStatus === 'pending' ? 'idle' : state.resumeStatus,
      };

    case 'session:issued':
      return { ...state, session: action.payload, resumeStatus: 'idle', roomNotFound: false };

    case 'room:state': {
      const room = action.payload;
      // Back in the lobby (rematch): the old game and its result are gone.
      if (room.status === 'lobby') return { ...state, room, game: null, gameOver: null };
      // A new game started: drop the previous result.
      if (room.status === 'playing' && state.gameOver) return { ...state, room, gameOver: null };
      return { ...state, room };
    }

    case 'game:state': {
      const p = action.payload;
      // Out-of-order delivery guard: never go back to an older version of the same game.
      if (state.game && state.game.roomId === p.roomId && p.version < state.game.version) return state;
      return {
        ...state,
        game: {
          roomId: p.roomId,
          version: p.version,
          view: p.view,
          turnDeadline: p.turnDeadline,
          serverTime: p.serverTime,
          receivedAt: action.receivedAt,
        },
      };
    }

    case 'game:over':
      return { ...state, gameOver: action.payload };

    case 'error': {
      const { code, message } = action.payload;
      // The server re-sends the current game:state right after a STALE_STATE; nothing to show.
      if (code === 'STALE_STATE') return state;
      const resumeFailed = state.resumeStatus === 'pending' && RESUME_FAILURES.has(code);
      return {
        ...state,
        resumeStatus: resumeFailed ? 'failed' : state.resumeStatus,
        roomNotFound: state.roomNotFound || code === 'ROOM_NOT_FOUND',
        lastError: { code, message, id: (state.lastError?.id ?? 0) + 1 },
      };
    }

    case 'resume:start':
      return { ...state, resumeStatus: 'pending', roomNotFound: false };

    case 'left':
      return { ...initialState, connection: state.connection, lastError: state.lastError };

    case 'dismissError':
      return { ...state, lastError: null };
  }
}

type Listener = () => void;

/** Minimal external store for `useSyncExternalStore`. */
export class Store {
  private state: ClientState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: ClientState = initialState) {
    this.state = initial;
  }

  getState = (): ClientState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(action: ClientAction): void {
    const next = reducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface RedisKeys {
  room(roomId: string): string;
  game(roomId: string): string;
  session(token: string): string;
  /** SCAN MATCH pattern for every room key under this prefix. */
  readonly roomPattern: string;
  /** SCAN MATCH pattern for every key under this prefix. */
  readonly allPattern: string;
}

/** Escapes Redis glob metacharacters so a prefix is matched literally. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, (ch) => `\\${ch}`);
}

export function redisKeys(prefix: string): RedisKeys {
  const literal = escapeGlob(prefix);
  return {
    room: (roomId) => `${prefix}room:${roomId}`,
    game: (roomId) => `${prefix}game:${roomId}`,
    session: (token) => `${prefix}session:${token}`,
    roomPattern: `${literal}room:*`,
    allPattern: `${literal}*`,
  };
}

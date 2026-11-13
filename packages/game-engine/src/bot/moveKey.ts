import { cardId, type ClientMove } from '@durak/shared';

/** A compact, unique key for a move (without its player). */
export function moveKey(move: ClientMove): string {
  switch (move.type) {
    case 'attack':
    case 'transfer':
      return `${move.type}:${cardId(move.card)}`;
    case 'defend':
      return `defend:${move.attackIndex}:${cardId(move.card)}`;
    case 'take':
    case 'pass':
      return move.type;
  }
}

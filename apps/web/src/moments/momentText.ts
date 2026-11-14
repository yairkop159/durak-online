import type { Moment } from '../anim/moments';
import type { Strings } from '../i18n/he';

/** The banner text of a moment, from the viewer's point of view (pure). */
export function momentText(moment: Moment, viewerId: string | null, nameOf: (id: string) => string, t: Strings): string {
  const m = t.moments;
  switch (moment.type) {
    case 'wentOut': {
      if (viewerId !== null && moment.players.length === 1 && moment.players[0] === viewerId) return m.youWentOut;
      return m.wentOut(moment.players.map(nameOf).join(', '), moment.players.length);
    }
    case 'deckOut':
      if (moment.trumpTo === null) return m.deckOut;
      return moment.trumpTo === viewerId ? m.deckOutTrumpToYou : m.deckOutTrumpTo(nameOf(moment.trumpTo));
    case 'bigTake':
      return moment.by === viewerId ? m.youTookBig(moment.count) : m.bigTake(nameOf(moment.by), moment.count);
    case 'transfer':
      if (moment.from === viewerId) return m.youTransferred(nameOf(moment.to));
      if (moment.to === viewerId) return m.transferredToYou(nameOf(moment.from));
      return m.transfer(nameOf(moment.from), nameOf(moment.to));
    case 'perfectDefense':
      return moment.by === viewerId ? m.yourPerfectDefense : m.perfectDefense(nameOf(moment.by));
  }
}

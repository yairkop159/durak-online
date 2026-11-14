import { EMPTY_PLAYER_STATS, type GameOverPayload, type PlayerView } from '@durak/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AnimationEvent } from '../src/anim/diffViews';
import {
  BIG_TAKE_MIN_CARDS,
  enqueueMoments,
  MAX_QUEUED_MOMENTS,
  momentsFor,
  PERFECT_DEFENSE_MIN_PAIRS,
  scheduleMoments,
  seatEffects,
  type Moment,
} from '../src/anim/moments';
import { planReveal, revealKind } from '../src/anim/reveal';
import { scheduleEvents } from '../src/anim/timeline';
import { MOMENT_SOUNDS } from '../src/audio/soundPlan';
import { SOUND_NAMES } from '../src/audio/sfx';
import { highlights } from '../src/game/highlights';
import { t } from '../src/i18n';
import { momentText } from '../src/moments/momentText';
import { c, cards, gameState, makeView, renderTable, ROOM_ID } from './helpers';

const v = (spec: Parameters<typeof makeView>[0]) => makeView({ counts: { me: 6, bob: 6, carl: 6 }, ...spec });
const beaten = (n: number): AnimationEvent => ({ type: 'beaten', cards: cards('6S 7S 8S 9S 10S JS QS KS AS 6H 7H 8H').slice(0, 2 * n) });
const taken = (n: number): AnimationEvent => ({ type: 'taken', by: 'bob', to: { kind: 'seat', playerId: 'bob' }, cards: cards('6S 7S 8S 9S 10S JS QS KS').slice(0, n) });

describe('moments from consecutive views', () => {
  it('a player going out', () => {
    const prev = v({ deckCount: 0 });
    const next = v({ deckCount: 0, finished: ['carl'] });
    expect(momentsFor(prev, next, [beaten(1)])).toEqual([{ type: 'wentOut', players: ['carl'] }]);
  });

  it(`a take of ${BIG_TAKE_MIN_CARDS}+ cards; a smaller one is not a moment`, () => {
    expect(momentsFor(v({}), v({}), [taken(BIG_TAKE_MIN_CARDS)])).toEqual([{ type: 'bigTake', by: 'bob', count: BIG_TAKE_MIN_CARDS }]);
    expect(momentsFor(v({}), v({}), [taken(BIG_TAKE_MIN_CARDS - 1)])).toEqual([]);
  });

  it(`a perfect defense needs ${PERFECT_DEFENSE_MIN_PAIRS}+ beaten pairs`, () => {
    const next = { ...v({}), lastBout: { table: [], outcome: 'beaten', defenderId: 'bob' } } as PlayerView;
    expect(momentsFor(v({}), next, [beaten(PERFECT_DEFENSE_MIN_PAIRS)])).toEqual([{ type: 'perfectDefense', by: 'bob', pairs: 3 }]);
    expect(momentsFor(v({}), next, [beaten(PERFECT_DEFENSE_MIN_PAIRS - 1)])).toEqual([]);
  });

  it('a transfer: from the old defender to the new one', () => {
    const played: AnimationEvent = { type: 'played', by: 'bob', from: { kind: 'seat', playerId: 'bob' }, card: c('6H'), kind: 'transfer', slot: { index: 1, role: 'attack' } };
    expect(momentsFor(v({ defender: 'bob' }), v({ defender: 'carl' }), [played])).toEqual([{ type: 'transfer', from: 'bob', to: 'carl' }]);
  });

  it('the deck running out names who got the trump, or nobody when the views cannot tell', () => {
    const drawn = (includesTrump: boolean): AnimationEvent => ({ type: 'drawn', player: 'carl', to: { kind: 'seat', playerId: 'carl' }, count: 1, cards: null, includesTrump });
    expect(momentsFor(v({ deckCount: 2 }), v({ deckCount: 0 }), [beaten(1), drawn(true)])).toEqual([{ type: 'deckOut', trumpTo: 'carl' }]);
    expect(momentsFor(v({ deckCount: 2 }), v({ deckCount: 0 }), [beaten(1)])).toEqual([{ type: 'deckOut', trumpTo: null }]);
  });

  it('nothing on an empty diff or on the last step (the reveal takes over); priority order, at most 3', () => {
    expect(momentsFor(v({}), v({ finished: ['carl'] }), [])).toEqual([]);
    expect(momentsFor(v({}), v({ phase: { kind: 'finished', durak: 'bob' }, finished: ['me', 'carl'] }), [beaten(3)])).toEqual([]);
    const next = { ...v({ deckCount: 0, finished: ['carl'] }), lastBout: { table: [], outcome: 'beaten' as const, defenderId: 'me' } };
    const all = momentsFor(v({ deckCount: 3 }), next, [beaten(4), taken(5)]);
    expect(all.map((m) => m.type)).toEqual(['wentOut', 'deckOut', 'bigTake']);
    expect(all.length).toBe(MAX_QUEUED_MOMENTS);
  });

  it('each banner waits for its animation; the queue keeps the most important', () => {
    const events = [taken(5)];
    const timeline = scheduleEvents(events, { reduced: false });
    const [planned] = scheduleMoments([{ type: 'bigTake', by: 'bob', count: 5 }], timeline);
    expect(planned!.atMs).toBe(timeline.items[0]!.startMs + timeline.items[0]!.durationMs);
    const q = (type: Moment['type'], id: number) => ({ id, moment: { type, by: 'x', count: 4, pairs: 3, players: [], trumpTo: null, from: 'a', to: 'b' } as unknown as Moment });
    const queue = enqueueMoments([q('perfectDefense', 1), q('transfer', 2)], [q('bigTake', 3), q('wentOut', 4)]);
    expect(queue.map((x) => x.id)).toEqual([2, 3, 4]);
  });

  it('banner text from the viewer’s point of view (all in he.ts)', () => {
    const nameOf = (id: string) => id.toUpperCase();
    expect(momentText({ type: 'wentOut', players: ['me'] }, 'me', nameOf, t)).toBe('יצאת מהמשחק! 🎉');
    expect(momentText({ type: 'wentOut', players: ['bob'] }, 'me', nameOf, t)).toBe('BOB יצא/ה! 🎉');
    expect(momentText({ type: 'deckOut', trumpTo: 'me' }, 'me', nameOf, t)).toBe('החפיסה נגמרה! השליט אצלך');
    expect(momentText({ type: 'deckOut', trumpTo: 'bob' }, 'me', nameOf, t)).toBe('החפיסה נגמרה! השליט אצל BOB');
    expect(momentText({ type: 'bigTake', by: 'me', count: 5 }, 'me', nameOf, t)).toBe('לקחת 5 קלפים');
    expect(momentText({ type: 'transfer', from: 'bob', to: 'me' }, 'me', nameOf, t)).toBe('BOB העביר/ה אליך את ההתקפה');
    expect(momentText({ type: 'perfectDefense', by: 'carl', pairs: 3 }, null, nameOf, t)).toBe('הגנה מושלמת של CARL!');
    // Terminology: the existing words only.
    const all = JSON.stringify([t.moments, t.reveal, t.stats].map((x) => Object.values(x).map((f) => (typeof f === 'function' ? f('X', 2, 3) : f))));
    expect(all).not.toMatch(/דורק|קוזר/);
    expect(t.reveal.stamp).toBe('דוראק!');
  });

  it('seat effects and sounds per moment', () => {
    expect([...seatEffects({ type: 'wentOut', players: ['a', 'b'] })]).toEqual([['a', 'celebrate'], ['b', 'celebrate']]);
    expect([...seatEffects({ type: 'bigTake', by: 'a', count: 4 })]).toEqual([['a', 'shake']]);
    expect([...seatEffects({ type: 'transfer', from: 'a', to: 'b' })]).toEqual([['b', 'pulse']]);
    expect(seatEffects({ type: 'deckOut', trumpTo: null }).size).toBe(0);
    for (const sound of Object.values(MOMENT_SOUNDS)) expect(SOUND_NAMES).toContain(sound);
  });
});

const over = (extra: Partial<GameOverPayload> = {}): GameOverPayload => ({
  roomId: ROOM_ID,
  durakId: 'bob',
  finishOrder: ['me'],
  endReason: 'normal',
  botAssisted: [],
  forfeits: [],
  stats: {},
  ...extra,
});

describe('the durak reveal (planning)', () => {
  const view = makeView({ counts: { me: 0, bob: 3, carl: 0 } });
  it('stages scale with the animation speed; reduced motion has no reveal', () => {
    const normal = planReveal(over(), view, { reduced: false, speed: 1 })!;
    expect([normal.dimMs, normal.sweepMs, normal.stampMs, normal.totalMs]).toEqual([400, 1200, 800, 2400]);
    expect(normal.stampAtMs).toBe(1600);
    expect(normal.sweep.at(-1)).toBe('bob');
    const fast = planReveal(over(), view, { reduced: false, speed: 0.6 })!;
    expect(fast.totalMs).toBe(1440);
    expect(planReveal(over(), view, { reduced: true, speed: 1 })).toBeNull();
  });

  it('draw and forfeit variants; none for abandoned or restarted games', () => {
    expect(revealKind(over({ durakId: null }))).toBe('draw');
    expect(planReveal(over({ durakId: null }), view, { reduced: false, speed: 1 })!.sweepMs).toBe(0);
    expect(revealKind(over({ endReason: 'forfeit' }))).toBe('forfeit');
    expect(revealKind(over({ endReason: 'abandoned', durakId: null }))).toBeNull();
    expect(revealKind(over({ endReason: 'restarted', durakId: null }))).toBeNull();
  });
});

describe('game-over highlights', () => {
  const s = (p: Partial<typeof EMPTY_PLAYER_STATS>) => ({ ...EMPTY_PLAYER_STATS, ...p });
  it('most taken, best defense (rate breaks a tie), transfers only in perevodnoy, throw-ins; nothing at 0', () => {
    const stats = {
      me: s({ cardsTaken: 9, defenses: 3, boutsDefended: 3, transfers: 2 }),
      bob: s({ cardsTaken: 9, defenses: 3, boutsDefended: 5, throwIns: 4 }),
      carl: s({}),
    };
    expect(highlights(stats, 'podkidnoy')).toEqual([
      { kind: 'mostTaken', players: ['me', 'bob'], value: 9 },
      { kind: 'bestDefense', players: ['me'], value: 3, of: 3 },
      { kind: 'mostThrowIns', players: ['bob'], value: 4 },
    ]);
    expect(highlights(stats, 'perevodnoy').map((h) => h.kind)).toContain('mostTransfers');
    expect(highlights({ me: s({}), bob: s({}) }, 'perevodnoy')).toEqual([]);
  });
});

/** Two-step table fixture: me attacks bob, carl next. */
const running = () => makeView({ counts: { me: 5, bob: 6, carl: 6 }, hand: '7S 8S 9S 10S JS', table: [['6S', null]], config: { mode: 'perevodnoy' } });

describe('moments and the reveal on the table', () => {
  it('a transfer shows a banner that never takes clicks, and is announced politely', async () => {
    const { transport } = renderTable(running());
    const transferred = makeView({
      counts: { me: 5, bob: 5, carl: 6 },
      hand: '7S 8S 9S 10S JS',
      table: [['6S', null], ['6H', null]],
      attacker: 'bob',
      defender: 'carl',
      config: { mode: 'perevodnoy' },
    });
    act(() => transport.serverSends('game:state', gameState(transferred, 4)));
    const banner = await screen.findByTestId('moment-banner');
    expect(banner.textContent).toBe('BOB העביר/ה את ההתקפה ל־CARL');
    expect(banner.className).toContain('pointer-events-none');
    expect(banner.parentElement!.className).toContain('pointer-events-none');
    expect(screen.getByTestId('moment-announcer').getAttribute('aria-live')).toBe('polite');
    expect(within(screen.getByTestId('seat-carl')).getByTestId('seat-effect').className).toContain('pointer-events-none');
  });

  it('a game we watched end gets the reveal, then the overlay with the stats; tap skips', async () => {
    const { transport } = renderTable(running());
    const finished = makeView({ counts: { me: 0, bob: 4, carl: 0 }, finished: ['me', 'carl'], phase: { kind: 'finished', durak: 'bob' }, deckCount: 0 });
    const stats = {
      me: { ...EMPTY_PLAYER_STATS, cardsTaken: 0, defenses: 2, boutsDefended: 2 },
      bob: { ...EMPTY_PLAYER_STATS, cardsTaken: 7, takes: 2, boutsDefended: 2 },
      carl: { ...EMPTY_PLAYER_STATS, throwIns: 3 },
    };
    act(() => {
      transport.serverSends('game:state', gameState(finished, 4));
      transport.serverSends('game:over', over({ finishOrder: ['me', 'carl'], stats }));
    });
    const reveal = await screen.findByTestId('durak-reveal');
    expect(screen.queryByTestId('game-over-headline')).toBeNull();
    // Only the skip layer takes clicks.
    for (const el of reveal.querySelectorAll('*')) {
      if (el.getAttribute('data-testid') === 'reveal-skip' || el.closest('[data-testid="reveal-skip"]')) continue;
      if (el.parentElement === reveal) expect(el.className).toMatch(/pointer-events-none|sr-only/);
    }
    fireEvent.click(screen.getByTestId('reveal-skip'));
    expect(screen.queryByTestId('durak-reveal')).toBeNull();
    expect(screen.getByTestId('game-over-headline').textContent).toBe(t.gameOver.durak('BOB'));
    expect(screen.getByTestId('highlight-mostTaken').textContent).toContain('BOB');
    expect(screen.getByTestId('highlight-bestDefense').textContent).toContain('ME');
    expect(screen.getByTestId('highlight-mostThrowIns').textContent).toContain('CARL');
    fireEvent.click(screen.getByText(t.stats.showAll));
    expect(screen.getByTestId('stats-table').querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('reloading into a finished game: no reveal, the overlay at once; no stats without game:over', () => {
    renderTable(makeView({ counts: { me: 0, bob: 4 }, finished: ['me'], phase: { kind: 'finished', durak: 'bob' }, deckCount: 0 }));
    expect(screen.queryByTestId('durak-reveal')).toBeNull();
    expect(screen.getByTestId('game-over-headline')).toBeInTheDocument();
    expect(screen.queryByTestId('game-stats')).toBeNull();
  });
});

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { t } from '../src/i18n';
import { GameClient } from '../src/net/client';
import { ClientProvider } from '../src/net/react';
import { MemoryStorage } from '../src/net/sessionStore';
import { LRI, PDI, richToPlain } from '../src/screens/tutorial/TutorialText';
import { BASICS } from '../src/tutorial/lessons';
import { ProgressStore, TUTORIAL_KEY, parseProgress, practiceUnlocked } from '../src/tutorial/progress';
import { card } from '../src/tutorial/setup';
import { FakeTransport, ROOM_ID, renderTable, makeView } from './helpers';

/** Opponent moves wait here until the test runs them (no real timers). */
class ManualSchedule {
  private queue: (() => void)[] = [];
  readonly schedule = (fn: () => void) => {
    this.queue.push(fn);
    return () => {
      this.queue = this.queue.filter((f) => f !== fn);
    };
  };
  get pending(): number {
    return this.queue.length;
  }
  runAll(): void {
    for (let i = 0; i < 200 && this.queue.length > 0; i++) act(() => this.queue.shift()!());
  }
}

function renderAt(path: string, progress = new ProgressStore(new MemoryStorage())) {
  window.history.replaceState(null, '', path);
  const transport = new FakeTransport();
  const client = new GameClient({ transport, storage: new MemoryStorage(), now: () => 1_000 });
  const timers = new ManualSchedule();
  render(
    <ClientProvider client={client}>
      <App tutorial={{ progress, schedule: timers.schedule, practiceSeed: () => 7 }} />
    </ClientProvider>,
  );
  return { transport, client, progress, timers };
}

function handCard(id: string): HTMLElement {
  const el = within(screen.getByTestId('hand'))
    .getAllByRole('button')
    .find((b) => b.dataset.card === id);
  if (!el) throw new Error(`no hand card ${id}`);
  return el;
}
const handStates = () =>
  Object.fromEntries(
    within(screen.getByTestId('hand'))
      .getAllByRole('button')
      .map((b) => [b.dataset.card, b.dataset.state]),
  );
/** An accessible name containing `text` (names may carry an emoji prefix). */
const named = (text: string) => (name: string) => name.includes(text);
const guide = () => screen.getByTestId('guide');
const guideText = () => screen.getByTestId('guide-text');

/** Every card named in the guide sits in its own LTR isolate, and no card glyph appears outside one. */
function expectCardsIsolated(ids: readonly string[]) {
  const labels = [...guideText().querySelectorAll('bdi')];
  expect(labels.map((b) => b.dataset.cardLabel)).toEqual(ids);
  for (const b of labels) {
    expect(b.getAttribute('dir')).toBe('ltr');
    expect(b.querySelector('[data-glyph]')?.textContent).toMatch(/^(6|7|8|9|10|J|Q|K|A)[♠♣♦♥]︎$/);
  }
  const outside = [...guideText().querySelectorAll('span, strong, p')]
    .filter((el) => !el.closest('bdi'))
    .flatMap((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? ''));
  for (const text of outside) expect(text).not.toMatch(/[♠♣♦♥]/);
}

describe('a lesson on the real table, driven locally', () => {
  it('defend-suit: wrong taps are explained (card labels isolated), "try again", then success and next', async () => {
    const user = userEvent.setup();
    const { progress, timers, transport } = renderAt('/tutorial/defend-suit');
    expect(guide()).toHaveAttribute('data-phase', 'playing');
    expect(guideText()).toHaveAttribute('aria-live', 'polite');
    expectCardsIsolated(['8C']);
    // Only the lesson's card is highlighted; the other legal defense (J♥) is unlit but still a card.
    expect(handStates()).toMatchObject({ '10C': 'playable', JH: 'plain', '6C': 'dimmed', '7S': 'dimmed' });

    await user.click(handCard('6C'));
    expect(guide()).toHaveAttribute('data-phase', 'wrong');
    // The explanation (6♣ vs 8♣), then the hint that opens with it (10♣, 8♣).
    expectCardsIsolated(['6C', '8C', '10C', '8C']);
    expect(screen.getByTestId('guide-hint')).toBeInTheDocument();
    await user.click(within(guide()).getByRole('button', { name: t.tutorial.tryAgain }));
    expect(guide()).toHaveAttribute('data-phase', 'playing');

    // Take is legal, but this lesson is about defending: explained, nothing applied.
    await user.click(screen.getByRole('button', { name: t.table.take }));
    expect(guide()).toHaveAttribute('data-phase', 'wrong');
    expect(guideText()).toHaveTextContent('אפשר גם להגן');
    expect(screen.queryByRole('button', { name: t.table.take })).toBeNull(); // blocked while explaining
    await user.click(within(guide()).getByRole('button', { name: t.tutorial.tryAgain }));

    await user.click(handCard('10C'));
    await user.click(within(screen.getByTestId('pair-0')).getAllByRole('button')[0]!);
    timers.runAll();
    expect(guide()).toHaveAttribute('data-phase', 'success');
    expect(progress.get().completed).toEqual(['defend-suit']);
    // No game server: nothing was ever sent.
    expect(transport.emitted).toEqual([]);

    await user.click(within(guide()).getByRole('button', { name: t.tutorial.next }));
    expect(window.location.pathname).toBe('/tutorial/defend-trump');
    expect(guideText()).toHaveTextContent(richToPlain(t.tutorial.lessons['defend-trump'].goal).replace(/[⁦⁩]/g, '').slice(0, 10));
  });

  it('transfer (advanced): hand card, then the transfer slot; the bot answers on its own clock', async () => {
    const user = userEvent.setup();
    const { timers, progress } = renderAt('/tutorial/transfer');
    await user.click(handCard('7D'));
    await user.click(screen.getByRole('button', { name: t.table.transferHere }));
    expect(guide()).toHaveAttribute('data-phase', 'opponent');
    expect(timers.pending).toBe(1);
    timers.runAll();
    expect(guide()).toHaveAttribute('data-phase', 'success');
    expect(progress.get().completed).toEqual(['transfer']);
  });

  it('the trump lesson: the face-up trump is ringed; picking a non-trump is explained', async () => {
    const user = userEvent.setup();
    renderAt('/tutorial/trump');
    expect(screen.getByTestId('deck').querySelector('[data-card="9H"]')?.className).toContain('ring-accent');
    await user.click(handCard('6S'));
    expect(guideText()).toHaveTextContent('לא שליט');
    expectCardsIsolated(['6S']);
    await user.click(within(guide()).getByRole('button', { name: t.tutorial.tryAgain }));
    await user.click(handCard('7H'));
    expect(handCard('7H').dataset.state).toBe('selected');
    expect(guideText()).toHaveTextContent(t.tutorial.picked(1, 2));
    await user.click(handCard('KH'));
    expect(guide()).toHaveAttribute('data-phase', 'success');
  });

  it('the hint opens on request', async () => {
    const user = userEvent.setup();
    renderAt('/tutorial/attack');
    expect(screen.queryByTestId('guide-hint')).toBeNull();
    await user.click(within(guide()).getByRole('button', { name: named(t.tutorial.hint) }));
    expect(screen.getByTestId('guide-hint')).toBeInTheDocument();
  });

  it('skip goes to the next lesson without completing; leave goes back to the menu', async () => {
    const user = userEvent.setup();
    const { progress } = renderAt('/tutorial/take');
    await user.click(within(guide()).getByRole('button', { name: t.tutorial.skip }));
    expect(window.location.pathname).toBe('/tutorial/throw-in');
    expect(progress.get().completed).toEqual([]);
    await user.click(screen.getByRole('button', { name: t.table.leave }));
    expect(window.location.pathname).toBe('/tutorial');
    expect(screen.getByRole('heading', { level: 1, name: t.tutorial.menuTitle })).toBeInTheDocument();
  });

  it('no "connecting to the server" banner on tutorial pages', () => {
    renderAt('/tutorial/attack');
    expect(screen.queryByText(t.connection.connecting)).toBeNull();
    expect(screen.queryByText(t.connection.disconnected)).toBeNull();
  });
});

describe('menu, progress and the practice game', () => {
  it('the practice game is locked until the basics are done, then plays to the game-over overlay', async () => {
    const user = userEvent.setup();
    const progress = new ProgressStore(new MemoryStorage());
    const { timers } = renderAt('/tutorial', progress);
    expect(screen.getByTestId('practice-locked')).toBeInTheDocument();
    for (const id of BASICS) act(() => progress.complete(id));
    await user.click(screen.getByRole('link', { name: named(t.tutorial.lessons.practice.title) }));
    expect(window.location.pathname).toBe('/tutorial/practice');

    // Play: my legal cards are the highlighted ones; when nothing of mine is lit, Take or Pass.
    for (let i = 0; i < 400 && !screen.queryByRole('dialog'); i++) {
      timers.runAll();
      if (screen.queryByRole('dialog')) break;
      const lit = screen.queryAllByRole('button').find((b) => b.dataset.state === 'playable');
      const take = screen.queryByRole('button', { name: t.table.take }) ?? screen.queryByRole('button', { name: t.table.pass });
      const target = screen.queryAllByRole('button').find((b) => b.dataset.state === 'target');
      if (target) await user.click(target);
      else if (lit) await user.click(lit);
      else if (take) await user.click(take);
    }
    expect(await screen.findByText(t.gameOver.title, {}, { timeout: 4000 })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.tutorial.toMenu }));
    expect(window.location.pathname).toBe('/tutorial');
  });

  it('progress is versioned and parsed field by field', () => {
    expect(parseProgress(null)).toEqual({ v: 1, completed: [], offerSeen: false });
    expect(parseProgress('not json')).toEqual({ v: 1, completed: [], offerSeen: false });
    expect(parseProgress('{"v":1,"completed":["take","bogus","trump"],"offerSeen":"yes"}')).toEqual({
      v: 1,
      completed: ['trump', 'take'],
      offerSeen: false,
    });
    const basics = parseProgress(JSON.stringify({ completed: BASICS }));
    expect(practiceUnlocked(basics)).toBe(true);
    expect(practiceUnlocked(parseProgress(JSON.stringify({ completed: BASICS.slice(1) })))).toBe(false);
  });

  it('progress survives in storage, and blocked storage works in memory', () => {
    const storage = new MemoryStorage();
    new ProgressStore(storage).complete('take');
    expect(JSON.parse(storage.getItem(TUTORIAL_KEY)!)).toMatchObject({ v: 1, completed: ['take'] });
    expect(new ProgressStore(storage).get().completed).toEqual(['take']);
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    const store = new ProgressStore(blocked);
    store.complete('trump');
    expect(store.get().completed).toEqual(['trump']);
  });
});

describe('entry points', () => {
  it('Home offers the tutorial once; "not now" hides it for good, the Home link stays', async () => {
    const user = userEvent.setup();
    const progress = new ProgressStore(new MemoryStorage());
    renderAt('/', progress);
    const offer = screen.getByTestId('tutorial-offer');
    await user.click(within(offer).getByRole('button', { name: t.tutorial.offer.later }));
    expect(screen.queryByTestId('tutorial-offer')).toBeNull();
    expect(progress.get().offerSeen).toBe(true);
    await user.click(screen.getByRole('link', { name: named(t.tutorial.homeButton) }));
    expect(window.location.pathname).toBe('/tutorial');
  });

  it('"start" opens the first lesson', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(within(screen.getByTestId('tutorial-offer')).getByRole('button', { name: t.tutorial.offer.start }));
    expect(window.location.pathname).toBe('/tutorial/trump');
  });

  it('never in the invite-link join prompt, nor inside a room', () => {
    renderAt(`/room/${ROOM_ID}`);
    expect(screen.getByRole('heading', { name: t.join.title })).toBeInTheDocument();
    expect(screen.queryByTestId('tutorial-offer')).toBeNull();
    expect(screen.queryByText(t.tutorial.homeButton, { exact: false })).toBeNull();
  });

  it('never at a room table, and the in-game rules dialog has no tutorial link', async () => {
    const user = userEvent.setup();
    renderTable(makeView({ hand: '6S 9C' }));
    expect(screen.queryByTestId('tutorial-offer')).toBeNull();
    await user.click(screen.getByRole('button', { name: t.help.title }));
    expect(screen.queryByText(t.tutorial.rulesLink)).toBeNull();
  });

  it('the rules page links to the tutorial', async () => {
    const user = userEvent.setup();
    renderAt('/rules');
    await user.click(screen.getByRole('link', { name: named(t.tutorial.rulesLink) }));
    expect(window.location.pathname).toBe('/tutorial');
  });
});

describe('card labels in Hebrew text', () => {
  it('plain text isolates every card with LRI…PDI', () => {
    expect(richToPlain(t.tutorial.reason({ kind: 'lowerSameSuit', card: card('8C'), target: card('9C') }, 'H'))).toBe(
      `${LRI}8♣︎${PDI} נמוך מ-${LRI}9♣︎${PDI}. באותה צורה מכסים רק בקלף גבוה יותר.`,
    );
  });
});

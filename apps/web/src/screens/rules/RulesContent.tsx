import type { Card, Rank, Suit } from '@durak/shared';
import { useState, type ReactNode } from 'react';
import { CardBack } from '../../components/cards/CardBack';
import { PlayingCard } from '../../components/cards/PlayingCard';
import { t } from '../../i18n';
import type { GuideSectionId, HelpSection, RulesSectionId } from '../../i18n/he';

const card = (rank: Rank, suit: Suit): Card => ({ rank, suit });

/** A small labelled row of real card components (examples are drawn with the game's own cards). */
function Example({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="mt-2 flex flex-col items-center gap-1.5 rounded-xl bg-bg-0/40 p-3 ring-1 ring-line">
      <div className="flex flex-wrap items-center justify-center gap-1.5" dir="ltr">
        {children}
      </div>
      <figcaption className="text-xs text-muted">{caption}</figcaption>
    </figure>
  );
}

const Arrow = () => (
  <span aria-hidden="true" className="px-1 text-muted">
    →
  </span>
);

/** A defense pair: the attack card with its cover tilted on top, like on the table. */
function Covered({ attack, defense }: { attack: Card; defense: Card }) {
  return (
    <span className="relative inline-block pe-4 pb-3">
      <PlayingCard card={attack} size="sm" decorative />
      <PlayingCard card={defense} size="sm" decorative className="absolute top-3 left-4 rotate-[15deg]" />
    </span>
  );
}

const RULE_EXAMPLES: Partial<Record<RulesSectionId, () => ReactNode>> = {
  deck: () => (
    <Example caption={t.help.examples.ranks}>
      {([6, 7, 8, 9, 10, 11, 12, 13, 14] as const).map((r) => (
        <PlayingCard key={r} card={card(r, 'H')} size="xs" decorative />
      ))}
    </Example>
  ),
  trump: () => (
    <Example caption={t.help.examples.trump}>
      <span className="relative inline-block">
        <PlayingCard card={card(9, 'D')} size="sm" decorative className="rotate-90" />
        <CardBack size="sm" className="absolute top-0 left-4" />
      </span>
    </Example>
  ),
  defense: () => (
    <>
      <Example caption={t.help.examples.sameSuit}>
        <PlayingCard card={card(7, 'H')} size="sm" decorative />
        <Arrow />
        <Covered attack={card(7, 'H')} defense={card(9, 'H')} />
      </Example>
      <Example caption={`${t.help.examples.trumpBeats} (${t.table.trump}: ${t.suits.D})`}>
        <PlayingCard card={card(13, 'S')} size="sm" decorative />
        <Arrow />
        <Covered attack={card(13, 'S')} defense={card(6, 'D')} />
      </Example>
    </>
  ),
  throwIn: () => (
    <Example caption={t.help.examples.throwIn}>
      <Covered attack={card(8, 'S')} defense={card(10, 'S')} />
      <Arrow />
      <PlayingCard card={card(8, 'C')} size="sm" state="playable" decorative />
      <PlayingCard card={card(10, 'H')} size="sm" state="playable" decorative />
      <PlayingCard card={card(12, 'C')} size="sm" state="dimmed" decorative />
    </Example>
  ),
  transfer: () => (
    <Example caption={t.help.examples.transfer}>
      <PlayingCard card={card(9, 'C')} size="sm" decorative />
      <PlayingCard card={card(9, 'H')} size="sm" state="playable" decorative />
      <Arrow />
      <CardBack size="sm" />
    </Example>
  ),
};

const GUIDE_EXAMPLES: Partial<Record<GuideSectionId, () => ReactNode>> = {
  highlight: () => (
    <Example caption={`${t.help.examples.playable} · ${t.help.examples.dimmed}`}>
      <PlayingCard card={card(11, 'S')} size="sm" state="playable" decorative />
      <PlayingCard card={card(6, 'C')} size="sm" state="dimmed" decorative />
    </Example>
  ),
  defendTaps: () => (
    <Example caption={t.help.examples.sameSuit}>
      <PlayingCard card={card(10, 'C')} size="sm" state="selected" decorative />
      <Arrow />
      <PlayingCard card={card(8, 'C')} size="sm" state="target" decorative />
    </Example>
  ),
};

function Sections<Id extends string>({
  sections,
  examples,
}: {
  sections: readonly HelpSection<Id>[];
  examples: Partial<Record<Id, () => ReactNode>>;
}) {
  return (
    <div className="flex flex-col gap-5">
      {sections.map((s) => (
        <section key={s.id} aria-labelledby={`help-${s.id}`}>
          <h3 id={`help-${s.id}`} className="mb-1 font-bold text-accent">
            {s.title}
          </h3>
          {s.body.map((p, i) => (
            <p key={i} className="mb-1 text-sm leading-relaxed text-text/90">
              {p}
            </p>
          ))}
          {examples[s.id]?.()}
        </section>
      ))}
    </div>
  );
}

type Tab = 'rules' | 'guide';

/** The rules and the interface guide, in two tabs (shared by /rules and the in-game "?" dialog). */
export function RulesContent({ initialTab = 'rules' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: readonly Tab[] = ['rules', 'guide'];
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-btn bg-bg-0/60 p-1 ring-1 ring-line">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setTab(id)}
            className={`min-h-9 rounded-[10px] text-sm font-semibold ${tab === id ? 'bg-accent text-accent-ink' : 'text-muted hover:text-text'}`}
          >
            {t.help.tabs[id]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'rules' ? (
          <Sections sections={t.help.rules} examples={RULE_EXAMPLES} />
        ) : (
          <Sections sections={t.help.guide} examples={GUIDE_EXAMPLES} />
        )}
      </div>
    </div>
  );
}

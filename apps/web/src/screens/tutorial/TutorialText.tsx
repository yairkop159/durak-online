import { cardId } from '@durak/shared';
import { cardGlyph, cardLabel, isRed } from '../../components/cards/PlayingCard';
import { isCardPart, type Rich } from '../../tutorial/rich';

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
export const LRI = '⁦';
export const PDI = '⁩';

/**
 * Hebrew text naming cards. Each card is its own bidi isolate (`<bdi dir="ltr">`), so "8♣" never
 * reorders inside the right-to-left sentence; screen readers get the spoken name ("8 תלתן").
 */
export function TutorialText({ text }: { text: Rich }) {
  return (
    <>
      {text.map((part, i) =>
        isCardPart(part) ? (
          <bdi
            key={`${cardId(part)}-${i}`}
            dir="ltr"
            data-card-label={cardId(part)}
            className={`font-bold whitespace-nowrap ${isRed(part.suit) ? 'text-card-red brightness-150' : ''}`}
          >
            <span aria-hidden="true" data-glyph>
              {cardGlyph(part)}
            </span>
            <span className="sr-only">{cardLabel(part)}</span>
          </bdi>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** Plain text (non-DOM use only): every card label isolated with LRI…PDI. */
export function richToPlain(text: Rich): string {
  return text.map((part) => (isCardPart(part) ? `${LRI}${cardGlyph(part)}${PDI}` : part)).join('');
}

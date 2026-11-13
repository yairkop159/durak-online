import type { GameOverPayload, PlayerView } from '@durak/shared';
import { Button, Panel } from '../../components/ui';
import { t } from '../../i18n';
import { useClient } from '../../net/react';
import { navigate } from '../../routing';

/**
 * The result. `game:over` carries the end reason; after a reload only the finished view is
 * re-sent, so without it we fall back to the durak recorded in the view.
 */
export function GameOverOverlay({
  view,
  gameOver,
  nameOf,
  canRematch,
}: {
  view: PlayerView;
  gameOver: GameOverPayload | null;
  nameOf: (id: string) => string;
  canRematch: boolean;
}) {
  const client = useClient();
  const durak = gameOver ? gameOver.durakId : view.phase.kind === 'finished' ? view.phase.durak : null;
  const reason = gameOver?.endReason ?? 'normal';
  const finishOrder = gameOver?.finishOrder ?? view.finishOrder;

  let headline: string;
  if (reason === 'abandoned') headline = t.gameOver.abandoned;
  else if (reason === 'forfeit' && durak !== null) headline = t.gameOver.forfeit(nameOf(durak));
  else if (durak === null) headline = t.gameOver.draw;
  else if (durak === view.viewerId) headline = t.gameOver.youAreDurak;
  else headline = t.gameOver.durak(nameOf(durak));

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
      <Panel className="flex w-full max-w-sm flex-col gap-4 text-center">
        <h2 id="game-over-title" className="text-2xl font-black">
          {t.gameOver.title}
        </h2>
        <p className="text-xl font-bold text-amber-300" data-testid="game-over-headline">
          {headline}
        </p>
        <p className="text-xs text-emerald-100/70">{t.gameOver.reasons[reason]}</p>
        {finishOrder.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">{t.gameOver.finishOrder}</h3>
            <ol className="list-inside list-decimal text-sm">
              {finishOrder.map((id) => (
                <li key={id}>{nameOf(id)}</li>
              ))}
            </ol>
          </div>
        )}
        {canRematch ? (
          <Button onClick={() => client.rematch()}>{t.gameOver.backToLobby}</Button>
        ) : (
          <Button variant="secondary" onClick={() => navigate('/')}>
            {t.common.backHome}
          </Button>
        )}
      </Panel>
    </div>
  );
}

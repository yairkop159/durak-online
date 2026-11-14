import type { LeaderboardEntry } from '@durak/shared';
import { useEffect, useState } from 'react';
import { Panel } from '../../components/ui';
import { t } from '../../i18n';
import type { ProfileApiError } from '../../profile/api';
import { useDeviceProfile, useProfiles } from '../../profile/react';
import { PROFILE_PATH, profilePath } from '../../routing';
import { AppLink, linkButtonClass, PageShell } from './PageShell';

/** /leaderboard: the top 20 by rating; my row is highlighted; each row opens that profile. */
export function LeaderboardScreen() {
  const { api } = useProfiles();
  const device = useDeviceProfile();
  const [entries, setEntries] = useState<readonly LeaderboardEntry[] | null>(null);
  const [error, setError] = useState<ProfileApiError | null>(null);

  useEffect(() => {
    let live = true;
    void api.leaderboard().then((r) => {
      if (!live) return;
      if (r.ok) setEntries(r.value.entries);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <PageShell title={t.leaderboard.title}>
      <p className="text-sm text-muted">{t.leaderboard.subtitle}</p>
      <Panel className="p-3">
        {error ? (
          <p className="p-2 text-sm text-muted" role="status">
            {error === 'RATINGS_UNAVAILABLE' || error === 'NETWORK' || error === 'INTERNAL' ? t.profile.unavailable : t.apiErrors[error]}
          </p>
        ) : entries === null ? (
          <p className="p-2 text-sm text-muted" role="status">
            {t.common.loading}
          </p>
        ) : entries.length === 0 ? (
          <p className="p-2 text-sm text-muted">{t.leaderboard.empty}</p>
        ) : (
          <ol className="flex flex-col gap-1.5" aria-label={t.leaderboard.title}>
            {entries.map((e) => {
              const isMe = e.profileId === device?.profileId;
              return (
                <li key={e.profileId}>
                  <AppLink
                    href={profilePath(e.profileId)}
                    className={`flex min-h-11 items-center gap-3 rounded-btn px-3 py-1.5 ring-1 ${
                      isMe ? 'bg-accent/10 ring-accent' : 'bg-surface-2/50 ring-line hover:bg-surface-2'
                    }`}
                  >
                    <span className="w-7 shrink-0 text-center font-black tabular-nums text-muted">{e.rank}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold" {...(isMe ? { 'aria-current': 'true' as const } : {})}>
                      {e.nickname} {isMe && <span className="text-xs text-accent">{t.leaderboard.mine}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-muted tabular-nums">
                      {e.ratedGames} {t.leaderboard.games}
                    </span>
                    <span className="w-12 shrink-0 text-end text-lg font-black tabular-nums text-accent" aria-label={`${t.leaderboard.rating} ${e.rating}`}>
                      {e.rating}
                    </span>
                  </AppLink>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
      <AppLink href={PROFILE_PATH} className={`${linkButtonClass} self-center`}>
        👤 {t.profile.title}
      </AppLink>
    </PageShell>
  );
}

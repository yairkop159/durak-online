import { formatTransferCode, type PublicProfile, type RecentGame, type TransferCodeResponse } from '@durak/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Panel, Pill, inputClass, type PillTone } from '../../components/ui';
import { t } from '../../i18n';
import type { ProfileApiError } from '../../profile/api';
import { useDeviceProfile, useProfiles } from '../../profile/react';
import { LEADERBOARD_PATH } from '../../routing';
import { AppLink, linkButtonClass, PageShell } from './PageShell';

type Load<T> = { readonly status: 'loading' } | { readonly status: 'ok'; readonly value: T } | { readonly status: 'error'; readonly error: ProfileApiError };

const unavailable = (e: ProfileApiError) => e === 'RATINGS_UNAVAILABLE' || e === 'NETWORK' || e === 'INTERNAL';

/** "Bot 2" → the localized bot name (as on the table). */
export function shownName(nickname: string, isBot: boolean): string {
  const n = isBot ? /^Bot (\d+)$/.exec(nickname)?.[1] : undefined;
  return n ? t.bots.name(n) : nickname;
}

/**
 * /profile (mine) and /profile/:id (anyone's, public): rating, games, wins, durak count, rank and
 * the recent games. Mine also offers the transfer code and claiming a code from another device.
 * Never in a room (navigating away from /room/:id would drop the seat).
 */
export function ProfileScreen({ profileId }: { profileId: string | null }) {
  const profiles = useProfiles();
  const device = useDeviceProfile();
  const mine = profileId === null || profileId === device?.profileId;
  const targetId = profileId ?? device?.profileId ?? null;
  const [load, setLoad] = useState<Load<PublicProfile>>({ status: 'loading' });

  // My page: make sure the key is still valid (moved elsewhere → a fresh profile).
  useEffect(() => {
    if (profileId === null) void profiles.prepare();
  }, [profiles, profileId]);

  useEffect(() => {
    if (!targetId) return;
    let live = true;
    setLoad({ status: 'loading' });
    void profiles.api.publicProfile(targetId).then((r) => {
      if (live) setLoad(r.ok ? { status: 'ok', value: r.value } : { status: 'error', error: r.error });
    });
    return () => {
      live = false;
    };
  }, [profiles, targetId]);

  const title = mine ? t.profile.title : load.status === 'ok' ? load.value.nickname : t.profile.publicTitle;

  return (
    <PageShell title={title}>
      {!targetId ? (
        <Panel>
          <p className="text-sm text-muted">{t.profile.noProfile}</p>
        </Panel>
      ) : load.status === 'loading' ? (
        <Panel>
          <p className="text-sm text-muted" role="status">
            {t.common.loading}
          </p>
        </Panel>
      ) : load.status === 'error' ? (
        <Panel>
          <p className="text-sm text-muted" role="status">
            {unavailable(load.error) ? t.profile.unavailable : load.error === 'NOT_FOUND' ? t.profile.notFound : t.apiErrors[load.error]}
          </p>
        </Panel>
      ) : (
        <ProfileDetails profile={load.value} />
      )}

      <AppLink href={LEADERBOARD_PATH} className={`${linkButtonClass} self-center`}>
        🏆 {t.profile.leaderboardLink}
      </AppLink>

      {mine && device && <TransferPanel deviceKey={device.deviceKey} />}
      {mine && <ClaimPanel replacing={device !== null} />}
      {mine && <p className="text-center text-xs text-muted">{t.profile.privacy}</p>}
    </PageShell>
  );
}

function ProfileDetails({ profile }: { profile: PublicProfile }) {
  return (
    <>
      <Panel className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-lg font-bold">{profile.nickname}</div>
            <div className="text-sm text-muted">{profile.rank !== null ? t.profile.rank(profile.rank) : t.profile.unranked}</div>
          </div>
          <div className="shrink-0 text-center">
            <div className="text-3xl font-black text-accent tabular-nums" data-testid="rating">
              {profile.rating}
            </div>
            <div className="text-xs text-muted">{t.profile.rating}</div>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-2 text-center">
          <Stat label={t.profile.games} value={profile.games} />
          <Stat label={t.profile.wins} value={profile.wins} />
          <Stat label={t.profile.duraks} value={profile.duraks} />
        </dl>
      </Panel>
      <Panel className="flex flex-col gap-3">
        <h2 className="font-bold">{t.profile.recent}</h2>
        {profile.recent.length === 0 ? (
          <p className="text-sm text-muted">{t.profile.noGames}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {profile.recent.map((g) => (
              <RecentGameRow key={g.gameId} game={g} />
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-btn bg-surface-2/60 px-2 py-2 ring-1 ring-line">
      <dd className="text-xl font-black tabular-nums">{value}</dd>
      <dt className="text-xs text-muted">{label}</dt>
    </div>
  );
}

const RESULT_TONE: Record<RecentGame['result'], PillTone> = {
  win: 'accent',
  durak: 'attack',
  forfeit: 'warn',
  draw: 'neutral',
  unfinished: 'muted',
};

/** "+16" / "−16" (a real minus), isolated so RTL text never flips the sign. */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : '0';
}

function RecentGameRow({ game }: { game: RecentGame }) {
  const delta = game.rated && game.ratingBefore !== null && game.ratingAfter !== null ? game.ratingAfter - game.ratingBefore : null;
  const others = game.others.map((o) => shownName(o.nickname, o.isBot)).join(', ');
  return (
    <li className="flex items-center justify-between gap-3 rounded-btn bg-surface-2/50 px-3 py-2 ring-1 ring-line" data-testid="recent-game">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={RESULT_TONE[game.result]}>{t.profile.results[game.result]}</Pill>
          <span className="text-xs text-muted">{t.home.modes[game.mode]}</span>
          <span className="text-xs text-muted">{new Date(game.endedAt).toLocaleDateString('he-IL')}</span>
        </div>
        <span className="truncate text-sm">{t.profile.vs(others)}</span>
        {game.botAssisted && <span className="text-xs text-muted">🤖 {t.profile.botAssisted}</span>}
      </div>
      <span
        dir="ltr"
        className={`shrink-0 text-sm font-bold tabular-nums ${delta === null ? 'text-muted' : delta > 0 ? 'text-accent' : delta < 0 ? 'text-danger' : ''}`}
      >
        {delta === null ? t.profile.unrated : formatDelta(delta)}
      </span>
    </li>
  );
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function TransferPanel({ deviceKey }: { deviceKey: string }) {
  const { api } = useProfiles();
  const [issued, setIssued] = useState<{ code: TransferCodeResponse; receivedAt: number } | null>(null);
  const [error, setError] = useState<ProfileApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!issued) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [issued]);

  // Clock-skew free: the server's remaining time, counted down on our own clock.
  const remaining = issued ? issued.code.expiresAt - issued.code.serverTime - (now - issued.receivedAt) : 0;

  const request = async () => {
    setBusy(true);
    setError(null);
    const r = await api.transferCode(deviceKey);
    setBusy(false);
    if (r.ok) {
      setIssued({ code: r.value, receivedAt: Date.now() });
      setNow(Date.now());
    } else setError(r.error);
  };

  return (
    <Panel className="flex flex-col gap-3">
      <h2 className="font-bold">{t.profile.transfer.title}</h2>
      <p className="text-sm text-muted">{t.profile.transfer.explain}</p>
      {issued && remaining > 0 ? (
        <div className="flex flex-col items-center gap-1" aria-live="polite">
          <span className="text-xs text-muted">{t.profile.transfer.codeLabel}</span>
          <span dir="ltr" data-selectable className="font-mono text-3xl font-black tracking-widest text-accent" data-testid="transfer-code">
            {formatTransferCode(issued.code.code)}
          </span>
          <span className="text-xs text-muted tabular-nums">{t.profile.transfer.expiresIn(mmss(remaining))}</span>
        </div>
      ) : (
        issued && <p className="text-sm text-warn">{t.profile.transfer.expired}</p>
      )}
      {error && (
        <p className="text-sm text-warn" role="alert">
          {t.apiErrors[error]}
        </p>
      )}
      <Button variant="secondary" onClick={() => void request()} disabled={busy}>
        {t.profile.transfer.button}
      </Button>
    </Panel>
  );
}

function ClaimPanel({ replacing }: { replacing: boolean }) {
  const { api, store } = useProfiles();
  const [code, setCode] = useState('');
  const [error, setError] = useState<ProfileApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.claim(code);
    setBusy(false);
    if (r.ok) {
      store.set(r.value);
      setDone(r.value.nickname);
      setCode('');
    } else setError(r.error);
  };

  return (
    <Panel>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <h2 className="font-bold">{t.profile.claim.title}</h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t.profile.claim.label}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={12}
            dir="ltr"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD-1234"
            className={`${inputClass} font-mono tracking-widest`}
          />
        </label>
        {replacing && <p className="text-xs text-muted">{t.profile.claim.replaceWarning}</p>}
        {error && (
          <p className="text-sm text-warn" role="alert">
            {t.apiErrors[error]}
          </p>
        )}
        {done && (
          <p className="text-sm text-accent" role="status">
            {t.profile.claim.done(done)}
          </p>
        )}
        <Button type="submit" aria-disabled={!code.trim() || busy}>
          {t.profile.claim.submit}
        </Button>
      </form>
    </Panel>
  );
}

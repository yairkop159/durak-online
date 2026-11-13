import { GAME_MODES, MAX_PLAYERS, MIN_PLAYERS, type GameMode } from '@durak/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Panel } from '../components/ui';
import { t } from '../i18n';
import { useClient, useClientState } from '../net/react';
import { navigate, roomPath } from '../routing';

const PLAYER_COUNTS = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i);

export function HomeScreen() {
  const client = useClient();
  const { session } = useClientState();
  const [nickname, setNickname] = useState('');
  const [players, setPlayers] = useState(2);
  const [mode, setMode] = useState<GameMode>('podkidnoy');
  const [submitted, setSubmitted] = useState(false);

  // The room we just created: go there once the session arrives.
  useEffect(() => {
    if (submitted && session) navigate(roomPath(session.roomId));
  }, [submitted, session]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = nickname.trim();
    if (!name) return;
    setSubmitted(true);
    client.createRoom({ nickname: name, maxPlayers: players, mode });
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-4">
      <header className="text-center">
        <h1 className="text-4xl font-black tracking-tight">{t.appTitle}</h1>
        <p className="mt-2 text-emerald-100/80">{t.home.subtitle}</p>
      </header>
      <Panel>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t.home.nickname}</span>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={24}
              required
              autoFocus
              placeholder={t.home.nicknamePlaceholder}
              className="rounded-lg bg-white px-3 py-2 text-slate-900 outline-none focus:ring-2 focus:ring-amber-400"
            />
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t.home.players}</legend>
            <div className="grid grid-cols-5 gap-2">
              {PLAYER_COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={players === n}
                  onClick={() => setPlayers(n)}
                  className={`rounded-lg py-2 font-bold ${players === n ? 'bg-amber-400 text-slate-900' : 'bg-white/10 hover:bg-white/20'}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t.home.mode}</legend>
            {GAME_MODES.map((m) => (
              <label
                key={m}
                className={`flex cursor-pointer flex-col rounded-lg px-3 py-2 ring-1 ${mode === m ? 'bg-white/15 ring-amber-400' : 'ring-white/15 hover:bg-white/5'}`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="accent-amber-400" />
                  {t.home.modes[m]}
                </span>
                <span className="ms-6 text-xs text-emerald-100/70">{t.home.modeHints[m]}</span>
              </label>
            ))}
          </fieldset>

          <Button type="submit" disabled={!nickname.trim()}>
            {t.home.create}
          </Button>
        </form>
      </Panel>
    </div>
  );
}

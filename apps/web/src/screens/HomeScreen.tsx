import { GAME_MODES, MAX_PLAYERS, MIN_PLAYERS, type BotDifficulty, type GameMode } from '@durak/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DifficultyPicker } from '../components/DifficultyPicker';
import { SettingsButton } from '../components/SettingsDialog';
import { Button, Panel, inputClass } from '../components/ui';
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
  const [difficulty, setDifficulty] = useState<BotDifficulty>('medium');
  const [submitted, setSubmitted] = useState(false);

  // The room we just created: go there once the session arrives.
  useEffect(() => {
    if (submitted && session) navigate(roomPath(session.roomId));
  }, [submitted, session]);

  const nicknameRef = useRef<HTMLInputElement>(null);
  const missingNickname = !nickname.trim();

  /** Both start buttons stay clickable while "disabled" (aria-disabled): a click points at the field. */
  const needNickname = (): boolean => {
    if (!missingNickname) return false;
    nicknameRef.current?.focus();
    return true;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (needNickname()) return;
    setSubmitted(true);
    client.createRoom({ nickname: nickname.trim(), maxPlayers: players, mode });
  };

  const vsComputer = () => {
    if (needNickname()) return;
    setSubmitted(true);
    client.playVsComputer({ nickname: nickname.trim(), mode, difficulty });
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-4">
      <header className="relative text-center">
        <div className="absolute top-0 left-0 flex gap-1.5">
          <SettingsButton />
        </div>
        <div aria-hidden="true" className="mb-3 text-3xl tracking-[0.3em] text-accent drop-shadow-[0_0_12px_rgb(45_212_191/0.5)]">♠︎♥︎♣︎♦︎</div>
        <h1 className="text-4xl font-black tracking-tight">{t.appTitle}</h1>
        <p className="mt-2 text-muted">{t.home.subtitle}</p>
      </header>
      <Panel>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t.home.nickname}</span>
              <input
                ref={nicknameRef}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={24}
                autoFocus
                placeholder={t.home.nicknamePlaceholder}
                aria-describedby={missingNickname ? 'nickname-hint' : undefined}
                className={inputClass}
              />
            </label>
            {/* Outside the label: it describes the field, it is not part of its name. */}
            {missingNickname && (
              <span id="nickname-hint" className="text-xs text-muted">
                {t.home.nicknameRequired}
              </span>
            )}
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t.home.players}</legend>
            <div className="grid grid-cols-5 gap-2">
              {PLAYER_COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={players === n}
                  onClick={() => setPlayers(n)}
                  className={`rounded-btn py-2 font-bold ring-1 transition-colors ${players === n ? 'bg-accent text-accent-ink ring-accent shadow-[0_0_16px_rgb(45_212_191/0.35)]' : 'bg-surface-2 ring-line hover:bg-surface-3'}`}
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
                className={`flex cursor-pointer flex-col rounded-btn px-3 py-2.5 ring-1 transition-colors ${mode === m ? 'bg-accent/8 ring-accent' : 'bg-surface-2/50 ring-line hover:bg-surface-2'}`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="accent-teal-400" />
                  {t.home.modes[m]}
                </span>
                <span className="ms-6 text-xs text-muted">{t.home.modeHints[m]}</span>
              </label>
            ))}
          </fieldset>

          <Button type="submit" aria-disabled={missingNickname}>
            {t.home.create}
          </Button>

          <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            {t.home.or}
            <span className="h-px flex-1 bg-line" />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t.bots.difficulty}</legend>
            <DifficultyPicker value={difficulty} onChange={setDifficulty} />
            <span className="text-xs text-muted">{t.home.vsComputerHint}</span>
          </fieldset>
          <Button type="button" variant="secondary" aria-disabled={missingNickname} onClick={vsComputer}>
            🤖 {t.home.vsComputer}
          </Button>
        </form>
      </Panel>
    </div>
  );
}

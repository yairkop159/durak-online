import { GAME_MODES, MAX_PLAYERS, MIN_PLAYERS, TEAM_GAME_PLAYERS, type BotDifficulty, type GameMode } from '@durak/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DifficultyPicker } from '../components/DifficultyPicker';
import { SettingsButton } from '../components/SettingsDialog';
import { TeamsSwitch } from '../components/TeamsSwitch';
import { Button, Panel, inputClass } from '../components/ui';
import { t } from '../i18n';
import { useClient, useClientState } from '../net/react';
import { useDeviceProfile, useProfiles } from '../profile/react';
import { LEADERBOARD_PATH, navigate, PROFILE_PATH, roomPath, RULES_PATH, TUTORIAL_PATH, tutorialPath } from '../routing';
import { useTutorialProgress } from '../tutorial/progress';
import { useTutorialEnv } from '../tutorial/react';
import { AppLink } from './profile/PageShell';

const PLAYER_COUNTS = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i);
/** Bot opponents for "play vs computer": 1 .. MAX_PLAYERS - 1. */
const OPPONENT_COUNTS = Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => i + 1);

const countButtonClass = (selected: boolean) =>
  `min-h-11 rounded-btn py-2 font-bold ring-1 transition-colors ${selected ? 'bg-accent text-accent-ink ring-accent shadow-[0_0_16px_rgb(45_212_191/0.35)]' : 'bg-surface-2 ring-line hover:bg-surface-3'}`;

export function HomeScreen() {
  const client = useClient();
  const { session } = useClientState();
  const profiles = useProfiles();
  const device = useDeviceProfile();
  // Pre-filled from this device's profile (not the placeholder it was created with).
  const [nickname, setNickname] = useState(() =>
    device && device.nickname !== t.profile.defaultNickname ? device.nickname : '',
  );

  // In the background: create this device's profile, or check it is still valid (Phase 10).
  useEffect(() => {
    void profiles.prepare();
  }, [profiles]);
  const [players, setPlayers] = useState(2);
  const [mode, setMode] = useState<GameMode>('podkidnoy');
  const [difficulty, setDifficulty] = useState<BotDifficulty>('medium');
  const [bots, setBots] = useState(1);
  // 2v2: offered with 4 players (create) and with 3 opponents (vs computer: me + a bot partner).
  const [teams, setTeams] = useState(false);
  const [vsTeams, setVsTeams] = useState(false);
  const teamsOn = teams && players === TEAM_GAME_PLAYERS;
  const vsTeamsOn = vsTeams && bots === TEAM_GAME_PLAYERS - 1;
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
    const name = nickname.trim();
    client.createRoom({ nickname: name, maxPlayers: players, mode, teams: teamsOn, deviceKey: profiles.seatKey(name) });
  };

  const vsComputer = () => {
    if (needNickname()) return;
    setSubmitted(true);
    const name = nickname.trim();
    client.playVsComputer({ nickname: name, mode, difficulty, bots, teams: vsTeamsOn, deviceKey: profiles.seatKey(name) });
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-4">
      <header className="relative text-center">
        {/* z-10: the suit row below has a CSS filter, so it is its own stacking context, painted
            after this corner (tree order) and spanning the full width: without a z-index it covers the gear. */}
        <div className="absolute top-0 left-0 z-10 flex gap-1.5">
          <SettingsButton />
          <AppLink
            href={PROFILE_PATH}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-surface/70 text-lg ring-1 ring-line hover:bg-surface-2"
          >
            <span aria-hidden="true">👤</span>
            <span className="sr-only">{t.profile.title}</span>
          </AppLink>
        </div>
        <div aria-hidden="true" className="pointer-events-none mb-3 text-3xl tracking-[0.3em] text-accent drop-shadow-[0_0_12px_rgb(45_212_191/0.5)]">♠︎♥︎♣︎♦︎</div>
        <h1 className="text-4xl font-black tracking-tight">{t.appTitle}</h1>
        <p className="mt-2 text-muted">{t.home.subtitle}</p>
      </header>
      <TutorialOffer />
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
                  className={countButtonClass(players === n)}
                >
                  {n}
                </button>
              ))}
            </div>
            {players === TEAM_GAME_PLAYERS && <TeamsSwitch checked={teams} onChange={setTeams} />}
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
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t.home.opponents}</legend>
            <div className="grid grid-cols-5 gap-2">
              {OPPONENT_COUNTS.map((n) => (
                <button key={n} type="button" aria-pressed={bots === n} onClick={() => setBots(n)} className={countButtonClass(bots === n)}>
                  {n}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted">{t.home.vsComputerHint}</span>
            {bots === TEAM_GAME_PLAYERS - 1 && (
              <TeamsSwitch checked={vsTeams} onChange={setVsTeams} label={t.teams.vsComputerToggle} hint={t.teams.vsComputerHint} testId="vs-teams-switch" />
            )}
          </fieldset>
          <Button type="button" variant="secondary" aria-disabled={missingNickname} onClick={vsComputer}>
            🤖 {t.home.vsComputer}
          </Button>
        </form>
      </Panel>
      <nav className="flex flex-wrap items-center justify-center gap-x-2">
        <AppLink
          href={TUTORIAL_PATH}
          className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          🎓 {t.tutorial.homeButton}
        </AppLink>
        <AppLink
          href={RULES_PATH}
          className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          {t.help.title}
        </AppLink>
        <AppLink
          href={LEADERBOARD_PATH}
          className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          🏆 {t.profile.leaderboardLink}
        </AppLink>
      </nav>
    </div>
  );
}

/**
 * The one-time "new to Durak?" card: Home only (never the join prompt or a room), until it is
 * answered. The tutorial stays one tap away from Home's links and from the rules page.
 */
function TutorialOffer() {
  const { progress } = useTutorialEnv();
  const { offerSeen } = useTutorialProgress(progress);
  if (offerSeen) return null;
  return (
    <section className="flex flex-col gap-2 rounded-[22px] bg-accent/10 p-4 ring-1 ring-accent/45" aria-labelledby="tutorial-offer-title" data-testid="tutorial-offer">
      <h2 id="tutorial-offer-title" className="text-lg font-bold">
        🎓 {t.tutorial.offer.title}
      </h2>
      <p className="text-sm text-muted">{t.tutorial.offer.body}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            progress.markOfferSeen();
            navigate(tutorialPath('trump'));
          }}
        >
          {t.tutorial.offer.start}
        </Button>
        <Button variant="secondary" onClick={() => progress.markOfferSeen()}>
          {t.tutorial.offer.later}
        </Button>
      </div>
    </section>
  );
}

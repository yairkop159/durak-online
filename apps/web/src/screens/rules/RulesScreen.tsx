import { Panel } from '../../components/ui';
import { t } from '../../i18n';
import { navigate, TUTORIAL_PATH } from '../../routing';
import { AppLink } from '../profile/PageShell';
import { RulesContent } from './RulesContent';

/** /rules: the rules and the interface guide as a page (linked from Home). */
export function RulesScreen() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-black">{t.help.title}</h1>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="min-h-11 rounded-pill bg-surface/70 px-3 text-sm font-semibold ring-1 ring-line hover:bg-surface-2"
        >
          {t.common.backHome}
        </button>
      </header>
      {/* Only on this page: inside a room the rules are a dialog, and leaving the room would drop the seat. */}
      <AppLink
        href={TUTORIAL_PATH}
        className="inline-flex min-h-11 items-center self-start rounded-pill bg-accent/12 px-4 text-sm font-semibold text-accent ring-1 ring-accent/40 hover:bg-accent/20"
      >
        🎓 {t.tutorial.rulesLink}
      </AppLink>
      <Panel>
        <RulesContent />
      </Panel>
    </div>
  );
}

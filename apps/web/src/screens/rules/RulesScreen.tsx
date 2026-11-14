import { Panel } from '../../components/ui';
import { t } from '../../i18n';
import { navigate } from '../../routing';
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
      <Panel>
        <RulesContent />
      </Panel>
    </div>
  );
}

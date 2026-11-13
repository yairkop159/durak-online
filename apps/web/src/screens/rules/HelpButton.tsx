import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { t } from '../../i18n';
import { RulesContent } from './RulesContent';

/**
 * "?" that opens the rules and the interface guide in a dialog. In a room this must stay a dialog:
 * navigating to /rules would leave the room (the router drops the room binding).
 */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={t.help.title}
        onClick={() => setOpen(true)}
        className="grid size-9 place-items-center rounded-full bg-surface/70 text-base font-black ring-1 ring-line hover:bg-surface-2"
      >
        ?
      </button>
      {open && (
        <Modal title={t.help.title} onClose={() => setOpen(false)} wide>
          <RulesContent />
        </Modal>
      )}
    </>
  );
}

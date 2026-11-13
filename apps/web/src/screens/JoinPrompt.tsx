import { useState, type FormEvent } from 'react';
import { Button, Panel, inputClass } from '../components/ui';
import { t } from '../i18n';
import { useClient } from '../net/react';

/** Opening an invite link without a session: ask for a nickname, then join (as a spectator if the game started). */
export function JoinPrompt({ roomId }: { roomId: string }) {
  const client = useClient();
  const [nickname, setNickname] = useState('');
  const [sent, setSent] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = nickname.trim();
    if (!name) return;
    setSent(true);
    client.joinRoom(roomId, name);
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center p-4">
      <Panel>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold">{t.join.title}</h1>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t.home.nickname}</span>
            <input
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value);
                setSent(false);
              }}
              maxLength={24}
              required
              autoFocus
              placeholder={t.home.nicknamePlaceholder}
              className={inputClass}
            />
          </label>
          <Button type="submit" disabled={!nickname.trim() || sent}>
            {t.join.submit}
          </Button>
        </form>
      </Panel>
    </div>
  );
}

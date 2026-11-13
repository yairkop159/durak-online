import type { RoomMember } from '@durak/shared';
import { t } from '../i18n';
import { Pill } from './ui';

/** "🤖 Bot · medium" on a bot seat (lobby and table). */
export function BotPill({ member }: { member: RoomMember }) {
  return (
    <Pill tone="neutral">
      <span data-testid="bot-badge">
        🤖 {t.bots.badge}
        {member.botDifficulty && ` · ${t.bots.difficulties[member.botDifficulty]}`}
      </span>
    </Pill>
  );
}

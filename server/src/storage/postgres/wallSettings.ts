// The wall's settings on PostgreSQL (#822): the SQLite store's logic over `PgDb`. A setter reads the old value and writes the new
// one in one transaction and resolves with whether the value changed, so two setters at once cannot both claim the change.
import { isNewer } from '../../fleet/updateCheck.js';
import type { WallSettingsView } from '../../fleet/protocol.js';
import { NOTICES, isNoticeId } from '../features.js';
import type { WallSettingsApi } from '../types.js';
import type { PgDb } from './conn.js';

const NOTICE_PREFIX = 'wall_notice.';
const SHOW_BACKGROUND = 'wall_show_background_sessions';
const CARD_TITLE_MACHINE = 'wall_card_title_machine';
const UPDATE_DISMISSED = 'wall_update_dismissed';

export const pgWallSettings = (db: PgDb): WallSettingsApi => {
  const get = async (key: string): Promise<string | undefined> => (await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value;
  /** Writes the value and says whether it differs from what was there. */
  const set = (key: string, value: string): Promise<boolean> =>
    db.tx(async () => {
      const was = await get(key);
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
      return was !== value;
    });
  const noticeOn = async (id: string): Promise<boolean> => (await get(NOTICE_PREFIX + id)) !== '0';
  const showBackgroundSessions = async (): Promise<boolean> => (await get(SHOW_BACKGROUND)) === '1';
  const cardTitleMachine = async (): Promise<boolean> => (await get(CARD_TITLE_MACHINE)) === '1';
  /** A stored value that is not MAJOR.MINOR.PATCH counts as none. */
  const updateDismissed = async (): Promise<string | null> => {
    const v = await get(UPDATE_DISMISSED);
    return v !== undefined && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  };
  return {
    async view(): Promise<WallSettingsView> {
      const notices: Record<string, boolean> = {};
      for (const n of NOTICES) notices[n.id] = await noticeOn(n.id);
      return { notices, showBackgroundSessions: await showBackgroundSessions(), cardTitleMachine: await cardTitleMachine() };
    },
    updateDismissed,
    async setNotice(id, on) {
      if (!isNoticeId(id)) return { known: false, changed: false };
      return { known: true, changed: await set(NOTICE_PREFIX + id, on ? '1' : '0') };
    },
    setShowBackgroundSessions: (on) => set(SHOW_BACKGROUND, on ? '1' : '0'),
    setCardTitleMachine: (on) => set(CARD_TITLE_MACHINE, on ? '1' : '0'),
    // Only ever moves forward: a stale tab closing an older release must not bring back a newer one already closed.
    dismissUpdate: (version) =>
      db.tx(async () => {
        const had = await updateDismissed();
        if (had !== null && !isNewer(version, had)) return false;
        return set(UPDATE_DISMISSED, version);
      }),
  };
};

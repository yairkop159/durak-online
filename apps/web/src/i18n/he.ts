import type { BotDifficulty, GameEndReason, GameErrorCode, GameMode, ServerErrorCode, Suit } from '@durak/shared';

export type ErrorCode = ServerErrorCode | GameErrorCode;

/**
 * Every user-visible string. Another locale = another object of type `Strings`.
 * Functions are used where a string needs values interpolated.
 */
export interface Strings {
  readonly appTitle: string;
  readonly common: {
    readonly loading: string;
    readonly you: string;
    readonly backHome: string;
    readonly close: string;
    readonly cancel: string;
  };
  readonly connection: { readonly connecting: string; readonly disconnected: string; readonly reconnecting: string };
  readonly home: {
    readonly subtitle: string;
    readonly nickname: string;
    readonly nicknamePlaceholder: string;
    readonly nicknameRequired: string;
    readonly players: string;
    readonly mode: string;
    readonly modes: Record<GameMode, string>;
    readonly modeHints: Record<GameMode, string>;
    readonly create: string;
    readonly or: string;
    readonly vsComputer: string;
    readonly vsComputerHint: string;
  };
  readonly bots: {
    readonly badge: string;
    /** Display name of a bot seat ("Bot N" on the server). */
    readonly name: (n: string) => string;
    readonly difficulty: string;
    readonly difficulties: Record<BotDifficulty, string>;
    readonly add: string;
    readonly remove: (name: string) => string;
    /** On an AFK human's seat while the bot plays for them. */
    readonly playingForYou: string;
    readonly playingForThem: string;
  };
  readonly join: { readonly title: string; readonly submit: string };
  readonly notFound: { readonly title: string; readonly body: string };
  readonly lobby: {
    readonly title: string;
    readonly invite: string;
    readonly copy: string;
    readonly copied: string;
    readonly players: (count: number, max: number) => string;
    readonly spectators: (count: number) => string;
    readonly host: string;
    readonly offline: string;
    readonly afk: string;
    readonly start: string;
    readonly waitingForHost: string;
    readonly needMorePlayers: string;
    readonly leave: string;
  };
  readonly table: {
    readonly deck: (count: number) => string;
    readonly discard: (count: number) => string;
    readonly trump: string;
    readonly cards: (count: number) => string;
    readonly attacker: string;
    readonly defender: string;
    readonly afk: string;
    readonly offline: string;
    readonly out: string;
    readonly passed: string;
    readonly take: string;
    readonly pass: string;
    readonly transferHere: string;
    readonly spectating: string;
    readonly emptyTable: string;
    readonly discardPile: string;
    readonly lastBout: string;
    readonly deckEmpty: string;
    readonly yourTurn: string;
    readonly actions: string;
    readonly secondsLeft: (seconds: number) => string;
    /** Top bar: leave the room (mid-game: forfeit, after a confirm). */
    readonly leave: string;
    readonly leaveConfirm: {
      readonly title: string;
      /** The game ends now (2 players, or no other human still in). */
      readonly resign: string;
      /** A bot takes over the seat and the game goes on. */
      readonly takeover: string;
      readonly confirm: string;
    };
    /** On a seat whose human left the game. */
    readonly left: string;
    readonly status: {
      readonly youAttack: string;
      readonly waitAttack: (name: string) => string;
      readonly youDefend: string;
      readonly youTake: string;
      readonly youThrowIn: string;
      readonly othersDefend: (name: string) => string;
      readonly othersTake: (name: string) => string;
      readonly youAreOut: string;
    };
  };
  readonly gameOver: {
    readonly title: string;
    readonly durak: (name: string) => string;
    readonly youAreDurak: string;
    readonly draw: string;
    readonly forfeit: (name: string) => string;
    readonly abandoned: string;
    readonly finishOrder: string;
    /** Players who left (or timed out) and lost. */
    readonly forfeits: string;
    readonly backToLobby: string;
    readonly reasons: Record<GameEndReason, string>;
  };
  readonly restart: {
    readonly button: string;
    readonly title: string;
    readonly confirmTitle: string;
    readonly confirmBody: string;
    readonly propose: string;
    readonly proposed: (name: string) => string;
    readonly youProposed: string;
    readonly accept: string;
    readonly decline: string;
    readonly waiting: (accepted: number, total: number) => string;
    /** Toasts when a vote ends. */
    readonly passed: string;
    readonly declined: (name: string) => string;
    readonly expired: string;
    readonly cancelled: string;
  };
  readonly suits: Record<Suit, string>;
  readonly errors: Record<ErrorCode, string>;
}

export const he: Strings = {
  appTitle: 'דוראק אונליין',
  common: {
    loading: 'טוען…',
    you: 'אני',
    backHome: 'למסך הראשי',
    close: 'סגירה',
    cancel: 'ביטול',
  },
  connection: {
    connecting: 'מתחבר לשרת…',
    disconnected: 'החיבור לשרת נותק. מנסה להתחבר מחדש…',
    /** In a room while disconnected or re-binding the seat; input is blocked meanwhile. */
    reconnecting: 'מתחבר מחדש...',
  },
  home: {
    subtitle: 'משחק הקלפים הרוסי, עם חברים, בזמן אמת',
    nickname: 'הכינוי שלך',
    nicknamePlaceholder: 'למשל: סשה',
    nicknameRequired: 'נא להזין כינוי כדי להתחיל',
    players: 'מספר שחקנים',
    mode: 'סוג משחק',
    modes: { podkidnoy: 'פודקידנוי', perevodnoy: 'פרבודנוי' },
    modeHints: {
      podkidnoy: 'קלסי: מוסיפים קלפים באותו ערך',
      perevodnoy: 'אפשר גם להעביר את ההתקפה לשחקן הבא',
    },
    create: 'יצירת חדר',
    or: 'או',
    vsComputer: 'משחק נגד המחשב',
    vsComputerHint: 'משחק מיידי אחד על אחד מול בוט',
  },
  bots: {
    badge: 'בוט',
    name: (n) => `מחשב ${n}`,
    difficulty: 'רמת קושי',
    difficulties: { easy: 'קל', medium: 'בינוני', hard: 'קשה' },
    add: 'הוספת בוט',
    remove: (name) => `הסרת ${name}`,
    playingForYou: 'הבוט משחק במקומך',
    playingForThem: 'בוט משחק',
  },
  join: { title: 'הצטרפות לחדר', submit: 'הצטרפות' },
  notFound: { title: 'החדר לא נמצא', body: 'ייתכן שהקישור שגוי או שהחדר כבר נסגר.' },
  lobby: {
    title: 'חדר המתנה',
    invite: 'קישור הזמנה',
    copy: 'העתקה',
    copied: 'הועתק!',
    players: (count, max) => `שחקנים (${count}/${max})`,
    spectators: (count) => (count === 1 ? 'צופה אחד' : `${count} צופים`),
    host: 'מארח',
    offline: 'מנותק',
    afk: 'לא פעיל',
    start: 'התחלת משחק',
    waitingForHost: 'ממתינים שהמארח יתחיל את המשחק',
    needMorePlayers: 'צריך לפחות שני שחקנים',
    leave: 'יציאה מהחדר',
  },
  table: {
    deck: (count) => `בחפיסה: ${count}`,
    discard: (count) => `הושלכו: ${count}`,
    trump: 'שליט',
    cards: (count) => `${count} קלפים`,
    attacker: 'תוקף',
    defender: 'מגן',
    afk: 'לא פעיל',
    offline: 'מנותק',
    out: 'יצא',
    passed: 'סיים',
    take: 'לקחת',
    pass: 'סיימתי',
    transferHere: 'העברה',
    spectating: 'מצב צפייה',
    emptyTable: 'השולחן ריק',
    discardPile: 'ערימת ההשלכה',
    lastBout: 'הסיבוב הקודם',
    deckEmpty: 'החפיסה נגמרה',
    yourTurn: 'התור שלך',
    actions: 'פעולות',
    secondsLeft: (seconds) => `${seconds} שנ׳`,
    leave: 'יציאה',
    leaveConfirm: {
      title: 'לפרוש מהמשחק?',
      resign: 'המשחק יסתיים ותיחשב/י כמפסיד/ה.',
      takeover: 'בוט ימשיך לשחק במקומך, ותיחשב/י כמפסיד/ה.',
      confirm: 'פרישה',
    },
    left: 'פרש/ה',
    status: {
      youAttack: 'תורך לתקוף: בחר קלף',
      waitAttack: (name) => `${name} תוקף`,
      youDefend: 'תורך להגן: בחר קלף ואז את הקלף שהוא מכסה, או קח',
      youTake: 'אתה לוקח את הקלפים',
      youThrowIn: 'אפשר להוסיף קלפים באותו ערך',
      othersDefend: (name) => `${name} מגן`,
      othersTake: (name) => `${name} לוקח`,
      youAreOut: 'יצאת מהמשחק — כל הכבוד!',
    },
  },
  gameOver: {
    title: 'המשחק נגמר',
    durak: (name) => `${name} הוא הדוראק`,
    youAreDurak: 'אתה הדוראק!',
    draw: 'תיקו — אין דוראק',
    forfeit: (name) => `${name} פרש/ה והפסיד/ה`,
    abandoned: 'המשחק הופסק: אף אחד לא שיחק',
    finishOrder: 'סדר היציאה',
    forfeits: 'פרשו מהמשחק',
    backToLobby: 'חזרה לחדר ההמתנה',
    reasons: { normal: 'סיום רגיל', forfeit: 'הפסד טכני', abandoned: 'משחק נטוש', restarted: 'הוחלף במשחק חדש' },
  },
  restart: {
    button: 'משחק חדש',
    title: 'הצבעה על משחק חדש',
    confirmTitle: 'להציע משחק חדש?',
    confirmBody: 'כל השחקנים צריכים להסכים. המשחק הנוכחי יבוטל בלי מפסיד, ויחולקו קלפים מחדש.',
    propose: 'הצעה',
    proposed: (name) => `${name} מציע/ה משחק חדש`,
    youProposed: 'הצעת משחק חדש',
    accept: 'מסכים/ה',
    decline: 'לא',
    waiting: (accepted, total) => `ממתין לתשובות (${accepted}/${total})`,
    passed: 'המשחק התחיל מחדש',
    declined: (name) => `${name} סירב/ה למשחק חדש`,
    expired: 'פג הזמן להצבעה',
    cancelled: 'ההצבעה בוטלה',
  },
  suits: { S: 'עלה', C: 'תלתן', D: 'יהלום', H: 'לב' },
  errors: {
    INVALID_PAYLOAD: 'בקשה לא תקינה',
    NOT_IN_ROOM: 'אינך בחדר הזה',
    ROOM_NOT_FOUND: 'החדר לא נמצא',
    NOT_HOST: 'רק המארח יכול לעשות את זה',
    NOT_ENOUGH_PLAYERS: 'צריך לפחות שני שחקנים',
    GAME_NOT_STARTED: 'המשחק עוד לא התחיל',
    GAME_IN_PROGRESS: 'המשחק כבר רץ',
    STALE_STATE: 'המצב התעדכן, נסה שוב',
    INVALID_SESSION: 'החיבור לחדר פג. הצטרף מחדש',
    ROOM_FULL: 'החדר מלא',
    NOT_A_BOT: 'אפשר להסיר רק בוטים',
    NO_HUMANS: 'צריך לפחות שחקן אנושי אחד',
    INTERNAL: 'שגיאת שרת. נסה שוב',
    RATE_LIMITED: 'יותר מדי פעולות. האט רגע ונסה שוב',
    TOO_MANY_ROOMS: 'יצרת יותר מדי חדרים בשעה האחרונה. נסה שוב מאוחר יותר',
    SERVER_FULL: 'השרת מלא כרגע. נסה שוב בעוד כמה דקות',
    TOO_MANY_CONNECTIONS: 'יותר מדי חיבורים פתוחים מהרשת שלך. סגור לשוניות אחרות ונסה שוב',
    VOTE_IN_PROGRESS: 'כבר יש הצבעה פתוחה',
    VOTE_COOLDOWN: 'הצעת משחק חדש לפני רגע. אפשר להציע שוב בעוד דקה',
    NO_ACTIVE_VOTE: 'ההצבעה כבר הסתיימה',
    INVALID_PLAYER_COUNT: 'מספר שחקנים לא תקין',
    DUPLICATE_PLAYER: 'שחקן כפול',
    INVALID_CONFIG: 'הגדרות משחק לא תקינות',
    GAME_FINISHED: 'המשחק נגמר',
    UNKNOWN_PLAYER: 'שחקן לא מוכר',
    PLAYER_FINISHED: 'כבר יצאת מהמשחק',
    NOT_YOUR_TURN: 'זה לא תורך',
    CARD_NOT_IN_HAND: 'הקלף לא ביד שלך',
    INVALID_MOVE: 'מהלך לא חוקי',
    RANK_NOT_ON_TABLE: 'אפשר להוסיף רק קלף בערך שכבר על השולחן',
    TABLE_LIMIT_REACHED: 'אי אפשר להוסיף עוד קלפים בסיבוב הזה',
    INVALID_ATTACK_INDEX: 'אין קלף התקפה במקום הזה',
    ALREADY_COVERED: 'הקלף הזה כבר מכוסה',
    CARD_DOES_NOT_BEAT: 'הקלף הזה לא מכסה את קלף ההתקפה',
    TRANSFER_NOT_ALLOWED: 'אי אפשר להעביר עכשיו',
    ALREADY_PASSED: 'כבר סיימת בסיבוב הזה',
  },
};

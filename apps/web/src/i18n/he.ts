import type { AnimationSpeed, TipId } from '../settings/settings';
import type { BotDifficulty, GameEndReason, GameErrorCode, GameMode, PlayerResult, ReactionId, ServerErrorCode, Suit } from '@durak/shared';
import type { ProfileApiError } from '../profile/api';

export type ErrorCode = ServerErrorCode | GameErrorCode;

export type RulesSectionId =
  | 'goal'
  | 'deck'
  | 'trump'
  | 'attack'
  | 'defense'
  | 'throwIn'
  | 'take'
  | 'pass'
  | 'transfer'
  | 'draw'
  | 'out'
  | 'durak';
export type GuideSectionId = 'highlight' | 'defendTaps' | 'buttons' | 'countdown' | 'afk' | 'reconnect' | 'leave' | 'restart';

export interface HelpSection<Id extends string> {
  readonly id: Id;
  readonly title: string;
  readonly body: readonly string[];
}

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
    /** Legend of the "number of bot opponents" picker (1-5). */
    readonly opponents: string;
  };
  readonly bots: {
    readonly badge: string;
    /** Display name of a bot seat ("Bot N" on the server). */
    readonly name: (n: string) => string;
    readonly difficulty: string;
    readonly difficulties: Record<BotDifficulty, string>;
    readonly add: string;
    /** Lobby: the heading and hint over the add-bot controls. */
    readonly addTitle: string;
    readonly addHint: string;
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
  /** Game moments (banners). `you*` variants when the viewer is the one it happened to. */
  readonly moments: {
    readonly wentOut: (names: string, count: number) => string;
    readonly youWentOut: string;
    readonly bigTake: (name: string, count: number) => string;
    readonly youTookBig: (count: number) => string;
    readonly perfectDefense: (name: string) => string;
    readonly yourPerfectDefense: string;
    readonly transfer: (from: string, to: string) => string;
    readonly youTransferred: (to: string) => string;
    readonly transferredToYou: (from: string) => string;
    readonly deckOut: string;
    readonly deckOutTrumpTo: (name: string) => string;
    readonly deckOutTrumpToYou: string;
  };
  /** The durak reveal at the end of a game. */
  readonly reveal: {
    readonly stamp: string;
    readonly draw: string;
    readonly skip: string;
  };
  /** End-of-game statistics on the game-over screen. */
  readonly stats: {
    readonly highlights: string;
    readonly mostTaken: string;
    readonly mostTakenValue: (count: number) => string;
    readonly bestDefense: string;
    readonly bestDefenseValue: (defenses: number, of: number) => string;
    readonly mostTransfers: string;
    readonly mostTransfersValue: (count: number) => string;
    readonly mostThrowIns: string;
    readonly mostThrowInsValue: (count: number) => string;
    readonly showAll: string;
    readonly hideAll: string;
    readonly columns: {
      readonly player: string;
      readonly boutsAttacked: string;
      readonly defenses: string;
      readonly cardsTaken: string;
      readonly throwIns: string;
      readonly transfers: string;
      readonly cardsPlayed: string;
    };
  };
  readonly reactions: {
    /** The button that opens the picker. */
    readonly button: string;
    readonly pickerTitle: string;
    /** What each reaction shows (an emoji or a short phrase) and how a screen reader says it. */
    readonly items: Record<ReactionId, { readonly text: string; readonly label: string }>;
    /** Read out by the polite live region. */
    readonly announce: (name: string, label: string) => string;
  };
  readonly settings: {
    readonly title: string;
    readonly sfx: string;
    readonly sfxVolume: string;
    readonly music: string;
    readonly musicVolume: string;
    readonly animationSpeed: string;
    readonly speeds: Record<AnimationSpeed, string>;
    readonly reducedMotionNote: string;
    readonly showTips: string;
    readonly resetTips: string;
    readonly showReactions: string;
    readonly vibration: string;
  };
  readonly help: {
    readonly title: string;
    readonly tabs: { readonly rules: string; readonly guide: string };
    readonly rules: readonly HelpSection<RulesSectionId>[];
    readonly guide: readonly HelpSection<GuideSectionId>[];
    readonly examples: {
      readonly ranks: string;
      readonly trump: string;
      readonly sameSuit: string;
      readonly trumpBeats: string;
      readonly throwIn: string;
      readonly transfer: string;
      readonly playable: string;
      readonly dimmed: string;
    };
  };
  readonly profile: {
    readonly title: string;
    /** A public profile (someone else's, from the leaderboard). */
    readonly publicTitle: string;
    /** Placeholder until the first game sets the real nickname. */
    readonly defaultNickname: string;
    readonly privacy: string;
    readonly rating: string;
    readonly rank: (n: number) => string;
    readonly unranked: string;
    readonly games: string;
    readonly wins: string;
    readonly duraks: string;
    readonly recent: string;
    readonly noGames: string;
    readonly results: Record<PlayerResult, string>;
    readonly unrated: string;
    readonly botAssisted: string;
    readonly vs: (names: string) => string;
    readonly noProfile: string;
    readonly unavailable: string;
    readonly notFound: string;
    readonly leaderboardLink: string;
    readonly transfer: {
      readonly title: string;
      readonly explain: string;
      readonly button: string;
      readonly codeLabel: string;
      readonly expiresIn: (time: string) => string;
      readonly expired: string;
    };
    readonly claim: {
      readonly title: string;
      readonly label: string;
      readonly submit: string;
      readonly replaceWarning: string;
      readonly done: (name: string) => string;
    };
  };
  readonly leaderboard: {
    readonly title: string;
    readonly subtitle: string;
    readonly empty: string;
    readonly rank: string;
    readonly player: string;
    readonly rating: string;
    readonly games: string;
    readonly mine: string;
  };
  /** Profile / rating API errors (Phase 10), including NETWORK (no server answer). */
  readonly apiErrors: Record<ProfileApiError, string>;
  readonly tips: Record<TipId, string> & { readonly label: string; readonly dismiss: string };
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
    vsComputerHint: 'משחק מיידי מול בוטים, בלי לחכות לשחקנים',
    opponents: 'מספר יריבים',
  },
  bots: {
    badge: 'בוט',
    name: (n) => `מחשב ${n}`,
    difficulty: 'רמת קושי',
    difficulties: { easy: 'קל', medium: 'בינוני', hard: 'קשה' },
    add: 'הוספת בוט',
    addTitle: 'חסרים שחקנים? הוסיפו בוט',
    addHint: 'בוט ממלא מקום פנוי ומשחק מיד. אפשר להוסיף כמה שרוצים, עד שהחדר מתמלא.',
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
  moments: {
    wentOut: (names, count) => (count > 1 ? `${names} יצאו! 🎉` : `${names} יצא/ה! 🎉`),
    youWentOut: 'יצאת מהמשחק! 🎉',
    bigTake: (name, count) => `${name} לקח/ה ${count} קלפים`,
    youTookBig: (count) => `לקחת ${count} קלפים`,
    perfectDefense: (name) => `הגנה מושלמת של ${name}!`,
    yourPerfectDefense: 'הגנה מושלמת!',
    transfer: (from, to) => `${from} העביר/ה את ההתקפה ל־${to}`,
    youTransferred: (to) => `העברת את ההתקפה ל־${to}`,
    transferredToYou: (from) => `${from} העביר/ה אליך את ההתקפה`,
    deckOut: 'החפיסה נגמרה!',
    deckOutTrumpTo: (name) => `החפיסה נגמרה! השליט אצל ${name}`,
    deckOutTrumpToYou: 'החפיסה נגמרה! השליט אצלך',
  },
  reveal: {
    stamp: 'דוראק!',
    draw: 'תיקו!',
    skip: 'דילוג',
  },
  stats: {
    highlights: 'רגעי שיא',
    mostTaken: 'הכי הרבה קלפים נלקחו',
    mostTakenValue: (count) => `${count} קלפים`,
    bestDefense: 'ההגנה הטובה ביותר',
    bestDefenseValue: (defenses, of) => `${defenses} מתוך ${of} הגנות הצליחו`,
    mostTransfers: 'הכי הרבה העברות',
    mostTransfersValue: (count) => `${count} העברות`,
    mostThrowIns: 'הכי הרבה הוספות',
    mostThrowInsValue: (count) => `${count} קלפים נוספו`,
    showAll: 'כל הנתונים',
    hideAll: 'הסתרת הנתונים',
    columns: {
      player: 'שחקן',
      boutsAttacked: 'תקיפות',
      defenses: 'הגנות',
      cardsTaken: 'נלקחו',
      throwIns: 'הוספות',
      transfers: 'העברות',
      cardsPlayed: 'קלפים ששוחקו',
    },
  },
  reactions: {
    button: 'תגובה מהירה',
    pickerTitle: 'שליחת תגובה',
    items: {
      laugh: { text: '😂', label: 'צוחק/ת' },
      fire: { text: '🔥', label: 'אש' },
      shock: { text: '😱', label: 'בהלה' },
      clap: { text: '👏', label: 'מחיאות כפיים' },
      think: { text: '🤔', label: 'חושב/ת' },
      nice: { text: 'יפה!', label: 'יפה!' },
      lucky: { text: 'מזל...', label: 'מזל...' },
      ohNo: { text: 'אוי לא', label: 'אוי לא' },
      again: { text: 'עוד סיבוב?', label: 'עוד סיבוב?' },
    },
    announce: (name, label) => `${name}: ${label}`,
  },
  settings: {
    title: 'הגדרות',
    sfx: 'צלילים',
    sfxVolume: 'עוצמת צלילים',
    music: 'מוזיקת רקע',
    musicVolume: 'עוצמת מוזיקה',
    animationSpeed: 'מהירות אנימציה',
    speeds: { normal: 'רגילה', fast: 'מהירה' },
    reducedMotionNote: 'אם במכשיר מוגדרת "הפחתת תנועה", האנימציות יוחלפו בהופעה מהירה בכל מקרה.',
    showTips: 'הצגת טיפים',
    resetTips: 'הצגת הטיפים מההתחלה',
    showReactions: 'הצגת תגובות מהירות',
    vibration: 'רטט בתורך ובסוף המשחק',
  },
  help: {
    title: 'חוקים ועזרה',
    tabs: { rules: 'חוקי המשחק', guide: 'איך משחקים כאן' },
    rules: [
      {
        id: 'goal',
        title: 'מטרת המשחק',
        body: [
          'להיפטר מכל הקלפים. מי שנשאר אחרון עם קלפים ביד הוא ה"דוראק" ("טיפש" ברוסית) – המפסיד היחיד.',
          'אין מנצח אחד: כל מי שיוצא לפניו ניצל.',
        ],
      },
      {
        id: 'deck',
        title: 'למה 36 קלפים?',
        body: [
          'דוראק משוחק בחפיסה הרוסית הקלאסית: 36 קלפים, מ־6 עד אס בכל אחת מארבע הצורות.',
          'בלי הקלפים 2–5 כל קלף חזק ונחשב, המשחק קצר וסוער, ויש מספיק קלפים לשישה שחקנים עם שישה קלפים לכל אחד.',
        ],
      },
      {
        id: 'trump',
        title: 'שליט',
        body: [
          'אחרי החלוקה הקלף התחתון של החפיסה נחשף, והצורה שלו היא השליט לכל המשחק. הוא גם הקלף האחרון שיישלף.',
          'כל שליט חזק מכל קלף שאינו שליט. מי שמחזיק את השליט הנמוך ביותר פותח את הסיבוב הראשון.',
        ],
      },
      {
        id: 'attack',
        title: 'התקפה',
        body: [
          'התוקף פותח בקלף כלשהו מול השחקן שאחריו – המגן.',
          'בסיבוב הראשון מותרים עד 5 קלפי התקפה, ואחריו עד 6. אף פעם לא יותר קלפים לא מכוסים ממספר הקלפים שביד המגן.',
        ],
      },
      {
        id: 'defense',
        title: 'הגנה',
        body: [
          'המגן מכסה כל קלף התקפה בקלף גבוה יותר מאותה צורה, או בשליט כשקלף ההתקפה אינו שליט. שליט מול שליט – הגבוה מנצח.',
          'אפשר לכסות את קלפי ההתקפה בכל סדר.',
        ],
      },
      {
        id: 'throwIn',
        title: 'הוספת קלפים',
        body: [
          'כל שחקן חוץ מהמגן יכול להוסיף קלף בערך שכבר מופיע על השולחן – בקלף התקפה או בקלף הגנה – כל עוד יש מקום.',
        ],
      },
      {
        id: 'take',
        title: 'לקיחה',
        body: [
          'מגן שלא יכול (או לא רוצה) לכסות לוקח את כל הקלפים שעל השולחן, כולל המכוסים. האחרים עוד יכולים להוסיף לו קלפים לפני שהסיבוב נסגר.',
          'מי שלקח מפסיד את התור לתקוף: התוקף הבא הוא השחקן שאחריו.',
        ],
      },
      {
        id: 'pass',
        title: 'סיימתי',
        body: [
          'מי שאין לו מה להוסיף לוחץ "סיימתי". הסיבוב נגמר כשכל הקלפים מכוסים (או שהמגן לוקח), וכל השאר סיימו או לא יכולים להוסיף.',
          'כשהמגן הדף הכל, הקלפים יוצאים מהמשחק והמגן הוא התוקף הבא.',
        ],
      },
      {
        id: 'transfer',
        title: 'העברה (פרבודנוי)',
        body: [
          'במצב פרבודנוי המגן יכול, לפני שכיסה קלף כלשהו, להניח קלף באותו ערך כמו קלפי ההתקפה ולהעביר את כל ההתקפה לשחקן הבא – אם יש לו מספיק קלפים.',
          'מי שהעביר הופך לתוקף, ואפשר להעביר שוב ושוב.',
        ],
      },
      {
        id: 'draw',
        title: 'השלמת קלפים',
        body: ['בסוף כל סיבוב כולם משלימים ל־6 קלפים מהחפיסה: קודם התוקף, אחריו השאר לפי הסדר, והמגן אחרון.'],
      },
      {
        id: 'out',
        title: 'יציאה מהמשחק',
        body: ['כשהחפיסה נגמרה, מי שנשאר בלי קלפים בסוף סיבוב יוצא מהמשחק – ניצל.'],
      },
      {
        id: 'durak',
        title: 'מי הדוראק?',
        body: ['האחרון שנשאר עם קלפים ביד. אם השחקנים האחרונים נפטרו מהקלפים באותו סיבוב – תיקו, ואין דוראק.'],
      },
    ],
    guide: [
      {
        id: 'highlight',
        title: 'קלפים מודגשים ומעומעמים',
        body: ['בתורך, קלפים שאפשר לשחק עכשיו מודגשים ומתרוממים. קלפים מעומעמים אי אפשר לשחק כרגע.'],
      },
      {
        id: 'defendTaps',
        title: 'הגנה בשתי לחיצות',
        body: [
          'לחצו על קלף מהיד ואז על קלף ההתקפה שהוא מכסה – או להפך: קודם קלף ההתקפה ואז הקלף מהיד.',
          'להעברה: קלף מהיד ואז המשבצת "העברה" שעל השולחן.',
        ],
      },
      {
        id: 'buttons',
        title: '"לקחת" ו"סיימתי"',
        body: ['הכפתורים מופיעים מעל היד רק כשהם חוקיים: "לקחת" למגן, "סיימתי" למי שיכול להוסיף קלפים.'],
      },
      {
        id: 'countdown',
        title: 'טבעת הזמן',
        body: [
          'הטבעת סביב התמונה של השחקן מראה כמה זמן נשאר לו. כשהזמן נגמר המהלך נעשה אוטומטית: המגן לוקח, והאחרים מסיימים.',
        ],
      },
      {
        id: 'afk',
        title: 'בוט משחק במקומך',
        body: ['אחרי שני תורות ברצף שעברו בלי מהלך, בוט ממשיך בשבילך עד שתעשה/י מהלך בעצמך.'],
      },
      {
        id: 'reconnect',
        title: '"מתחבר מחדש..."',
        body: [
          'אם החיבור נופל מופיע פס "מתחבר מחדש..." עד שהחיבור חוזר. רענון הדף לא מוציא אותך מהחדר.',
          'מי שלא חוזר תוך דקה נחשב כמי שפרש.',
        ],
      },
      {
        id: 'leave',
        title: 'יציאה באמצע משחק',
        body: ['"יציאה" באמצע משחק נחשבת הפסד. במשחק של שניים המשחק נגמר; כשיש עוד שחקנים, בוט ממשיך במקומך.'],
      },
      {
        id: 'restart',
        title: 'משחק חדש',
        body: [
          '"משחק חדש" פותח הצבעה. אם כל השחקנים המחוברים מסכימים תוך 30 שניות, המשחק מבוטל בלי מפסיד ומחולקים קלפים חדשים.',
        ],
      },
    ],
    examples: {
      ranks: 'מהנמוך לגבוה',
      trump: 'הקלף הגלוי מתחת לחפיסה קובע את השליט',
      sameSuit: 'אותה צורה, ערך גבוה יותר',
      trumpBeats: 'שליט מכסה כל קלף שאינו שליט',
      throwIn: 'על השולחן 8 ו־10: אפשר להוסיף כל 8 או 10',
      transfer: 'מעבירים 9 על 9',
      playable: 'אפשר לשחק',
      dimmed: 'לא עכשיו',
    },
  },
  profile: {
    title: 'הפרופיל שלי',
    publicTitle: 'פרופיל שחקן',
    defaultNickname: 'שחקן',
    privacy: 'בלי אימייל ובלי סיסמה: רק כינוי ומזהה אקראי שנשמרים במכשיר הזה.',
    rating: 'דירוג',
    rank: (n) => `מקום ${n} בטבלה`,
    unranked: 'עוד אין דירוג: משחק מדורג צריך לפחות שני שחקנים אנושיים.',
    games: 'משחקים',
    wins: 'ניצחונות',
    duraks: 'פעמים דוראק',
    recent: 'משחקים אחרונים',
    noGames: 'עוד אין משחקים. המשחקים הבאים יופיעו כאן.',
    results: { win: 'ניצחון', durak: 'דוראק', draw: 'תיקו', forfeit: 'הפסד טכני', unfinished: 'לא הסתיים' },
    unrated: 'לא מדורג',
    botAssisted: 'בוט שיחק חלק מהמשחק',
    vs: (names) => `נגד ${names}`,
    noProfile: 'הפרופיל נוצר אוטומטית במשחק הראשון. יש לך פרופיל במכשיר אחר? אפשר להעביר אותו לכאן עם קוד.',
    unavailable: 'הפרופילים והדירוג לא זמינים כרגע. המשחק עצמו עובד כרגיל.',
    notFound: 'הפרופיל לא נמצא',
    leaderboardLink: 'טבלת הדירוג',
    transfer: {
      title: 'מעבר למכשיר אחר',
      explain: 'במכשיר החדש: "הפרופיל שלי" ← "יש לי קוד", ומקלידים את הקוד. הקוד תקף ל־10 דקות ולפעם אחת, ואחרי המעבר הפרופיל לא יעבוד יותר במכשיר הזה.',
      button: 'קבלת קוד מעבר',
      codeLabel: 'קוד המעבר',
      expiresIn: (time) => `בתוקף עוד ${time}`,
      expired: 'הקוד פג. אפשר לבקש קוד חדש.',
    },
    claim: {
      title: 'יש לי קוד',
      label: 'קוד מעבר',
      submit: 'העברת הפרופיל למכשיר הזה',
      replaceWarning: 'הפרופיל שכבר נמצא במכשיר הזה יוחלף.',
      done: (name) => `הפרופיל של ${name} עבר למכשיר הזה`,
    },
  },
  leaderboard: {
    title: 'טבלת הדירוג',
    subtitle: '20 המובילים. מדורגים רק משחקים עם שני שחקנים אנושיים לפחות.',
    empty: 'עוד אין משחקים מדורגים.',
    rank: 'מקום',
    player: 'שחקן',
    rating: 'דירוג',
    games: 'משחקים',
    mine: '(אני)',
  },
  apiErrors: {
    INVALID_PAYLOAD: 'בקשה לא תקינה',
    UNAUTHORIZED: 'הפרופיל הזה כבר לא פעיל במכשיר הזה',
    NOT_FOUND: 'לא נמצא',
    INVALID_CODE: 'הקוד שגוי, פג או שכבר השתמשו בו',
    RATE_LIMITED: 'יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות',
    RATINGS_UNAVAILABLE: 'הפרופילים והדירוג לא זמינים כרגע. המשחק עצמו עובד כרגיל.',
    INTERNAL: 'שגיאת שרת. אפשר לנסות שוב',
    NETWORK: 'אין כרגע חיבור לשרת',
  },
  tips: {
    label: 'טיפ',
    dismiss: 'הבנתי',
    firstAttack: 'תורך לפתוח: לחצו על קלף כלשהו כדי לתקוף.',
    firstDefense: 'כדי להגן: לחצו על קלף מהיד ואז על קלף ההתקפה שהוא מכסה. אין ברירה? "לקחת".',
    firstThrowIn: 'אפשר להוסיף קלף בערך שכבר על השולחן – או ללחוץ "סיימתי".',
    firstTransfer: 'יש לך קלף באותו ערך: אפשר להעביר את ההתקפה לשחקן הבא (קלף ואז "העברה").',
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

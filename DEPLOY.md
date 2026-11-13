# פריסה לייצור (Deploy)

## לשחק עם חברים דרך Quick Tunnel

הדרך הכי מהירה לשחק עם חברים, בלי חשבון ובלי שרת: המחשב שלך מריץ את ה-build של הייצור,
ו-Cloudflare Quick Tunnel נותן לו כתובת `https://….trycloudflare.com` ציבורית (HTTPS ו-WebSockets עובדים).

**דרישות:** Docker Desktop פועל, ו-`cloudflared` מותקן:
```powershell
winget install --id Cloudflare.cloudflared
```

**הפעלה:** פקודה אחת שבונה ומריצה את ה-stack, פותחת את המנהרה ומדפיסה את הכתובת לשיתוף:
```powershell
npm run tunnel
```
- הסקריפט (`scripts/tunnel.mjs`) מחכה שהאפליקציה תהיה תקינה מקומית ושהכתובת הציבורית תענה על `/health`, ורק אז מדפיס אותה.
- **Ctrl+C** סוגר את המנהרה. הכתובת נעלמת לתמיד, והרצה חוזרת נותנת כתובת חדשה.
- ה-stack ממשיך לרוץ אחרי Ctrl+C. עצירה:
```powershell
npm run prod:down
```
- בעיות? `$env:TUNNEL_VERBOSE=1; npm run tunnel` מציג את הפלט של `cloudflared`.
- אפשר גם ידנית: `$env:TRUST_PROXY=1; $env:APP_BIND="127.0.0.1"; npm run prod:up` ואז `cloudflared tunnel --url http://127.0.0.1:8080`.

**למה `TRUST_PROXY=1` (הסקריפט מגדיר אותו לבד):**
- כל הבקשות מגיעות לאפליקציה מ-`cloudflared` דרך ה-port forwarding של Docker, כלומר מאותה כתובת (`172.19.0.1`, ה-gateway של Docker).
- בלי אמון ב-proxy, כל החברים נראים כמו IP אחד וחולקים את ההגבלות לכל IP: ‏20 חיבורים ו-30 חדרים בשעה ביחד.
- בדקתי דרך מנהרה אמיתית: ה-edge של Cloudflare **מוסיף בסוף** את כתובת הלקוח האמיתית ל-`X-Forwarded-For`, ו-`cloudflared` לא מוסיף כלום.
  לכן האפליקציה מקבלת `[מה שהלקוח שלח…], <הלקוח האמיתי>` מ-hop אחד, ואמון ב-hop אחד בדיוק בוחר את הלקוח האמיתי.
- `X-Forwarded-For` מזויף נשאר בחלק שמתעלמים ממנו. `CF-Connecting-IP` מזויף נחסם כבר ב-Cloudflare (שגיאה 1000).
- `APP_BIND=127.0.0.1` מוודא שה-port לא חשוף ל-LAN. אחרת מישהו ברשת המקומית יכול לעקוף את המנהרה ולשלוח `X-Forwarded-For` מזויף.
- בדיקת ה-Origin של Socket.io עובדת בלי שינוי: `cloudflared` שומר את ה-Host המקורי (`….trycloudflare.com`), אז הדפדפן נחשב same-origin.
- בלוג של השרת, כל חיבור נרשם כ-`socket connected` עם ה-`ip` שחושב, וכך אפשר לוודא את זה (`docker logs durak-prod-app-1`).

**כדאי לדעת:**
- Quick Tunnel מיועד לבדיקות ולשימוש קטן: בלי SLA, הכתובת זמנית, ו-Cloudflare עלול להגביל אותו.
- המשחק רץ על המחשב שלך: אם הוא נרדם או מתנתק, השחקנים מתנתקים (יש להם 60 שניות לחזור).
- לקוחות IPv6 נספרים לפי כתובת מלאה (‎/128). מי שמחליף כתובות בתוך ה-‎/64 שלו יכול לעקוף את ההגבלות לכל IP. לשימוש עם חברים זה בסדר.
- לבדיקת קצה-לקצה דרך המנהרה: `npm run smoke -- https://<name>.trycloudflare.com`.

---

המשך המסמך מסביר איך להעלות את דוראק אונליין לאוויר באופן קבוע: השוואה בין שלוש פלטפורמות, ההמלצה, והוראות צעד-אחר-צעד.

> ## ⚠️ חשוב: השרת תומך במופע (instance) אחד בלבד
> הנעילה לכל חדר (`KeyedMutex`), טיימרי התורות והבוטים חיים בזיכרון של תהליך Node אחד.
> שני מופעים מול אותו Redis עלולים להריץ מהלכים במקביל על אותו חדר ולהשחית משחקים.
> **אסור** להגדיר autoscaling, "high availability", או יותר ממכונה/רפליקה אחת, ואסור לבחור
> אסטרטגיית פריסה blue-green שמריצה זמנית שני מופעים. כדי לתמוך ביותר ממופע אחד צריך נעילה
> מבוזרת (למשל Redis `SET NX PX` עם fencing tokens) או ניתוב דביק של כל חדר למופע אחד.

## מה רץ בייצור

image אחד (`Dockerfile`) שמריץ תהליך Node יחיד:
- מגיש את אפליקציית הווב הבנויה (קבצים סטטיים + SPA fallback, כך ש-`/room/:id` עובד גם ברענון).
- Socket.io על אותו origin (הלקוח מתחבר לכתובת שממנה נטען; `VITE_SERVER_URL` רק דורס).
- `GET /health` → `{ ok, repository, redis }`, ומחזיר 503 כש-Redis לא זמין.
- Redis חיצוני לשמירת חדרים, משחקים ו-sessions (חובה בייצור: בלי Redis הכול בזיכרון ונמחק בכל ריסטארט).

הרצה מקומית של build הייצור: `npm run prod:up` ואז http://localhost:8080 (עצירה: `npm run prod:down`).
בדיקת קצה-לקצה מול כל שרת: `npm run build --workspace=packages/shared --workspace=packages/game-engine` ואז `npm run smoke -- <URL>`.

## השוואת פלטפורמות

המחירים נאספו בנובמבר 2026 ממקורות ציבוריים (חלקם צד שלישי) ומשתנים לעיתים קרובות. **בדוק את דף התמחור הרשמי לפני שאתה נרשם.**
הערכת עלות ל"תחביב קטן": מכונה אחת קטנה שרצה 24/7 + Redis קטן.

| | **Fly.io** | **Railway** | **Render** |
|---|---|---|---|
| WebSockets ארוכים | ✅ | ✅ | ✅ (בתשלום) |
| מופע יחיד שתמיד דולק | ✅ עם `auto_stop_machines = "off"` | ✅ (שירות רגיל לא נרדם) | ✅ רק בתוכנית בתשלום |
| מכונה קטנה | shared-cpu-1x: 256MB ≈ ‎$2.19 לחודש, 512MB ≈ ‎$3.7 (הערכה לפי ‎$6 ל-GB) | לפי שימוש: ‎$20 ל-vCPU ו-‎$10 ל-GB RAM בחודש | Starter ‏(512MB): ‎$7 לחודש |
| דמי מנוי | אין | Hobby: ‎$5 לחודש שכוללים ‎$5 שימוש | אין (workspace Hobby חינם) |
| שכבה חינמית | אין לארגונים חדשים (ניסיון קצר בלבד) | ניסיון חד-פעמי (‎$5 קרדיט); לפי חלק מהמקורות גם ‎$1 לחודש אחריו | Free: ‏512MB, ‏0.1 CPU, **נרדם אחרי 15 דקות** |
| Redis מנוהל | Upstash דרך `fly redis create`: לפי שימוש ‎$0.20 ל-100K פקודות, או קבוע מ-‎$10 לחודש | תבנית Redis בקליק, מחויבת לפי שימוש כמו כל שירות | Key Value: חינמי 25MB **בלי persistence**; בתשלום מ-‎~$10 לחודש |
| שינה / cold start | לא, אם מכבים auto-stop | לא (אלא אם מפעילים serverless/sleep) | בחינמי: נרדם אחרי 15 דק', ההתעוררות ‎~1 דקה |
| עלות משוערת לחודש | **‎~$4–6** (מכונה 512MB + Upstash לפי שימוש) | **‎~$5–8** | **‎~$17** (Starter + Key Value בתשלום) |
| קושי | בינוני: CLI ‏(`flyctl`) + `fly.toml` (קיים בריפו) | קל: חיבור GitHub, מזהה את ה-Dockerfile לבד | קל: דשבורד, מזהה Dockerfile |

**למה לא Render Free:** השרת שומר טיימרים, בוטים וחיבורים פתוחים בתהליך. שינה אחרי 15 דקות מנתקת שחקנים, ו-0.1 CPU איטי מדי לבוט (IS-MCTS).
ה-Key Value החינמי בלי persistence, אז ריסטארט מוחק את כל המשחקים.

## ההמלצה: Fly.io

- הכי זול למכונה שתמיד דולקת (בערך ‎$4–6 לחודש), בלי מנוי חודשי.
- מריץ את ה-Dockerfile שלנו כמו שהוא, WebSockets עובדים בלי הגדרות מיוחדות, ויש אזורים קרובים לישראל (למשל `fra`, פרנקפורט).
- שליטה מלאה במספר המכונות (חשוב, כי מותר רק מופע אחד), ו-Redis מנוהל זמין בפקודה אחת.

אלטרנטיבה אם אתה מעדיף דשבורד ובלי CLI: **Railway** (בערך אותו מחיר, פשוט יותר).
שם צריך לוודא ש-Replicas = 1, להגדיר `NODE_ENV=production`, ‏`TRUST_PROXY=1`, ‏`REDIS_URL` (מתוך שירות ה-Redis), ו-Healthcheck Path = `/health`.

## פריסה ל-Fly.io צעד אחר צעד

### 0. דרישות
חשבון ב-Fly.io (דורש כרטיס אשראי). אני לא יצרתי חשבון ולא פרסתי כלום; הצעדים האלה בשבילך.

### 1. התקנת flyctl והתחברות
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
fly auth signup   # או: fly auth login
```

### 2. יצירת האפליקציה
בחר שם ייחודי (הוא יהיה גם הכתובת `https://<name>.fly.dev`), ועדכן אותו בשורה `app = ...` בקובץ `fly.toml`:
```bash
fly apps create durak-yourname
```

### 3. Redis
**אפשרות א' (מומלצת, מנוהלת): Upstash דרך Fly**
```bash
fly redis create
```
- בחר את אותו אזור (`fra`), **בלי eviction**, ותוכנית pay-as-you-go.
- בסוף הפקודה תודפס כתובת חיבור (`redis://default:<password>@fly-<name>.upstash.io:6379`). שמור אותה בתור secret:
```bash
fly secrets set REDIS_URL="redis://default:<password>@fly-<name>.upstash.io:6379" --app durak-yourname
```
הערכת שימוש: בדיקת `/health` כל 30 שניות היא ‎~86K פקודות בחודש. משחק שלם הוא כמה מאות פקודות. בשימוש תחביבי זה סנטים עד דולרים בודדים לחודש.

> בדקתי את השרת רק מול Redis 7 רגיל (מקומי ו-CI), ולא מול Upstash. השרת משתמש ב-`MULTI/EXEC`, ‏`SCAN`, ‏`GETEX` ו-`SET … KEEPTTL`.
> אם `/health` מחזיר `redis: "down"` או שיש שגיאות Redis בלוגים, עבור לאפשרות ב'.

**אפשרות ב': Redis משלך על Fly (תאימות מלאה, ‎~$2.5 לחודש)**
אפליקציה נפרדת עם volume. ראה https://fly.io/docs/ (חפש "Redis on Fly"). מגדירים `REDIS_URL=redis://<redis-app>.internal:6379` כ-secret.

### 4. פריסה, ובדיוק מכונה אחת
```bash
fly deploy --ha=false
fly scale count 1 --yes
fly status
```
- `--ha=false` חשוב: בלעדיו Fly יוצר **שתי** מכונות בפריסה הראשונה.
- `fly.toml` כבר מגדיר `auto_stop_machines = "off"`, ‏`min_machines_running = 1`, ‏`strategy = "rolling"` ו-health check על `/health`.
- `fly status` צריך להראות מכונה אחת בדיוק במצב `started`.

### 5. משתני סביבה

| משתנה | ערך ב-Fly | הערות |
|---|---|---|
| `REDIS_URL` | secret (צעד 3) | חובה בייצור |
| `NODE_ENV` | `production` (ב-`fly.toml`) | מפעיל CORS של same-origin בלבד |
| `PORT` | `8080` (ב-`fly.toml`) | תואם `internal_port` |
| `TRUST_PROXY` | `1` (ב-`fly.toml`) | ה-proxy של Fly הוא hop אחד; כך כתובות ה-IP של לקוחות נכונות להגבלות |
| `CORS_ORIGINS` | ריק | רק אם דומיין אחר צריך להתחבר |
| `BOT_WORKERS` | ריק | ברירת מחדל: מעבדים זמינים פחות 1, בין 1 ל-4 (מזהה מגבלת cgroup) |
| `TURN_TIMEOUT_MS`, ‏`AFK_TIMEOUT_MS`, ‏`RECONNECT_GRACE_MS` | ברירות מחדל | 30000 / 5000 / 60000 |
| `RATE_LIMIT_BURST`, ‏`RATE_LIMIT_PER_SEC` | 20 / 10 | token bucket לכל socket |
| `RATE_LIMIT_DISCONNECT_AFTER` | 100 | אירועים שנזרקו ב-10 שניות לפני ניתוק |
| `MAX_ROOMS_PER_IP_PER_HOUR`, ‏`MAX_ROOMS`, ‏`MAX_SOCKETS_PER_IP` | 30 / 500 / 20 | הגבלות נגד ניצול לרעה |

שינוי משתנה רגיל: `fly secrets set NAME=value` (גורם לריסטארט), או עריכת `[env]` ב-`fly.toml` ואז `fly deploy --ha=false`.

### 6. בדיקת /health ובדיקת קצה-לקצה
```bash
curl https://durak-yourname.fly.dev/health
# צפוי: {"ok":true,"repository":"redis","redis":"PONG"}

fly checks list        # מצב ה-health check של Fly
fly logs               # לוגים חיים; בעלייה מודפסת שורת "settings" עם כל ההגדרות בפועל

# מהריפו המקומי: משחק אמיתי נגד בוט
npm run build --workspace=packages/shared --workspace=packages/game-engine
npm run smoke -- https://durak-yourname.fly.dev
```
ואז פשוט לפתוח את `https://durak-yourname.fly.dev` בדפדפן ולשחק.

### 7. עדכונים
```bash
fly deploy --ha=false
```
- הפריסה מחליפה את המכונה הקיימת, אז יש השבתה קצרה (שניות).
- המשחקים שמורים ב-Redis, הלקוחות מתחברים מחדש לבד ומחדשים את ה-session.
- לכל שחקן יש 60 שניות (`RECONNECT_GRACE_MS`) לפני הפסד טכני.

### תקלות נפוצות
- **`/health` מחזיר 503 / `redis: "down"`:** בדוק את `REDIS_URL` (`fly secrets list`) ואת `fly logs`.
- **"יותר מדי חיבורים":** כמה שחקנים מאחורי אותה רשת (NAT). העלה את `MAX_SOCKETS_PER_IP`.
- **מופיעות שתי מכונות ב-`fly status`:** הרץ `fly scale count 1 --yes` מיד.

## מקורות (תמחור, נובמבר 2026)
- Fly.io: https://fly.io/docs/about/pricing/ , https://fly.io/docs/upstash/redis/ , https://fly.io/docs/launch/autostop-autostart/
- Railway: https://railway.com/pricing (סיכומים: https://www.srvrlss.io/provider/railway/ , https://www.budgetforge.dev/tools/railway-pricing-2026)
- Render: https://render.com/pricing (סיכומים: https://temps.sh/blog/render-pricing-2026 , https://www.activepieces.com/blog/render-pricing-2026-free-tier-workers-total-cost)

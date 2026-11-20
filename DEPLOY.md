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
- **מאז שלב 10:** ה-compose קובע רשת עם subnet קבוע (`172.30.80.0/24`) ו-`TRUSTED_PROXIES` מצביע עליה, כך שמאמינים לכותרות רק כשהחיבור באמת מגיע מה-gateway של Docker (`172.30.80.1`). הסקריפט מגדיר גם `TRUST_CF_CONNECTING_IP=true`: מעדיפים את `CF-Connecting-IP` ש-Cloudflare קובע (ואם הוא חסר, חוזרים לכלל של `X-Forwarded-For`). אל תפעילו את זה מאחורי proxy שאינו Cloudflare: שם לקוח יכול לזייף את הכותרת.

**כדאי לדעת:**
- Quick Tunnel מיועד לבדיקות ולשימוש קטן: בלי SLA, הכתובת זמנית, ו-Cloudflare עלול להגביל אותו.
- המשחק רץ על המחשב שלך: אם הוא נרדם או מתנתק, השחקנים מתנתקים (יש להם 60 שניות לחזור).
- לקוחות IPv6 נספרים לפי כתובת מלאה (‎/128). מי שמחליף כתובות בתוך ה-‎/64 שלו יכול לעקוף את ההגבלות לכל IP. לשימוש עם חברים זה בסדר.
- לבדיקת קצה-לקצה דרך המנהרה: `npm run smoke -- https://<name>.trycloudflare.com`.

---

## אירוח קבוע: עוד לא נקבע

**כרגע:** הדרך לשחק עם חברים היא ה-Quick Tunnel שלמעלה.
**אירוח קבוע:** עוד לא נבחר. הכיוון שנבדק הוא Azure דרך GitHub Student Pack.
(`fly.toml` נשאר בריפו מתקופה קודמת, אבל לא משתמשים ב-Fly.io: הוא בתשלום.)

החלקים הבאים לא תלויים בפלטפורמה: מה כל שרת קבוע צריך לספק.

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
- `GET /health` → `{ ok, repository, redis, postgres }`, ומחזיר 503 רק כש-Redis לא זמין (Postgres למטה לא מפיל את השרת).
- Postgres (לא חובה) לפרופילים, היסטוריית משחקים ודירוג ELO. ה-migrations רצים אוטומטית בעליית השרת (`prisma migrate deploy`). בלי `DATABASE_URL`, או כש-Postgres למטה, המשחקים עובדים כרגיל ורק הדירוג כבוי (`/api/*` מחזיר 503).
- Redis חיצוני לשמירת חדרים, משחקים ו-sessions (חובה בייצור: בלי Redis הכול בזיכרון ונמחק בכל ריסטארט).

הרצה מקומית של build הייצור: `npm run prod:up` ואז http://localhost:8080 (עצירה: `npm run prod:down`).

## מה שרת קבוע צריך

- **מכונה אחת שתמיד דולקת:** WebSockets ארוכים, בלי "שינה" אחרי חוסר פעילות (השרת מחזיק טיימרים, בוטים וחיבורים פתוחים), ובלי autoscaling.
- **CPU אמיתי:** הבוט (IS-MCTS) חושב עד 300 ms למהלך ב-worker threads; ‏0.1 CPU איטי מדי.
- **Redis עם persistence**, שתומך ב-`MULTI/EXEC`, ‏`SCAN`, ‏`GETEX` ו-`SET … KEEPTTL` (השרת נבדק מול Redis 7).
- **Postgres** (לא חובה) לפרופילים ולדירוג.
- **HTTPS** (נדרש גם ל-PWA וגם ל-wake lock), ו-health check על `/health`.
- **פריסה שמחליפה את המופע** (לא מריצה שניים במקביל). השבתה קצרה בעדכון היא בסדר: המשחקים שמורים ב-Redis, הלקוחות מתחברים מחדש לבד, ולכל שחקן יש 60 שניות (`RECONNECT_GRACE_MS`) לפני הפסד טכני.

## משתני סביבה

| משתנה | ערך מומלץ | הערות |
|---|---|---|
| `REDIS_URL` | secret | חובה בייצור |
| `NODE_ENV` | `production` | מפעיל CORS של same-origin בלבד |
| `PORT` | `8080` | ברירת המחדל ב-image |
| `TRUST_PROXY` | מספר ה-proxies לפני האפליקציה (בדרך כלל `1`) | כך כתובות ה-IP של לקוחות נכונות להגבלות |
| `TRUSTED_PROXIES` | ה-CIDR של ה-proxy, אם ידוע | ריק = כל peer נחשב proxy (בסדר רק אם רק ה-proxy מגיע לאפליקציה) |
| `TRUST_CF_CONNECTING_IP` | `false` | רק כש-Cloudflare לפני האפליקציה |
| `DATABASE_URL` | secret | לא חובה: בלעדיו אין פרופילים ודירוג |
| `DB_MIGRATE_ON_START` | `true` | `prisma migrate deploy` בעליית השרת |
| `CORS_ORIGINS` | ריק | רק אם דומיין אחר צריך להתחבר |
| `BOT_WORKERS` | ריק | ברירת מחדל: מעבדים זמינים פחות 1, בין 1 ל-4 (מזהה מגבלת cgroup) |
| `TURN_TIMEOUT_MS`, ‏`AFK_TIMEOUT_MS`, ‏`RECONNECT_GRACE_MS` | ברירות מחדל | 30000 / 5000 / 60000 |
| `RATE_LIMIT_BURST`, ‏`RATE_LIMIT_PER_SEC` | 20 / 10 | token bucket לכל socket |
| `RATE_LIMIT_DISCONNECT_AFTER` | 100 | אירועים שנזרקו ב-10 שניות לפני ניתוק |
| `MAX_ROOMS_PER_IP_PER_HOUR`, ‏`MAX_ROOMS`, ‏`MAX_SOCKETS_PER_IP` | 30 / 500 / 20 | הגבלות נגד ניצול לרעה |

## בדיקה אחרי פריסה

```bash
curl https://<הכתובת>/health
# צפוי: {"ok":true,"repository":"redis","redis":"PONG","postgres":"ok"}

# מהריפו המקומי: משחק אמיתי נגד בוט
npm run build --workspace=packages/shared --workspace=packages/game-engine
npm run smoke -- https://<הכתובת>
```
בעליית השרת מודפסת בלוג שורת `settings` עם כל ההגדרות בפועל.

### תקלות נפוצות
- **`/health` מחזיר 503 / `redis: "down"`:** בדוק את `REDIS_URL` ואת הלוגים.
- **"יותר מדי חיבורים":** כמה שחקנים מאחורי אותה רשת (NAT). העלה את `MAX_SOCKETS_PER_IP`.
- **כל השחקנים מקבלים אותה כתובת IP בלוג `socket connected`:** `TRUST_PROXY` לא מוגדר נכון לפלטפורמה.

# Sairahus 2026 — implementation plan

Doraemon-themed sairahus event. A junior finds their senior by spending
dorayaki coins on gadget hints. Everything lives inside LINE.

## Stack (and what we're not using)

| Piece | Choice | Why not the other thing |
|---|---|---|
| Bot | LINE Messaging API channel | — |
| Screens | **One** LIFF app, static HTML on GitHub Pages (`/docs`) | This repo already exists and Pages is free. No build step, no framework, no Vercel account. |
| Backend | Google Apps Script web app | Zero ops, zero cost, staff can fix data in the Sheet. |
| DB | Google Sheets, 4 tabs | 200 participants. Postgres is a second thing to babysit at 2am. |
| Admin | LINE group + rich menu | No admin website. |

Two channels, **same provider**: Messaging API (bot) + LINE Login (hosts the
LIFF app). `userId` is provider-scoped — different providers means the LIFF
form and the webhook see different IDs for the same person, and matching
silently breaks. This is the one setup mistake that is expensive to discover late.

## One LIFF app, not five

Rich menu tiles link to `https://liff.line.me/{LIFF_ID}?p=quest`. LIFF passes
query strings through, so one registered app + one `docs/index.html` serves
all five screens. Five LIFF IDs to keep in sync is five chances to point a
tile at the wrong one.

```
docs/index.html    ?p=register | hint | quest | wallet | checkin | staff
apps-script/Code.gs        doPost router + LINE webhook
apps-script/Match.gs       matcher + cutoff + self-check
```

Three files. That's the whole system.

## Data model — 4 tabs

- **participants** — `lineUserId, nickname, realName, studentId, email, year(1-4), house(1-10), village(1-5), capacity, seniorId, pairStatus, checkedInAt, role, hint1, hint2, hint3, hint4`
- **submissions** — `userId, round, questId, imageId, status, reviewerId, ts`
- **hint_unlocks** — `userId, level, ts`
- **config** — `phase, checkinCode, quest titles, hint templates, theme strings`

**No token ledger sheet.** Coins are earned only by quest approval and spent
only on hints, both already recorded:

```js
balance = countRows(submissions, {userId, status:'pass'})
        - sum(hint_unlocks[userId].map(h => HINT_COST[h.level]))
```

A ledger is a second source of truth that can disagree with the first one.

**No pairs sheet.** `seniorId` + `pairStatus` are columns on the junior's row.

All UI and sheet values are English (`pass` / `fail` / `overflow`, `Baan`,
`Village`) so staff reading the raw sheet see the same words as the screens.

## Auth — the only place not to be lazy

Never trust a `userId` POSTed from the page; devtools can edit it and check in
for a friend or drain their coins. Send `liff.getIDToken()`, verify server-side:

```js
function verify(idToken) {
  const r = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: LOGIN_CHANNEL_ID }
  });
  return JSON.parse(r).sub;   // the only userId we ever trust
}
```

Scopes: `openid` + `profile` only — still true even though we now collect
email. **Ask for the student email as a form field, not a LINE scope.** The
`email` scope needs an extra consent screen people bail on, requires channel
review, and gives you their personal LINE email anyway — not the university
one you actually want as a backup contact.

```html
<input type="email" name="email" required
       pattern=".+@STUDENT_DOMAIN" title="University email only">
```

Native validation, no regex library, no JS. Domain lives in `config` so it's
one cell to change. Re-validate server-side — `pattern` is a UX hint, not a
trust boundary.

CORS: POST from Pages to `/exec` with `Content-Type: text/plain`. Apps Script
can't answer a preflight; text/plain doesn't trigger one. `JSON.parse(e.postData.contents)`
server-side. Skipped: a proxy, a CORS shim.

Writes wrap in `LockService.getScriptLock()`. Native, one line, handles the
12:30 check-in spike.

## The state machine

One cell: `config.phase`. Every button reads it and behaves accordingly.
Six buttons and one variable, not twelve features.

```
REGISTER → QUEST_R1 → QUEST_R2 → QUEST_R3 → HUNT → REVEAL
```

A hint shows only when `phase >= HUNT` **and** `balance >= 1`. Two cheap gates.

## The six flows

**1. Registration** — LIFF form. Seniors get capacity + the four hint boxes
(below). Submit → confirmation card + `linkRichMenuIdToUser` swaps them to the
registered menu.

**2. Quests** — junior picks round+quest in LIFF, returns to chat, uploads
photo. The photo lands in Drive and the submission joins a **pull queue on the
staff screen** — not a push into a staff group. 600 submissions pushed to a
group counts once per member and would blow the free message quota; a queue
screen is also better than scrolling 200 cards in a chat.

Approval writes a coin and pushes nothing. The junior sees the new balance in
their wallet. Idempotent: under lock, if `status !== ''` the tap is ignored, so
two staff tapping at once can't double-credit.

**3. Matching** — run once from the Apps Script editor when registration
closes. Not a global assignment problem: sairahus lineage is inherited within a
Baan, so a junior's senior must be in the same Baan — 10 independent
round-robins by remaining capacity. Shortfall → `overflow` pool + flag for a
human, detected now, not on event day. Villages = greedy largest-first bin-pack
of Baans into 5 balanced groups. ~30 lines with a self-check.

**4. Check-in** — no scanner, no queue. 4-digit code on a sign at the door
(the "Anywhere Door code"); junior taps Check in, types it, done. The code stops
dorm check-ins. At 13:30 the lead hits **cut-off**: every junior whose senior
never showed gets reassigned within their house to a checked-in senior with
spare capacity; only affected seniors are notified. One button instead of
thirty minutes of paper.

**5. Hints — senior-authored, four free-text boxes.** Juniors already know
their Baan and pairing is within-Baan, so the search space is ~10 people
from the start. A generated village→house ladder would reveal nothing they
don't already know. The fun is the senior writing their own clues, so the
system stores strings and does not generate anything:

| Lv | Gadget | Prompt shown to the senior | Cost |
|---|---|---|---|
| 1 | Bamboo Copter | "A view from above — a broad trait or hobby" | 1 |
| 2 | Anywhere Door | "Something people usually get wrong about you" | 1 |
| 3 | Search Light | "Event-day marker — what you are wearing, where you'll be" | 2 |
| 4 | Out of the Drawer | "Your initials + the first thing you'll say" | free at REVEAL |

Level 4 is free so nobody goes home without finding their senior.

Three things this costs us, all cheap:

- **Level 3 is stale.** Seniors register weeks early and can't know what
  they'll wear. Rich menu tile "My hints" opens `?p=hint` — the same form
  in edit mode, phase-gated to event day morning. No new code path.
- **Blank hints.** *Never charge a coin for empty text.* Check the cell
  before deducting; if blank, reply "your senior hasn't written this yet" and refund
  nothing because nothing was taken. This is the one guard that turns a
  lazy feature into an angry junior otherwise.
- **Lazy hints.** `minlength=15` on the textarea plus a filled-in example
  placeholder per box. Staff menu gets a "seniors with no hints" count → nag list.

**6. Staff menu** — Review quests, Change phase, Check-in counts, Cut-off & rematch.
Phase and cut-off gated to 2–3 hardcoded lead userIds in `config`.

## Theme

5 villages = 5 characters (blue/yellow/pink/orange/green — distinct enough for
name tags, zero explanation needed). 10 Baans = 10 gadgets. Coins = dorayaki
coins, wallet screen = the Magic Pocket.

All theme strings live in the `config` tab. Nothing in the system logic depends
on the theme — retheme in an hour if the faculty asks.

Licensing: Fujiko Pro property. Internal non-ticketed event is normally
uneventful, but draw original art in the palette rather than pasting official
assets, and don't sell merch with it.

## Build order

1. **Registration + rich menus** — ship 2 weeks before the form opens
2. **Matcher** — needed the day registration closes
3. **Quests + approval** — quest week
4. **Check-in + cut-off** — the highest-value piece; test it with 10 people first
5. **Hints** — ships *with* registration (they're just form fields). Only the
   `?p=hint` edit screen and the unlock/charge logic wait until quest week.

## Where this breaks

- **Approval backlog.** 3 rounds × 200 juniors = ~600 taps. Decide *before you
  build*: auto-approve round 1, require a caption keyword, spot-check the rest.
  Not at 2am.
- **Venue wifi.** Keep the check-in screen tiny; retry on failure.
- **Never added the OA.** Staff manual-add path → placeholder row they claim
  later. Email is the backup channel here: staff can reach someone who blocked
  the OA or changed LINE accounts without hunting through group chats.
- **Seniors who never write hints.** The only unfixable-on-the-day failure —
  a junior with four blank hints has no path to their senior. Nag list from
  the staff menu during quest week, and make hint 1 required at registration
  so at least one always exists.

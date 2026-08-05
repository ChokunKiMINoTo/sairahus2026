# Sairahus 2026

Doraemon-themed sairahus (senior-junior pairing) event, running entirely inside LINE.
Design and rationale: [PLAN.md](PLAN.md).

```
docs/index.html      LIFF screens  (?p=register|hint|quest|wallet|checkin|staff)
apps-script/Code.gs  API + LINE webhook
apps-script/Match.gs matching, villages, 13:30 cut-off, self-check
```

---

# Setup

About 45 minutes. **Do the steps in order** — step 1 produces the URL step 3
needs, and step 6 produces the URL step 7 needs. Skipping ahead means going
back.

You need: a GitHub account with push access to this repo, a Google account,
and a LINE account.

---



## 1 · Turn on GitHub Pages

This has to be first: the LIFF app registration in step 3 asks for this URL.

1. Push this repo to GitHub if you haven't.
2. Repo → **Settings** → **Pages**.
3. Source **Deploy from a branch**, branch `main`, folder `/docs` → **Save**.
4. Wait ~1 minute, then copy the URL it shows:
  `https://<your-user>.github.io/sairahus2026/`

Open it. You'll see an error about LIFF — correct at this stage, the IDs aren't
filled in yet. You only need the URL.

> Keep this as `PAGES_URL`.

---



## 2 · Create the LINE provider and two channels

Go to the [LINE Developers Console](https://developers.line.biz/console/).

**Create one provider** (e.g. `Sairahus 2026`). A provider is just a folder
for channels.

> ⚠️ **The one mistake that is expensive to find later.** Both channels below
> must sit under this **same provider**. `userId` is scoped to the provider,
> not the channel — put them under different providers and the ID your
> registration form saves won't match the ID your webhook sees. Registration
> looks fine, matching produces garbage, and you find out on event day.

**Channel A — Messaging API** (the bot, rich menus, photo uploads)

1. Inside the provider → **Create a new channel** → **Messaging API**.
2. Fill in name, description, category. Region **Thailand**.
3. Open the channel → **Messaging API** tab → scroll to **Channel access
  token (long-lived)** → **Issue** → copy it.
  > Keep as `CHANNEL_TOKEN`. This is a password — never commit it.
4. Same tab, turn **Allow bot to join group chats** off (not needed).

**Channel B — LINE Login** (hosts the LIFF screens)

1. Same provider → **Create a new channel** → **LINE Login**.
2. App type: **Web app**.
3. **Basic settings** tab → copy the **Channel ID** (a number).
  > Keep as `LOGIN_CHANNEL_ID`.

**Turn off the OA's canned replies** — otherwise the bot answers every photo
with "Thanks for your message". At [LINE Official Account
Manager](https://manager.line.biz/) → your OA → **Settings** → **Response
settings**:


| Setting          | Set to  |
| ---------------- | ------- |
| Chat             | **On**  |
| Greeting message | **Off** |
| Auto-response    | **Off** |
| Webhook          | **On**  |


---



## 3 · Register the LIFF app

On the **LINE Login** channel → **LIFF** tab → **Add**:


| Field            | Value                                     |
| ---------------- | ----------------------------------------- |
| LIFF app name    | `Sairahus 2026`                           |
| Size             | **Full**                                  |
| Endpoint URL     | your `PAGES_URL` from step 1              |
| Scopes           | ✅ `profile` ✅ `openid` — **nothing else** |
| Bot link feature | **On (Aggressive)**                       |


Copy the **LIFF ID** it generates (looks like `2001234567-AbCdEfGh`).

> Keep as `LIFF_ID`.

Don't tick `email`. It adds a consent screen people bail on, needs channel
review, and returns their personal LINE address — not the university one the
form asks for.

**Bot link feature: On** means people who open a LIFF screen are offered the
OA to add. Without it, someone who gets a link but never adds the bot has no
rich menu and no way back in.

---



## 4 · Create the Sheet and paste the code

1. New Google Sheet at [sheets.new](https://sheets.new). Name it
  `Sairahus 2026 — data`.
2. **Extensions** → **Apps Script**. A new tab opens.
3. Delete the sample `myFunction` in `Code.gs`, paste in all of
  `apps-script/Code.gs` from this repo.
4. **+** next to *Files* → **Script** → name it `Match` → paste in all of
  `apps-script/Match.gs`.
5. 💾 Save.

**Run the one-time setup:**

1. In the function dropdown at the top, pick `setupSheets` → **Run**.
2. Google asks for authorization. You'll hit a scary screen:
  **Advanced** → **Go to  (unsafe)** → **Allow**.
   This is normal for a script you wrote yourself and haven't published.
3. Switch back to the Sheet. You should now have four tabs:
  `participants`, `submissions`, `hint_unlocks`, `config`.

If the tabs didn't appear, check **Executions** in the left sidebar for the
error.

---



## 5 · Store the secrets

Secrets go in Script Properties, **not** the Sheet — staff can read the Sheet.

In the Apps Script editor → ⚙️ **Project Settings** → scroll to **Script
Properties** → **Edit script properties** → add three:


| Property           | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| `CHANNEL_TOKEN`    | the long token from step 2, channel A                  |
| `LOGIN_CHANNEL_ID` | the numeric Channel ID from step 2, channel B          |
| `WEBHOOK_KEY`      | any long random string you invent, e.g. `k7fj2p9qzx4m` |


**Save script properties.**

`WEBHOOK_KEY` is explained in step 7.

---



## 6 · Deploy the web app

Apps Script editor → **Deploy** → **New deployment**:

1. ⚙️ next to *Select type* → **Web app**.
2. Description: `v1`.
3. **Execute as: Me**.
4. **Who has access: Anyone** ← must be *Anyone*, not *Anyone with a Google
  account*. Participants are not signing into Google.
5. **Deploy** → copy the **Web app URL**, ending in `/exec`.

> Keep as `EXEC_URL`.

> 🔁 **Every time you change the** `.gs` **files**, you must **Deploy → Manage
> deployments → ✏️ → Version: New version → Deploy**. Editing and saving alone
> changes nothing live. This trips up everyone at least once.
> Keep the same deployment so the URL stays stable.

---



## 7 · Point the bot's webhook at it

Back on the **Messaging API** channel → **Messaging API** tab → **Webhook
URL** → **Edit**. Enter your `EXEC_URL` with the key appended:

```
https://script.google.com/macros/s/AKfy.../exec?k=YOUR_WEBHOOK_KEY
```

Turn **Use webhook** on.

**Verify** will fail or show a redirect warning — that's expected, Apps Script
answers with a 302. The real test is step 12.

Why a key in the URL instead of a signature check

LINE signs every webhook with an `x-line-signature` header. Apps Script cannot
read request headers, so that check is impossible here. The secret in the query
string is the substitute: anyone who doesn't know it can't post fake events.
Marked `ponytail:` in `Code.gs` — the fix is moving off Apps Script, worth it
only if this ever handles something worth forging.



---



## 8 · Wire up the page

1. Open `docs/index.html`, edit the two constants at the top of the `<script>`:

```js
const LIFF_ID = '2001234567-AbCdEfGh';                          // from step 3
const API = 'https://script.google.com/macros/s/AKfy.../exec';  // from step 6, NO ?k=
```

> The page uses the plain `/exec` URL. The `?k=` key is only for the bot
> webhook — putting it here would publish your secret in a public repo.

1. Commit and push. Pages redeploys in ~1 minute.
2. Open `PAGES_URL` in a normal browser. Expect **"Something went wrong"** — LIFF
  only fully initialises inside LINE. No blank page and no `PASTE_...` text
   means the constants took.

---



## 9 · Create the photo folder

1. New folder in Google Drive, e.g. `Sairahus 2026 — quest photos`.
2. Open it and copy the ID out of the URL:
  `https://drive.google.com/drive/folders/1AbC…XyZ`
3. In the Sheet's `config` tab, set `DRIVE_FOLDER_ID` to that ID.

Quest photos land here. Each is set link-viewable so the staff review screen
can show thumbnails.

---



## 10 · Register yourself and become a lead

`LEAD_IDS` needs LINE userIds, and the only place to get one is a registration
record. So register first.

1. Add your OA as a friend — **Messaging API** tab → scan the QR code.
2. Open this in **LINE's own chat** (send it to yourself, then tap it):
  `https://liff.line.me/<LIFF_ID>?p=register`
3. Fill in the form as a `senior` and submit.
4. Open the Sheet → `participants` tab → your row is there. Copy your
  `lineUserId` (starts with `U`).
5. In the `config` tab, paste it into `LEAD_IDS`. For several leads,
  comma-separate with no spaces:
   `U1a2b3...,U9z8y7...`
6. Anyone who should review quests but not change phases: set their `role`
  cell to `staff` in `participants`.


| Role                | Can do                                                 |
| ------------------- | ------------------------------------------------------ |
| `junior` / `senior` | their own screens                                      |
| `staff`             | review quest photos, see stats                         |
| in `LEAD_IDS`       | the above, plus change phase and run the 13:30 cut-off |


Keep `LEAD_IDS` to 2–3 people. A mis-tapped phase change during the hunt is
disruptive.

---



## 11 · Build the rich menus

The rich menu is the entire UI. Four menus, one per audience.

**Design them** in [LINE OA Manager](https://manager.line.biz/) → **Rich
menus** → **Create**. For every tile pick action type **Link**, and use:

```
https://liff.line.me/<LIFF_ID>?p=<screen>
```


| Menu                           | Tiles (`?p=`)                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Guest** (not yet registered) | Register → `register`                                                                             |
| **Junior**                     | Magic Pocket → `wallet` · Submit quest → `quest` · Check in → `checkin` · My details → `register` |
| **Senior**                     | My hints → `hint` · Check in → `checkin` · My juniors → `wallet` · My details → `register`        |
| **Staff**                      | Staff → `staff` · Check in → `checkin` · Magic Pocket → `wallet`                                  |


Set the **Guest** menu as the **default** so new followers get it
automatically. Set every menu's display period to cover the event.

**Then collect the four IDs.** OA Manager doesn't show them, so ask the API
once — paste into a terminal with your `CHANNEL_TOKEN`:

```sh
curl -s -H "Authorization: Bearer $CHANNEL_TOKEN" \
  https://api.line.me/v2/bot/richmenu/list \
  | grep -o '"richMenuId":"[^"]*"\|"name":"[^"]*"'
```

Match each name to its `richmenu-…` id, then fill in the `config` tab:
`RICHMENU_GUEST`, `RICHMENU_JUNIOR`, `RICHMENU_SENIOR`, `RICHMENU_STAFF`.

The bot swaps a user's menu automatically when they register.

---



## 12 · Fill in the rest of `config`, then smoke-test

In the `config` tab:


| Key                              | Set to                                                         |
| -------------------------------- | -------------------------------------------------------------- |
| `PHASE`                          | `REGISTER`                                                     |
| `CHECKIN_CODE`                   | any 4 digits — the number on the door sign                     |
| `EMAIL_DOMAIN`                   | accepted student email domains: `student.mahidol.ac.th, student.mahidol.edu`. Comma, semicolon, pipe or space all separate. Leave blank to accept any domain. |
| `QUEST_R1` `QUEST_R2` `QUEST_R3` | 3 quest titles each, separated by `|`                          |


**Now walk the whole flow yourself, in this order.** Every step should work
before you tell 200 people to register.

- [ ] **Register a second test account as a** `junior` in the same Baan as
  ```
  your senior account. Check both rows appear in `participants`.
  ```
- [ ] Rich menu changed by itself after registering.
- [ ] Set `PHASE` to `QUEST_R1` on the staff screen. As the junior: menu →
  ```
  quest → pick one → return to chat → **send a photo**. Bot confirms.
  ```
- [ ] New row in `submissions`, photo in the Drive folder.
- [ ] Staff screen → **Review quests** → the photo shows → tap **Pass**.
- [ ] Junior's wallet now reads **1 coin**.
- [ ] `PHASE` → `CHECKIN`. Junior checks in with the code. A wrong code is
  ```
  rejected.
  ```
- [ ] Apps Script editor → run `test_match()` → log says
  ```
  `all match tests passed`.
  ```
- [ ] Run `runMatch()` → junior's row gets a `seniorId` and a `village`.
- [ ] `PHASE` → `HUNT`. Junior's wallet unlocks hint 1 and the coin is spent.
- [ ] `PHASE` → `REVEAL`. Hint 4 opens free.
- [ ] **Clear the test rows** from `participants`, `submissions`, and
  ```
  `hint_unlocks` — leave the header row. Set `PHASE` back to `REGISTER`.
  ```

Working through all of it? You're ready to open registration.

---



## Troubleshooting


| Symptom                               | Cause                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Screen shows `Please sign in again`   | `LOGIN_CHANNEL_ID` wrong, or it belongs to a channel under a different provider |
| Bot silent on photos                  | Webhook URL missing `?k=`, `WEBHOOK_KEY` mismatched, or Use webhook off         |
| Bot replies "Thanks for your message" | Auto-response still on in OA Manager (step 2)                                   |
| Code edits have no effect             | Didn't redeploy as a **new version** (step 6)                                   |
| Valid university email rejected       | Read the error text — it lists the domains the server actually parsed from `EMAIL_DOMAIN`. If that list looks wrong, fix the cell. `setupSheets()` never overwrites an existing key, so a seeded default must be edited by hand. |
| Staff screen says "for staff only"    | userId not in `LEAD_IDS`, or `role` isn't `staff`                               |
| Quest photo won't display for review  | `DRIVE_FOLDER_ID` empty or wrong                                                |
| Everyone paired to nobody             | `runMatch()` never ran, or no seniors registered in that house                  |
| `System is busy`                      | Genuine concurrent load; it resolves on retry                                   |


Failed runs are logged: Apps Script editor → **Executions** in the left
sidebar. That's the first place to look for anything unexplained.

---



# Running the event


| When                  | Do                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration opens    | `PHASE` = `REGISTER`. Share the OA QR code.                                                                                                                                                             |
| During quest week     | `PHASE` = `QUEST_R1` → `R2` → `R3`. Watch the staff screen's **Seniors with no hints written** list and nag them.                                                                                       |
| Registration closes   | Run `test_match()`, then `runMatch()` from the editor. Read the log: `overflow` and `shortHouses` are houses with too few seniors. **Fix that now, not on the day** — recruit extra seniors and re-run. |
| Event day, doors open | `PHASE` = `CHECKIN`. Put `CHECKIN_CODE` on the sign.                                                                                                                                                    |
| Morning of            | Remind seniors to refresh any hint that has gone stale (what they're wearing, where they'll stand) via the **My hints** menu tile.                                                                       |
| Hunt starts           | `PHASE` = `HUNT`. Hints 1–3 unlock.                                                                                                                                                                     |
| 13:30                 | **Cut-off & rematch** on the staff screen. Reassigns juniors whose senior never showed. Read the `stranded` count — those need a human.                                                                 |
| Reveal                | `PHASE` = `REVEAL`. Hint 4 goes free so nobody leaves without finding their senior.                                                                                                                     |


Change `PHASE` only from the staff screen. It's the single variable the whole
system reads.

**Someone who never added the OA:** add their row to `participants` by hand
(leave `lineUserId` blank), run `runMatch()`, and pair them off the sheet on
the day. Their email is the backup contact.

---



## Tests

`test_match()` in `Match.gs` — from the Apps Script editor, or locally:

```sh
node -e "eval(require('fs').readFileSync('apps-script/Match.gs','utf8')); test_match();"
```

Covers capacity limits, even load spread, short-house overflow, and cut-off
refusing to push a senior past capacity. Run it before `runMatch()` touches
real data.
/**
 * Sairahus 2026 — backend for the LINE bot and the LIFF screens.
 * Container-bound to the event Spreadsheet.
 *
 * Secrets  -> Script Properties (staff can read the Sheet, not the properties)
 * Settings -> `config` tab (staff change these during the event)
 */

const PHASES = ['REGISTER', 'QUEST_R1', 'QUEST_R2', 'QUEST_R3', 'CHECKIN', 'HUNT', 'REVEAL'];
const HINT_COST = { 1: 1, 2: 1, 3: 2, 4: 0 };
const YEARS = 4;    // years 1-4
const BAANS = 10;   // Baan 1-10

// Sheet values. Staff read these columns directly, so keep them readable.
const PASS = 'pass';
const FAIL = 'fail';
const OVERFLOW = 'overflow';   // junior with no senior in their Baan

const BRANCHES = ['ICT', 'DST'];

/**
 * Desired schema. Used by setupSheets() to create tabs and to add columns that
 * are missing from an existing tab — never to locate a column at write time.
 * The sheet's own header row is the authority for layout, so staff can reorder
 * columns and old sheets keep working after a schema change.
 */
const TABS = {
  participants: ['lineUserId', 'nickname', 'realName', 'studentId', 'email', 'branch', 'year',
                 'house', 'village', 'capacity', 'seniorId', 'pairStatus', 'checkedInAt', 'role',
                 'hint1', 'hint2', 'hint3', 'hint4'],
  submissions:  ['userId', 'round', 'questId', 'fileId', 'status', 'reviewerId', 'ts'],
  hint_unlocks: ['userId', 'level', 'ts'],
  config:       ['key', 'value'],
};

// ---------- sheet access ----------------------------------------------------

function tab(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

/**
 * Whole tab as objects. `_row` is the 1-based sheet row, for writes.
 *
 * Memoized per execution: a single `me` call used to read participants,
 * submissions and hint_unlocks twice each. Any write drops the cache, so
 * read-after-write still sees fresh data.
 */
let _rows = {};
function rows(name) {
  if (_rows[name]) return _rows[name];
  const v = tab(name).getDataRange().getValues();
  const head = v.shift();
  return _rows[name] = v.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((k, j) => o[k] = r[j]);
    return o;
  });
}

/**
 * The tab's real header row — the authority for where a column lives.
 * Reading layout from the sheet instead of TABS means adding a field, or a
 * staffer dragging a column, can't silently write into the wrong one.
 */
let _head = {};
function headers(name) {
  if (_head[name]) return _head[name];
  const sheet = tab(name);
  return _head[name] = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim());
}

function appendRow(name, obj) {
  tab(name).appendRow(headers(name).map(k => obj[k] === undefined ? '' : obj[k]));
  delete _rows[name];
}

/** Patch named columns on one row. Unknown column names are ignored. */
function updateRow(name, rowNum, patch) {
  const sheet = tab(name);
  const head = headers(name);
  Object.keys(patch).forEach(k => {
    const col = head.indexOf(k) + 1;
    if (col > 0) sheet.getRange(rowNum, col).setValue(patch[k]);
  });
  delete _rows[name];
}

function prop(key) { return PropertiesService.getScriptProperties().getProperty(key); }

let _cfg = null;
function cfg(key) {
  if (!_cfg) {
    _cfg = {};
    tab('config').getDataRange().getValues().forEach(([k, v]) => _cfg[k] = v);
  }
  return _cfg[key];
}

function setCfg(key, value) {
  const found = rows('config').find(r => r.key === key);
  if (found) updateRow('config', found._row, { value: value });
  else appendRow('config', { key: key, value: value });
  _cfg = null;
}

// ponytail: linear scan of ~400 rows. Fine to ~2000; index by userId if it ever drags.
function findUser(uid) { return rows('participants').find(p => p.lineUserId === uid); }

function phaseAtLeast(p) { return PHASES.indexOf(cfg('PHASE')) >= PHASES.indexOf(p); }

// ---------- entry points ----------------------------------------------------

function doGet() { return ContentService.createTextOutput('ok'); }

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  // LINE webhook. Apps Script cannot read request headers, so the x-line-signature
  // check is impossible here.
  // ponytail: secret in the webhook URL instead. Move to a real server if the
  // event ever handles anything worth forging.
  if (body.events) {
    if (e.parameter.k !== prop('WEBHOOK_KEY')) return json({ ok: false });
    body.events.forEach(ev => {
      try { onEvent(ev); } catch (err) { console.error(err.stack || err); }
    });
    return json({ ok: true });
  }

  return json(api(body));
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- LIFF API --------------------------------------------------------

const WRITE_ACTIONS = ['register', 'saveHints', 'pickQuest', 'unlockHint', 'checkin',
                       'review', 'setPhase', 'cutoff'];

function api(body) {
  const uid = verifyIdToken(body.idToken);
  if (!uid) return { error: 'auth', message: 'Please sign in again.' };

  const fn = ACTIONS[body.action];
  if (!fn) return { error: 'unknown_action' };

  if (WRITE_ACTIONS.indexOf(body.action) < 0) return fn(uid, body);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { error: 'busy', message: 'System is busy — please try again.' };
  try { return fn(uid, body); } finally { lock.releaseLock(); }
}

/**
 * The only userId we ever trust. A POSTed one can be edited in devtools.
 *
 * Successful verifications are cached for 10 min keyed by a digest of the token
 * itself, which saves a round trip to api.line.me on every tap. Safe: the token
 * is signed, so the same token always maps to the same user. Failures are never
 * cached.
 */
function verifyIdToken(idToken) {
  if (!idToken) return null;

  const cache = CacheService.getScriptCache();
  const key = 'idt_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get(key);
  if (hit) return hit;

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop('LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;

  const sub = JSON.parse(res.getContentText()).sub;
  if (sub) cache.put(key, sub, 600);
  return sub;
}

// ---------- actions ---------------------------------------------------------

const ACTIONS = {

  /** Everything a screen needs to render itself. */
  me: function (uid) {
    const p = findUser(uid);
    const out = { phase: cfg('PHASE'), registered: !!p };
    if (!p) return out;

    out.role = p.role;
    out.nickname = p.nickname;
    out.house = p.house;
    out.village = p.village;
    out.checkedIn = !!p.checkedInAt;

    if (p.role === 'senior') {
      out.hints = [p.hint1, p.hint2, p.hint3, p.hint4];
      out.capacity = p.capacity;
      out.juniorCount = rows('participants').filter(x => x.seniorId === uid).length;
      return out;
    }

    out.balance = balance(uid);
    out.pairStatus = p.pairStatus;
    out.hints = hintState(uid, p);
    out.round = currentRound();
    out.quests = out.round ? quests(out.round) : [];
    out.submitted = rows('submissions')
      .filter(s => s.userId === uid && Number(s.round) === out.round && s.status !== FAIL)
      .map(s => s.questId);
    return out;
  },

  register: function (uid, b) {
    const err = validateRegistration(b);
    if (err) return { error: 'invalid', message: err };

    const existing = findUser(uid);
    const row = {
      lineUserId: uid,
      nickname: b.nickname.trim(),
      realName: b.realName.trim(),
      studentId: String(b.studentId).trim(),
      email: b.email.trim().toLowerCase(),
      branch: String(b.branch).trim().toUpperCase(),
      year: Number(b.year),
      house: Number(b.house),
      role: b.role,
      capacity: b.role === 'senior' ? Number(b.capacity) : '',
      hint1: b.role === 'senior' ? (b.hint1 || '').trim() : '',
      hint2: b.role === 'senior' ? (b.hint2 || '').trim() : '',
      hint3: b.role === 'senior' ? (b.hint3 || '').trim() : '',
      hint4: b.role === 'senior' ? (b.hint4 || '').trim() : '',
    };

    if (existing) updateRow('participants', existing._row, row);
    else appendRow('participants', row);

    linkRichMenu(uid, b.role === 'senior' ? cfg('RICHMENU_SENIOR') : cfg('RICHMENU_JUNIOR'));
    return { ok: true };
  },

  /** Seniors rewrite their hints — mainly hint 3 on the morning of the event. */
  saveHints: function (uid, b) {
    const p = findUser(uid);
    if (!p || p.role !== 'senior') return { error: 'not_senior' };
    const blank = missingHint(b);
    if (blank) return { error: 'invalid', message: 'Hint ' + blank + ' cannot be empty.' };
    updateRow('participants', p._row, {
      hint1: b.hint1.trim(), hint2: (b.hint2 || '').trim(),
      hint3: (b.hint3 || '').trim(), hint4: (b.hint4 || '').trim(),
    });
    return { ok: true };
  },

  /** Remember which quest the next uploaded photo belongs to. */
  pickQuest: function (uid, b) {
    const round = Number(b.round);
    if (!phaseAtLeast('QUEST_R' + round)) return { error: 'phase', message: 'This round is not open yet.' };
    if (quests(round).indexOf(b.questId) < 0) return { error: 'invalid' };

    const done = rows('submissions').filter(s =>
      s.userId === uid && Number(s.round) === round && s.questId === b.questId && s.status !== FAIL);
    if (done.length) return { error: 'duplicate', message: 'You already submitted this quest.' };

    PropertiesService.getScriptProperties()
      .setProperty('pending_' + uid, JSON.stringify({ round: round, questId: b.questId }));
    return { ok: true };
  },

  unlockHint: function (uid, b) {
    const level = Number(b.level);
    if (!HINT_COST.hasOwnProperty(level)) return { error: 'invalid' };
    if (level === 4 ? !phaseAtLeast('REVEAL') : !phaseAtLeast('HUNT')) {
      return { error: 'phase', message: 'This hint is not available yet.' };
    }

    const me = findUser(uid);
    if (!me || me.role !== 'junior') return { error: 'not_junior' };
    if (!me.seniorId) return { error: 'no_pair', message: 'You have no senior assigned yet — talk to a staff member.' };

    const already = rows('hint_unlocks').find(h => h.userId === uid && Number(h.level) === level);
    const text = String(findUser(me.seniorId)['hint' + level] || '').trim();

    if (already) return { ok: true, level: level, text: text };   // idempotent, no charge

    // Never charge for an empty hint.
    if (!text) return { error: 'blank', message: 'Your senior has not written this hint yet. No coins were taken.' };

    const cost = HINT_COST[level];
    if (balance(uid) < cost) return { error: 'coins', message: 'Not enough dorayaki coins.' };

    appendRow('hint_unlocks', { userId: uid, level: level, ts: new Date() });
    return { ok: true, level: level, text: text };
  },

  checkin: function (uid, b) {
    if (!phaseAtLeast('CHECKIN')) return { error: 'phase', message: 'Check-in is not open yet.' };
    const p = findUser(uid);
    if (!p) return { error: 'not_registered' };
    if (p.checkedInAt) return { ok: true, already: true };
    // ponytail: no brute-force lock on the 4-digit code. Worst case is marking
    // yourself present, not a security boundary. Add attempt counting if it matters.
    if (String(b.code || '').trim() !== String(cfg('CHECKIN_CODE')).trim()) {
      return { error: 'code', message: 'Wrong code.' };
    }
    updateRow('participants', p._row, { checkedInAt: new Date() });
    return { ok: true };
  },

  // ---- staff -----

  pending: function (uid) {
    if (!isStaff(uid)) return { error: 'forbidden' };
    const names = {};
    rows('participants').forEach(p => names[p.lineUserId] = p.nickname + ' (Baan ' + p.house + ')');
    return {
      items: rows('submissions').filter(s => !s.status).slice(0, 40).map(s => ({
        row: s._row,
        who: names[s.userId] || s.userId,
        round: s.round,
        questId: s.questId,
        img: 'https://drive.google.com/thumbnail?id=' + s.fileId + '&sz=w600',
      })),
    };
  },

  review: function (uid, b) {
    if (!isStaff(uid)) return { error: 'forbidden' };
    const s = rows('submissions').find(x => x._row === Number(b.row));
    if (!s) return { error: 'invalid' };
    if (s.status) return { ok: true, already: true };   // first tap wins
    updateRow('submissions', s._row, {
      status: b.pass ? PASS : FAIL, reviewerId: uid, ts: new Date(),
    });
    return { ok: true };
  },

  stats: function (uid) {
    if (!isStaff(uid)) return { error: 'forbidden' };
    const p = rows('participants');
    const juniors = p.filter(x => x.role === 'junior');
    const seniors = p.filter(x => x.role === 'senior');
    return {
      phase: cfg('PHASE'),
      isLead: isLead(uid),
      checkinCode: cfg('CHECKIN_CODE'),
      juniors: juniors.length,
      seniors: seniors.length,
      checkedInJuniors: juniors.filter(x => x.checkedInAt).length,
      checkedInSeniors: seniors.filter(x => x.checkedInAt).length,
      unpaired: juniors.filter(x => !x.seniorId).length,
      pendingReviews: rows('submissions').filter(x => !x.status).length,
      // Anyone missing ANY hint — records created before all four became
      // required, or a cell a staffer cleared by hand.
      noHints: seniors.filter(x => missingHint(x))
                      .map(x => x.nickname + ' (Baan ' + x.house + ', missing hint ' +
                                missingHint(x) + ')'),
    };
  },

  setPhase: function (uid, b) {
    if (!isLead(uid)) return { error: 'forbidden' };
    if (PHASES.indexOf(b.phase) < 0) return { error: 'invalid' };
    setCfg('PHASE', b.phase);
    return { ok: true, phase: b.phase };
  },

  cutoff: function (uid) {
    if (!isLead(uid)) return { error: 'forbidden' };
    return runCutoff();
  },
};

// ---------- domain helpers --------------------------------------------------

function balance(uid) {
  const earned = rows('submissions').filter(s => s.userId === uid && s.status === PASS).length;
  const spent = rows('hint_unlocks').filter(h => h.userId === uid)
    .reduce((sum, h) => sum + (HINT_COST[Number(h.level)] || 0), 0);
  return earned - spent;
}

/** What the wallet screen shows: locked levels carry no text. */
function hintState(uid, junior) {
  const unlocked = {};
  rows('hint_unlocks').filter(h => h.userId === uid).forEach(h => unlocked[Number(h.level)] = true);
  const senior = junior.seniorId ? findUser(junior.seniorId) : null;

  return [1, 2, 3, 4].map(level => ({
    level: level,
    cost: HINT_COST[level],
    unlocked: !!unlocked[level],
    available: level === 4 ? phaseAtLeast('REVEAL') : phaseAtLeast('HUNT'),
    written: !!(senior && String(senior['hint' + level] || '').trim()),
    text: unlocked[level] && senior ? String(senior['hint' + level] || '') : '',
  }));
}

/**
 * Accepted student email domains from the `EMAIL_DOMAIN` config cell.
 * Empty list = accept any domain.
 *
 * Deliberately forgiving about how the cell is written, because the same config
 * sheet uses commas for LEAD_IDS and pipes for QUEST_R*: any of `, ; |` or
 * whitespace separates, and each entry may be written as `example.com`,
 * `@example.com`, or even a whole address like `me@example.com`.
 */
function allowedDomains() {
  // Both spellings accepted: a typo'd key would otherwise fail open and let
  // every domain through, which is the wrong way for this check to break.
  return String(cfg('EMAIL_DOMAIN') || cfg('EMAIL_DOMAINS') || '').toLowerCase()
    .split(/[\s,;|]+/)
    .map(d => d.trim().replace(/^.*@/, ''))
    .filter(String);
}

/** First hint level (1-4) that is blank on a record, or 0 if all four are filled. */
function missingHint(rec) {
  for (let i = 1; i <= 4; i++) if (!String(rec['hint' + i] || '').trim()) return i;
  return 0;
}

function quests(round) { return String(cfg('QUEST_R' + round) || '').split('|').filter(String); }

/** 1-3 while a quest phase is open, 0 otherwise. */
function currentRound() {
  const m = /^QUEST_R(\d)$/.exec(cfg('PHASE'));
  return m ? Number(m[1]) : 0;
}

function isStaff(uid) {
  const p = findUser(uid);
  return (p && p.role === 'staff') || isLead(uid);
}

function isLead(uid) {
  return String(cfg('LEAD_IDS') || '').split(',').map(s => s.trim()).indexOf(uid) >= 0;
}

// ---------- LINE webhook ----------------------------------------------------

function onEvent(ev) {
  if (ev.type === 'follow') {
    linkRichMenu(ev.source.userId, cfg('RICHMENU_GUEST'));
    return reply(ev.replyToken, 'Welcome to Sairahus 2026 🔵\nTap "Register" in the menu below to get started.');
  }

  if (ev.type === 'message' && ev.message.type === 'image') return onQuestPhoto(ev);

  if (ev.type === 'message' && ev.message.type === 'text') {
    return reply(ev.replyToken, 'Use the menu below. If something is wrong, message a staff member.');
  }
}

function onQuestPhoto(ev) {
  const uid = ev.source.userId;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('pending_' + uid);
  if (!raw) {
    return reply(ev.replyToken, 'Tap "Submit quest" in the menu and pick a quest first, then send the photo.');
  }

  const pick = JSON.parse(raw);
  const fileId = saveImage(ev.message.id);
  appendRow('submissions', {
    userId: uid, round: pick.round, questId: pick.questId, fileId: fileId, status: '', ts: new Date(),
  });
  props.deleteProperty('pending_' + uid);

  // No push when staff approve later — juniors pull their balance from the wallet
  // screen. 200 juniors x 3 rounds of pushes would blow the free message quota.
  reply(ev.replyToken, 'Got your photo for "' + pick.questId + '". Waiting for staff review.\n' +
    'Check your coins in the "Magic Pocket" menu.');
}

function saveImage(messageId) {
  const blob = UrlFetchApp.fetch(
    'https://api-data.line.me/v2/bot/message/' + messageId + '/content',
    { headers: { Authorization: 'Bearer ' + prop('CHANNEL_TOKEN') } }
  ).getBlob().setName(messageId + '.jpg');

  const file = DriveApp.getFolderById(cfg('DRIVE_FOLDER_ID')).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

function reply(token, text) {
  lineApi('https://api.line.me/v2/bot/message/reply',
    { replyToken: token, messages: [{ type: 'text', text: text }] });
}

function linkRichMenu(uid, menuId) {
  if (!menuId) return;
  lineApi('https://api.line.me/v2/bot/user/' + uid + '/richmenu/' + menuId, null, 'post');
}

function lineApi(url, payload, method) {
  const opts = {
    method: method || 'post',
    headers: { Authorization: 'Bearer ' + prop('CHANNEL_TOKEN') },
    muteHttpExceptions: true,
  };
  if (payload) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch(url, opts);
  if (res.getResponseCode() >= 300) console.error(url + ' -> ' + res.getContentText());
}

// ---------- validation ------------------------------------------------------

function validateRegistration(b) {
  if (!phaseAtLeast('REGISTER') || phaseAtLeast('CHECKIN')) return 'Registration is closed.';
  if (['junior', 'senior'].indexOf(b.role) < 0) return 'Pick junior or senior.';
  if (!b.nickname || !b.nickname.trim()) return 'Nickname is required.';
  if (!b.realName || !b.realName.trim()) return 'Full name is required.';
  if (!/^\d{7,12}$/.test(String(b.studentId || '').trim())) return 'Student ID must be 7-12 digits.';

  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'That email address is not valid.';
  const domains = allowedDomains();
  if (domains.length && domains.indexOf(email.slice(email.lastIndexOf('@') + 1)) < 0) {
    return 'Use your university email (' + domains.map(d => '@' + d).join(' or ') + ') only.';
  }

  if (BRANCHES.indexOf(String(b.branch || '').trim().toUpperCase()) < 0) {
    return 'Pick your branch (' + BRANCHES.join(' or ') + ').';
  }

  const house = Number(b.house);
  if (!(house >= 1 && house <= BAANS)) return 'Pick a Baan from 1-' + BAANS + '.';
  if (!(Number(b.year) >= 1 && Number(b.year) <= YEARS)) return 'Pick a year from 1-' + YEARS + '.';

  if (b.role === 'senior') {
    const cap = Number(b.capacity);
    if (!(cap >= 1 && cap <= 5)) return 'Capacity must be 1-5 juniors.';
    const blank = missingHint(b);
    if (blank) return 'Hint ' + blank + ' cannot be empty.';
  }
  return null;
}

// ---------- one-time setup --------------------------------------------------

/**
 * Run from the editor to create the tabs and seed `config`.
 * Safe to re-run: it adds columns the schema has gained without touching
 * existing data, and never overwrites a config key that already has a value.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActive();
  const added = {};

  Object.keys(TABS).forEach(name => {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) { sheet.appendRow(TABS[name]); return; }

    // Existing tab: append any missing columns to the right so every current
    // column index stays valid.
    const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h).trim());
    const missing = TABS[name].filter(c => head.indexOf(c) < 0);
    if (missing.length) {
      sheet.getRange(1, head.length + 1, 1, missing.length).setValues([missing]);
      added[name] = missing;
    }
  });

  _head = {}; _rows = {};   // layout changed under us
  if (Object.keys(added).length) console.log('Added columns: ' + JSON.stringify(added));

  [['PHASE', 'REGISTER'], ['CHECKIN_CODE', '4126'],
   ['EMAIL_DOMAIN', 'student.mahidol.ac.th, student.mahidol.edu'],
   ['LEAD_IDS', ''], ['DRIVE_FOLDER_ID', ''], ['RICHMENU_GUEST', ''], ['RICHMENU_JUNIOR', ''],
   ['RICHMENU_SENIOR', ''], ['RICHMENU_STAFF', ''],
   ['QUEST_R1', 'Photo with a new friend|Photo at the faculty sign|Photo of your favourite thing'],
   ['QUEST_R2', 'Group photo with your Baan|Photo with a staff member|Photo doing a Doraemon pose'],
   ['QUEST_R3', 'Photo with the souvenir|Team photo|Photo of your favourite spot on campus'],
  ].forEach(([k, v]) => { if (cfg(k) === undefined) setCfg(k, v); });
}

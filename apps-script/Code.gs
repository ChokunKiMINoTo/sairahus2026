/**
 * สายรหัส 2026 — backend for the LINE bot and the LIFF screens.
 * Container-bound to the event Spreadsheet.
 *
 * Secrets  -> Script Properties (staff can read the Sheet, not the properties)
 * Settings -> `config` tab (staff change these during the event)
 */

const PHASES = ['REGISTER', 'QUEST_R1', 'QUEST_R2', 'QUEST_R3', 'CHECKIN', 'HUNT', 'REVEAL'];
const HINT_COST = { 1: 1, 2: 1, 3: 2, 4: 0 };
const HINT_MIN = 15;

const TABS = {
  participants: ['lineUserId', 'nickname', 'realName', 'studentId', 'email', 'year', 'house',
                 'village', 'capacity', 'seniorId', 'pairStatus', 'checkedInAt', 'role',
                 'hint1', 'hint2', 'hint3', 'hint4'],
  submissions:  ['userId', 'round', 'questId', 'fileId', 'status', 'reviewerId', 'ts'],
  hint_unlocks: ['userId', 'level', 'ts'],
  config:       ['key', 'value'],
};

// ---------- sheet access ----------------------------------------------------

function tab(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

/** Whole tab as objects. `_row` is the 1-based sheet row, for writes. */
function rows(name) {
  const v = tab(name).getDataRange().getValues();
  const head = v.shift();
  return v.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((k, j) => o[k] = r[j]);
    return o;
  });
}

function appendRow(name, obj) {
  tab(name).appendRow(TABS[name].map(k => obj[k] === undefined ? '' : obj[k]));
}

/** Patch named columns on one row. */
function updateRow(name, rowNum, patch) {
  const sheet = tab(name);
  Object.keys(patch).forEach(k => {
    const col = TABS[name].indexOf(k) + 1;
    if (col > 0) sheet.getRange(rowNum, col).setValue(patch[k]);
  });
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
  if (!uid) return { error: 'auth', message: 'เข้าสู่ระบบใหม่อีกครั้ง' };

  const fn = ACTIONS[body.action];
  if (!fn) return { error: 'unknown_action' };

  if (WRITE_ACTIONS.indexOf(body.action) < 0) return fn(uid, body);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { error: 'busy', message: 'ระบบกำลังหนาแน่น ลองใหม่อีกครั้ง' };
  try { return fn(uid, body); } finally { lock.releaseLock(); }
}

/** The only userId we ever trust. A POSTed one can be edited in devtools. */
function verifyIdToken(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop('LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  return JSON.parse(res.getContentText()).sub;
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
      .filter(s => s.userId === uid && Number(s.round) === out.round && s.status !== 'ไม่ผ่าน')
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
    if (!b.hint1 || b.hint1.trim().length < HINT_MIN) {
      return { error: 'invalid', message: 'ใบ้ข้อ 1 ต้องยาวอย่างน้อย ' + HINT_MIN + ' ตัวอักษร' };
    }
    updateRow('participants', p._row, {
      hint1: b.hint1.trim(), hint2: (b.hint2 || '').trim(),
      hint3: (b.hint3 || '').trim(), hint4: (b.hint4 || '').trim(),
    });
    return { ok: true };
  },

  /** Remember which quest the next uploaded photo belongs to. */
  pickQuest: function (uid, b) {
    const round = Number(b.round);
    if (!phaseAtLeast('QUEST_R' + round)) return { error: 'phase', message: 'ยังไม่เปิดรอบนี้' };
    if (quests(round).indexOf(b.questId) < 0) return { error: 'invalid' };

    const done = rows('submissions').filter(s =>
      s.userId === uid && Number(s.round) === round && s.questId === b.questId && s.status !== 'ไม่ผ่าน');
    if (done.length) return { error: 'duplicate', message: 'ภารกิจนี้ส่งไปแล้ว' };

    PropertiesService.getScriptProperties()
      .setProperty('pending_' + uid, JSON.stringify({ round: round, questId: b.questId }));
    return { ok: true };
  },

  unlockHint: function (uid, b) {
    const level = Number(b.level);
    if (!HINT_COST.hasOwnProperty(level)) return { error: 'invalid' };
    if (level === 4 ? !phaseAtLeast('REVEAL') : !phaseAtLeast('HUNT')) {
      return { error: 'phase', message: 'ยังไม่ถึงเวลาเปิดใบ้ข้อนี้' };
    }

    const me = findUser(uid);
    if (!me || me.role !== 'junior') return { error: 'not_junior' };
    if (!me.seniorId) return { error: 'no_pair', message: 'ยังไม่ได้จับคู่ ติดต่อสตาฟ' };

    const already = rows('hint_unlocks').find(h => h.userId === uid && Number(h.level) === level);
    const text = String(findUser(me.seniorId)['hint' + level] || '').trim();

    if (already) return { ok: true, level: level, text: text };   // idempotent, no charge

    // Never charge for an empty hint.
    if (!text) return { error: 'blank', message: 'พี่ยังไม่ได้เขียนใบ้ข้อนี้ ยังไม่ถูกหักเหรียญ' };

    const cost = HINT_COST[level];
    if (balance(uid) < cost) return { error: 'coins', message: 'เหรียญโดรายากิไม่พอ' };

    appendRow('hint_unlocks', { userId: uid, level: level, ts: new Date() });
    return { ok: true, level: level, text: text };
  },

  checkin: function (uid, b) {
    if (!phaseAtLeast('CHECKIN')) return { error: 'phase', message: 'ยังไม่เปิดเช็คอิน' };
    const p = findUser(uid);
    if (!p) return { error: 'not_registered' };
    if (p.checkedInAt) return { ok: true, already: true };
    // ponytail: no brute-force lock on the 4-digit code. Worst case is marking
    // yourself present, not a security boundary. Add attempt counting if it matters.
    if (String(b.code || '').trim() !== String(cfg('CHECKIN_CODE')).trim()) {
      return { error: 'code', message: 'รหัสไม่ถูกต้อง' };
    }
    updateRow('participants', p._row, { checkedInAt: new Date() });
    return { ok: true };
  },

  // ---- staff -----

  pending: function (uid) {
    if (!isStaff(uid)) return { error: 'forbidden' };
    const names = {};
    rows('participants').forEach(p => names[p.lineUserId] = p.nickname + ' (บ้าน ' + p.house + ')');
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
      status: b.pass ? 'ผ่าน' : 'ไม่ผ่าน', reviewerId: uid, ts: new Date(),
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
      noHints: seniors.filter(x => !String(x.hint1 || '').trim())
                      .map(x => x.nickname + ' (บ้าน ' + x.house + ')'),
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
  const earned = rows('submissions').filter(s => s.userId === uid && s.status === 'ผ่าน').length;
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
    return reply(ev.replyToken, 'ยินดีต้อนรับสู่ สายรหัส 2026 🔵\nกดเมนู "สมัคร" ด้านล่างเพื่อเริ่มเลย');
  }

  if (ev.type === 'message' && ev.message.type === 'image') return onQuestPhoto(ev);

  if (ev.type === 'message' && ev.message.type === 'text') {
    return reply(ev.replyToken, 'ใช้เมนูด้านล่างได้เลย ถ้าติดปัญหาทักสตาฟได้');
  }
}

function onQuestPhoto(ev) {
  const uid = ev.source.userId;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('pending_' + uid);
  if (!raw) {
    return reply(ev.replyToken, 'กดเมนู "ส่งภารกิจ" เลือกภารกิจก่อน แล้วค่อยส่งรูปนะ');
  }

  const pick = JSON.parse(raw);
  const fileId = saveImage(ev.message.id);
  appendRow('submissions', {
    userId: uid, round: pick.round, questId: pick.questId, fileId: fileId, status: '', ts: new Date(),
  });
  props.deleteProperty('pending_' + uid);

  // No push when staff approve later — juniors pull their balance from the wallet
  // screen. 200 juniors x 3 rounds of pushes would blow the free message quota.
  reply(ev.replyToken, 'รับภารกิจ "' + pick.questId + '" แล้ว รอสตาฟตรวจ\n' +
    'ดูเหรียญได้ที่เมนู "กระเป๋าวิเศษ"');
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
  if (!phaseAtLeast('REGISTER') || phaseAtLeast('CHECKIN')) return 'ปิดรับสมัครแล้ว';
  if (['junior', 'senior'].indexOf(b.role) < 0) return 'เลือกสถานะไม่ถูกต้อง';
  if (!b.nickname || !b.nickname.trim()) return 'กรอกชื่อเล่น';
  if (!b.realName || !b.realName.trim()) return 'กรอกชื่อ-นามสกุล';
  if (!/^\d{7,12}$/.test(String(b.studentId || '').trim())) return 'รหัสนักศึกษาไม่ถูกต้อง';

  const domain = String(cfg('EMAIL_DOMAIN') || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'อีเมลไม่ถูกต้อง';
  if (domain && email.slice(-domain.length - 1) !== '@' + domain) {
    return 'ใช้อีเมลมหาวิทยาลัย (@' + domain + ') เท่านั้น';
  }

  const house = Number(b.house);
  if (!(house >= 1 && house <= 20)) return 'เลือกบ้านย่อย 1-20';
  if (!(Number(b.year) >= 1 && Number(b.year) <= 8)) return 'เลือกชั้นปี';

  if (b.role === 'senior') {
    const cap = Number(b.capacity);
    if (!(cap >= 1 && cap <= 5)) return 'รับน้องได้ 1-5 คน';
    if (!b.hint1 || b.hint1.trim().length < HINT_MIN) {
      return 'ใบ้ข้อ 1 ต้องยาวอย่างน้อย ' + HINT_MIN + ' ตัวอักษร';
    }
  }
  return null;
}

// ---------- one-time setup --------------------------------------------------

/** Run once from the editor to create the tabs and seed `config`. */
function setupSheets() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(name => {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(TABS[name]);
  });
  [['PHASE', 'REGISTER'], ['CHECKIN_CODE', '4126'], ['EMAIL_DOMAIN', 'student.mahidol.ac.th'],
   ['LEAD_IDS', ''], ['DRIVE_FOLDER_ID', ''], ['RICHMENU_GUEST', ''], ['RICHMENU_JUNIOR', ''],
   ['RICHMENU_SENIOR', ''], ['RICHMENU_STAFF', ''],
   ['QUEST_R1', 'ถ่ายรูปคู่เพื่อนใหม่|ถ่ายรูปกับป้ายคณะ|ถ่ายรูปของโปรด'],
   ['QUEST_R2', 'ถ่ายรูปหมู่บ้านย่อย|ถ่ายรูปกับสตาฟ|ถ่ายรูปท่าโดราเอมอน'],
   ['QUEST_R3', 'ถ่ายรูปกับของที่ระลึก|ถ่ายรูปทีม|ถ่ายรูปมุมโปรดในคณะ'],
  ].forEach(([k, v]) => { if (cfg(k) === undefined) setCfg(k, v); });
}

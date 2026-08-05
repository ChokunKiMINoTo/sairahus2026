/**
 * Matching, village assignment, and the 13:30 cut-off.
 *
 * The logic lives in pure functions so `test_match` can check it without
 * touching the Sheet. Run `test_match` from the editor before running
 * `runMatch` on real data.
 */

// ---------- pure logic ------------------------------------------------------

/**
 * One Baan. Juniors go to whichever senior has the most room left, so the
 * load spreads evenly instead of filling seniors one at a time.
 * Returns { pairs: {juniorId: seniorId}, overflow: [juniorId] }.
 */
function matchHouse(juniors, seniors) {
  const left = {};
  seniors.forEach(s => left[s.id] = Math.max(0, Number(s.capacity) || 0));

  const pairs = {};
  const overflow = [];

  juniors.forEach(j => {
    let best = null;
    seniors.forEach(s => { if (left[s.id] > 0 && (!best || left[s.id] > left[best])) best = s.id; });
    if (best === null) overflow.push(j.id);
    else { pairs[j.id] = best; left[best]--; }
  });

  return { pairs: pairs, overflow: overflow };
}

/**
 * Group houses into `n` villages of roughly equal headcount.
 * Greedy largest-first: biggest house goes to the emptiest village.
 * Returns { house: village }.
 */
function packVillages(headcount, n) {
  const totals = new Array(n).fill(0);
  const out = {};

  Object.keys(headcount)
    .sort((a, b) => headcount[b] - headcount[a])
    .forEach(house => {
      let bin = 0;
      for (let i = 1; i < n; i++) if (totals[i] < totals[bin]) bin = i;
      totals[bin] += headcount[house];
      out[house] = bin + 1;
    });

  return out;
}

/**
 * Juniors whose senior never checked in get moved to a senior who did, in the
 * same house, with room to spare. Returns { juniorId: newSeniorId }.
 */
function reassign(juniors, seniors) {
  const present = {};
  seniors.forEach(s => { if (s.checkedIn) present[s.id] = s; });

  const load = {};
  juniors.forEach(j => { if (j.seniorId) load[j.seniorId] = (load[j.seniorId] || 0) + 1; });

  const moves = {};
  juniors.forEach(j => {
    if (!j.checkedIn) return;                  // no-show junior needs nothing
    if (j.seniorId && present[j.seniorId]) return;   // their senior is here

    let best = null;
    Object.keys(present).forEach(id => {
      const room = (Number(present[id].capacity) || 0) - (load[id] || 0);
      if (room <= 0) return;
      if (!best || room > (Number(present[best].capacity) || 0) - (load[best] || 0)) best = id;
    });
    if (best === null) return;                 // house is full; staff handles it

    moves[j.id] = best;
    load[best] = (load[best] || 0) + 1;
    if (j.seniorId) load[j.seniorId]--;
  });

  return moves;
}

// ---------- sheet wrappers --------------------------------------------------

/** Run once, from the editor, when registration closes. */
function runMatch() {
  const all = rows('participants');
  const byHouse = {};
  all.forEach(p => {
    if (p.role !== 'junior' && p.role !== 'senior') return;
    (byHouse[p.house] = byHouse[p.house] || []).push(p);
  });

  const headcount = {};
  const report = { paired: 0, overflow: [], shortHouses: [] };

  Object.keys(byHouse).forEach(house => {
    const people = byHouse[house];
    headcount[house] = people.length;

    const juniors = people.filter(p => p.role === 'junior').map(p => ({ id: p.lineUserId }));
    const seniors = people.filter(p => p.role === 'senior')
      .map(p => ({ id: p.lineUserId, capacity: p.capacity }));

    const result = matchHouse(juniors, seniors);
    const rowOf = {};
    people.forEach(p => rowOf[p.lineUserId] = p._row);

    Object.keys(result.pairs).forEach(jid => {
      updateRow('participants', rowOf[jid], { seniorId: result.pairs[jid], pairStatus: 'pre' });
      report.paired++;
    });
    result.overflow.forEach(jid => {
      updateRow('participants', rowOf[jid], { seniorId: '', pairStatus: OVERFLOW });
      report.overflow.push(jid);
    });
    if (result.overflow.length) report.shortHouses.push(house);
  });

  const villages = packVillages(headcount, 5);
  all.forEach(p => {
    if (villages[p.house]) updateRow('participants', p._row, { village: villages[p.house] });
  });

  console.log(JSON.stringify(report, null, 2));
  return report;
}

/** The 13:30 button. Only touches juniors whose senior did not show up. */
function runCutoff() {
  const all = rows('participants');
  const rowOf = {};
  all.forEach(p => rowOf[p.lineUserId] = p._row);

  const moved = [];
  const stranded = [];

  const houses = {};
  all.forEach(p => (houses[p.house] = houses[p.house] || []).push(p));

  Object.keys(houses).forEach(house => {
    const people = houses[house];
    const juniors = people.filter(p => p.role === 'junior').map(p => ({
      id: p.lineUserId, seniorId: p.seniorId, checkedIn: !!p.checkedInAt,
    }));
    const seniors = people.filter(p => p.role === 'senior').map(p => ({
      id: p.lineUserId, capacity: p.capacity, checkedIn: !!p.checkedInAt,
    }));

    const moves = reassign(juniors, seniors);
    juniors.forEach(j => {
      if (moves[j.id]) {
        updateRow('participants', rowOf[j.id], { seniorId: moves[j.id], pairStatus: 'reassigned' });
        moved.push(j.id);
      } else if (j.checkedIn && !j.seniorId) {
        stranded.push(j.id);
      }
    });
  });

  // Only the affected seniors get told. Everyone else pulls from their menu.
  const newJuniors = {};
  moved.forEach(jid => {
    const sid = rows('participants').find(p => p.lineUserId === jid).seniorId;
    newJuniors[sid] = (newJuniors[sid] || 0) + 1;
  });
  Object.keys(newJuniors).forEach(sid => {
    push(sid, newJuniors[sid] + ' more junior(s) have been assigned to you 🔵\n' +
      'Open the "Magic Pocket" menu to see your list.');
  });

  const report = { moved: moved.length, stranded: stranded.length, strandedIds: stranded };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function push(uid, text) {
  lineApi('https://api.line.me/v2/bot/message/push',
    { to: uid, messages: [{ type: 'text', text: text }] });
}

// ---------- self-check ------------------------------------------------------

/** Run from the editor. Throws on the first broken invariant. */
function test_match() {
  function eq(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(label + ': got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
    }
  }

  // Capacity is respected and load spreads instead of stacking.
  const r1 = matchHouse(
    [{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }, { id: 'j4' }],
    [{ id: 's1', capacity: 2 }, { id: 's2', capacity: 2 }]
  );
  eq(r1.overflow, [], 'no overflow when capacity fits');
  eq(Object.keys(r1.pairs).length, 4, 'everyone paired');
  const load = {};
  Object.keys(r1.pairs).forEach(j => load[r1.pairs[j]] = (load[r1.pairs[j]] || 0) + 1);
  eq(load, { s1: 2, s2: 2 }, 'load spread evenly');

  // Short house overflows instead of overbooking a senior.
  const r2 = matchHouse([{ id: 'j1' }, { id: 'j2' }, { id: 'j3' }], [{ id: 's1', capacity: 2 }]);
  eq(r2.overflow.length, 1, 'one junior overflows');
  eq(Object.keys(r2.pairs).length, 2, 'senior filled to capacity, not past it');

  // No seniors at all is not a crash.
  eq(matchHouse([{ id: 'j1' }], []).overflow, ['j1'], 'empty house overflows cleanly');

  // Villages balance.
  const v = packVillages({ 1: 10, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5 }, 5);
  const totals = {};
  Object.keys(v).forEach(h => totals[v[h]] = (totals[v[h]] || 0) + ({ 1: 10, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5 })[h]);
  const spread = Math.max.apply(null, Object.values(totals)) - Math.min.apply(null, Object.values(totals));
  if (spread > 5) throw new Error('villages unbalanced, spread ' + spread);

  // Cut-off moves a junior off a no-show senior, and only that junior.
  const moves = reassign(
    [{ id: 'j1', seniorId: 's1', checkedIn: true }, { id: 'j2', seniorId: 's2', checkedIn: true }],
    [{ id: 's1', capacity: 2, checkedIn: false }, { id: 's2', capacity: 2, checkedIn: true }]
  );
  eq(moves, { j1: 's2' }, 'orphan moved to the senior who showed up');

  // A junior who never checked in is left alone.
  eq(reassign(
    [{ id: 'j1', seniorId: 's1', checkedIn: false }],
    [{ id: 's1', capacity: 2, checkedIn: false }, { id: 's2', capacity: 2, checkedIn: true }]
  ), {}, 'absent junior not reassigned');

  // Nobody gets pushed past capacity during cut-off.
  eq(reassign(
    [{ id: 'j1', seniorId: 's1', checkedIn: true }, { id: 'j2', seniorId: 's2', checkedIn: true }],
    [{ id: 's1', capacity: 1, checkedIn: false }, { id: 's2', capacity: 1, checkedIn: true }]
  ), {}, 'no room means no move');

  console.log('all match tests passed');
}

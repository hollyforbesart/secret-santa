// Family Secret Santa — Cloudflare Worker (API + scheduled auto-draw).
// Static files in /public are served by Cloudflare; everything under /api/* lands here.

const TZ = 'America/Port_of_Spain';
const SESSION_COOKIE = 'ss_session';
const ADMIN_COOKIE = 'ss_admin';
const YEAR = 60 * 60 * 24 * 365;

const DEFAULT_SETTINGS = {
  title: 'Family Secret Santa 2026',
  welcome: "Ho ho ho! Christmas is coming and we're doing Secret Santa again. Tap below to tell us if you're in!",
  rsvp_deadline: '',
  draw_at: '',
  budget: '300 TTD',
  budget_note: "You're welcome to spend more if you'd like!",
  exchange_note: '',
  draw_status: 'open', // open | drawing | drawn
  late_join: '0',
  // One household per line. People in the same household never draw each other.
  // Matched on first name when someone RSVPs (the organizer can change it later).
  households: [
    'Dexter, Reyann and Holly',
    'Grizel, Isaiah and David',
    'Marielle and Xayvion',
    'Nikki, Vickie and Franklin',
    'Andra, Cynthia and Dianne',
    'Larry and Alison',
    'Mikhail and Hannah',
  ].join('\n'),
};

function parseHouseholds(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    const label = line.trim();
    if (!label) continue;
    for (const n of label.split(/,|&|\band\b/i)) {
      const k = n.trim().toLowerCase();
      if (k) map.set(k, label);
    }
  }
  return map;
}
// "Holly Forbes" -> matches "holly"; also tries the full name.
function presetHousehold(s, name) {
  const map = parseHouseholds(s.households);
  const key = String(name || '').trim().toLowerCase();
  return map.get(key) || map.get(key.split(/\s+/)[0]) || '';
}

// ---------------------------------------------------------------- schema
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS people (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL,
     rsvp TEXT NOT NULL,
     pin_hash TEXT,
     email TEXT,
     household TEXT NOT NULL DEFAULT '',
     household_manual INTEGER NOT NULL DEFAULT 0,
     sizes TEXT NOT NULL DEFAULT '',
     colours TEXT NOT NULL DEFAULT '',
     no_thanks TEXT NOT NULL DEFAULT '',
     in_draw INTEGER NOT NULL DEFAULT 0,
     spun_at TEXT,
     failed_attempts INTEGER NOT NULL DEFAULT 0,
     locked_until TEXT,
     pin_reset_notice INTEGER NOT NULL DEFAULT 0,
     wall_seen_id INTEGER NOT NULL DEFAULT 0,
     removed INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, person_id INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS matches (giver_id INTEGER PRIMARY KEY, receiver_id INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wishes (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, text TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, giver_id INTEGER NOT NULL, receiver_id INTEGER NOT NULL, from_role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS wall (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER, is_announcement INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, person_id INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL DEFAULT '/', created_at TEXT NOT NULL, pushed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(giver_id, receiver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notif_person ON notifications(person_id, id)`,
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const nowIso = () => new Date().toISOString();

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

const enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(n = 32) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
async function sha256(str) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(str))); }
async function hmac(keyStr, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function getCookie(req, name) {
  const h = req.headers.get('cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const nameKey = (s) => cleanName(s).toLowerCase();
const hhKey = (s) => String(s || '').trim().toLowerCase();
const clip = (s, n) => String(s || '').trim().slice(0, n);
const validPin = (p) => /^\d{4}$/.test(String(p || ''));
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------- settings
async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of results) s[r.key] = r.value;
  if (!s.pepper) {
    s.pepper = randomToken(32);
    await setSetting(env, 'pepper', s.pepper);
  }
  return s;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}
async function addLog(env, text) {
  await env.DB.prepare('INSERT INTO log (at, text) VALUES (?, ?)').bind(nowIso(), text).run();
}

function phaseOf(s) {
  if (s.draw_status === 'drawn') return 'drawn';
  if (s.rsvp_deadline && Date.now() >= Date.parse(s.rsvp_deadline)) return 'closed';
  return 'rsvp';
}
function rsvpOpen(s) {
  const p = phaseOf(s);
  return p === 'rsvp' || (p === 'drawn' && s.late_join === '1');
}

// ---------------------------------------------------------------- auth
async function hashPin(s, pin) {
  const salt = randomToken(12);
  return `${salt}$${await hmac(s.pepper, `${salt}:${pin}`)}`;
}
async function checkPin(s, pin, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split('$');
  return timingSafeEqual(await hmac(s.pepper, `${salt}:${pin}`), h);
}
async function newSession(env, personId) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, person_id, created_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), personId, nowIso()).run();
  return cookie(SESSION_COOKIE, token, YEAR);
}
async function currentPerson(env, req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT p.* FROM sessions s JOIN people p ON p.id = s.person_id
     WHERE s.token_hash = ? AND p.removed = 0 AND p.rsvp = 'yes'`
  ).bind(await sha256(token)).first();
}
async function requirePerson(env, req) {
  const me = await currentPerson(env, req);
  if (!me) fail(401, 'Please sign in again.');
  return me;
}
async function isAdmin(env, req) {
  const token = getCookie(req, ADMIN_COOKIE);
  if (!token) return false;
  const row = await env.DB.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash = ?').bind(await sha256(token)).first();
  return !!row;
}
async function requireAdmin(env, req) {
  if (!(await isAdmin(env, req))) fail(401, 'Organizer sign-in needed.');
}

// ---------------------------------------------------------------- draw logic
const canGive = (a, b) => a.id !== b.id && !(hhKey(a.household) && hhKey(a.household) === hhKey(b.household));

// One big loop (A→B→C→…→A) so nobody gets themselves and nobody gets their own household.
function findCycle(people) {
  const n = people.length;
  if (n < 2) return null;
  for (let t = 0; t < 3000; t++) {
    const o = shuffle([...people]);
    if (o.every((p, i) => canGive(p, o[(i + 1) % n]))) return o;
  }
  const start = people[0];
  const path = [start];
  const used = new Set([start.id]);
  let steps = 0;
  const dfs = () => {
    if (++steps > 200000) return false;
    if (path.length === n) return canGive(path[n - 1], start);
    const last = path[path.length - 1];
    for (const c of shuffle(people.filter((p) => !used.has(p.id) && canGive(last, p)))) {
      path.push(c); used.add(c.id);
      if (dfs()) return true;
      path.pop(); used.delete(c.id);
    }
    return false;
  };
  return dfs() ? path : null;
}

async function runDraw(env, ctx, { manual = false } = {}) {
  // Claim the draw so two requests can't draw at once.
  const claim = await env.DB.prepare(`UPDATE settings SET value = 'drawing' WHERE key = 'draw_status' AND value = 'open'`).run();
  if (!claim.meta.changes) {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'draw_status'`).first();
    if (!row) { await setSetting(env, 'draw_status', 'drawing'); } else { return { ok: false, error: 'The draw has already happened.' }; }
  }
  try {
    const { results: people } = await env.DB.prepare(`SELECT id, name, household FROM people WHERE rsvp = 'yes' AND removed = 0`).all();
    if (people.length < 3) throw new Error(`Only ${people.length} ${people.length === 1 ? 'person has' : 'people have'} said yes — at least 3 are needed.`);
    const cycle = findCycle(people);
    if (!cycle) throw new Error('Could not find a fair draw with the household rules. Try removing a household block or two.');
    const t = nowIso();
    const stmts = [
      env.DB.prepare('DELETE FROM matches'),
      env.DB.prepare('UPDATE people SET in_draw = 0, spun_at = NULL'),
      ...cycle.map((p, i) => env.DB.prepare('INSERT INTO matches (giver_id, receiver_id, created_at) VALUES (?, ?, ?)').bind(p.id, cycle[(i + 1) % cycle.length].id, t)),
      ...cycle.map((p) => env.DB.prepare('UPDATE people SET in_draw = 1 WHERE id = ?').bind(p.id)),
      env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('draw_status', 'drawn') ON CONFLICT(key) DO UPDATE SET value = 'drawn'`),
      env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('drawn_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(t),
      env.DB.prepare(`DELETE FROM settings WHERE key IN ('draw_error', 'draw_error_for')`),
    ];
    await env.DB.batch(stmts);
    await addLog(env, `Names drawn ${manual ? 'by the organizer' : 'automatically'} for ${cycle.length} people.`);
    await notify(env, ctx, cycle.map((p) => p.id), {
      title: '🎅 Names have been drawn!',
      body: 'Open the Secret Santa site and spin the wheel to find out who you got!',
      url: '/#home',
      email: true,
    });
    return { ok: true, count: cycle.length };
  } catch (e) {
    await setSetting(env, 'draw_status', 'open');
    await setSetting(env, 'draw_error', e.message);
    const s = await getSettings(env);
    await setSetting(env, 'draw_error_for', s.draw_at || '');
    await addLog(env, `Draw did not happen: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function maybeAutoDraw(env, ctx) {
  const s = await getSettings(env);
  if (s.draw_status !== 'open' || !s.draw_at) return;
  if (Date.now() < Date.parse(s.draw_at)) return;
  if (s.draw_error && s.draw_error_for === s.draw_at) return; // already failed for this date; organizer must fix
  await runDraw(env, ctx);
}

async function getMatchRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.giver_id, m.receiver_id, g.household AS gh, g.spun_at AS gspun, g.name AS gname, r.household AS rh
     FROM matches m JOIN people g ON g.id = m.giver_id JOIN people r ON r.id = m.receiver_id`
  ).all();
  return results;
}

const CHANGED_NOTE = {
  title: '🎁 Your Secret Santa person has changed',
  body: 'Someone joined or left the Secret Santa, so you have a new person. Open the site to see who you are buying for now.',
  url: '/#home',
  email: true,
};

// Late joiner: slot them into the loop between two people (A→B becomes A→new→B).
async function insertLate(env, ctx, person) {
  const rows = await getMatchRows(env);
  const me = { id: person.id, household: person.household };
  const fits = rows.filter((r) => canGive({ id: r.giver_id, household: r.gh }, me) && canGive(me, { id: r.receiver_id, household: r.rh }));
  if (!fits.length) {
    await addLog(env, `${person.name} joined late but could not be fitted into the draw (household rules). Check households, then use "Fit into draw".`);
    return false;
  }
  const notSpun = fits.filter((r) => !r.gspun);
  const pick = shuffle(notSpun.length ? notSpun : fits)[0];
  await env.DB.batch([
    env.DB.prepare('UPDATE matches SET receiver_id = ? WHERE giver_id = ?').bind(person.id, pick.giver_id),
    env.DB.prepare('INSERT INTO matches (giver_id, receiver_id, created_at) VALUES (?, ?, ?)').bind(person.id, pick.receiver_id, nowIso()),
    env.DB.prepare('UPDATE people SET in_draw = 1, spun_at = NULL WHERE id = ?').bind(person.id),
  ]);
  await addLog(env, `${person.name} was added to the draw.${pick.gspun ? ' One person had their match changed and was notified.' : ''}`);
  if (pick.gspun) await notify(env, ctx, [pick.giver_id], CHANGED_NOTE);
  await notify(env, ctx, [person.id], { title: "🎅 You're in the draw!", body: 'Open the site and spin the wheel to see who you got!', url: '/#home', email: true });
  return true;
}

// Someone leaves after the draw: W→X→Y becomes W→Y (or a small swap if households clash).
async function removeFromDraw(env, ctx, personId) {
  const rows = await getMatchRows(env);
  const into = rows.find((r) => r.receiver_id === personId);
  const out = rows.find((r) => r.giver_id === personId);
  const stmts = [env.DB.prepare('DELETE FROM matches WHERE giver_id = ?').bind(personId), env.DB.prepare('UPDATE people SET in_draw = 0 WHERE id = ?').bind(personId)];
  const toNotify = [];
  let problem = null;
  if (into && out) {
    const W = { id: into.giver_id, household: into.gh, spun: into.gspun };
    const Y = { id: out.receiver_id, household: out.rh };
    if (W.id === Y.id) {
      stmts.push(env.DB.prepare('DELETE FROM matches WHERE giver_id = ?').bind(W.id));
      problem = 'Only one person is left in the draw.';
    } else if (canGive(W, Y)) {
      stmts.push(env.DB.prepare('UPDATE matches SET receiver_id = ? WHERE giver_id = ?').bind(Y.id, W.id));
      if (W.spun) toNotify.push(W.id);
    } else {
      // swap with another pair C→D so that W→D and C→Y
      const others = shuffle(rows.filter((r) => r.giver_id !== personId && r.giver_id !== W.id && r.receiver_id !== personId));
      const prefer = [...others.filter((r) => !r.gspun), ...others.filter((r) => r.gspun)];
      const swap = prefer.find((r) => canGive(W, { id: r.receiver_id, household: r.rh }) && canGive({ id: r.giver_id, household: r.gh }, Y));
      if (swap) {
        stmts.push(env.DB.prepare('UPDATE matches SET receiver_id = ? WHERE giver_id = ?').bind(swap.receiver_id, W.id));
        stmts.push(env.DB.prepare('UPDATE matches SET receiver_id = ? WHERE giver_id = ?').bind(Y.id, swap.giver_id));
        if (W.spun) toNotify.push(W.id);
        if (swap.gspun) toNotify.push(swap.giver_id);
      } else {
        stmts.push(env.DB.prepare('DELETE FROM matches WHERE giver_id = ?').bind(W.id));
        problem = 'One person no longer has anyone to buy for because of household rules. Ask your helper to look at the sealed list.';
      }
    }
  }
  await env.DB.batch(stmts);
  if (toNotify.length) await notify(env, ctx, toNotify, CHANGED_NOTE);
  return { changed: toNotify.length, problem };
}

// ---------------------------------------------------------------- notifications (in-site + push + email)
async function notify(env, ctx, personIds, { title, body, url = '/', email = false }) {
  if (!personIds.length) return;
  const t = nowIso();
  await env.DB.batch(personIds.map((id) => env.DB.prepare('INSERT INTO notifications (person_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, title, body, url, t)));
  const s = await getSettings(env);
  const work = (async () => {
    const ph = personIds.map(() => '?').join(',');
    const { results: subs } = await env.DB.prepare(`SELECT endpoint FROM push_subs WHERE person_id IN (${ph})`).bind(...personIds).all();
    const jobs = subs.map((x) => sendPush(env, s, x.endpoint).catch((e) => console.error('push', e)));
    if (email && emailEnabled(env)) {
      const { results: people } = await env.DB.prepare(`SELECT name, email FROM people WHERE id IN (${ph}) AND email IS NOT NULL AND email != ''`).bind(...personIds).all();
      for (const p of people) jobs.push(sendEmail(env, s, p, title, body, url).catch((e) => console.error('email', e)));
    }
    await Promise.all(jobs);
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
}

async function getVapid(env, s) {
  if (s.vapid_public && s.vapid_private) return { pub: s.vapid_public, jwk: JSON.parse(s.vapid_private) };
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = b64url(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  await setSetting(env, 'vapid_public', pub);
  await setSetting(env, 'vapid_private', JSON.stringify(jwk));
  s.vapid_public = pub; s.vapid_private = JSON.stringify(jwk);
  return { pub, jwk };
}

// "Tickle" push with no payload; the service worker then fetches the newest notification text.
async function sendPush(env, s, endpoint) {
  const { pub, jwk } = await getVapid(env, s);
  const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const origin = s.origin && s.origin.startsWith('https://') ? s.origin : null;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.CONTACT_EMAIL ? `mailto:${env.CONTACT_EMAIL}` : origin || 'mailto:secret-santa@example.com',
  })));
  const sig = b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { TTL: '86400', Urgency: 'high', Authorization: `vapid t=${header}.${claims}.${sig}, k=${pub}`, 'Content-Length': '0' },
  });
  if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
}

const emailEnabled = (env) => !!(env.BREVO_API_KEY && env.EMAIL_FROM);
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function sendEmail(env, s, person, title, body, url) {
  const link = (s.origin || '') + url;
  const html = `<div style="font-family:Arial,sans-serif;font-size:18px;line-height:1.5;color:#222;max-width:520px">
    <p>Hi ${escHtml(person.name)},</p><p>${escHtml(body)}</p>
    <p><a href="${escHtml(link)}" style="display:inline-block;background:#c8102e;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:bold">Open Secret Santa 🎅</a></p>
    <p style="color:#777;font-size:14px">${escHtml(s.title)}</p></div>`;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: env.EMAIL_FROM, name: 'Family Secret Santa' }, to: [{ email: person.email, name: person.name }], subject: title, htmlContent: html }),
  });
}

// ---------------------------------------------------------------- data shapes
function publicSettings(s) {
  const out = {};
  for (const k of ['title', 'welcome', 'rsvp_deadline', 'draw_at', 'budget', 'budget_note', 'exchange_note']) out[k] = s[k] || '';
  return out;
}
async function getMatchFor(env, me) {
  return env.DB.prepare(`SELECT m.receiver_id, p.name FROM matches m JOIN people p ON p.id = m.receiver_id WHERE m.giver_id = ?`).bind(me.id).first();
}
async function getSantaFor(env, me) {
  return env.DB.prepare(`SELECT giver_id FROM matches WHERE receiver_id = ?`).bind(me.id).first();
}
async function wishlistOf(env, personId) {
  const p = await env.DB.prepare('SELECT name, sizes, colours, no_thanks FROM people WHERE id = ?').bind(personId).first();
  const { results } = await env.DB.prepare('SELECT id, text, link FROM wishes WHERE person_id = ? ORDER BY id').bind(personId).all();
  return { name: p?.name || '', sizes: p?.sizes || '', colours: p?.colours || '', no_thanks: p?.no_thanks || '', items: results };
}

// ---------------------------------------------------------------- API
async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

async function handleApi(req, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const route = (m, p) => method === m && path === p;
  let match;

  // ---------- public state
  if (route('GET', '/api/state')) {
    const s = await getSettings(env);
    const me = await currentPerson(env, req);
    const { results: participants } = await env.DB.prepare(`SELECT id, name FROM people WHERE rsvp = 'yes' AND removed = 0 ORDER BY name COLLATE NOCASE`).all();
    const phase = phaseOf(s);
    let meOut = null;
    if (me) {
      const m = phase === 'drawn' ? await getMatchFor(env, me) : null;
      const santa = phase === 'drawn' ? await getSantaFor(env, me) : null;
      const unreadGiftee = m ? (await env.DB.prepare(`SELECT COUNT(*) c FROM messages WHERE giver_id = ? AND receiver_id = ? AND from_role = 'giftee' AND read_at IS NULL`).bind(me.id, m.receiver_id).first()).c : 0;
      const unreadSanta = santa ? (await env.DB.prepare(`SELECT COUNT(*) c FROM messages WHERE giver_id = ? AND receiver_id = ? AND from_role = 'santa' AND read_at IS NULL`).bind(santa.giver_id, me.id).first()).c : 0;
      const wallNew = (await env.DB.prepare('SELECT COUNT(*) c FROM wall WHERE id > ? AND (person_id IS NULL OR person_id != ?)').bind(me.wall_seen_id, me.id).first()).c;
      const wishCount = (await env.DB.prepare('SELECT COUNT(*) c FROM wishes WHERE person_id = ?').bind(me.id).first()).c;
      meOut = {
        id: me.id, name: me.name, email: me.email || '', household: me.household,
        sizes: me.sizes, colours: me.colours, no_thanks: me.no_thanks, wishCount,
        inDraw: !!me.in_draw, hasMatch: !!m, spun: !!me.spun_at,
        receiverName: m && me.spun_at ? m.name : null,
        unreadGiftee, unreadSanta, wallNew,
        pinResetNotice: !!me.pin_reset_notice,
      };
    }
    return json({
      settings: publicSettings(s), phase, rsvpOpen: rsvpOpen(s), drawNoun: s.draw_error && phase !== 'drawn' ? 'delayed' : '',
      participants: participants.map((p) => p.name), me: meOut,
      vapidPublicKey: (await getVapid(env, s)).pub, emailEnabled: emailEnabled(env), timeZone: TZ,
    });
  }

  if (route('GET', '/api/people')) {
    const { results } = await env.DB.prepare(`SELECT id, name FROM people WHERE rsvp = 'yes' AND removed = 0 ORDER BY name COLLATE NOCASE`).all();
    return json({ people: results });
  }

  // ---------- RSVP
  if (route('POST', '/api/rsvp')) {
    const s = await getSettings(env);
    if (!rsvpOpen(s)) fail(400, 'Sorry, RSVPs are closed. Please message the organizer.');
    const b = await readBody(req);
    const name = cleanName(b.name);
    if (name.length < 2) fail(400, 'Please type your name.');
    const key = nameKey(name);
    const existing = await env.DB.prepare('SELECT * FROM people WHERE name_key = ? AND removed = 0').bind(key).first();

    if (b.answer === 'no') {
      if (existing && existing.rsvp === 'yes') fail(400, `${existing.name} already said yes. If that's you and you've changed your mind, sign in and tap "I can't take part".`);
      if (!existing) await env.DB.prepare(`INSERT INTO people (name, name_key, rsvp, created_at) VALUES (?, ?, 'no', ?)`).bind(name, key, nowIso()).run();
      await addLog(env, `${name} said no thanks.`);
      return json({ ok: true });
    }

    if (!validPin(b.pin)) fail(400, 'Your PIN needs to be exactly 4 numbers.');
    if (existing && existing.rsvp === 'yes') fail(409, `Someone named "${existing.name}" already said yes. If that's you, tap "Sign in" instead. If not, add your last name or a nickname.`);
    const email = clip(b.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'That email address does not look right. You can also leave it blank.');
    const pinHash = await hashPin(s, b.pin);
    const household = presetHousehold(s, name);
    let id;
    if (existing) {
      await env.DB.prepare(`UPDATE people SET name = ?, rsvp = 'yes', pin_hash = ?, email = ?, household = ? WHERE id = ?`).bind(name, pinHash, email, existing.household_manual ? existing.household : household, existing.id).run();
      id = existing.id;
    } else {
      const r = await env.DB.prepare(`INSERT INTO people (name, name_key, rsvp, pin_hash, email, household, created_at) VALUES (?, ?, 'yes', ?, ?, ?, ?)`).bind(name, key, pinHash, email, household, nowIso()).run();
      id = r.meta.last_row_id;
    }
    await addLog(env, `${name} said yes!${household ? ` (household: ${household})` : ''}`);
    if (phaseOf(s) === 'drawn') await insertLate(env, ctx, { id, name, household });
    return json({ ok: true }, 200, { 'set-cookie': await newSession(env, id) });
  }

  // ---------- sign in / out
  if (route('POST', '/api/login')) {
    const s = await getSettings(env);
    const b = await readBody(req);
    const p = await env.DB.prepare(`SELECT * FROM people WHERE id = ? AND rsvp = 'yes' AND removed = 0`).bind(Number(b.id) || 0).first();
    if (!p) fail(404, 'We could not find that name.');
    if (p.locked_until && Date.now() < Date.parse(p.locked_until)) {
      const mins = Math.ceil((Date.parse(p.locked_until) - Date.now()) / 60000);
      fail(429, `Too many wrong tries. Please wait ${mins} minute${mins === 1 ? '' : 's'}, or ask the organizer to reset your PIN.`);
    }
    if (!(await checkPin(s, String(b.pin || ''), p.pin_hash))) {
      const tries = p.failed_attempts + 1;
      if (tries >= 5) {
        await env.DB.prepare('UPDATE people SET failed_attempts = 0, locked_until = ? WHERE id = ?').bind(new Date(Date.now() + 15 * 60000).toISOString(), p.id).run();
        fail(429, 'Too many wrong tries. Please wait 15 minutes, or ask the organizer to reset your PIN.');
      }
      await env.DB.prepare('UPDATE people SET failed_attempts = ? WHERE id = ?').bind(tries, p.id).run();
      fail(401, `That PIN isn't right. Please try again. (${5 - tries} ${5 - tries === 1 ? 'try' : 'tries'} left)`);
    }
    await env.DB.prepare('UPDATE people SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(p.id).run();
    return json({ ok: true }, 200, { 'set-cookie': await newSession(env, p.id) });
  }

  if (route('POST', '/api/logout')) {
    const token = getCookie(req, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
  }

  // ---------- me
  if (route('POST', '/api/me')) {
    const me = await requirePerson(env, req);
    const b = await readBody(req);
    const email = b.email === undefined ? me.email : clip(b.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'That email address does not look right.');
    await env.DB.prepare('UPDATE people SET email = ?, sizes = ?, colours = ?, no_thanks = ? WHERE id = ?').bind(
      email,
      b.sizes === undefined ? me.sizes : clip(b.sizes, 300),
      b.colours === undefined ? me.colours : clip(b.colours, 300),
      b.no_thanks === undefined ? me.no_thanks : clip(b.no_thanks, 300),
      me.id
    ).run();
    return json({ ok: true });
  }
  if (route('POST', '/api/me/pin')) {
    const me = await requirePerson(env, req);
    const s = await getSettings(env);
    const b = await readBody(req);
    if (!validPin(b.pin)) fail(400, 'Your PIN needs to be exactly 4 numbers.');
    await env.DB.prepare('UPDATE people SET pin_hash = ?, pin_reset_notice = 0 WHERE id = ?').bind(await hashPin(s, b.pin), me.id).run();
    return json({ ok: true });
  }
  if (route('POST', '/api/me/ack-reset')) {
    const me = await requirePerson(env, req);
    await env.DB.prepare('UPDATE people SET pin_reset_notice = 0 WHERE id = ?').bind(me.id).run();
    return json({ ok: true });
  }
  if (route('POST', '/api/me/withdraw')) {
    const me = await requirePerson(env, req);
    const s = await getSettings(env);
    if (phaseOf(s) === 'drawn' && me.in_draw) fail(400, 'Names have already been drawn. Please message the organizer so they can take you out safely.');
    await env.DB.batch([
      env.DB.prepare(`UPDATE people SET rsvp = 'no' WHERE id = ?`).bind(me.id),
      env.DB.prepare('DELETE FROM sessions WHERE person_id = ?').bind(me.id),
    ]);
    await addLog(env, `${me.name} changed their RSVP to no.`);
    return json({ ok: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
  }

  // ---------- wish list
  if (route('GET', '/api/wishes')) {
    const me = await requirePerson(env, req);
    return json(await wishlistOf(env, me.id));
  }
  if (route('POST', '/api/wishes')) {
    const me = await requirePerson(env, req);
    const b = await readBody(req);
    const text = clip(b.text, 300);
    let link = clip(b.link, 500);
    if (!text) fail(400, 'Please type what you would like.');
    if (link && !/^https?:\/\//i.test(link)) link = /^[\w-]+(\.[\w-]+)+/.test(link) ? `https://${link}` : '';
    const count = (await env.DB.prepare('SELECT COUNT(*) c FROM wishes WHERE person_id = ?').bind(me.id).first()).c;
    if (count >= 30) fail(400, 'That is a lot of wishes! Please remove one first.');
    await env.DB.prepare('INSERT INTO wishes (person_id, text, link, created_at) VALUES (?, ?, ?, ?)').bind(me.id, text, link, nowIso()).run();
    return json({ ok: true });
  }
  if (method === 'DELETE' && (match = path.match(/^\/api\/wishes\/(\d+)$/))) {
    const me = await requirePerson(env, req);
    await env.DB.prepare('DELETE FROM wishes WHERE id = ? AND person_id = ?').bind(Number(match[1]), me.id).run();
    return json({ ok: true });
  }

  // ---------- my person + spin
  if (route('GET', '/api/match')) {
    const me = await requirePerson(env, req);
    const m = await getMatchFor(env, me);
    if (!m) fail(404, 'No match yet.');
    if (!me.spun_at) fail(403, 'Spin the wheel first!');
    return json(await wishlistOf(env, m.receiver_id));
  }
  if (route('POST', '/api/spin')) {
    const me = await requirePerson(env, req);
    const m = await getMatchFor(env, me);
    if (!m) fail(404, 'Names have not been drawn for you yet.');
    if (!me.spun_at) await env.DB.prepare('UPDATE people SET spun_at = ? WHERE id = ?').bind(nowIso(), me.id).run();
    const { results } = await env.DB.prepare(`SELECT name FROM people WHERE in_draw = 1 AND removed = 0 AND id != ?`).bind(me.id).all();
    return json({ receiver: m.name, wheel: shuffle(results.map((r) => r.name)) });
  }

  // ---------- anonymous messages
  if ((match = path.match(/^\/api\/thread\/(giftee|santa)$/))) {
    const me = await requirePerson(env, req);
    const which = match[1];
    let giverId, receiverId, otherName;
    if (which === 'giftee') {
      const m = await getMatchFor(env, me);
      if (!m || !me.spun_at) fail(404, 'Spin the wheel first to see who you are buying for.');
      giverId = me.id; receiverId = m.receiver_id; otherName = m.name;
    } else {
      const sRow = await getSantaFor(env, me);
      if (!sRow) fail(404, 'Messages open after names are drawn.');
      giverId = sRow.giver_id; receiverId = me.id; otherName = 'Your Secret Santa';
    }
    const myRole = which === 'giftee' ? 'santa' : 'giftee';
    if (method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, from_role, body, created_at FROM messages WHERE giver_id = ? AND receiver_id = ? ORDER BY id').bind(giverId, receiverId).all();
      await env.DB.prepare('UPDATE messages SET read_at = ? WHERE giver_id = ? AND receiver_id = ? AND from_role != ? AND read_at IS NULL').bind(nowIso(), giverId, receiverId, myRole).run();
      return json({ otherName, messages: results.map((r) => ({ id: r.id, mine: r.from_role === myRole, body: r.body, at: r.created_at })) });
    }
    if (method === 'POST') {
      const b = await readBody(req);
      const body = clip(b.body, 1000);
      if (!body) fail(400, 'Please type a message.');
      await env.DB.prepare('INSERT INTO messages (giver_id, receiver_id, from_role, body, created_at) VALUES (?, ?, ?, ?, ?)').bind(giverId, receiverId, myRole, body, nowIso()).run();
      if (which === 'giftee') {
        await notify(env, ctx, [receiverId], { title: '🎅 Your Secret Santa sent you a message', body: 'Open the site to read it and reply. (They stay secret!)', url: '/#thread/santa', email: true });
      } else {
        await notify(env, ctx, [giverId], { title: `💬 ${me.name} replied to you`, body: `${me.name} answered your Secret Santa message. Open the site to read it.`, url: '/#thread/giftee', email: true });
      }
      return json({ ok: true });
    }
  }

  // ---------- family wall
  if (route('GET', '/api/wall')) {
    const me = await requirePerson(env, req);
    const { results } = await env.DB.prepare(
      `SELECT w.id, w.body, w.created_at, w.is_announcement, w.person_id, p.name FROM wall w LEFT JOIN people p ON p.id = w.person_id ORDER BY w.id DESC LIMIT 150`
    ).all();
    if (results.length) await env.DB.prepare('UPDATE people SET wall_seen_id = ? WHERE id = ?').bind(results[0].id, me.id).run();
    return json({ posts: results.map((r) => ({ id: r.id, body: r.body, at: r.created_at, name: r.is_announcement ? 'Organizer' : r.name || 'Someone', announcement: !!r.is_announcement, mine: r.person_id === me.id })) });
  }
  if (route('POST', '/api/wall')) {
    const me = await requirePerson(env, req);
    const b = await readBody(req);
    const body = clip(b.body, 1000);
    if (!body) fail(400, 'Please type a message.');
    await env.DB.prepare('INSERT INTO wall (person_id, body, created_at) VALUES (?, ?, ?)').bind(me.id, body, nowIso()).run();
    const { results } = await env.DB.prepare(`SELECT id FROM people WHERE rsvp = 'yes' AND removed = 0 AND id != ?`).bind(me.id).all();
    await notify(env, ctx, results.map((r) => r.id), { title: `💬 ${me.name} posted in the family chat`, body: body.length > 90 ? body.slice(0, 87) + '…' : body, url: '/#wall' });
    return json({ ok: true });
  }
  if (method === 'DELETE' && (match = path.match(/^\/api\/wall\/(\d+)$/))) {
    const me = await requirePerson(env, req);
    await env.DB.prepare('DELETE FROM wall WHERE id = ? AND person_id = ?').bind(Number(match[1]), me.id).run();
    return json({ ok: true });
  }

  // ---------- push
  if (route('POST', '/api/push/subscribe')) {
    const me = await requirePerson(env, req);
    const b = await readBody(req);
    const endpoint = String(b.endpoint || '');
    if (!/^https:\/\//.test(endpoint)) fail(400, 'Bad subscription.');
    await env.DB.prepare('INSERT INTO push_subs (endpoint, person_id, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET person_id = excluded.person_id').bind(endpoint, me.id, nowIso()).run();
    return json({ ok: true });
  }
  if (route('POST', '/api/push/unsubscribe')) {
    const b = await readBody(req);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(b.endpoint || '')).run();
    return json({ ok: true });
  }
  if (route('POST', '/api/push/test')) {
    const me = await requirePerson(env, req);
    await notify(env, ctx, [me.id], { title: '🎄 Notifications are on!', body: "This is how you'll hear about messages and the big draw.", url: '/#home' });
    return json({ ok: true });
  }
  if (route('GET', '/api/notifications/latest')) {
    const me = await currentPerson(env, req);
    if (!me) return json({});
    // Newest one not yet shown on this person's phone(s); fall back to the newest overall.
    const n = await env.DB.prepare('SELECT id, title, body, url FROM notifications WHERE person_id = ? AND pushed_at IS NULL ORDER BY id DESC LIMIT 1').bind(me.id).first()
      || await env.DB.prepare('SELECT id, title, body, url FROM notifications WHERE person_id = ? ORDER BY id DESC LIMIT 1').bind(me.id).first();
    if (!n) return json({});
    await env.DB.prepare('UPDATE notifications SET pushed_at = ? WHERE person_id = ? AND id <= ? AND pushed_at IS NULL').bind(nowIso(), me.id, n.id).run();
    return json({ title: n.title, body: n.body, url: n.url });
  }

  // ---------- organizer
  if (route('POST', '/api/admin/login')) {
    const s = await getSettings(env);
    if (!env.ADMIN_PASSWORD) fail(500, 'ADMIN_PASSWORD has not been set up yet.');
    const lock = Number(s.admin_locked_until || 0);
    if (Date.now() < lock) fail(429, 'Too many wrong tries. Please wait a few minutes.');
    const b = await readBody(req);
    if (!timingSafeEqual(await sha256(String(b.password || '')), await sha256(env.ADMIN_PASSWORD))) {
      const tries = Number(s.admin_fails || 0) + 1;
      if (tries >= 8) { await setSetting(env, 'admin_locked_until', Date.now() + 10 * 60000); await setSetting(env, 'admin_fails', 0); }
      else await setSetting(env, 'admin_fails', tries);
      fail(401, 'Wrong organizer password.');
    }
    await setSetting(env, 'admin_fails', 0);
    const token = randomToken();
    await env.DB.prepare('INSERT INTO admin_sessions (token_hash, created_at) VALUES (?, ?)').bind(await sha256(token), nowIso()).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(ADMIN_COOKIE, token, 60 * 60 * 24 * 60) });
  }
  if (route('POST', '/api/admin/logout')) {
    const token = getCookie(req, ADMIN_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(ADMIN_COOKIE, '', 0) });
  }
  if (path.startsWith('/api/admin/')) {
    await requireAdmin(env, req);
    return handleAdmin(req, env, ctx, path, method);
  }

  // ---------- sealed list for a trusted helper (needs the OPS_KEY secret)
  if (route('GET', '/api/ops/matches')) {
    const auth = req.headers.get('authorization') || '';
    if (!env.OPS_KEY || !timingSafeEqual(auth, `Bearer ${env.OPS_KEY}`)) fail(404, 'Not found');
    const { results } = await env.DB.prepare(
      `SELECT g.id gid, g.name giver, r.id rid, r.name receiver, g.spun_at FROM matches m JOIN people g ON g.id = m.giver_id JOIN people r ON r.id = m.receiver_id ORDER BY g.name`
    ).all();
    await addLog(env, 'The sealed list was looked at by the helper key.');
    return json({ matches: results });
  }

  fail(404, 'Not found');
}

async function handleAdmin(req, env, ctx, path, method) {
  const route = (m, p) => method === m && path === p;
  let match;

  if (route('GET', '/api/admin/overview')) {
    const s = await getSettings(env);
    const { results: people } = await env.DB.prepare(
      `SELECT p.id, p.name, p.rsvp, p.email, p.household, p.in_draw, p.spun_at, p.created_at, p.locked_until,
         (SELECT COUNT(*) FROM wishes w WHERE w.person_id = p.id) AS wishes,
         (SELECT COUNT(*) FROM push_subs ps WHERE ps.person_id = p.id) AS push
       FROM people p WHERE p.removed = 0 ORDER BY p.rsvp DESC, p.name COLLATE NOCASE`
    ).all();
    const { results: log } = await env.DB.prepare('SELECT at, text FROM log ORDER BY id DESC LIMIT 60').all();
    const drawn = phaseOf(s) === 'drawn';
    let unmatched = [];
    if (drawn) {
      const { results } = await env.DB.prepare(
        `SELECT p.name FROM people p WHERE p.rsvp = 'yes' AND p.removed = 0 AND (p.id NOT IN (SELECT giver_id FROM matches) OR p.id NOT IN (SELECT receiver_id FROM matches))`
      ).all();
      unmatched = results.map((r) => r.name);
    }
    return json({
      settings: { ...publicSettings(s), late_join: s.late_join, households: s.households },
      phase: phaseOf(s), rsvpOpen: rsvpOpen(s), drawError: s.draw_error || '', drawnAt: s.drawn_at || '',
      people: people.map((p) => ({ ...p, email: !!p.email, spun: !!p.spun_at, locked: !!(p.locked_until && Date.now() < Date.parse(p.locked_until)) })),
      unmatched, log, emailEnabled: emailEnabled(env), opsEnabled: !!env.OPS_KEY,
    });
  }

  if (route('POST', '/api/admin/settings')) {
    const b = await readBody(req);
    const s = await getSettings(env);
    for (const k of ['title', 'welcome', 'budget', 'budget_note', 'exchange_note']) if (b[k] !== undefined) await setSetting(env, k, clip(b[k], k === 'welcome' ? 600 : 200));
    for (const k of ['rsvp_deadline', 'draw_at']) {
      if (b[k] === undefined) continue;
      const v = b[k] ? new Date(b[k]).toISOString() : '';
      await setSetting(env, k, v);
    }
    if (b.late_join !== undefined) await setSetting(env, 'late_join', b.late_join ? '1' : '0');
    if (b.households !== undefined) {
      const text = clip(b.households, 3000);
      await setSetting(env, 'households', text);
      // Re-apply to everyone whose household wasn't set by hand.
      const { results } = await env.DB.prepare('SELECT id, name FROM people WHERE removed = 0 AND household_manual = 0').all();
      const fresh = { ...s, households: text };
      if (results.length) await env.DB.batch(results.map((p) => env.DB.prepare('UPDATE people SET household = ? WHERE id = ?').bind(presetHousehold(fresh, p.name), p.id)));
    }
    if (b.draw_at !== undefined && s.draw_error) await env.DB.prepare(`DELETE FROM settings WHERE key IN ('draw_error', 'draw_error_for')`).run();
    await addLog(env, 'Organizer updated the settings.');
    return json({ ok: true });
  }

  if (route('POST', '/api/admin/draw')) {
    const r = await runDraw(env, ctx, { manual: true });
    if (!r.ok) fail(400, r.error);
    return json(r);
  }

  if (route('POST', '/api/admin/undo-draw')) {
    const spun = (await env.DB.prepare('SELECT COUNT(*) c FROM people WHERE spun_at IS NOT NULL AND in_draw = 1').first()).c;
    const b = await readBody(req);
    if (spun && !b.force) fail(400, `${spun} ${spun === 1 ? 'person has' : 'people have'} already spun the wheel. Cancelling now would change their match.`);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM matches'),
      env.DB.prepare('DELETE FROM messages'),
      env.DB.prepare('UPDATE people SET in_draw = 0, spun_at = NULL'),
      env.DB.prepare(`UPDATE settings SET value = 'open' WHERE key = 'draw_status'`),
      env.DB.prepare(`UPDATE settings SET value = '' WHERE key = 'draw_at'`),
    ]);
    await addLog(env, 'Organizer cancelled the draw. Set a new draw date or press "Draw names now".');
    return json({ ok: true });
  }

  if ((match = path.match(/^\/api\/admin\/person\/(\d+)$/)) && method === 'POST') {
    const id = Number(match[1]);
    const b = await readBody(req);
    const p = await env.DB.prepare('SELECT * FROM people WHERE id = ? AND removed = 0').bind(id).first();
    if (!p) fail(404, 'Person not found.');
    if (b.household !== undefined) await env.DB.prepare('UPDATE people SET household = ?, household_manual = 1 WHERE id = ?').bind(clip(b.household, 60), id).run();
    if (b.name !== undefined) {
      const name = cleanName(b.name);
      if (name.length < 2) fail(400, 'Name is too short.');
      await env.DB.prepare('UPDATE people SET name = ?, name_key = ? WHERE id = ?').bind(name, nameKey(name), id).run();
    }
    return json({ ok: true });
  }

  if ((match = path.match(/^\/api\/admin\/person\/(\d+)\/reset-pin$/)) && method === 'POST') {
    const id = Number(match[1]);
    const s = await getSettings(env);
    const b = await readBody(req);
    if (!validPin(b.pin)) fail(400, 'The new PIN needs to be exactly 4 numbers.');
    const p = await env.DB.prepare('SELECT name FROM people WHERE id = ?').bind(id).first();
    if (!p) fail(404, 'Person not found.');
    await env.DB.batch([
      env.DB.prepare('UPDATE people SET pin_hash = ?, pin_reset_notice = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(await hashPin(s, b.pin), id),
      env.DB.prepare('DELETE FROM sessions WHERE person_id = ?').bind(id),
    ]);
    await addLog(env, `Organizer reset ${p.name}'s PIN. They will see a notice when they sign in.`);
    return json({ ok: true });
  }

  if ((match = path.match(/^\/api\/admin\/person\/(\d+)\/remove$/)) && method === 'POST') {
    const id = Number(match[1]);
    const p = await env.DB.prepare('SELECT * FROM people WHERE id = ? AND removed = 0').bind(id).first();
    if (!p) fail(404, 'Person not found.');
    let result = { changed: 0, problem: null };
    if (p.in_draw) result = await removeFromDraw(env, ctx, id);
    await env.DB.batch([
      env.DB.prepare('UPDATE people SET removed = 1, in_draw = 0 WHERE id = ?').bind(id),
      env.DB.prepare('DELETE FROM sessions WHERE person_id = ?').bind(id),
      env.DB.prepare('DELETE FROM push_subs WHERE person_id = ?').bind(id),
    ]);
    await addLog(env, `Organizer removed ${p.name}.${result.changed ? ` ${result.changed} person(s) got a new match and were notified.` : ''}${result.problem ? ' PROBLEM: ' + result.problem : ''}`);
    return json({ ok: true, ...result });
  }

  if ((match = path.match(/^\/api\/admin\/person\/(\d+)\/fit$/)) && method === 'POST') {
    const id = Number(match[1]);
    const p = await env.DB.prepare(`SELECT * FROM people WHERE id = ? AND removed = 0 AND rsvp = 'yes'`).bind(id).first();
    if (!p) fail(404, 'Person not found.');
    if (p.in_draw) fail(400, `${p.name} is already in the draw.`);
    const ok = await insertLate(env, ctx, p);
    if (!ok) fail(400, `Could not fit ${p.name} in because of household rules.`);
    return json({ ok: true });
  }

  if (route('POST', '/api/admin/announce')) {
    const b = await readBody(req);
    const body = clip(b.body, 1000);
    if (!body) fail(400, 'Please type a message.');
    await env.DB.prepare('INSERT INTO wall (person_id, is_announcement, body, created_at) VALUES (NULL, 1, ?, ?)').bind(body, nowIso()).run();
    const { results } = await env.DB.prepare(`SELECT id FROM people WHERE rsvp = 'yes' AND removed = 0`).all();
    await notify(env, ctx, results.map((r) => r.id), { title: '📣 Secret Santa announcement', body: body.length > 120 ? body.slice(0, 117) + '…' : body, url: '/#wall', email: !!b.email });
    await addLog(env, 'Organizer posted an announcement.');
    return json({ ok: true });
  }

  if ((match = path.match(/^\/api\/admin\/wall\/(\d+)$/)) && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM wall WHERE id = ?').bind(Number(match[1])).run();
    return json({ ok: true });
  }

  if (route('POST', '/api/admin/reset-all')) {
    const b = await readBody(req);
    if (b.confirm !== 'RESET') fail(400, 'Type RESET to confirm.');
    await env.DB.batch([
      ...['people', 'sessions', 'matches', 'wishes', 'messages', 'wall', 'push_subs', 'notifications'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
      env.DB.prepare(`UPDATE settings SET value = 'open' WHERE key = 'draw_status'`),
      env.DB.prepare(`DELETE FROM settings WHERE key IN ('draw_error', 'draw_error_for', 'drawn_at')`),
    ]);
    await addLog(env, 'Organizer cleared everyone out (fresh start). Settings were kept.');
    return json({ ok: true });
  }

  fail(404, 'Not found');
}

// ---------------------------------------------------------------- entry
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      const s = await getSettings(env);
      if (s.origin !== url.origin && !url.hostname.includes('localhost') && url.protocol === 'https:') await setSetting(env, 'origin', url.origin);
      await maybeAutoDraw(env, ctx);
      return await handleApi(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong. Please try again in a moment.' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    await maybeAutoDraw(env, ctx);
  },
};

export { findCycle, canGive };

/* Hauskarte BW – Team-Funktionen (Chat, private Chats, Anhänge, Team-Verwaltung, Verträge, Teamcall)
   Wird von server.js geladen. Die Karten-Daten (Tabelle changes/buildings) werden hier nicht angefasst. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function team({ db, DATA, readBody, send, userFromToken, hashPin, log }) {
  const FILES = path.join(DATA, 'anhaenge');
  fs.mkdirSync(FILES, { recursive: true });
  const MAX_FILE = 200 * 1048576;  // 200 MB (Videos)
  db.exec(`
  CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, uid TEXT NOT NULL, text TEXT, file_id TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel, seq);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, uid TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS contracts (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, month TEXT NOT NULL, at TEXT NOT NULL, note TEXT, deleted INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS contracts_month ON contracts(month, deleted);
  CREATE TABLE IF NOT EXISTS goals (month TEXT PRIMARY KEY, goal INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS former_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT NOT NULL);
  `);
  const now = () => new Date().toISOString();
  const curMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7);
  const err = (res, code, message) => send(res, code, { message });
  const userRow = id => db.prepare('SELECT id, name, admin, active FROM users WHERE id = ?').get(id);
  const pub = u => ({ id: u.id, name: u.name, admin: !!u.admin, active: !!u.active });

  // Kanäle: "team" = alle; "dm:<id>~<id>" = privat zwischen genau zwei Personen
  function canAccess(me, ch) {
    if (ch === 'team') return true;
    const m = /^dm:([^~]+)~([^~]+)$/.exec(ch);
    if (!m || m[1] >= m[2]) return false;
    if (m[1] !== me.uid && m[2] !== me.uid) return false;
    return !!userRow(m[1]) && !!userRow(m[2]);
  }
  function saveUpload(req, dest, limit) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest); let size = 0, failed = false;
      const fail = e => { if (failed) return; failed = true; out.destroy(); fs.rm(dest, { force: true }, () => {}); reject(e); };
      req.on('data', c => { size += c.length; if (size > limit) { fail(Object.assign(Error('Datei ist zu groß (höchstens 200 MB).'), { code: 413 })); req.destroy(); } });
      req.on('error', fail); out.on('error', fail);
      req.pipe(out);
      out.on('finish', () => { if (!failed) resolve(size); });
    });
  }
  const SAFE_INLINE = /^(image\/(jpeg|png|gif|webp)|application\/pdf|video\/(mp4|webm|quicktime|3gpp|x-matroska)|audio\/(webm|ogg|mpeg|mp4|aac|wav|x-m4a|mp3|3gpp|amr))$/;
  const msgOut = r => ({ id: r.seq, from: r.uid, text: r.text || '', at: r.created_at, file: r.file_id ? (() => { const f = db.prepare('SELECT id, name, type, size FROM files WHERE id = ?').get(r.file_id); return f || null; })() : null });

  async function handle(req, res, url) {
    const me = userFromToken(req);
    if (!me) return err(res, 401, 'Nicht angemeldet');
    const meRow = userRow(me.uid);
    const isAdmin = !!meRow.admin;
    const p = url.pathname.slice(5);  // ohne "/api/"
    const M = req.method;

    /* ---------- Ich & Team ---------- */
    if (p === 'me' && M === 'GET') return send(res, 200, pub(meRow));
    if (p === 'users' && M === 'GET') return send(res, 200, db.prepare('SELECT id, name, admin, active FROM users ORDER BY name COLLATE NOCASE').all().map(pub).concat(db.prepare('SELECT id, name FROM former_users').all().map(u => ({ id: u.id, name: u.name, admin: false, active: false, deleted: true }))));
    if (p === 'users' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur Administratoren können Mitarbeiter anlegen.');
      const b = await readBody(req) || {}, name = String(b.name || '').trim(), pin = String(b.pin || '');
      if (!name || name.length > 60) return err(res, 400, 'Bitte einen Namen eingeben.');
      if (pin.length < 4) return err(res, 400, 'Die PIN braucht mindestens 4 Ziffern.');
      const ex = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name);
      if (ex && ex.active) return err(res, 409, '„' + name + '“ gibt es schon.');
      if (ex) { db.prepare('UPDATE users SET active = 1, hash = ?, admin = ? WHERE id = ?').run(hashPin(pin), b.admin ? 1 : 0, ex.id); log('Mitarbeiter wieder aufgenommen:', name); return send(res, 200, pub(userRow(ex.id))); }
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, name, hash, active, created_at, admin) VALUES (?, ?, ?, 1, ?, ?)').run(id, name, hashPin(pin), now(), b.admin ? 1 : 0);
      log('Mitarbeiter angelegt:', name, 'von', meRow.name);
      return send(res, 200, pub(userRow(id)));
    }
    let m;
    if ((m = /^users\/([^/]+)\/delete$/.exec(p)) && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur Administratoren können Mitarbeiter löschen.');
      const u = userRow(decodeURIComponent(m[1])); if (!u) return err(res, 404, 'Mitarbeiter nicht gefunden.');
      if (u.id === me.uid) return err(res, 400, 'Du kannst dich nicht selbst löschen.');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM sessions WHERE uid = ?').run(u.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        db.prepare('INSERT OR REPLACE INTO former_users (id, name, deleted_at) VALUES (?, ?, ?)').run(u.id, u.name, now());
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      log('Mitarbeiter gelöscht:', u.name, 'von', meRow.name);
      return send(res, 200, { ok: true });
    }
    if ((m = /^users\/([^/]+)$/.exec(p)) && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur Administratoren können Mitarbeiter verwalten.');
      const u = userRow(decodeURIComponent(m[1])); if (!u) return err(res, 404, 'Mitarbeiter nicht gefunden.');
      const b = await readBody(req) || {};
      if (u.id === me.uid && (b.active === false || b.admin === false)) return err(res, 400, 'Du kannst dich nicht selbst blockieren oder dir die Admin-Rechte nehmen.');
      if (b.pin !== undefined) { if (String(b.pin).length < 4) return err(res, 400, 'Die PIN braucht mindestens 4 Ziffern.'); db.prepare('UPDATE users SET hash = ? WHERE id = ?').run(hashPin(String(b.pin)), u.id); if (u.id !== me.uid) db.prepare('DELETE FROM sessions WHERE uid = ?').run(u.id); }
      if (b.admin !== undefined) db.prepare('UPDATE users SET admin = ? WHERE id = ?').run(b.admin ? 1 : 0, u.id);
      if (b.active === false) { db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id); db.prepare('DELETE FROM sessions WHERE uid = ?').run(u.id); log('Mitarbeiter blockiert:', u.name, 'von', meRow.name); }
      if (b.active === true) { db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(u.id); log('Mitarbeiter freigegeben:', u.name, 'von', meRow.name); }
      return send(res, 200, pub(userRow(u.id)));
    }

    /* ---------- Chat ---------- */
    if (p === 'channels' && M === 'GET') {
      const rows = db.prepare(`SELECT m.* FROM messages m JOIN (SELECT channel, MAX(seq) s FROM messages WHERE channel = 'team' OR channel LIKE ? OR channel LIKE ? GROUP BY channel) x ON x.s = m.seq`).all('dm:' + me.uid + '~%', 'dm:%~' + me.uid);
      return send(res, 200, rows.filter(r => canAccess(me, r.channel)).map(r => ({ id: r.channel, last: { id: r.seq, from: r.uid, at: r.created_at, text: r.text || (r.file_id ? '📎 ' + ((db.prepare('SELECT name FROM files WHERE id = ?').get(r.file_id) || {}).name || 'Anhang') : '') } })));
    }
    if (p === 'messages' && M === 'GET') {
      const ch = url.searchParams.get('channel') || '';
      if (!canAccess(me, ch)) return err(res, 403, 'Kein Zugriff auf diesen Chat.');
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const rows = after ? db.prepare('SELECT * FROM messages WHERE channel = ? AND seq > ? ORDER BY seq LIMIT 500').all(ch, after)
        : db.prepare('SELECT * FROM (SELECT * FROM messages WHERE channel = ? ORDER BY seq DESC LIMIT 300) ORDER BY seq').all(ch);
      return send(res, 200, rows.map(msgOut));
    }
    if (p === 'messages' && M === 'POST') {
      const b = await readBody(req) || {}, ch = String(b.channel || ''), text = String(b.text || '').trim().slice(0, 4000);
      if (!canAccess(me, ch)) return err(res, 403, 'Kein Zugriff auf diesen Chat.');
      let fid = null;
      if (b.attachment) { const f = db.prepare('SELECT id FROM files WHERE id = ? AND uid = ?').get(String(b.attachment), me.uid); if (!f) return err(res, 400, 'Anhang nicht gefunden.'); fid = f.id; }
      if (!text && !fid) return err(res, 400, 'Leere Nachricht.');
      const r = db.prepare('INSERT INTO messages (channel, uid, text, file_id, created_at) VALUES (?, ?, ?, ?, ?)').run(ch, me.uid, text, fid, now());
      return send(res, 200, { id: Number(r.lastInsertRowid) });
    }
    if (p === 'files' && M === 'POST') {
      const id = crypto.randomBytes(16).toString('hex'), dest = path.join(FILES, id);
      let size;
      try { size = await saveUpload(req, dest, MAX_FILE); } catch (e) { return err(res, e.code || 400, e.message); }
      if (!size) { fs.rmSync(dest, { force: true }); return err(res, 400, 'Leere Datei.'); }
      let name = 'Datei'; try { name = decodeURIComponent(String(req.headers['x-filename'] || 'Datei')); } catch (e) {}
      name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'Datei';
      const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100);
      db.prepare('INSERT INTO files (id, name, type, size, uid, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, type, size, me.uid, now());
      return send(res, 200, { id });
    }
    if ((m = /^files\/([0-9a-f]{32})$/.exec(p)) && M === 'GET') {
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(m[1]);
      if (!f) return err(res, 404, 'Datei nicht gefunden.');
      const ok = f.uid === me.uid || db.prepare('SELECT channel FROM messages WHERE file_id = ?').all(f.id).some(r => canAccess(me, r.channel));
      if (!ok) return err(res, 403, 'Kein Zugriff auf diese Datei.');
      const inline = SAFE_INLINE.test(f.type);
      const head = { 'Content-Type': inline ? f.type : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" };
      const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (rg && (rg[1] || rg[2])) {
        let a = rg[1] ? +rg[1] : Math.max(0, f.size - +rg[2]), b = rg[1] && rg[2] ? Math.min(+rg[2], f.size - 1) : f.size - 1;
        if (a > b || a >= f.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + f.size }); return res.end(); }
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${f.size}`, 'Content-Length': b - a + 1 });
        return fs.createReadStream(path.join(FILES, f.id), { start: a, end: b }).pipe(res);
      }
      res.writeHead(200, { ...head, 'Content-Length': f.size });
      return fs.createReadStream(path.join(FILES, f.id)).pipe(res);
    }

    /* ---------- Verträge ---------- */
    if (p === 'contracts' && M === 'GET') {
      const month = /^\d{4}-\d\d$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : curMonth();
      const list = db.prepare('SELECT id, uid, at, note FROM contracts WHERE month = ? AND deleted = 0 ORDER BY at DESC').all(month);
      const mine = list.filter(c => c.uid === me.uid);
      const goal = (db.prepare('SELECT goal FROM goals WHERE month = ?').get(month) || {}).goal || 0;
      const first = (db.prepare('SELECT MIN(month) f FROM contracts WHERE deleted = 0').get() || {}).f || curMonth();
      const months = db.prepare('SELECT DISTINCT month FROM contracts WHERE deleted = 0 ORDER BY month').all().map(r => r.month);
      let users = null;
      if (isAdmin) {
        const counts = {}; for (const c of list) counts[c.uid] = (counts[c.uid] || 0) + 1;
        users = db.prepare('SELECT id, name, active FROM users').all().map(u => ({ id: u.id, name: u.name, active: !!u.active, count: counts[u.id] || 0 })).filter(u => u.active || u.count);
      }
      return send(res, 200, { month, total: list.length, goal, myCount: mine.length, mine: mine.map(c => ({ id: c.id, at: c.at, note: c.note || '' })), users, first, months: [...new Set([...months, curMonth()])].sort() });
    }
    if (p === 'contracts' && M === 'POST') {
      const b = await readBody(req) || {};
      const r = db.prepare('INSERT INTO contracts (uid, month, at, note) VALUES (?, ?, ?, ?)').run(me.uid, curMonth(), now(), String(b.note || '').trim().slice(0, 200));
      return send(res, 200, { id: Number(r.lastInsertRowid) });
    }
    if ((m = /^contracts\/(\d+)\/delete$/.exec(p)) && M === 'POST') {
      const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(+m[1]);
      if (!c || c.uid !== me.uid) return err(res, 403, 'Du kannst nur deine eigenen Einträge zurücknehmen.');
      if (c.month !== curMonth()) return err(res, 400, 'Einträge aus abgeschlossenen Monaten bleiben unverändert.');
      db.prepare('UPDATE contracts SET deleted = 1 WHERE id = ?').run(c.id);
      return send(res, 200, { ok: true });
    }
    if (p === 'goals' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur Administratoren können das Monatsziel festlegen.');
      const b = await readBody(req) || {};
      if (!/^\d{4}-\d\d$/.test(String(b.month))) return err(res, 400, 'Ungültiger Monat.');
      const g = Math.max(0, Math.min(100000, parseInt(b.goal, 10) || 0));
      db.prepare('INSERT INTO goals (month, goal) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET goal = excluded.goal').run(b.month, g);
      return send(res, 200, { ok: true });
    }

    /* ---------- Teamcall ---------- */
    const getSet = k => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
    if (p === 'settings' && M === 'GET') return send(res, 200, { zoom: getSet('zoom'), zoomNote: getSet('zoomNote') });
    if (p === 'settings' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur Administratoren können den Teamcall-Link ändern.');
      const b = await readBody(req) || {};
      const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      if (b.zoom !== undefined) { const z = String(b.zoom).trim(); if (z && !/^https:\/\/\S+$/.test(z)) return err(res, 400, 'Bitte einen Link beginnend mit https:// eingeben.'); put.run('zoom', z.slice(0, 500)); }
      if (b.zoomNote !== undefined) put.run('zoomNote', String(b.zoomNote).trim().slice(0, 120));
      return send(res, 200, { ok: true });
    }
    return err(res, 404, 'unbekannt');
  }
  return { handle };
};

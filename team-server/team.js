/* Hauskarte BW – Team-Funktionen (Chat, private Chats, Anhänge, Team-Verwaltung, Verträge, Teamcall)
   Wird von server.js geladen. Die Karten-Daten (Tabelle changes/buildings) werden hier nicht angefasst. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function team({ db, DATA, readBody, send, userFromToken, hashPin, log, signStream }) {
  const FILES = path.join(DATA, 'anhaenge');
  fs.mkdirSync(FILES, { recursive: true });
  const MAX_FILE = 200 * 1048576;  // 200 MB (Videos)
  const MAX_ACADEMY = 4096 * 1048576;  // Academy (nur Admin): Schulungsvideos bis 4 GB
  db.exec(`
  CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, uid TEXT NOT NULL, text TEXT, file_id TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel, seq);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, uid TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS contracts (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, month TEXT NOT NULL, at TEXT NOT NULL, note TEXT, deleted INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS contracts_month ON contracts(month, deleted);
  CREATE TABLE IF NOT EXISTS goals (month TEXT PRIMARY KEY, goal INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS former_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS day_goals (uid TEXT NOT NULL, day TEXT NOT NULL, goal INTEGER NOT NULL, PRIMARY KEY (uid, day));
  CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS project_members (pid INTEGER NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (pid, uid));
  CREATE TABLE IF NOT EXISTS day_status (uid TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (uid, day));
  CREATE TABLE IF NOT EXISTS academy (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL, file_id TEXT, thumb_id TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reads (uid TEXT NOT NULL, key TEXT NOT NULL, val INTEGER NOT NULL, PRIMARY KEY (uid, key));
  `);
  const now = () => new Date().toISOString();
  const curMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7);
  const curDay = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const dayOf = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const err = (res, code, message) => send(res, code, { message });
  // Zugriffsberechtigung je Benutzer: 'full' = Vollzugriff (Standard, auch für alle bestehenden), 'academy' = nur Academy
  try { db.exec("ALTER TABLE users ADD COLUMN access TEXT NOT NULL DEFAULT 'full'"); } catch (e) { /* Spalte gibt es schon */ }
  const userRow = id => db.prepare('SELECT id, name, admin, active, access FROM users WHERE id = ?').get(id);
  const pub = u => ({ id: u.id, name: u.name, admin: !!u.admin, active: !!u.active, access: u.access === 'academy' ? 'academy' : 'full' });

  // Erster Administrator ohne Admin-ZIP: Solange es noch gar keinen aktiven Admin gibt,
  // bekommt der Mitarbeiter „Neki“ die Admin-Rechte automatisch. Gibt es schon einen Admin, passiert nichts.
  function ensureAdmin() {
    try {
      if (db.prepare('SELECT 1 FROM users WHERE admin = 1 AND active = 1').get()) return;
      const n = db.prepare("SELECT id, name FROM users WHERE active = 1 AND (name = 'Neki' COLLATE NOCASE OR name LIKE 'Neki %') ORDER BY created_at LIMIT 1").get();
      if (n) { db.prepare('UPDATE users SET admin = 1 WHERE id = ?').run(n.id); log('Administrator automatisch festgelegt:', n.name); }
    } catch (e) { log('Admin-Prüfung fehlgeschlagen:', e.message); }
  }
  ensureAdmin();
  // Schreibweise des Firmennamens: „ENERWAVE“ → „enerwave“ in bereits gespeicherten Academy-Titeln (einmalig)
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'nameLowercase'").get()) {
    db.prepare("UPDATE academy SET title = REPLACE(title, 'ENERWAVE', 'enerwave') WHERE title LIKE '%ENERWAVE%'").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nameLowercase', '1')").run();
  }
  if (!db.prepare('SELECT 1 FROM academy').get() && !db.prepare("SELECT 1 FROM settings WHERE key = 'academySeeded'").get()) {
    db.prepare("INSERT INTO academy (kind, title, sort, created_at, updated_at) VALUES ('pdf', 'enerwave Workbook', 1, ?, ?)").run(now(), now());
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('academySeeded', '1')").run();
  }

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
    if (url.pathname === '/api/me') ensureAdmin();
    const meRow = userRow(me.uid);
    if (!meRow) return err(res, 401, 'Nicht angemeldet');
    const isAdmin = !!meRow.admin;
    const p = url.pathname.slice(5);  // ohne "/api/"
    const M = req.method;
    // „Nur Academy“: ausschließlich eigene Angaben, Academy-Liste und Academy-Dateien – alles andere gesperrt
    if (meRow.access === 'academy') {
      let fm;
      const allowed = (p === 'me' && M === 'GET') || (p === 'academy' && M === 'GET') || (/^academy\/\d+\/stream$/.test(p) && M === 'GET') ||
        ((fm = /^files\/([0-9a-f]{32})$/.exec(p)) && M === 'GET' && !!db.prepare('SELECT 1 FROM academy WHERE file_id = ? OR thumb_id = ?').get(fm[1], fm[1]));
      if (!allowed) return send(res, 403, { message: 'Für dich ist nur die Academy freigegeben.', code: 'academy' });
    }

    /* ---------- Ich & Team ---------- */
    if (p === 'me' && M === 'GET') return send(res, 200, pub(meRow));
    if (p === 'users' && M === 'GET') return send(res, 200, db.prepare('SELECT id, name, admin, active, access FROM users ORDER BY name COLLATE NOCASE').all().filter(u => isAdmin || u.access !== 'academy').map(pub).concat(db.prepare('SELECT id, name FROM former_users').all().map(u => ({ id: u.id, name: u.name, admin: false, active: false, deleted: true }))));
    if (p === 'users' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur Administratoren können Mitarbeiter anlegen.');
      const b = await readBody(req) || {}, name = String(b.name || '').trim(), pin = String(b.pin || '');
      if (!name || name.length > 60) return err(res, 400, 'Bitte einen Namen eingeben.');
      if (pin.length < 4) return err(res, 400, 'Die PIN braucht mindestens 4 Ziffern.');
      const ex = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name);
      if (ex && ex.active) return err(res, 409, '„' + name + '“ gibt es schon.');
      const access = b.access === 'academy' && !b.admin ? 'academy' : 'full';  // Administratoren haben immer Vollzugriff
      if (ex) { db.prepare('UPDATE users SET active = 1, hash = ?, admin = ?, access = ? WHERE id = ?').run(hashPin(pin), b.admin ? 1 : 0, access, ex.id); log('Mitarbeiter wieder aufgenommen:', name); return send(res, 200, pub(userRow(ex.id))); }
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, name, hash, active, created_at, admin, access) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, name, hashPin(pin), now(), b.admin ? 1 : 0, access);
      log('Mitarbeiter angelegt:', name, access === 'academy' ? '(Nur Academy)' : '(Vollzugriff)', 'von', meRow.name);
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
      if (b.access !== undefined) {
        const acc = b.access === 'academy' ? 'academy' : 'full';
        if (acc === 'academy' && (u.admin || b.admin)) return err(res, 400, 'Administratoren haben immer Vollzugriff.');
        db.prepare('UPDATE users SET access = ? WHERE id = ?').run(acc, u.id);
        log('Zugriff geändert:', u.name, acc === 'academy' ? 'Nur Academy' : 'Vollzugriff', 'von', meRow.name);
      }
      if (b.admin !== undefined) { db.prepare('UPDATE users SET admin = ? WHERE id = ?').run(b.admin ? 1 : 0, u.id); if (b.admin) db.prepare("UPDATE users SET access = 'full' WHERE id = ?").run(u.id); }
      if (b.active === false) { db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id); db.prepare('DELETE FROM sessions WHERE uid = ?').run(u.id); log('Mitarbeiter blockiert:', u.name, 'von', meRow.name); }
      if (b.active === true) { db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(u.id); log('Mitarbeiter freigegeben:', u.name, 'von', meRow.name); }
      return send(res, 200, pub(userRow(u.id)));
    }

    /* ---------- Benachrichtigungen (gelesen/ungelesen je Mitarbeiter, zentral gespeichert) ---------- */
    const myChannels = () => db.prepare("SELECT DISTINCT channel FROM messages WHERE channel = 'team' OR channel LIKE ? OR channel LIKE ?").all('dm:' + me.uid + '~%', 'dm:%~' + me.uid).map(r => r.channel).filter(c => canAccess(me, c));
    const setRead = db.prepare('INSERT INTO reads (uid, key, val) VALUES (?, ?, ?) ON CONFLICT(uid, key) DO UPDATE SET val = MAX(val, excluded.val)');
    const maxContract = () => (db.prepare('SELECT MAX(id) m FROM contracts').get() || {}).m || 0;
    if (p === 'notify' && M === 'POST') {
      const b = await readBody(req) || {};
      if (!db.prepare("SELECT 1 FROM reads WHERE uid = ? AND key = '_init'").get(me.uid)) {
        // Erster Aufruf: bisherigen Lesestand des Geräts übernehmen, Dashboard ab jetzt zählen
        const local = b.local && typeof b.local === 'object' ? b.local : {};
        for (const ch of myChannels()) { const v = parseInt(local[ch], 10); if (v > 0) setRead.run(me.uid, ch, v); }
        setRead.run(me.uid, 'dash', maxContract()); setRead.run(me.uid, '_init', 1);
      }
      const reads = Object.fromEntries(db.prepare('SELECT key, val FROM reads WHERE uid = ?').all(me.uid).map(r => [r.key, r.val]));
      const chats = {}; let chat = 0;
      for (const ch of myChannels()) {
        const n = db.prepare('SELECT COUNT(*) n FROM messages WHERE channel = ? AND seq > ? AND uid != ?').get(ch, reads[ch] || 0, me.uid).n;
        if (n) { chats[ch] = n; chat += n; }
      }
      const dash = db.prepare('SELECT COUNT(*) n FROM contracts WHERE id > ? AND uid != ? AND deleted = 0').get(reads.dash || 0, me.uid).n;
      return send(res, 200, { chat, chats, dash });
    }
    if (p === 'read' && M === 'POST') {
      const b = await readBody(req) || {}, key = String(b.key || '');
      if (key === 'dash') setRead.run(me.uid, 'dash', maxContract());
      else if (canAccess(me, key)) { const v = parseInt(b.val, 10); if (v > 0) setRead.run(me.uid, key, v); }
      else return err(res, 403, 'Kein Zugriff auf diesen Chat.');
      return send(res, 200, { ok: true });
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
      const academyUp = isAdmin && req.headers['x-academy'] === '1';
      try { size = await saveUpload(req, dest, academyUp ? MAX_ACADEMY : MAX_FILE); } catch (e) { return err(res, e.code || 400, academyUp && e.code === 413 ? 'Datei ist zu groß (höchstens 4 GB).' : e.message); }
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
      // Academy-Inhalte (PDFs, Videos, Vorschaubilder) dürfen alle angemeldeten Mitarbeiter sehen
      const ok = f.uid === me.uid || !!db.prepare('SELECT 1 FROM academy WHERE file_id = ? OR thumb_id = ?').get(f.id, f.id) || db.prepare('SELECT channel FROM messages WHERE file_id = ?').all(f.id).some(r => canAccess(me, r.channel));
      if (!ok) return err(res, 403, 'Kein Zugriff auf diese Datei.');
      if (me.via === 'stream' && me.fid !== f.id) return err(res, 403, 'Kein Zugriff auf diese Datei.');
      const acMain = !!db.prepare('SELECT 1 FROM academy WHERE file_id = ?').get(f.id);
      const viewOnly = acMain && !isAdmin;  // Academy-Original für normale Benutzer: nur ansehen, nicht herunterladen
      if (viewOnly && me.via === 'query') return err(res, 403, 'Academy-Inhalte können nur in der App angesehen werden.');
      if (viewOnly && me.via === 'stream' && !/^video\//.test(f.type)) return err(res, 403, 'Academy-Inhalte können nur in der App angesehen werden.');
      const inline = SAFE_INLINE.test(f.type);
      const head = { 'Content-Type': inline ? f.type : 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Disposition': viewOnly ? 'inline' : (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': viewOnly ? 'private, no-store' : 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" };
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

    /* ---------- Academy (Schulungs-PDFs und -Videos; verwalten nur Admin, ansehen alle) ---------- */
    const acOut = a => { const f = a.file_id ? db.prepare('SELECT id, name, type, size FROM files WHERE id = ?').get(a.file_id) : null; if (f && !isAdmin) delete f.name; return { id: a.id, kind: a.kind, title: a.title, file: f || null, thumb: a.thumb_id || null, updated: a.updated_at }; };
    if ((m = /^academy\/(\d+)\/stream$/.exec(p)) && M === 'GET') {
      const a = db.prepare('SELECT * FROM academy WHERE id = ?').get(Number(m[1]));
      if (!a || !a.file_id || a.kind !== 'video') return err(res, 404, 'Video nicht gefunden.');
      return send(res, 200, { url: '/api/files/' + a.file_id + '?s=' + signStream(a.file_id, me.uid, 6 * 3600e3) });
    }
    const ownFile = (id, kindRe) => { if (!id) return null; const f = db.prepare('SELECT * FROM files WHERE id = ?').get(String(id)); if (!f || f.uid !== me.uid || (kindRe && !kindRe.test(f.type))) return undefined; return f.id; };
    const dropFile = id => {  // Datei entfernen, wenn sie nirgends sonst verwendet wird
      if (!id || db.prepare('SELECT 1 FROM academy WHERE file_id = ? OR thumb_id = ?').get(id, id) || db.prepare('SELECT 1 FROM messages WHERE file_id = ?').get(id)) return;
      db.prepare('DELETE FROM files WHERE id = ?').run(id); fs.rm(path.join(FILES, id), { force: true }, () => {});
    };
    const KIND_RE = { pdf: /^application\/pdf$/, video: /^video\// };
    if (p === 'academy' && M === 'GET') return send(res, 200, db.prepare('SELECT * FROM academy ORDER BY kind, sort, id').all().map(acOut));
    if (p === 'academy' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator kann Academy-Inhalte verwalten.');
      const b = await readBody(req) || {}, kind = b.kind === 'video' ? 'video' : b.kind === 'pdf' ? 'pdf' : null, title = String(b.title || '').trim().slice(0, 120);
      if (!kind) return err(res, 400, 'Unbekannte Art.');
      if (!title) return err(res, 400, 'Bitte einen Titel eingeben.');
      const fid = ownFile(b.file, KIND_RE[kind]), tid = ownFile(b.thumb, /^image\//);
      if (fid === undefined) return err(res, 400, kind === 'pdf' ? 'Bitte eine PDF-Datei wählen.' : 'Bitte eine Videodatei wählen.');
      if (kind === 'video' && !fid) return err(res, 400, 'Bitte ein Video hochladen.');
      const sort = (db.prepare('SELECT MAX(sort) m FROM academy WHERE kind = ?').get(kind).m || 0) + 1;
      const r = db.prepare('INSERT INTO academy (kind, title, file_id, thumb_id, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(kind, title, fid || null, tid === undefined ? null : tid, sort, now(), now());
      log('Academy:', kind, '„' + title + '“ hinzugefügt von', meRow.name);
      return send(res, 200, acOut(db.prepare('SELECT * FROM academy WHERE id = ?').get(r.lastInsertRowid)));
    }
    if ((m = /^academy\/(\d+)\/delete$/.exec(p)) && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator kann Academy-Inhalte verwalten.');
      const a = db.prepare('SELECT * FROM academy WHERE id = ?').get(Number(m[1])); if (!a) return err(res, 404, 'Nicht gefunden.');
      db.prepare('DELETE FROM academy WHERE id = ?').run(a.id); dropFile(a.file_id); dropFile(a.thumb_id);
      log('Academy: „' + a.title + '“ gelöscht von', meRow.name);
      return send(res, 200, { ok: true });
    }
    if ((m = /^academy\/(\d+)$/.exec(p)) && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator kann Academy-Inhalte verwalten.');
      const a = db.prepare('SELECT * FROM academy WHERE id = ?').get(Number(m[1])); if (!a) return err(res, 404, 'Nicht gefunden.');
      const b = await readBody(req) || {};
      if (b.title !== undefined) { const t = String(b.title).trim().slice(0, 120); if (!t) return err(res, 400, 'Bitte einen Titel eingeben.'); db.prepare('UPDATE academy SET title = ? WHERE id = ?').run(t, a.id); }
      if (b.file !== undefined) {  // Datei austauschen
        const fid = ownFile(b.file, KIND_RE[a.kind]); if (!fid) return err(res, 400, a.kind === 'pdf' ? 'Bitte eine PDF-Datei wählen.' : 'Bitte eine Videodatei wählen.');
        db.prepare('UPDATE academy SET file_id = ? WHERE id = ?').run(fid, a.id); dropFile(a.file_id);
      }
      if (b.thumb !== undefined) { const tid = ownFile(b.thumb, /^image\//) || null; db.prepare('UPDATE academy SET thumb_id = ? WHERE id = ?').run(tid, a.id); dropFile(a.thumb_id); }
      db.prepare('UPDATE academy SET updated_at = ? WHERE id = ?').run(now(), a.id);
      return send(res, 200, acOut(db.prepare('SELECT * FROM academy WHERE id = ?').get(a.id)));
    }

    /* ---------- Verträge ---------- */
    if (p === 'contracts' && M === 'GET') {
      const month = /^\d{4}-\d\d$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : curMonth();
      const list = db.prepare('SELECT id, uid, at, note FROM contracts WHERE month = ? AND deleted = 0 ORDER BY at DESC').all(month);
      const mine = list.filter(c => c.uid === me.uid);
      const goal = (db.prepare('SELECT goal FROM goals WHERE month = ?').get(month) || {}).goal || 0;
      const first = (db.prepare('SELECT MIN(month) f FROM contracts WHERE deleted = 0').get() || {}).f || curMonth();
      const months = db.prepare('SELECT DISTINCT month FROM contracts WHERE deleted = 0 ORDER BY month').all().map(r => r.month);
      // Monatszahlen aller Mitarbeiter sind für das ganze Team sichtbar (Name + Anzahl)
      let users = null;
      {
        const counts = {}; for (const c of list) counts[c.uid] = (counts[c.uid] || 0) + 1;
        users = db.prepare("SELECT id, name, active, access FROM users").all().map(u => ({ id: u.id, name: u.name, active: !!u.active && u.access !== 'academy', count: counts[u.id] || 0 })).filter(u => u.active || u.count);
      }
      // Heute: aus denselben Verträgen des laufenden Monats berechnet (keine eigene Zählung, keine Doppelzählung)
      const today = (() => {
        const day = curDay(), cm = curMonth();
        const curList = month === cm ? list : db.prepare('SELECT id, uid, at FROM contracts WHERE month = ? AND deleted = 0').all(cm);
        const dayCnt = {}, monCnt = {};
        for (const c of curList) { monCnt[c.uid] = (monCnt[c.uid] || 0) + 1; if (dayOf(c.at) === day) dayCnt[c.uid] = (dayCnt[c.uid] || 0) + 1; }
        const goals = Object.fromEntries(db.prepare('SELECT uid, goal FROM day_goals WHERE day = ?').all(day).map(r => [r.uid, r.goal]));
        const lastGoal = (db.prepare('SELECT goal FROM day_goals WHERE uid = ? ORDER BY day DESC LIMIT 1').get(me.uid) || {}).goal || 0;
        // Aktiv-Status nur für heute (keine Uhrzeiten, keine Historie): '' = noch nicht gestartet, 'active', 'ended'
        const stat = Object.fromEntries(db.prepare('SELECT uid, status FROM day_status WHERE day = ?').all(day).map(r => [r.uid, r.status]));
        const team = db.prepare("SELECT id, name FROM users WHERE active = 1 AND access != 'academy'").all().map(u => ({ id: u.id, name: u.name, today: dayCnt[u.id] || 0, goal: goals[u.id] || 0, month: monCnt[u.id] || 0, status: stat[u.id] || '' }));
        return { day, count: dayCnt[me.uid] || 0, goal: goals[me.uid] || 0, lastGoal, team, status: stat[me.uid] || '' };
      })();
      return send(res, 200, { month, total: list.length, goal, myCount: mine.length, mine: mine.map(c => ({ id: c.id, at: c.at, note: c.note || '' })), users, first, months: [...new Set([...months, curMonth()])].sort(), today });
    }
    // Aktiv-Status (START/ENDE): nur der eigene, nur für heute; ältere Tage werden gelöscht (keine Zeiterfassung)
    if (p === 'daystatus' && M === 'POST') {
      const b = await readBody(req) || {}, st = String(b.status || '');
      if (!['active', 'ended', ''].includes(st)) return err(res, 400, 'Unbekannter Status.');
      const day = curDay();
      db.prepare('DELETE FROM day_status WHERE day != ?').run(day);
      if (!st) db.prepare('DELETE FROM day_status WHERE uid = ? AND day = ?').run(me.uid, day);
      else db.prepare('INSERT INTO day_status (uid, day, status) VALUES (?, ?, ?) ON CONFLICT(uid, day) DO UPDATE SET status = excluded.status').run(me.uid, day, st);
      return send(res, 200, { ok: true, status: st });
    }
    // Persönliches Tagesziel: nur für sich selbst und nur für heute
    if (p === 'daygoal' && M === 'POST') {
      const b = await readBody(req) || {}, g = Number(b.goal);
      if (!Number.isInteger(g) || g < 0 || g > 99) return err(res, 400, 'Bitte eine Zahl zwischen 1 und 99 eingeben.');
      if (g === 0) db.prepare('DELETE FROM day_goals WHERE uid = ? AND day = ?').run(me.uid, curDay());
      else db.prepare('INSERT INTO day_goals (uid, day, goal) VALUES (?, ?, ?) ON CONFLICT(uid, day) DO UPDATE SET goal = excluded.goal').run(me.uid, curDay(), g);
      return send(res, 200, { ok: true, goal: g });
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

    /* ---------- Projekte (Mitarbeiter kommen aus der zentralen Tabelle users) ---------- */
    const projOut = pr => ({ id: pr.id, name: pr.name, active: !!pr.active, members: db.prepare('SELECT u.id, u.name, u.active FROM project_members pm JOIN users u ON u.id = pm.uid WHERE pm.pid = ? ORDER BY u.name COLLATE NOCASE').all(pr.id).map(u => ({ id: u.id, name: u.name, active: !!u.active })) });
    const cleanMembers = list => [...new Set((Array.isArray(list) ? list : []).map(String))].filter(id => db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
    const setMembers = (pid, list) => { db.prepare('DELETE FROM project_members WHERE pid = ?').run(pid); const ins = db.prepare('INSERT INTO project_members (pid, uid) VALUES (?, ?)'); for (const id of cleanMembers(list)) ins.run(pid, id); };
    if (p === 'projects' && M === 'GET') {
      // Admin sieht alle Projekte, Mitarbeiter nur die, denen sie angehören
      const rows = isAdmin ? db.prepare('SELECT * FROM projects ORDER BY active DESC, name COLLATE NOCASE').all()
        : db.prepare('SELECT p.* FROM projects p JOIN project_members pm ON pm.pid = p.id WHERE pm.uid = ? ORDER BY p.active DESC, p.name COLLATE NOCASE').all(me.uid);
      return send(res, 200, rows.map(projOut));
    }
    if (p === 'projects' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator kann Projekte anlegen.');
      const b = await readBody(req) || {}, name = String(b.name || '').trim().slice(0, 80);
      if (!name) return err(res, 400, 'Bitte einen Projektnamen eingeben.');
      if (db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE').get(name)) return err(res, 409, 'Ein Projekt „' + name + '“ gibt es schon.');
      const r = db.prepare('INSERT INTO projects (name, active, created_at) VALUES (?, ?, ?)').run(name, b.active === false ? 0 : 1, now());
      setMembers(Number(r.lastInsertRowid), b.members);
      log('Projekt angelegt:', name, 'von', meRow.name);
      return send(res, 200, projOut(db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid)));
    }
    if ((m = /^projects\/(\d+)\/delete$/.exec(p)) && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator kann Projekte löschen.');
      const pr = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(m[1])); if (!pr) return err(res, 404, 'Projekt nicht gefunden.');
      db.prepare('DELETE FROM project_members WHERE pid = ?').run(pr.id); db.prepare('DELETE FROM projects WHERE id = ?').run(pr.id);
      log('Projekt gelöscht:', pr.name, 'von', meRow.name);
      return send(res, 200, { ok: true });
    }
    if ((m = /^projects\/(\d+)$/.exec(p)) && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator kann Projekte ändern.');
      const pr = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(m[1])); if (!pr) return err(res, 404, 'Projekt nicht gefunden.');
      const b = await readBody(req) || {};
      if (b.name !== undefined) {
        const name = String(b.name).trim().slice(0, 80); if (!name) return err(res, 400, 'Bitte einen Projektnamen eingeben.');
        if (db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND id != ?').get(name, pr.id)) return err(res, 409, 'Ein Projekt „' + name + '“ gibt es schon.');
        db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, pr.id);
      }
      if (b.active !== undefined) db.prepare('UPDATE projects SET active = ? WHERE id = ?').run(b.active ? 1 : 0, pr.id);
      if (b.members !== undefined) setMembers(pr.id, b.members);
      return send(res, 200, projOut(db.prepare('SELECT * FROM projects WHERE id = ?').get(pr.id)));
    }

    /* ---------- Teamcall ---------- */
    const getSet = k => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
    const getCall = () => { try { return JSON.parse(getSet('call') || 'null'); } catch (e) { return null; } };
    if (p === 'settings' && M === 'GET') return send(res, 200, { zoom: getSet('zoom'), zoomNote: getSet('zoomNote'), call: getCall() });
    if (p === 'settings' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur Administratoren können den Teamcall-Link ändern.');
      const b = await readBody(req) || {};
      const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      if (b.zoom !== undefined) { const z = String(b.zoom).trim(); if (z && !/^https:\/\/\S+$/.test(z)) return err(res, 400, 'Bitte einen Link beginnend mit https:// eingeben.'); put.run('zoom', z.slice(0, 500)); }
      if (b.zoomNote !== undefined) put.run('zoomNote', String(b.zoomNote).trim().slice(0, 120));
      // Termin: einmalig (Datum) oder jede Woche (Wochentag 0=So … 6=Sa), Start- und Endzeit
      if (b.call !== undefined) {
        if (b.call === null) put.run('call', '');
        else {
          const c = b.call, hm = /^([01]\d|2[0-3]):[0-5]\d$/;
          const out = { repeat: !!c.repeat, start: String(c.start || ''), end: String(c.end || '') };
          if (!hm.test(out.start) || !hm.test(out.end)) return err(res, 400, 'Bitte Start- und Endzeit angeben.');
          if (out.end <= out.start) return err(res, 400, 'Die Endzeit muss nach der Startzeit liegen.');
          if (out.repeat) { out.weekday = Number(c.weekday); if (!Number.isInteger(out.weekday) || out.weekday < 0 || out.weekday > 6) return err(res, 400, 'Bitte einen Wochentag wählen.'); }
          else { out.date = String(c.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date) || isNaN(Date.parse(out.date))) return err(res, 400, 'Bitte ein Datum wählen.'); }
          put.run('call', JSON.stringify(out));
          log('Teamcall-Termin geändert von', meRow.name + ':', JSON.stringify(out));
        }
      }
      return send(res, 200, { ok: true });
    }
    return err(res, 404, 'unbekannt');
  }
  return { handle };
};

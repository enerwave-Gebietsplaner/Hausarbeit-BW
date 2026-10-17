/* Hauskarte BW – Team-Server
   Läuft auf dem Büro-Laptop. Liefert die App aus und gleicht die Eingaben der Tablets ab.
   Erreichbar nur über Tailscale (tailscale serve → https://<laptop>.<tailnet>.ts.net).

   Start:            node server.js
   Mitarbeiter:      node server.js user add "Max Müller" 4711
                     node server.js user pin "Max Müller" 1234
                     node server.js user remove "Max Müller"
                     node server.js user list
                     node server.js user admin "Max Müller"        (Administrator; "nein" zum Entziehen)
   Sicherung jetzt:  node server.js backup
*/
'use strict';
process.removeAllListeners('warning');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.join(ROOT, 'daten');
const BACKUPS = path.join(DATA, 'sicherungen');
const APP = path.join(ROOT, 'app');
const KEEP_BACKUPS = 60;
fs.mkdirSync(BACKUPS, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'hauskarte.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bid TEXT NOT NULL,
  f TEXT NOT NULL,
  v TEXT,
  t TEXT NOT NULL,
  uid TEXT NOT NULL,
  by_name TEXT,
  device TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_bid ON changes(bid);
CREATE TABLE IF NOT EXISTS buildings (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, kind TEXT NOT NULL, uid TEXT NOT NULL, expires INTEGER NOT NULL);
`);

try { db.exec('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* Spalte gibt es schon */ }
const now = () => new Date().toISOString();
const log = (...a) => console.log(new Date().toLocaleString('de-DE'), ...a);

/* ---------- Mitarbeiter ---------- */
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) { return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function checkPin(pin, stored) { const [salt, h] = stored.split(':'); const x = crypto.scryptSync(String(pin), salt, 32); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); }
const findUser = name => db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(String(name).trim());

/* ---------- Sicherung ---------- */
function backup() {
  const day = new Date().toLocaleDateString('sv-SE');  // JJJJ-MM-TT
  const file = path.join(BACKUPS, `hauskarte-${day}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(BACKUPS).filter(f => /^hauskarte-\d{4}-\d\d-\d\d\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUPS, f));
  return file;
}

/* ---------- Kommandozeile ---------- */
const [cmd, sub, ...args] = process.argv.slice(2);
if (cmd === 'user') {
  const name = (args[0] || '').trim(), pin = args[1];
  if (sub === 'add') {
    if (!name || !pin || String(pin).length < 4) { console.log('Aufruf: node server.js user add "Name" PIN   (PIN mind. 4 Zeichen)'); process.exit(1); }
    if (findUser(name)) { console.log(`„${name}“ gibt es schon. PIN ändern: node server.js user pin "${name}" NEUEPIN`); process.exit(1); }
    db.prepare('INSERT INTO users (id, name, hash, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), name, hashPin(pin), now());
    console.log(`Mitarbeiter „${name}“ angelegt.`);
  } else if (sub === 'pin') {
    const u = findUser(name); if (!u || !pin || String(pin).length < 4) { console.log('Mitarbeiter nicht gefunden oder PIN zu kurz.'); process.exit(1); }
    db.prepare('UPDATE users SET hash = ?, active = 1 WHERE id = ?').run(hashPin(pin), u.id);
    db.prepare('DELETE FROM sessions WHERE uid = ?').run(u.id);
    console.log(`PIN für „${u.name}“ geändert. Das Tablet muss sich neu anmelden.`);
  } else if (sub === 'remove') {
    const u = findUser(name); if (!u) { console.log('Mitarbeiter nicht gefunden.'); process.exit(1); }
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE uid = ?').run(u.id);
    console.log(`„${u.name}“ gesperrt. Seine bisherigen Eingaben bleiben erhalten.`);
  } else if (sub === 'admin') {
    const u = findUser(name); if (!u) { console.log('Mitarbeiter nicht gefunden.'); process.exit(1); }
    const on = !/^(nein|no|0|aus)$/i.test(String(args[1] || 'ja'));
    db.prepare('UPDATE users SET admin = ? WHERE id = ?').run(on ? 1 : 0, u.id);
    console.log(on ? `„${u.name}“ ist jetzt Administrator.` : `„${u.name}“ ist kein Administrator mehr.`);
  } else {
    const list = db.prepare('SELECT name, active, admin, created_at FROM users ORDER BY name').all();
    if (!list.length) console.log('Noch keine Mitarbeiter. Anlegen: node server.js user add "Name" PIN');
    for (const u of list) console.log((u.active ? '  ✓ ' : '  ✗ gesperrt: ') + u.name + (u.admin ? '  (Admin)' : ''));
    if (list.length && !list.some(u => u.admin && u.active)) console.log('\n  Hinweis: Noch kein Administrator. Festlegen: node server.js user admin "Name"');
  }
  process.exit(0);
}
if (cmd === 'backup') { console.log('Sicherung: ' + backup()); process.exit(0); }

/* ---------- Anmeldung ---------- */
const ACCESS_MS = 30 * 864e5, REFRESH_MS = 400 * 864e5;
const fails = new Map();
function issue(u) {
  const access = crypto.randomBytes(32).toString('base64url'), refresh = crypto.randomBytes(32).toString('base64url');
  const ins = db.prepare('INSERT INTO sessions (token, kind, uid, expires) VALUES (?, ?, ?, ?)');
  ins.run(access, 'a', u.id, Date.now() + ACCESS_MS);
  ins.run(refresh, 'r', u.id, Date.now() + REFRESH_MS);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_MS / 1000, user: { id: u.id, email: '', user_metadata: { name: u.name } } };
}
function userFromToken(req) {
  let tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
  // Bilder, Videos und Sprachnachrichten im Chat werden direkt per Adresse geladen (Schlüssel in ?t=)
  if (!tok && /^\/api\/files\/[0-9a-f]{32}$/.test(String(req.url).split('?')[0])) tok = new URL(req.url, 'http://x').searchParams.get('t') || '';
  if (!tok) return null;
  const s = db.prepare("SELECT s.uid, u.name FROM sessions s JOIN users u ON u.id = s.uid WHERE s.token = ? AND s.kind = 'a' AND s.expires > ? AND u.active = 1").get(tok, Date.now());
  return s || null;
}

/* ---------- HTTP ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 20e6) { reject(Error('zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : null); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveFile(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(APP, p));
  if (!file.startsWith(APP + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Nicht gefunden'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const team = require('./team.js')({ db, DATA, readBody, send, userFromToken, hashPin, log });

const insertChange = db.prepare('INSERT OR IGNORE INTO changes (id, bid, f, v, t, uid, by_name, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const upsertBuilding = db.prepare('INSERT INTO buildings (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
    const body = await readBody(req) || {};
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const name = String(body.email || body.name || '').trim();
      const key = name.toLowerCase(), f = fails.get(key) || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, { error_description: 'Zu viele Fehlversuche – bitte 5 Minuten warten.' });
      const u = findUser(name);
      if (!u || !u.active || !checkPin(body.password || '', u.hash)) {
        f.n++; if (f.n >= 8) { f.until = Date.now() + 5 * 60000; f.n = 0; } fails.set(key, f);
        await new Promise(r => setTimeout(r, 800));
        log('Anmeldung fehlgeschlagen:', name);
        return send(res, 400, { error_description: 'Invalid login credentials' });
      }
      fails.delete(key);
      log('Angemeldet:', u.name);
      return send(res, 200, issue(u));
    }
    if (grant === 'refresh_token') {
      const s = db.prepare("SELECT s.uid FROM sessions s JOIN users u ON u.id = s.uid WHERE s.token = ? AND s.kind = 'r' AND s.expires > ? AND u.active = 1").get(String(body.refresh_token || ''), Date.now());
      if (!s) return send(res, 400, { error_description: 'Invalid Refresh Token' });
      db.prepare('DELETE FROM sessions WHERE token = ?').run(String(body.refresh_token));
      return send(res, 200, issue(db.prepare('SELECT * FROM users WHERE id = ?').get(s.uid)));
    }
    return send(res, 400, { error_description: 'unsupported grant' });
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const me = userFromToken(req);
    if (!me) return send(res, 401, { message: 'Nicht angemeldet' });
    // „Nur Academy“-Benutzer bekommen keine Kartendaten
    try { if ((db.prepare('SELECT access FROM users WHERE id = ?').get(me.uid) || {}).access === 'academy') return send(res, 403, { message: 'Für dich ist nur die Academy freigegeben.', code: 'academy' }); } catch (e) { /* ältere Datenbank ohne Spalte */ }
    const table = url.pathname.slice(9);
    if (table === 'changes') {
      if (req.method === 'POST') {
        const rows = await readBody(req);
        if (!Array.isArray(rows)) return send(res, 400, { message: 'Liste erwartet' });
        const at = now();
        db.exec('BEGIN');
        try {
          for (const r of rows) {
            if (!r || typeof r.id !== 'string' || typeof r.bid !== 'string' || typeof r.f !== 'string' || typeof r.t !== 'string') continue;
            insertChange.run(r.id, r.bid, r.f, r.v === undefined ? null : JSON.stringify(r.v), r.t, me.uid, me.name, String(r.device || '').slice(0, 20), at);
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 201);
      }
      const gt = parseInt((url.searchParams.get('seq') || 'gt.0').replace(/^gt\./, ''), 10) || 0;
      const lim = Math.min(5000, parseInt(url.searchParams.get('limit') || '1000', 10) || 1000);
      const rows = db.prepare('SELECT seq, id, bid, f, v, t, created_at FROM changes WHERE seq > ? ORDER BY seq LIMIT ?').all(gt, lim);
      return send(res, 200, rows.map(r => ({ ...r, v: r.v === null ? null : JSON.parse(r.v) })));
    }
    if (table === 'buildings') {
      if (req.method === 'POST') {
        const rows = await readBody(req);
        if (!Array.isArray(rows)) return send(res, 400, { message: 'Liste erwartet' });
        const at = now();
        db.exec('BEGIN');
        try { for (const r of rows) if (r && typeof r.id === 'string' && r.data) upsertBuilding.run(r.id, JSON.stringify(r.data), at); db.exec('COMMIT'); }
        catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 201);
      }
      const m = /^in\.\((.*)\)$/.exec(url.searchParams.get('id') || '');
      const ids = m ? m[1].split(',').map(s => s.replace(/^"|"$/g, '')).slice(0, 500) : [];
      const get = db.prepare('SELECT id, data FROM buildings WHERE id = ?');
      return send(res, 200, ids.map(id => get.get(id)).filter(Boolean).map(r => ({ id: r.id, data: JSON.parse(r.data) })));
    }
    return send(res, 404, { message: 'unbekannt' });
  }
  if (url.pathname.startsWith('/api/')) return team.handle(req, res, url);
  if (url.pathname === '/status') {
    const c = db.prepare('SELECT COUNT(*) n, MAX(created_at) last FROM changes').get();
    return send(res, 200, { ok: true, aenderungen: c.n, letzte: c.last });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res, url);
  res.writeHead(405); res.end();
}

const httpServer = http.createServer((req, res) => {
  handle(req, res).catch(e => { log('Fehler:', e.message); if (!res.headersSent) send(res, 500, { message: 'Serverfehler' }); else res.end(); });
});
httpServer.requestTimeout = 3 * 3600e3;  // große Academy-Videos über das Handynetz brauchen länger als die Standard-5-Minuten
httpServer.listen(PORT, HOST, () => {
  const users = db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get().n;
  log(`Hauskarte-Server läuft auf http://${HOST}:${PORT} – ${users} Mitarbeiter`);
  if (!users) log('Noch keine Mitarbeiter angelegt: node server.js user add "Name" PIN');
});

// tägliche Sicherung (beim Start und dann alle 24 Stunden)
try { log('Sicherung: ' + backup()); } catch (e) { log('Sicherung fehlgeschlagen:', e.message); }
setInterval(() => { try { log('Sicherung: ' + backup()); } catch (e) { log('Sicherung fehlgeschlagen:', e.message); } }, 24 * 3600e3);

/* ---------- Automatische Updates ----------
   Prüft alle 30 Minuten, ob es auf GitHub eine neue Version gibt (Datei team-server/version.json),
   lädt geänderte Dateien, prüft deren Prüfsumme und tauscht sie aus. Ändert sich server.js oder team.js,
   beendet sich der Server; start-server.cmd startet ihn sofort neu. Daten bleiben unberührt. */
const UPDATE_BASE = process.env.HAUSKARTE_UPDATE_URL || 'https://raw.githubusercontent.com/enerwave-gebietsplaner/Hausarbeit-BW/main/team-server/';
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
function localVersion() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')); } catch (e) { return { version: 0, files: {} }; } }
async function checkUpdate() {
  if (process.env.HAUSKARTE_NO_UPDATE) return;
  try {
    const res = await fetch(UPDATE_BASE + 'version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const remote = await res.json();
    const local = localVersion();
    if (!(remote.version > local.version) || !remote.files) return;
    const changed = Object.entries(remote.files).filter(([f, h]) => {
      if (f.includes('..') || path.isAbsolute(f)) return false;
      try { return sha256(fs.readFileSync(path.join(ROOT, f))) !== h; } catch (e) { return true; }
    });
    const got = [];
    for (const [f, h] of changed) {
      const r = await fetch(UPDATE_BASE + f.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw Error(f + ': HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (sha256(buf) !== h) throw Error(f + ': Prüfsumme stimmt nicht');
      got.push([f, buf]);
    }
    for (const [f, buf] of got) {
      const dest = path.join(ROOT, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + '.neu', buf);
      fs.renameSync(dest + '.neu', dest);
    }
    fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify(remote, null, 1));
    log(`Update auf Version ${remote.version} installiert (${got.length} Dateien).`);
    // Neu starten, sobald sich Programmcode des Servers geändert hat (server.js, team.js, …) – sonst bliebe der alte Stand im Speicher
    if (got.some(([f]) => /^[^/]+\.js$/.test(f))) { log('Server wird für das Update neu gestartet.'); setTimeout(() => process.exit(0), 500); }
  } catch (e) { log('Update-Prüfung fehlgeschlagen:', e.message); }
}
setTimeout(checkUpdate, 60e3);
setInterval(checkUpdate, 30 * 60e3);

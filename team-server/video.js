// enerwave Connect – Video-Optimierung für die Academy (läuft im Hintergrund auf dem Server)
//
// Für jedes Academy-Video wird – einmalig, im Hintergrund – eine browserfreundliche Abspielfassung erzeugt:
//   • MP4 mit „Fast Start“ (Inhaltsverzeichnis/moov am Dateianfang → Wiedergabe startet sofort)
//   • H.264 (yuv420p) + AAC, höchstens 1920 px lange Seite, gedeckelte Datenrate, Keyframe alle 2 s
//     (flüssig auch über Mobilfunk und schnelles Springen im Video)
// Ist das Video schon passend, wird es nur verlustfrei umsortiert (keine Neukodierung).
// Die Originaldatei bleibt unverändert erhalten (Admin: „Original herunterladen“).
// Ohne ffmpeg (Download nicht möglich) wird wenigstens Fast Start direkt in JavaScript hergestellt.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { spawn, execFile } = require('child_process');

const FF_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip';
const FF_SHA = 'fa7d4d7e795db0e2503f49f105f46ed5852386f0cfdd819899be3b65ebde24fc';
const FF_DIR = 'ffmpeg-7.1-essentials_build/bin/';
const MAX_RATE = 4500;  // kbit/s Video – Obergrenze der Abspielfassung

module.exports = function ({ db, DATA, FILES, log }) {
  db.exec(`CREATE TABLE IF NOT EXISTS academy_play (src_id TEXT PRIMARY KEY, play_id TEXT, status TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL);`);
  const TOOLS = path.join(DATA, 'tools', 'ffmpeg');
  const now = () => new Date().toISOString();
  const win = process.platform === 'win32';
  let ff = null, children = new Set();
  process.on('exit', () => { for (const c of children) try { c.kill(); } catch (e) {} });

  /* ---------- ffmpeg finden oder (nur Windows) einmalig herunterladen ---------- */
  const works = bin => new Promise(r => execFile(bin, ['-version'], { timeout: 15000, windowsHide: true }, e => r(!e)));
  async function findFF() {
    const cands = [];
    if (process.env.FFMPEG) cands.push([process.env.FFMPEG, process.env.FFPROBE || process.env.FFMPEG.replace(/ffmpeg(\.exe)?$/i, m => m.replace(/mpeg/i, 'probe'))]);
    cands.push([path.join(TOOLS, win ? 'ffmpeg.exe' : 'ffmpeg'), path.join(TOOLS, win ? 'ffprobe.exe' : 'ffprobe')]);
    if (!process.env.FFMPEG_NO_PATH) cands.push(['ffmpeg', 'ffprobe']);
    for (const [a, b] of cands) if ((a.includes(path.sep) ? fs.existsSync(a) : true) && await works(a) && await works(b)) return { ffmpeg: a, ffprobe: b };
    return null;
  }
  async function download() {
    if (!win || process.env.FFMPEG_NO_DOWNLOAD) return false;
    const last = db.prepare("SELECT value FROM settings WHERE key = 'ffmpegTry'").get();
    if (last && Date.now() - Number(last.value) < 20 * 3600e3) return false;  // höchstens einmal am Tag versuchen
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ffmpegTry', ?)").run(String(Date.now()));
    const tmp = path.join(DATA, 'tools', 'ffmpeg-dl'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, 'ffmpeg.zip');
    try {
      log('Video-Optimierung: lade ffmpeg (einmalig, ca. 90 MB) …');
      const r = await fetch(FF_URL); if (!r.ok) throw Error('HTTP ' + r.status);
      const h = crypto.createHash('sha256'), out = fs.createWriteStream(zip);
      for await (const c of r.body) { h.update(c); if (!out.write(c)) await new Promise(ok => out.once('drain', ok)); }
      await new Promise((ok, no) => out.end(e => e ? no(e) : ok()));
      if (h.digest('hex') !== FF_SHA) throw Error('Prüfsumme stimmt nicht');
      const ex = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { timeout: 600000, windowsHide: true }, e => e ? no(e) : ok()));
      try { await ex('tar', ['-xf', zip, '-C', tmp, FF_DIR + 'ffmpeg.exe', FF_DIR + 'ffprobe.exe']); }
      catch (e) { await ex('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`]); }
      fs.mkdirSync(TOOLS, { recursive: true });
      for (const n of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(tmp, FF_DIR, n), path.join(TOOLS, n));
      log('Video-Optimierung: ffmpeg bereit.');
      return true;
    } catch (e) { log('Video-Optimierung: ffmpeg-Download nicht möglich (' + e.message + ') – nur Fast Start ohne Neukodierung.'); return false; }
    finally { fs.rm(tmp, { recursive: true, force: true }, () => {}); }
  }

  /* ---------- Hilfen ---------- */
  function run(bin, args) {
    return new Promise((ok, no) => {
      const c = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(c);
      try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
      let out = '', err = '';
      c.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-4e6); });
      c.stderr.on('data', d => { err += d; if (err.length > 2e4) err = err.slice(-2e4); });
      c.on('error', e => { children.delete(c); no(e); });
      c.on('close', code => { children.delete(c); code === 0 ? ok(out) : no(Error((err.trim().split('\n').pop() || 'ffmpeg-Fehler ' + code).slice(0, 300))); });
    });
  }
  // Top-Level-Boxen einer MP4/MOV-Datei
  function boxes(fd, size) {
    const list = [], b = Buffer.alloc(16); let pos = 0;
    while (pos + 8 <= size) {
      fs.readSync(fd, b, 0, 16, pos);
      let len = b.readUInt32BE(0), type = b.toString('latin1', 4, 8), hdr = 8;
      if (len === 1) { len = Number(b.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr || pos + len > size || !/^[\x20-\x7e]{4}$/.test(type)) return null;
      list.push({ type, pos, len }); pos += len;
    }
    return list;
  }
  function moovAtFront(file) {  // true = Fast Start vorhanden, false = moov hinten, null = kein MP4/MOV
    const fd = fs.openSync(file, 'r');
    try { const bx = boxes(fd, fs.fstatSync(fd).size); if (!bx) return null; const mv = bx.findIndex(x => x.type === 'moov'), md = bx.findIndex(x => x.type === 'mdat'); return mv < 0 || md < 0 ? null : mv < md; }
    finally { fs.closeSync(fd); }
  }
  // Fast Start ohne ffmpeg: moov vor mdat verschieben und Chunk-Offsets (stco/co64) anpassen
  async function jsFaststart(src, dst) {
    const fd = fs.openSync(src, 'r'); let moov, bx;
    try {
      const size = fs.fstatSync(fd).size; bx = boxes(fd, size); if (!bx) return false;
      const mi = bx.findIndex(x => x.type === 'moov'), di = bx.findIndex(x => x.type === 'mdat');
      if (mi < 0 || di < 0 || mi < di || bx.slice(mi + 1).some(x => x.type === 'mdat')) return false;
      const m = bx[mi]; if (m.len > 256 * 1048576) return false;
      moov = Buffer.alloc(m.len); fs.readSync(fd, moov, 0, m.len, m.pos);
    } finally { fs.closeSync(fd); }
    const delta = moov.length; let ok = true;
    (function walk(start, end) {
      let p = start;
      while (ok && p + 8 <= end) {
        let len = moov.readUInt32BE(p), type = moov.toString('latin1', p + 4, p + 8), hdr = 8;
        if (len === 1) { len = Number(moov.readBigUInt64BE(p + 8)); hdr = 16; } else if (len === 0) len = end - p;
        if (len < hdr || p + len > end) { ok = false; return; }
        if (type === 'cmov') { ok = false; return; }
        if (/^(moov|trak|mdia|minf|stbl)$/.test(type)) walk(p + hdr, p + len);
        else if (type === 'stco') { const n = moov.readUInt32BE(p + hdr + 4); for (let i = 0; i < n; i++) { const o = p + hdr + 8 + i * 4, v = moov.readUInt32BE(o) + delta; if (v > 0xffffffff) { ok = false; return; } moov.writeUInt32BE(v, o); } }
        else if (type === 'co64') { const n = moov.readUInt32BE(p + hdr + 4); for (let i = 0; i < n; i++) { const o = p + hdr + 8 + i * 8; moov.writeBigUInt64BE(moov.readBigUInt64BE(o) + BigInt(delta), o); } }
        p += len;
      }
    })(0, moov.length);
    if (!ok) return false;
    const first = bx.findIndex(x => x.type === 'mdat'), out = fs.createWriteStream(dst);
    const copy = (a, b) => new Promise((res, rej) => { if (b <= a) return res(); const r = fs.createReadStream(src, { start: a, end: b - 1, highWaterMark: 1 << 20 }); r.on('error', rej); r.on('end', res); r.pipe(out, { end: false }); });
    try {
      for (const x of bx.slice(0, first)) await copy(x.pos, x.pos + x.len);
      await new Promise((res, rej) => out.write(moov, e => e ? rej(e) : res()));
      for (const x of bx.slice(first)) if (x.type !== 'moov') await copy(x.pos, x.pos + x.len);
      await new Promise((res, rej) => out.end(e => e ? rej(e) : res()));
    } catch (e) { out.destroy(); throw e; }
    return true;
  }

  /* ---------- eine Abspielfassung erzeugen ---------- */
  async function optimize(src) {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(src); if (!f) return;
    const inFile = path.join(FILES, f.id), id = crypto.randomBytes(16).toString('hex'), tmp = path.join(FILES, id + '.tmp');
    const done = (playId, type, note, status = 'ok') => {
      if (!db.prepare('SELECT 1 FROM academy WHERE file_id = ?').get(src)) { fs.rmSync(tmp, { force: true }); return; }  // inzwischen ersetzt/gelöscht
      if (playId) {
        fs.renameSync(tmp, path.join(FILES, playId));
        db.prepare('INSERT INTO files (id, name, type, size, uid, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(playId, f.name.replace(/\.[^.]*$/, '') + ' (Wiedergabe).mp4', type, fs.statSync(path.join(FILES, playId)).size, f.uid, now());
      }
      const prev = db.prepare('SELECT play_id FROM academy_play WHERE src_id = ? AND play_id IS NOT NULL').get(src);  // ältere Fassung: erst später löschen (läuft evtl. gerade)
      if (prev) db.prepare("INSERT OR REPLACE INTO academy_play (src_id, play_id, status, note, updated_at) VALUES (?, ?, 'old', '', ?)").run('old:' + prev.play_id, prev.play_id, now());
      db.prepare('INSERT OR REPLACE INTO academy_play (src_id, play_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?)').run(src, playId || null, status, note, now());
      log('Video-Optimierung:', f.name, '→', note);
    };
    try {
      if (ff) {
        const info = JSON.parse(await run(ff.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', inFile]));
        const v = (info.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        if (!v) throw Error('keine Videospur gefunden');
        const a = (info.streams || []).find(s => s.codec_type === 'audio');
        const rate = Number(info.format && info.format.bit_rate) || 0, fmt = String(info.format && info.format.format_name || '');
        const long = Math.max(v.width || 0, v.height || 0);
        const goodV = v.codec_name === 'h264' && /^yuvj?420p$/.test(v.pix_fmt || '') && !/High 10|4:2:2|4:4:4/.test(v.profile || '') && long <= 1920 && (!rate || rate <= (MAX_RATE + 1500) * 1000);
        const goodA = !a || a.codec_name === 'aac';
        const mp4 = /mp4|mov/.test(fmt);
        if (goodV && goodA && mp4 && moovAtFront(inFile)) return done(null, null, 'bereits optimal (H.264/AAC, Fast Start)');
        const base = ['-hide_banner', '-nostdin', '-y', '-i', inFile, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1'];
        if (goodV && goodA && mp4) {
          await run(ff.ffmpeg, [...base, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp]);
          return done(id, 'video/mp4', 'Fast Start (ohne Neukodierung)');
        }
        const scale = "scale=w='if(gte(iw,ih),min(1920,trunc(iw/2)*2),-2)':h='if(gte(iw,ih),-2,min(1920,trunc(ih/2)*2))'";
        const thr = String(Math.max(1, Math.floor(os.cpus().length * 0.75)));
        await run(ff.ffmpeg, [...base, '-vf', scale + ',format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', MAX_RATE + 'k', '-bufsize', 2 * MAX_RATE + 'k',
          '-profile:v', 'high', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-threads', thr,
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp]);
        return done(id, 'video/mp4', `neu kodiert: H.264/AAC, Fast Start (vorher ${v.codec_name}${a ? '/' + a.codec_name : ''}, ${v.width}×${v.height}${rate ? ', ' + Math.round(rate / 1e5) / 10 + ' Mbit/s' : ''})`);
      }
      const front = moovAtFront(inFile);
      if (front === false && await jsFaststart(inFile, tmp)) return done(id, /^video\/(mp4|quicktime)$/.test(f.type) ? f.type : 'video/mp4', 'Fast Start (ohne ffmpeg)', 'basic');
      fs.rmSync(tmp, { force: true });
      db.prepare('INSERT OR REPLACE INTO academy_play (src_id, play_id, status, note, updated_at) VALUES (?, NULL, ?, ?, ?)').run(src, 'basic', front ? 'Fast Start vorhanden, ffmpeg fehlt' : 'ffmpeg fehlt', now());
      log('Video-Optimierung:', f.name, '→', front ? 'Fast Start bereits vorhanden (ohne ffmpeg keine Neukodierung)' : 'unverändert (ohne ffmpeg keine Neukodierung)');
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      db.prepare('INSERT OR REPLACE INTO academy_play (src_id, play_id, status, note, updated_at) VALUES (?, NULL, ?, ?, ?)').run(src, 'failed', e.message.slice(0, 300), now());
      log('Video-Optimierung fehlgeschlagen:', f.name, '–', e.message);
    }
  }

  /* ---------- Warteschlange: ein Video nach dem anderen ---------- */
  let busy = false, again = false;
  function sweep() {  // abgelöste Abspielfassungen nach Ablauf aller Abspiel-Links entfernen
    for (const r of db.prepare("SELECT src_id, play_id FROM academy_play WHERE status = 'old' AND updated_at < ?").all(new Date(Date.now() - 7 * 3600e3).toISOString())) {
      db.prepare('DELETE FROM files WHERE id = ?').run(r.play_id); fs.rm(path.join(FILES, r.play_id), { force: true }, () => {});
      db.prepare('DELETE FROM academy_play WHERE src_id = ?').run(r.src_id);
    }
  }
  async function pump() {
    if (busy) { again = true; return; } busy = true;
    try {
      sweep();
      if (!ff) { ff = await findFF(); if (!ff && await download()) ff = await findFF(); }
      for (;;) {
        again = false;
        // offen: kein Eintrag, oder nur Grundstufe (ffmpeg war nicht da und ist es jetzt)
        const todo = db.prepare(`SELECT a.file_id id FROM academy a JOIN files f ON f.id = a.file_id LEFT JOIN academy_play p ON p.src_id = a.file_id
          WHERE a.kind = 'video' AND (p.src_id IS NULL OR (p.status = 'basic' AND ?)) ORDER BY a.id LIMIT 1`).get(ff ? 1 : 0);
        if (!todo) { if (!again) break; continue; }
        await optimize(todo.id);
      }
    } catch (e) { log('Video-Optimierung:', e.message); }
    finally { busy = false; }
  }
  // Reste abgebrochener Läufe aufräumen
  try { for (const n of fs.readdirSync(FILES)) if (n.endsWith('.tmp')) fs.rm(path.join(FILES, n), { force: true }, () => {}); } catch (e) {}
  setTimeout(pump, 3000);
  setInterval(pump, 3 * 3600e3).unref();  // falls ffmpeg später verfügbar wird

  return {
    queue: () => setImmediate(pump),
    // Abspielfassung zu einer Original-Datei (sonst das Original selbst)
    playFor: src => { const r = src && db.prepare("SELECT play_id FROM academy_play WHERE src_id = ? AND play_id IS NOT NULL").get(src); return r && db.prepare('SELECT 1 FROM files WHERE id = ?').get(r.play_id) ? r.play_id : src; },
    isPlay: id => !!db.prepare("SELECT 1 FROM academy_play p LEFT JOIN academy a ON a.file_id = p.src_id WHERE p.play_id = ? AND (a.id IS NOT NULL OR p.status = 'old')").get(id),
    // beim Ersetzen/Löschen des Originals: Abspielfassung mit entfernen
    drop: src => { for (const r of db.prepare('SELECT play_id FROM academy_play WHERE src_id = ?').all(src)) if (r.play_id) { db.prepare('DELETE FROM files WHERE id = ?').run(r.play_id); fs.rm(path.join(FILES, r.play_id), { force: true }, () => {}); } db.prepare('DELETE FROM academy_play WHERE src_id = ?').run(src); },
  };
};

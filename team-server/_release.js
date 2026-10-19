// Erzeugt version.json für die automatischen Updates des Team-Servers.
// Aufruf (im Ordner team-server):  node _release.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILES = ['server.js', 'team.js', 'video.js', 'start-server.cmd', 'mitarbeiter.ps1', 'Mitarbeiter verwalten.bat', 'ANLEITUNG.txt',
  'app/index.html', 'app/team.html', 'app/motivation.js', 'app/sw.js', 'app/sync-config.js', 'app/manifest.webmanifest', 'app/icon.svg', 'app/v16.html', 'app/pdfjs/pdf.min.js', 'app/pdfjs/pdf.worker.min.js', 'app/pdfjs/LICENSE.txt'];
const old = fs.existsSync('version.json') ? JSON.parse(fs.readFileSync('version.json', 'utf8')) : { version: 0 };
const files = {};
for (const f of FILES) files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, f))).digest('hex');
const v = { version: old.version + 1, created: new Date().toISOString(), files };
fs.writeFileSync('version.json', JSON.stringify(v, null, 1));
console.log('version.json → Version', v.version);

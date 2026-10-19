// enerwave Connect – Academy: Kundensimulator, Lernfortschritt, Coaching (Server-Teil)
//
// • Nutzt die bestehende Benutzerstruktur (users.id, admin, access) – keine eigene Benutzerverwaltung.
// • KI-Zugang (Anthropic Claude API) nur hier auf dem Server; der Schlüssel liegt in der Datenbank
//   im Ordner „daten“ (nicht auf GitHub, nie im Browser) und wird nie an die App zurückgegeben.
// • Während des Gesprächs: KI = Kunde (schnelles Modell, Antwort wird gestreamt).
//   Nach dem Gespräch: KI = Coach (gründlicheres Modell, strukturierte Auswertung).
// • Alle Kunden-, Rechnungs- und Tarifdaten sind fiktive Schulungsdaten.
'use strict';
const crypto = require('crypto');

const API_BASE = (process.env.ANTHROPIC_BASE || 'https://api.anthropic.com').replace(/\/$/, '');

/* ====================== Einstellungen (vom Admin änderbar) ====================== */
const COACH_STARTS = [
  'Bevor du klingelst: Sei du selbst. Dein Pitch gibt dir Orientierung, aber dein Kunde spricht mit einem Menschen – nicht mit einem auswendig gelernten Skript. Hör zu, sei aufmerksam und reagiere auf das, was vor dir passiert. Deine Wirkung beginnt, bevor dein Angebot überhaupt Thema wird. Bereit? Dann klingel.',
  'Geh selbstverständlich an diese Tür. Du bist hier, um ein vernünftiges Gespräch zu führen. Ruhig, klar und freundlich. Du kennst deinen Ablauf. Jetzt konzentrier dich auf den Menschen vor dir.',
  'Heute trainierst du nicht, möglichst viel zu reden. Du trainierst zuzuhören. Achte darauf, was der Kunde tatsächlich sagt und reagiere darauf.',
  'Deine Energie kommt vor deinen Worten. Sprich klar, bleib positiv und führe das Gespräch ohne unnötigen Druck.',
  'Du musst deinen Pitch nicht Wort für Wort wiedergeben. Die Inhalte müssen sitzen, aber die Sprache darf deine sein. Bleib authentisch.',
  'Jede Tür ist anders. Vielleicht öffnet jemand freundlich, skeptisch oder gestresst. Nimm die Stimmung wahr und hole den Kunden dort ab, wo er gerade steht.',
  'Führe das Gespräch, aber erzwinge es nicht. Hör zu, versteh den Einwand und mache den nächsten Schritt einfach. Eine klare Grenze des Kunden wird respektiert.',
  'Der Kunde erlebt zuerst dich und danach dein Angebot. Sei aufmerksam, empathisch, selbstbewusst und präsent. Bereit? Dann klingel.',
  'Wenn die Rechnung kommt, arbeite sauber mit den tatsächlichen Daten. Erkläre verständlich und führe natürlich zum nächsten Schritt.',
  'Ein Nein ist kein Misserfolg. Ein respektvolles Gesprächsende sagt genauso viel über deine Professionalität aus wie ein Abschluss.',
  'Stell eine gute Frage mehr und behaupte eine Sache weniger. Was du belegen kannst, schafft Vertrauen.'
];
const EXAM_START = 'Jetzt gibt es keine Hilfestellung. Du weißt nicht, welcher Kunde öffnet und was auf dich zukommt. Verlass dich auf dein Wissen, deine Aufmerksamkeit und deine Gesprächsführung. Bleib authentisch. Bleib klar. Bleib beim Kunden. Bereit? Dann klingel.';

const CATS = [
  { key: 'wirkung', label: 'Authentizität & Wirkung', max: 10 },
  { key: 'zuhoeren', label: 'Zuhören & Empathie', max: 15 },
  { key: 'pitch', label: 'Pitch & Einstieg', max: 10 },
  { key: 'fuehrung', label: 'Gesprächsführung', max: 15 },
  { key: 'einwand', label: 'Einwandbehandlung', max: 15 },
  { key: 'fachlich', label: 'Fachliche Richtigkeit', max: 15 },
  { key: 'vorabschluss', label: 'Vorabschluss', max: 10 },
  { key: 'closing', label: 'Closing & Transparenz', max: 10 }
];
const CRITICAL = {
  rolle: 'Falsche Unternehmensrolle behauptet',
  rechnung: 'Gravierend falsche Tarifberechnung',
  ersparnis: 'Erfundene oder falsch dargestellte Ersparnis (z. B. Abschlagsdifferenz als Ersparnis)',
  verschleiern: 'Wichtige Informationen verschleiert / Kunde wusste nicht, was er bestätigt',
  ablehnung: 'Eindeutige Ablehnung wiederholt ignoriert'
};
const TYPES = {
  offen: { label: 'Offener Kunde', desc: 'Freundlich, hat Zeit, hört zu, kaum oder keine Einwände. Holt bei einem vernünftigen Gespräch relativ schnell die Rechnung.', objections: [0, 0] },
  normal: { label: 'Normaler Kunde', desc: 'Freundlich bis neutral. Stellt vielleicht eine Rückfrage oder bringt einen Einwand.', objections: [0, 1] },
  einwand: { label: 'Einwandkunde', desc: 'Bringt typischerweise 1–2 Einwände. Bei guter Gesprächsführung kann er zugänglicher werden.', objections: [1, 2] },
  skeptisch: { label: 'Skeptischer Kunde', desc: 'Stellt kritische Fragen zu Firma, Rolle, Daten und Rechnung. Will Belege statt Behauptungen.', objections: [1, 3] },
  schwierig: { label: 'Schwieriger Kunde', desc: 'Gestresst oder stark ablehnend, kann mehrere Einwände bringen. Darf das Gespräch klar beenden („Nein. Ich möchte das nicht. Bitte gehen Sie.“).', objections: [2, 3] }
};
const OBJECTIONS = {
  normal: ['Was genau prüfen Sie?', 'Geht es darum, dass ich wechseln soll?', 'Ich bin eigentlich zufrieden.'],
  einwand: ['Kein Interesse.', 'Ich habe keine Zeit.', 'Ich bin zufrieden.', 'Ich habe erst gewechselt.', 'Das macht mein Mann / meine Frau.', 'Ich möchte nichts ändern.', 'Schicken Sie mir lieber etwas zu.', 'Ich kenne meinen Tarif.', 'Ich möchte meine Rechnung nicht zeigen.'],
  skeptisch: ['Von welcher Firma kommen Sie genau?', 'Sind Sie direkt von den Stadtwerken?', 'Warum brauchen Sie meine Rechnung?', 'Woher wissen Sie, dass ich zu viel bezahle?', 'Was passiert mit meinen Daten?', 'Muss ich etwas unterschreiben?', 'Ist das ein Anbieterwechsel?', 'Woher weiß ich, dass das günstiger ist?'],
  schwierig: ['Ich habe keine Zeit.', 'Kein Interesse.', 'An der Tür kaufe ich grundsätzlich nichts.', 'Ich möchte nichts ändern.', 'Nein. Ich möchte das nicht. Bitte gehen Sie.']
};
const PERSONAS = ['freundlich und gesprächig', 'ruhig und sachlich', 'skeptisch', 'gestresst', 'älter und erklärungsbedürftig', 'jung und direkt', 'preisorientiert', 'loyal zum bisherigen Anbieter', 'misstrauisch', 'neugierig', 'technisch interessiert', 'wenig energiekundig', 'sehr gut informiert', 'ungeduldig', 'humorvoll'];
// Die 10 Ausgangsszenarien (Verlauf und Formulierungen variiert die KI jedes Mal)
const SCENARIOS = [
  { id: 1, type: 'offen', title: 'Freundlicher Kunde – keine Einwände – Rechnung sofort', bill: 'sofort', objections: 0 },
  { id: 2, type: 'normal', title: 'Normaler Kunde – Rückfrage – danach Rechnung', bill: 'nach_vertrauen', objections: 1 },
  { id: 3, type: 'einwand', title: '„Kein Interesse“ – bei guter Reaktion offen', bill: 'nach_vertrauen', objections: 1, fixed: ['Kein Interesse.'] },
  { id: 4, type: 'einwand', title: '„Keine Zeit“ – ein Einwand', bill: 'nach_vertrauen', objections: 1, fixed: ['Ich habe keine Zeit.'] },
  { id: 5, type: 'einwand', title: '„Keine Zeit“ + „Bin zufrieden“', bill: 'nach_vertrauen', objections: 2, fixed: ['Ich habe keine Zeit.', 'Ich bin zufrieden.'] },
  { id: 6, type: 'skeptisch', title: 'Skeptischer Kunde – Unternehmensrolle / Rechnung', bill: 'nach_vertrauen', objections: 2, fixed: ['Sind Sie direkt von den Stadtwerken?', 'Warum brauchen Sie meine Rechnung?'] },
  { id: 7, type: 'normal', title: 'Preisorientierter Kunde', bill: 'nach_vertrauen', objections: 1, persona: 'preisorientiert', fixed: ['Woher weiß ich, dass das günstiger ist?'] },
  { id: 8, type: 'normal', title: 'Kunde ohne Rechnung', bill: 'keine', objections: 1 },
  { id: 9, type: 'offen', title: 'Rechnung vorhanden – anspruchsvoller Vorabschluss', bill: 'sofort', objections: 0, persona: 'sehr gut informiert', hard: true },
  { id: 10, type: 'schwierig', title: 'Harter Kunde – eindeutige Ablehnung – professionelles Gesprächsende', bill: 'nie', objections: 2, fixed: ['Nein. Ich möchte das nicht. Bitte gehen Sie.'] }
];
// Welche Szenarien welche Schwäche trainieren (adaptives Coaching)
const FOCUS = { wirkung: [2, 3, 6], zuhoeren: [6, 7, 5], pitch: [2, 3, 4], fuehrung: [5, 6, 3], einwand: [3, 4, 5, 6, 10], fachlich: [9, 8, 7], vorabschluss: [9, 1, 8, 7], closing: [1, 9, 2] };
const MODES = {
  komplett: { label: 'Komplettes Gespräch', note: '' },
  schnell: { label: 'Schnelltraining', note: 'Schnelltraining: Halte das Gespräch kompakt. Entscheide dich nach wenigen Wechseln (Rechnung holen, später, oder ablehnen).' },
  pitch: { label: 'Fokus Pitch', note: 'Fokus Pitch: Es geht um Begrüßung, Vorstellung und Einstieg. Sobald du dich entschieden hast, ob du dich auf das Gespräch einlässt (z. B. die Rechnung holen würdest) oder nicht, beende das Gespräch freundlich (ended=true).' },
  einwand: { label: 'Fokus Einwände', note: 'Fokus Einwände: Bringe deine Einwände deutlich und gib nicht zu schnell nach. Bei überzeugender Behandlung darfst du zugänglicher werden.' },
  vorabschluss: { label: 'Fokus Vorabschluss', note: 'Fokus Vorabschluss: Das Gespräch beginnt, nachdem du deine Rechnung geholt hast. Du stehst mit der Rechnung in der Hand an der Tür. Stelle typische Fragen zur Rechnung und zum Vergleich.' },
  pruefung: { label: 'Prüfungsmodus', note: '' }
};
const PROVIDERS = { strom: ['Lumora Energie GmbH', 'Vestano Strom AG', 'Stadtwerke Musterhausen', 'Nordwind Energieversorgung (fiktiv)', 'Helios Haushaltsstrom GmbH'], gas: ['Kalor Gas & Wärme GmbH', 'Stadtwerke Musterhausen', 'Gasversorgung Talfeld (fiktiv)', 'Thermova Energie AG'] };
const DEFAULTS = {
  dist: { offen: 20, normal: 30, einwand: 25, skeptisch: 15, schwierig: 10 },
  examPass: 80,
  role: 'Du bist Energieberater/in von enerwave (Vertriebspartner). Du kommst NICHT im Auftrag der Stadtwerke und bist kein Mitarbeiter des bisherigen Versorgers.',
  tariff: {
    strom: { name: 'enerwave Strom Schulungstarif (fiktiv)', ap: 28.9, gp: 11.9, garantie: '12 Monate Preisgarantie (Energiepreis, ohne Steuern/Abgaben)', laufzeit: '12 Monate, danach monatlich kündbar' },
    gas: { name: 'enerwave Gas Schulungstarif (fiktiv)', ap: 10.4, gp: 12.9, garantie: '12 Monate Preisgarantie (Energiepreis, ohne Steuern/Abgaben)', laufzeit: '12 Monate, danach monatlich kündbar' }
  },
  models: { customer: 'claude-haiku-5-5', coach: 'claude-sonnet-5-5' },
  // für spätere Verwaltung vorbereitet (werden bereits verwendet):
  coachStarts: COACH_STARTS, examStart: EXAM_START, objections: OBJECTIONS, personas: PERSONAS, scenarios: SCENARIOS, cats: CATS, critical: CRITICAL
};

/* ====================== Hilfen ====================== */
const rnd = n => crypto.randomInt(n);
const pick = a => a[rnd(a.length)];
const between = (a, b, dec = 0) => { const f = 10 ** dec; return Math.round((a + (b - a) * (crypto.randomInt(1e6) / 1e6)) * f) / f; };
const digits = n => Array.from({ length: n }, (_, i) => i === 0 ? 1 + rnd(9) : rnd(10)).join('');
const eur = n => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = rnd(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const weighted = obj => { const e = Object.entries(obj).filter(([, w]) => w > 0); const s = e.reduce((a, [, w]) => a + w, 0); let r = crypto.randomInt(1e6) / 1e6 * s; for (const [k, w] of e) { if ((r -= w) <= 0) return k; } return e[e.length - 1][0]; };
const mmss = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(Number(v) || 0)));

// Fiktive Schulungsrechnung
function makeInvoice(energy) {
  const strom = energy === 'strom';
  const kwh = strom ? 100 * Math.round(between(1400, 5600) / 100) : 500 * Math.round(between(6000, 26000) / 500);
  const ap = strom ? between(26.5, 41.9, 2) : between(8.9, 15.9, 2);          // ct/kWh brutto
  const gpm = strom ? between(9, 18.5, 2) : between(8, 21, 2);                 // €/Monat brutto
  const year = Math.round((kwh * ap / 100 + gpm * 12) * 100) / 100;
  const abschlag = Math.round(year / 12 * between(0.92, 1.18, 2));             // Abschlag weicht oft ab
  const to = new Date(); to.setMonth(to.getMonth() - 1 - rnd(5)); to.setDate(1); to.setDate(0);
  const from = new Date(to); from.setFullYear(from.getFullYear() - 1); from.setDate(from.getDate() + 1);
  const fmt = d => d.toLocaleDateString('de-DE');
  const alt = strom ? 10000 + rnd(80000) : 1000 + rnd(30000);
  return {
    hinweis: 'SCHULUNGSRECHNUNG – alle Daten fiktiv',
    energie: strom ? 'Strom' : 'Gas', anbieter: pick(PROVIDERS[energy]), tarif: pick(strom ? ['Grundversorgung Strom', 'KlassikStrom', 'StromFix 24', 'Haushaltsstrom Basis'] : ['Grundversorgung Gas', 'ErdgasKlassik', 'WärmeFix 12', 'Gas Basis']),
    kundennummer: 'K' + digits(8), vertragskonto: digits(12), zaehlernummer: strom ? '1' + pick(['ESY', 'EMH', 'ITR', 'LOG']) + digits(10) : digits(8), malo: '5' + digits(10),
    zeitraum: fmt(from) + ' – ' + fmt(to), zaehlerstand_alt: alt, zaehlerstand_neu: alt + (strom ? kwh : Math.round(kwh / 10.5)),
    verbrauch_kwh: kwh, arbeitspreis_ct: ap, grundpreis_monat: gpm, grundpreis_jahr: Math.round(gpm * 1200) / 100, jahreskosten: year, abschlag
  };
}
function invoiceText(i) {
  return `${i.hinweis}\nEnergie: ${i.energie} · Anbieter: ${i.anbieter} · Tarif: ${i.tarif}\nKundennummer: ${i.kundennummer} · Vertragskonto: ${i.vertragskonto}\nZählernummer: ${i.zaehlernummer} · MaLo-ID: ${i.malo}\nAbrechnungszeitraum: ${i.zeitraum}\nZählerstand alt/neu: ${i.zaehlerstand_alt} / ${i.zaehlerstand_neu}${i.energie === 'Gas' ? ' m³' : ' kWh'}\nVerbrauch: ${i.verbrauch_kwh} kWh\nArbeitspreis: ${String(i.arbeitspreis_ct).replace('.', ',')} ct/kWh · Grundpreis: ${eur(i.grundpreis_monat)} /Monat (${eur(i.grundpreis_jahr)} /Jahr)\nJahreskosten laut Abrechnung: ${eur(i.jahreskosten)} · Neuer monatlicher Abschlag: ${i.abschlag} €`;
}
// Referenzwerte, damit der Coach Zahlen sicher prüfen kann
function reference(inv, tariff) {
  const t = tariff, oldYear = inv.jahreskosten, newYear = Math.round((inv.verbrauch_kwh * t.ap / 100 + t.gp * 12) * 100) / 100;
  const newAbschlag = Math.round(newYear / 12);
  const est = Math.round((inv.abschlag * 12 - inv.grundpreis_jahr) / (inv.arbeitspreis_ct / 100));
  return {
    alte_jahreskosten: oldYear, neue_jahreskosten: newYear, jahresdifferenz: Math.round((oldYear - newYear) * 100) / 100,
    alter_abschlag: inv.abschlag, neuer_abschlag_ca: newAbschlag, abschlagsdifferenz: inv.abschlag - newAbschlag,
    schaetzung_ohne_rechnung_kwh: est,
    hinweis: oldYear - newYear > 0 ? 'Der Schulungstarif ist für diesen Verbrauch günstiger.' : 'Achtung: Der Schulungstarif ist für diesen Verbrauch NICHT günstiger – ehrliche Aussage erwartet.'
  };
}

/* ====================== KI-Anbindung (Anthropic Messages API) ====================== */
function partialReply() {  // liest das Feld "reply" aus gestreamtem JSON, Zeichen für Zeichen
  let buf = '', pos = -1, out = '', done = false, esc = false, uni = null;
  return chunk => {
    buf += chunk; let add = '';
    if (pos < 0) { const m = /"reply"\s*:\s*"/.exec(buf); if (!m) return ''; pos = m.index + m[0].length; }
    while (!done && pos < buf.length) {
      const c = buf[pos];
      if (uni !== null) { if (buf.length - pos < 4) break; add += String.fromCharCode(parseInt(buf.substr(pos, 4), 16)); pos += 4; uni = null; continue; }
      pos++;
      if (esc) { esc = false; if (c === 'u') { uni = ''; continue; } add += { n: '\n', t: ' ', r: '', '"': '"', '\\': '\\', '/': '/', b: '', f: '' }[c] ?? c; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { done = true; break; }
      add += c;
    }
    out += add; return add;
  };
}

module.exports = function sim({ db, send, readBody, log, now }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS sim_sessions (id TEXT PRIMARY KEY, uid TEXT NOT NULL, mode TEXT NOT NULL, ctype TEXT NOT NULL, scenario TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT, transcript TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}', score INTEGER, passed INTEGER, result TEXT);
  CREATE INDEX IF NOT EXISTS sim_sessions_uid ON sim_sessions(uid, started_at);
  CREATE TABLE IF NOT EXISTS ac_progress (uid TEXT NOT NULL, item_id INTEGER NOT NULL, kind TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, opens INTEGER NOT NULL DEFAULT 0,
    pages INTEGER, max_page INTEGER, dur REAL, played REAL, completed_at TEXT, PRIMARY KEY (uid, item_id));
  CREATE TABLE IF NOT EXISTS academy_text (file_id TEXT PRIMARY KEY, chars INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const err = (res, code, message, extra) => send(res, code, { message, ...extra });
  const getSet = k => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
  const setSet = (k, v) => v === null ? db.prepare('DELETE FROM settings WHERE key = ?').run(k) : db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  const config = () => { let c = {}; try { c = JSON.parse(getSet('simConfig') || '{}'); } catch (e) {} return { ...DEFAULTS, ...c, tariff: { ...DEFAULTS.tariff, ...(c.tariff || {}) }, models: { ...DEFAULTS.models, ...(c.models || {}) }, dist: { ...DEFAULTS.dist, ...(c.dist || {}) } }; };
  const apiKey = () => process.env.ANTHROPIC_API_KEY || getSet('aiKey') || '';

  async function claude({ model, system, messages, schema, maxTokens, stream, onText, timeout }) {
    const key = apiKey(); if (!key) throw Object.assign(Error('Der KI-Zugang ist noch nicht eingerichtet. Bitte den Administrator fragen.'), { code: 'nokey' });
    const body = { model, max_tokens: maxTokens, system, messages, stream: !!stream };
    if (schema) body.output_config = { format: { type: 'json_schema', schema } };
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      let started = false;
      try {
        const r = await fetch(API_BASE + '/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout || 60000) });
        if (!r.ok) {
          const t = await r.text().catch(() => ''); let m = ''; try { m = JSON.parse(t).error.message; } catch (e) { m = t.slice(0, 200); }
          const e = Object.assign(Error(r.status === 401 ? 'Der KI-Schlüssel ist ungültig.' : r.status === 429 ? 'Die KI ist gerade ausgelastet (Limit erreicht). Bitte kurz warten.' : 'KI-Fehler ' + r.status + (m ? ': ' + m : '')), { status: r.status });
          if (r.status === 401 || r.status === 400 || r.status === 403 || r.status === 404) throw Object.assign(e, { fatal: true });
          throw e;
        }
        if (!stream) { const j = await r.json(); const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); return { text, stop: j.stop_reason, usage: j.usage }; }
        let text = '', stop = null, carry = '';
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          carry += dec.decode(chunk, { stream: true });
          let i;
          while ((i = carry.indexOf('\n\n')) >= 0) {
            const ev = carry.slice(0, i); carry = carry.slice(i + 2);
            const line = ev.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
            let d; try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
            if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') { started = true; text += d.delta.text; if (onText) onText(d.delta.text); }
            else if (d.type === 'message_delta' && d.delta) stop = d.delta.stop_reason || stop;
            else if (d.type === 'error') throw Error((d.error && d.error.message) || 'KI-Fehler');
          }
        }
        return { text, stop };
      } catch (e) {
        lastErr = e.name === 'TimeoutError' || e.name === 'AbortError' ? Object.assign(Error('Die KI antwortet gerade nicht (Zeitüberschreitung).'), { status: 504 }) : e;
        if (e.fatal || started) break;  // nicht doppelt antworten lassen, wenn schon Text kam
        await new Promise(r => setTimeout(r, 700));
      }
    }
    throw lastErr;
  }

  /* ---------- Wissensbasis aus den Academy-PDFs (einmalig aufbereitet, nicht bei jeder Runde) ---------- */
  const BASE_KNOWLEDGE = `Grundsätze des enerwave Haustürgesprächs (Strom & Gas):
- Einstieg: freundlich, klar vorstellen (Name, Firma enerwave, Anlass), transparent sagen, worum es geht (Strom-/Gasrechnung prüfen, ob es günstiger geht). Keine falsche Zugehörigkeit (nicht „von den Stadtwerken“, wenn das nicht stimmt).
- Zuhören vor Reden: Stimmung wahrnehmen, auf das Gesagte eingehen, Fragen stellen.
- Einwände: wahrnehmen → angemessen reagieren → vereinfachen → kleinen nächsten Schritt anbieten (z. B. kurz auf die Rechnung schauen) → Entscheidung respektieren.
- Rechnung: Daten ABLESEN, nicht schätzen. MaLo-ID ≠ Zählernummer ≠ Kundennummer/Vertragskonto ≠ Zählerstand.
- Ohne Rechnung: vorsichtige Schätzung (Monatsabschlag × 12 − Jahresgrundpreis) ÷ Arbeitspreis in €/kWh = geschätzter Jahresverbrauch – immer als Schätzung kennzeichnen; Jahresabrechnung hat Vorrang.
- Tarifvergleich: Jahreskosten = Jahresverbrauch × Arbeitspreis + Jahresgrundpreis. Nicht nur den Arbeitspreis vergleichen. Eine niedrigere Abschlagszahlung ist KEINE automatische Ersparnis.
- Vorabschluss: Verbrauch, Abschlag, Arbeits- und Grundpreis erkennen, alten und neuen Tarif nachvollziehbar vergleichen, Preisgarantie/Laufzeit nur nennen, wenn hinterlegt, Ersparnis nur belegbar.
- Closing: Vertragsdaten transparent erklären, Kundendaten kontrollieren, Anbieterwechsel erklären (Kündigung/Wechsel übernimmt i. d. R. der neue Anbieter), offene Fragen klären – der Kunde muss wissen, was er bestätigt. Kein Druck.
- Ein klares Nein wird respektiert; professionelle Verabschiedung ist ein gutes Ergebnis.`;
  const knowledge = () => getSet('simKnowledge') || BASE_KNOWLEDGE;
  let kBusy = false;
  async function buildKnowledge(force) {
    if (kBusy || !apiKey()) return; kBusy = true;
    try {
      const rows = db.prepare("SELECT a.title, t.text, t.file_id FROM academy a JOIN academy_text t ON t.file_id = a.file_id WHERE a.kind = 'pdf' ORDER BY a.sort, a.id").all();
      const sig = crypto.createHash('sha256').update(rows.map(r => r.file_id).join(',')).digest('hex');
      if (!rows.length || (!force && getSet('simKnowledgeSig') === sig)) return;
      let src = '', budget = 320000;
      for (const r of rows) { const part = `\n\n### ${r.title}\n${r.text}`.slice(0, Math.max(0, Math.floor(budget / 1))); src += part; budget -= part.length; if (budget <= 0) break; }
      const r = await claude({ model: config().models.coach, maxTokens: 6000, timeout: 240000,
        system: 'Du bereitest Schulungsunterlagen eines Energievertriebs (Haustürgeschäft Strom & Gas) als kompakte, sachliche Wissensbasis für einen KI-Verkaufstrainer auf. Schreibe auf Deutsch, strukturiert mit kurzen Stichpunkten. Gib nur Inhalte wieder, die in den Unterlagen stehen – nichts erfinden.',
        messages: [{ role: 'user', content: 'Fasse die folgenden enerwave Schulungsunterlagen zusammen (höchstens ca. 1800 Wörter). Gliederung: 1. Einstieg/Pitch-Bausteine (Kernaussagen, keine Wort-für-Wort-Skripte), 2. Einwände und empfohlene Behandlung, 3. Rechnungsanalyse & Vorabschluss, 4. Closing & Transparenzpflichten, 5. Fachwissen Strom/Gas, 6. Do’s & Don’ts.\n\nUNTERLAGEN:' + src }] });
      if (r.text.trim().length > 200) { setSet('simKnowledge', BASE_KNOWLEDGE + '\n\nAUS DEN ENERWAVE SCHULUNGSUNTERLAGEN:\n' + r.text.trim()); setSet('simKnowledgeSig', sig); setSet('simKnowledgeAt', now()); log('Kundensimulator: Wissensbasis aus', rows.length, 'Unterlage(n) aufbereitet.'); }
    } catch (e) { log('Kundensimulator: Wissensbasis nicht aufbereitet –', e.message); }
    finally { kBusy = false; }
  }
  setTimeout(() => buildKnowledge(false), 8000);

  /* ---------- Kunde: Prompt und Antwortformat ---------- */
  const CUSTOMER_SCHEMA = { type: 'object', additionalProperties: false, required: ['reply', 'trust', 'openness', 'time_pressure', 'skepticism', 'buy_readiness', 'annoyance', 'phase', 'show_invoice', 'ended', 'outcome', 'memory', 'objections_raised', 'open_questions'],
    properties: {
      reply: { type: 'string', description: 'Was der Kunde jetzt sagt (gesprochene Sprache, ohne Regieanweisungen).' },
      trust: { type: 'integer' }, openness: { type: 'integer' }, time_pressure: { type: 'integer' }, skepticism: { type: 'integer' }, buy_readiness: { type: 'integer' }, annoyance: { type: 'integer' },
      phase: { type: 'string', enum: ['tuer', 'gespraech', 'einwand', 'rechnung', 'vorabschluss', 'closing', 'ende'] },
      show_invoice: { type: 'boolean', description: 'true, sobald der Kunde seine Rechnung geholt hat und sie zeigt.' },
      ended: { type: 'boolean', description: 'true, wenn das Gespräch vorbei ist (Tür zu, verabschiedet, Abschluss erledigt).' },
      outcome: { type: 'string', enum: ['offen', 'abschluss', 'spaeter', 'abgelehnt', 'abgebrochen'] },
      memory: { type: 'array', items: { type: 'string' }, description: 'NEUE wichtige Fakten aus der letzten Verkäufer-Aussage: genannte Zahlen, Versprechen, Behauptungen, Widersprüche (kurz).' },
      objections_raised: { type: 'array', items: { type: 'string' }, description: 'Alle bisher von dir gebrachten Einwände/Fragen.' },
      open_questions: { type: 'array', items: { type: 'string' }, description: 'Deine noch nicht zufriedenstellend beantworteten Fragen.' }
    } };
  const CUSTOMER_RULES = `Du spielst in einem Verkaufstraining für Haustürgespräche (Strom & Gas) einen KUNDEN an seiner Haustür. Du bist ausschließlich dieser Kunde – nie Coach, nie Erzähler, nie KI.

SO SPRICHST DU
- Natürliches, gesprochenes Deutsch, passend zu Alter und Persönlichkeit. Meist 1–3 kurze Sätze, damit das Gespräch flüssig bleibt. Keine Regieanweisungen, keine Sternchen, keine Emojis.
- Keine Tipps, keine Bewertung, keine Musterantworten, keine Punkte, keine Hinweise auf das Training.
- Sieze den Verkäufer, außer du bist jung/direkt und er duzt dich.
- Keine Karikatur: realistische Menschen mit nachvollziehbaren Reaktionen.

GESPRÄCHSGEDÄCHTNIS
- Berücksichtige alles bisher Gesagte: Aussagen, gestellte und beantwortete Fragen, genannte Zahlen, deine bisherigen Einwände, gemachte Versprechen, Widersprüche, Transparenz, Druck.
- Frage nicht erneut, was schon gut beantwortet wurde. Bemerke Widersprüche („Eben sagten Sie noch …“).

INNERER ZUSTAND (0–100, geheim, steuert dein Verhalten; ändere ihn pro Runde meist um höchstens 15)
- Gutes Zuhören → Vertrauen steigt. Transparente Antwort → Vertrauen steigt, Skepsis sinkt.
- Ignoriert werden / andere Frage beantwortet → Vertrauen sinkt, Genervtheit steigt.
- Unbelegte Behauptung → Skepsis steigt deutlich.
- Druck trotz klarer Ablehnung → Vertrauen sinkt stark, Genervtheit steigt stark.
- Hoher Zeitdruck → du willst schnell zum Punkt oder beenden.

EINWÄNDE
- Bringe die für dich vorgesehenen Einwände an passender Stelle, nicht alle auf einmal. Gute Behandlung → du wirst zugänglicher und wiederholst den Einwand nicht stur. Schwache Behandlung → nachhaken oder abblocken.

RECHNUNG
- Hole die Rechnung nur, wenn es zu deinem Szenario passt und Vertrauen und Offenheit reichen (offene Kunden früh, andere erst nach überzeugender Erklärung). Dann sagst du z. B. „Moment, ich hol sie kurz.“ und setzt show_invoice=true. Der Verkäufer liest die Rechnung selbst – lies sie nicht komplett vor, beantworte aber Fragen dazu.
- Bemerke falsche Zahlen, falsch abgelesene Felder (MaLo-ID, Zählernummer, Kundennummer verwechselt) oder wenn ein niedrigerer Abschlag als Ersparnis verkauft wird – je nach Wissensstand fragst du kritisch nach („Wie kommen Sie auf diese Zahl?“, „Spare ich jetzt wirklich?“).
- Typische Fragen im Vorabschluss: „Warum ist mein Abschlag so hoch?“, „Spare ich jetzt wirklich?“, „Wie kommen Sie auf diese Zahl?“, „Was ist der Grundpreis?“, „Was passiert mit meinem alten Vertrag?“, „Wie lange gilt der Preis?“, „Was passiert, wenn ich weniger verbrauche?“

ROLLE DES VERKÄUFERS
- Die tatsächliche Rolle des Verkäufers steht im Szenario. Behauptet er eine andere Zugehörigkeit (z. B. Stadtwerke), steigt deine Skepsis; weicht er auf Nachfrage aus, noch mehr.

ABSCHLUSS UND ENDE
- Du stimmst einem Wechsel nur zu, wenn du verstanden hast, was du bestätigst, und deine Kaufbereitschaft hoch ist (etwa ab 70). Bleibt etwas unklar, fragst du nach. Bei Zusage: outcome=abschluss.
- Du darfst auch „später“ sagen (outcome=spaeter) oder dich bewusst dagegen entscheiden.
- Klare Ablehnung ist erlaubt. Respektiert der Verkäufer sie und verabschiedet sich, beendest du das Gespräch (ended=true, outcome=abgelehnt). Drängt er weiter, wirst du deutlicher und schließt die Tür (ended=true).
- ended=true, sobald das Gespräch an der Tür wirklich vorbei ist.

FACHLICHER HINTERGRUND DER FIRMA (nur damit du realistisch reagierst; du selbst bist Laie, außer deine Persönlichkeit sagt etwas anderes):
`;
  function customerSystem(s) {
    const sc = s.scenario, st = s.state;
    const dyn = `SZENARIO (geheim)
Kundentyp: ${TYPES[sc.ctype].label} – ${TYPES[sc.ctype].desc}
Ausgangssituation: ${sc.title}
Du: ${sc.name}, ${sc.age} Jahre, ${sc.persona}. ${sc.situation}
Trainingsmodus: ${MODES[s.mode].label}. ${MODES[s.mode].note}
Mögliche Einwände/Fragen für dich (eigene Formulierung, passend einsetzen): ${sc.objections.length ? sc.objections.join(' | ') : 'keine – du bist offen'}
Rechnung: ${sc.bill === 'sofort' ? 'liegt griffbereit, du holst sie bei einem vernünftigen Gespräch schnell' : sc.bill === 'keine' ? 'nicht im Haus (du findest sie nicht). Du kennst nur: monatlicher Abschlag ' + sc.invoice.abschlag + ' €, Anbieter ' + sc.invoice.anbieter + (sc.knowsPrices ? ', ungefähr ' + String(sc.invoice.arbeitspreis_ct).replace('.', ',') + ' ct/kWh und ' + eur(sc.invoice.grundpreis_monat) + ' Grundpreis im Monat (aus der App des Anbieters)' : '') : sc.bill === 'nie' ? 'du willst sie keinesfalls zeigen' : 'im Haus; du holst sie nur, wenn du Vertrauen gefasst hast'}
Daten deiner Rechnung (kennst du, liest du aber nicht ungefragt vor):
${invoiceText(sc.invoice)}
Tatsächliche Rolle des Verkäufers: ${sc.role}
Schulungstarif, den der Verkäufer anbieten kann (kennst du NICHT, bis er ihn erklärt): ${sc.tariff.name}: ${String(sc.tariff.ap).replace('.', ',')} ct/kWh, Grundpreis ${eur(sc.tariff.gp)}/Monat, ${sc.tariff.garantie}, ${sc.tariff.laufzeit}.

AKTUELLER INNERER ZUSTAND: Vertrauen ${st.trust}, Offenheit ${st.openness}, Zeitdruck ${st.time_pressure}, Skepsis ${st.skepticism}, Kaufbereitschaft ${st.buy_readiness}, Genervtheit ${st.annoyance}. Phase: ${st.phase}. Rechnung gezeigt: ${st.show_invoice ? 'ja' : 'nein'}.
GEDÄCHTNIS (wichtige Punkte bisher): ${(st.memory || []).slice(-25).join(' | ') || '–'}
Bisherige Einwände: ${(st.objections_raised || []).join(' | ') || '–'}
Offene Fragen: ${(st.open_questions || []).join(' | ') || '–'}`;
    return [{ type: 'text', text: CUSTOMER_RULES + knowledge(), cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: dyn }];
  }
  const custMessages = s => {
    const msgs = [];
    for (const t of s.transcript) {
      if (t.who === 'v') msgs.push({ role: 'user', content: `[${mmss(t.t || 0)}] Verkäufer: ${t.text}` });
      else if (t.who === 'k') msgs.push({ role: 'assistant', content: t.text });
      else if (t.who === 'x') msgs.push({ role: 'user', content: t.text });
    }
    // aufeinanderfolgende gleiche Rollen zusammenfassen (API verlangt Wechsel)
    const out = [];
    for (const m of msgs) { const l = out[out.length - 1]; if (l && l.role === m.role) l.content += '\n' + m.content; else out.push({ ...m }); }
    if (out.length && out[0].role === 'assistant') out.unshift({ role: 'user', content: '[Gespräch beginnt]' });
    return out;
  };

  /* ---------- Szenario auswählen (zufällig, nach Verteilung, adaptiv) ---------- */
  function weakest(uid) {
    const rows = db.prepare("SELECT result FROM sim_sessions WHERE uid = ? AND status = 'done' AND result IS NOT NULL ORDER BY ended_at DESC LIMIT 10").all(uid);
    const agg = {};
    for (const r of rows) { let res; try { res = JSON.parse(r.result); } catch (e) { continue; } for (const c of res.categories || []) if (c.applicable) { (agg[c.key] = agg[c.key] || []).push(c.pct); } }
    const avg = Object.entries(agg).filter(([, v]) => v.length >= 1).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]).sort((a, b) => a[1] - b[1]);
    return avg.length && rows.length >= 2 ? avg[0][0] : null;
  }
  function buildScenario(uid, mode, opts) {
    const cfg = config();
    let sc;
    const weak = opts.weakness || (mode !== 'pruefung' && !opts.ctype && rnd(100) < 30) ? weakest(uid) : null;
    if (opts.ctype) sc = pick(SCENARIOS.filter(x => x.type === opts.ctype));
    else if (weak && FOCUS[weak]) { const sid = pick(FOCUS[weak]); sc = SCENARIOS.find(x => x.id === sid); }
    else if (mode === 'einwand') sc = pick(SCENARIOS.filter(x => ['einwand', 'skeptisch', 'schwierig'].includes(x.type)));
    else if (mode === 'vorabschluss') sc = pick(SCENARIOS.filter(x => x.bill === 'sofort' || x.bill === 'nach_vertrauen'));
    else { const t = weighted(cfg.dist); sc = pick(SCENARIOS.filter(x => x.type === t)); }
    if (mode === 'vorabschluss' && (sc.bill === 'keine' || sc.bill === 'nie')) sc = SCENARIOS[8];
    if (process.env.SIM_FORCE_SCENARIO) sc = SCENARIOS.find(x => x.id === +process.env.SIM_FORCE_SCENARIO) || sc;  // nur für automatische Tests
    const energy = rnd(100) < 62 ? 'strom' : 'gas';
    const invoice = makeInvoice(energy);
    const female = rnd(2) === 0;
    const ages = sc.persona === 'älter und erklärungsbedürftig' ? [68, 84] : [24, 79];
    const persona = sc.persona || pick(cfg.personas.filter(p => sc.type === 'offen' ? !['misstrauisch', 'skeptisch', 'gestresst', 'ungeduldig'].includes(p) : true));
    let age = between(ages[0], ages[1]); if (persona === 'jung und direkt') age = between(21, 32); if (persona === 'älter und erklärungsbedürftig') age = between(70, 86);
    const last = pick(['Berger', 'Yilmaz', 'Hoffmann', 'Kowalski', 'Schneider', 'Weber', 'Nguyen', 'Fischer', 'Krüger', 'Schulz', 'Demir', 'Wagner', 'Lehmann', 'Becker']);
    const pool = sc.type === 'offen' ? [] : shuffle(cfg.objections[sc.type] || cfg.objections.einwand);
    const [lo, hi] = TYPES[sc.type].objections; const n = Math.max(sc.objections || 0, lo + rnd(hi - lo + 1));
    const objections = [...new Set([...(sc.fixed || []), ...pool])].slice(0, Math.max(n, (sc.fixed || []).length));
    const situation = pick(sc.type === 'schwierig' ? ['Du bist gerade beim Kochen und genervt von der Störung.', 'Du hattest schlechte Erfahrungen mit Haustürverkäufern.', 'Du bist im Stress, gleich musst du los.'] :
      sc.type === 'offen' ? ['Du hast heute frei und Zeit.', 'Du ärgerst dich schon länger über deine Stromkosten.', 'Du hast gerade an deine Nebenkosten gedacht.'] :
      ['Du warst gerade im Garten.', 'Du hast gerade Kaffee getrunken.', 'Du hast nicht mit Besuch gerechnet.', 'Du bist gerade von der Arbeit gekommen.']);
    return { sid: sc.id, ctype: sc.type, title: sc.title, bill: sc.bill, hard: !!sc.hard, persona, age, name: (female ? 'Frau ' : 'Herr ') + last, gender: female ? 'w' : 'm', situation, objections,
      knowsPrices: sc.bill === 'keine' && rnd(2) === 0, energy, invoice, tariff: cfg.tariff[energy], tariffs: cfg.tariff, role: cfg.role, weakness: weak || null };
  }
  const INITIAL = t => ({ offen: [62, 65, 25, 20, 40, 5], normal: [45, 45, 40, 35, 25, 10], einwand: [35, 30, 55, 45, 15, 20], skeptisch: [25, 35, 35, 75, 15, 15], schwierig: [15, 15, 75, 60, 5, 45] }[t]);
  const sessionOut = (s, full) => ({ id: s.id, mode: s.mode, status: s.status, started: s.started_at,
    transcript: s.transcript.filter(t => t.who !== 'x').map(t => ({ who: t.who, text: t.text, t: t.t })),
    invoice: s.state.show_invoice ? s.scenario.invoice : null, ended: !!s.state.ended,
    brief: { role: s.scenario.role, tariffs: s.scenario.tariffs || { [s.scenario.energy]: s.scenario.tariff } },
    voice: { gender: s.scenario.gender, age: s.scenario.age },
    ...(full ? { reveal: { type: TYPES[s.scenario.ctype].label, ctype: s.scenario.ctype, persona: s.scenario.persona, name: s.scenario.name, scenario: s.scenario.title } } : {}) });
  const load = id => { const r = db.prepare('SELECT * FROM sim_sessions WHERE id = ?').get(String(id)); if (!r) return null; return { ...r, scenario: JSON.parse(r.scenario), transcript: JSON.parse(r.transcript), state: JSON.parse(r.state), result: r.result ? JSON.parse(r.result) : null }; };
  const saveSession = s => db.prepare('UPDATE sim_sessions SET transcript = ?, state = ?, status = ? WHERE id = ?').run(JSON.stringify(s.transcript), JSON.stringify(s.state), s.status, s.id);
  const pending = new Map();  // laufende Kunden-Antworten je Gespräch (verhindert doppelte Anfragen)

  /* ---------- eine Gesprächsrunde: Verkäufer sagt etwas → Kunde antwortet (gestreamt) ---------- */
  async function customerTurn(s, onText) {
    const cfg = config();
    const r = await claude({ model: cfg.models.customer, system: customerSystem(s), messages: custMessages(s), schema: CUSTOMER_SCHEMA, maxTokens: 900, stream: true, timeout: 45000, onText });
    let j; try { j = JSON.parse(r.text); } catch (e) { throw Error('Die Antwort des Kunden war unvollständig. Bitte noch einmal senden.'); }
    const reply = String(j.reply || '').trim() || '…';
    const st = s.state;
    for (const k of ['trust', 'openness', 'time_pressure', 'skepticism', 'buy_readiness', 'annoyance']) st[k] = clamp(j[k], 0, 100);
    st.phase = j.phase || st.phase; st.outcome = j.outcome || st.outcome;
    if (j.show_invoice && s.scenario.bill !== 'keine' && s.scenario.bill !== 'nie') st.show_invoice = true;
    if (j.ended) st.ended = true;
    st.memory = [...(st.memory || []), ...(j.memory || []).map(x => String(x).slice(0, 200))].slice(-40);
    st.objections_raised = (j.objections_raised || st.objections_raised || []).slice(0, 12).map(x => String(x).slice(0, 160));
    st.open_questions = (j.open_questions || []).slice(0, 8).map(x => String(x).slice(0, 160));
    st.trace = [...(st.trace || []), { t: s.transcript.length ? s.transcript[s.transcript.length - 1].t : 0, trust: st.trust, skepticism: st.skepticism, annoyance: st.annoyance, buy: st.buy_readiness, phase: st.phase }].slice(-80);
    return reply;
  }

  /* ---------- Coach: Auswertung nach dem Gespräch ---------- */
  const COACH_SCHEMA = { type: 'object', additionalProperties: false, required: ['categories', 'label', 'summary', 'strengths', 'potentials', 'improvements', 'timeline', 'critical', 'outcome'],
    properties: {
      categories: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'applicable', 'pct', 'comment'], properties: { key: { type: 'string', enum: CATS.map(c => c.key) }, applicable: { type: 'boolean' }, pct: { type: 'integer', description: '0–100: wie gut diese Kategorie erfüllt wurde' }, comment: { type: 'string' } } } },
      label: { type: 'string', description: 'kurzes Gesamturteil, z. B. „Gutes Gespräch“' },
      summary: { type: 'string', description: '2–3 Sätze Coaching-Zusammenfassung' },
      strengths: { type: 'array', items: { type: 'string' }, description: '2–4 konkrete Punkte aus genau diesem Gespräch' },
      potentials: { type: 'array', items: { type: 'string' }, description: '2–4 konkrete Punkte aus genau diesem Gespräch' },
      improvements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['what', 'why', 'effect', 'better', 'example'], properties: { what: { type: 'string' }, why: { type: 'string' }, effect: { type: 'string' }, better: { type: 'string' }, example: { type: 'string' } } } },
      timeline: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['t', 'topic', 'rating', 'note'], properties: { t: { type: 'string', description: 'mm:ss' }, topic: { type: 'string' }, rating: { type: 'string', enum: ['gruen', 'gelb', 'rot'] }, note: { type: 'string' } } } },
      critical: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'note'], properties: { key: { type: 'string', enum: Object.keys(CRITICAL) }, note: { type: 'string' } } } },
      outcome: { type: 'string', enum: ['abschluss', 'spaeter', 'rechnung_geprueft', 'bewusst_dagegen', 'ablehnung_respektiert', 'abgebrochen', 'offen'] }
    } };
  const COACH_RULES = `Du bist ein erfahrener, wertschätzender Verkaufscoach für Haustürgespräche (Strom & Gas) bei enerwave. Du wertest ein Trainingsgespräch mit einem virtuellen Kunden aus.

BEWERTUNGSGRUNDSÄTZE
- Die enerwave Pitches und Einwandbehandlungen sind fachliche Grundlage, aber NICHT Wort für Wort. Eigene Formulierungen sind ausdrücklich erwünscht: Inhalt richtig, andere Worte = POSITIV.
- Auswendig aufgesagter Pitch ohne Zuhören ist KEINE perfekte Leistung. Ziel: gute Verkäufer, keine Roboter.
- Bewerte: Inhalt, Wirkung, Authentizität, Selbstverständlichkeit, Zuhören, Empathie, Gesprächsführung, Einwandbehandlung (wahrnehmen → angemessen reagieren → vereinfachen → kleiner nächster Schritt → Entscheidung respektieren), Fachwissen, Transparenz, Kundenorientierung, Vorabschluss, Closing.
- Positiv: eigene authentische Sprache, natürliches Auftreten, aktives Zuhören, Empathie, passende Reaktion, Ruhe, Selbstverständlichkeit, korrekte Zahlen, Transparenz, verständliche Erklärung, sinnvoller nächster Schritt, professionelles Closing, respektvoller Umgang mit Ablehnung.
- Abzug: Kunde nicht gehört, andere Frage beantwortet, monotones Aufsagen, Widersprüche, falsche Zahlen, falsche Rechnungsdaten (MaLo-ID ≠ Zählernummer ≠ Kundennummer/Vertragskonto ≠ Zählerstand), Abschlagsdifferenz als garantierte Ersparnis, unbelegte Versprechen, falsche Unternehmensrolle, unnötiger Druck, klare Ablehnung nicht respektiert, wichtige Vertragsinformationen verschwiegen, Kunde versteht nicht, was er bestätigt.
- Tarifvergleich: Jahreskosten = Verbrauch × Arbeitspreis + Jahresgrundpreis. Eine niedrigere Abschlagszahlung ist NICHT automatisch Ersparnis („Der monatliche Abschlag reduziert sich um 20 €“ ist korrekt, „Sie sparen 240 € im Jahr“ nur mit vergleichbaren Jahresgesamtkosten). Falsche Darstellung → deutlicher fachlicher Abzug und Erklärung.
- Ohne Rechnung ist eine vorsichtige Schätzung erlaubt: (Monatsabschlag × 12 − Jahresgrundpreis) ÷ Arbeitspreis in €/kWh – muss als Schätzung gekennzeichnet sein.
- Preisgarantie/Laufzeit nur nennen, wenn hinterlegt (siehe Schulungstarif). „Ich bin von den Stadtwerken“ / „im Auftrag der Stadtwerke“ nur positiv, wenn die Rolle im Szenario wirklich besteht – sonst kritischer Fehler „rolle“.
- Ein Abschluss durch Druck oder Unklarheit ist NICHT besser als ein sauberer, transparenter Abschluss. Erfolg ist nicht nur ein Vertrag: sauberer Abschluss, Kunde möchte später sprechen, Rechnung korrekt geprüft, Kunde entscheidet sich bewusst dagegen, eindeutige Ablehnung professionell respektiert – alles gute Ergebnisse.
- Kategorien, die im Gespräch nicht vorkommen konnten (z. B. kein Vorabschluss, weil der Kunde klar abgelehnt hat), setzt du auf applicable=false – das ist KEIN Abzug. Bewerte das, was im Szenario möglich war.
- Kritische Fehler nur eintragen, wenn sie eindeutig passiert sind.

AUSGABE
- categories: alle 8 Kategorien genau einmal (wirkung, zuhoeren, pitch, fuehrung, einwand, fachlich, vorabschluss, closing).
- strengths / potentials: je 2–4 konkrete Punkte aus GENAU diesem Gespräch (mit Bezug auf Aussagen).
- improvements: für jeden relevanten Fehler: 1. WAS ist passiert, 2. WARUM problematisch, 3. WELCHE WIRKUNG beim Kunden, 4. WAS wäre besser, 5. BEISPIEL-Formulierung (als Beispiel, nicht als einzig richtige Antwort, natürlich formuliert).
- timeline: wichtige Momente mit Zeitstempel (mm:ss) aus dem Protokoll, rating gruen/gelb/rot.
- Sprich den Mitarbeiter mit „du“ an. Deutsch, klar, motivierend, ehrlich.`;
  async function evaluate(s) {
    const cfg = config(), sc = s.scenario, ref = reference(sc.invoice, sc.tariff);
    const proto = s.transcript.filter(t => t.who !== 'x').map(t => `[${mmss(t.t || 0)}] ${t.who === 'v' ? 'VERKÄUFER' : 'KUNDE'}: ${t.text}`).join('\n');
    const facts = `TRAININGSMODUS: ${MODES[s.mode].label}
KUNDENTYP: ${TYPES[sc.ctype].label} (${sc.persona}, ${sc.age} J.) – Szenario: ${sc.title}
TATSÄCHLICHE ROLLE DES VERKÄUFERS: ${sc.role}
RECHNUNG: ${sc.bill === 'keine' ? 'keine Rechnung im Haus; Kunde kennt Abschlag ' + sc.invoice.abschlag + ' €' + (sc.knowsPrices ? ' sowie ungefähr Arbeits- und Grundpreis' : '') : sc.bill === 'nie' ? 'Kunde wollte keine Rechnung zeigen' : (s.state.show_invoice ? 'wurde gezeigt' : 'wurde NICHT gezeigt')}
${invoiceText(sc.invoice)}
SCHULUNGSTARIF: ${sc.tariff.name}: ${String(sc.tariff.ap).replace('.', ',')} ct/kWh, ${eur(sc.tariff.gp)}/Monat, ${sc.tariff.garantie}, ${sc.tariff.laufzeit}
REFERENZWERTE (vom System berechnet, zur Prüfung der genannten Zahlen): ${JSON.stringify(ref)}
VERLAUF DES KUNDEN (intern): ${JSON.stringify((s.state.trace || []).map(x => [x.t, x.trust, x.skepticism, x.annoyance, x.buy, x.phase]))} (t, Vertrauen, Skepsis, Genervtheit, Kaufbereitschaft, Phase)
ERGEBNIS LAUT KUNDE: ${s.state.outcome || 'offen'}${s.state.ended ? ' (Gespräch vom Kunden beendet)' : ' (vom Verkäufer beendet)'}

GESPRÄCHSPROTOKOLL:
${proto || '(kein Gespräch)'}`;
    const r = await claude({ model: cfg.models.coach, maxTokens: 5000, timeout: 150000, schema: COACH_SCHEMA,
      system: [{ type: 'text', text: COACH_RULES + '\n\nFACHLICHE GRUNDLAGE:\n' + knowledge(), cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: facts }] });
    let j; try { j = JSON.parse(r.text); } catch (e) { throw Error('Die Auswertung war unvollständig. Bitte erneut auswerten.'); }
    // Punkte serverseitig berechnen: nur Kategorien, die im Gespräch vorkamen; auf 100 hochgerechnet
    const cats = CATS.map(c => { const x = (j.categories || []).find(y => y.key === c.key) || { applicable: false, pct: 0, comment: '' }; return { key: c.key, label: c.label, max: c.max, applicable: !!x.applicable, pct: clamp(x.pct, 0, 100), comment: String(x.comment || ''), points: x.applicable ? Math.round(c.max * clamp(x.pct, 0, 100) / 100 * 10) / 10 : null }; });
    const app = cats.filter(c => c.applicable);
    const total = app.length ? Math.round(app.reduce((a, c) => a + c.max * c.pct / 100, 0) / app.reduce((a, c) => a + c.max, 0) * 100) : 0;
    const critical = (j.critical || []).filter(c => CRITICAL[c.key]).map(c => ({ key: c.key, label: CRITICAL[c.key], note: String(c.note || '') }));
    const exam = s.mode === 'pruefung';
    const passed = exam ? (total >= cfg.examPass && !critical.length) : null;
    return { total, label: String(j.label || ''), summary: String(j.summary || ''), categories: cats, strengths: (j.strengths || []).slice(0, 4), potentials: (j.potentials || []).slice(0, 4),
      improvements: (j.improvements || []).slice(0, 6), timeline: (j.timeline || []).slice(0, 14), critical, outcome: j.outcome || 'offen', exam, passed, examPass: cfg.examPass,
      reveal: { type: TYPES[sc.ctype].label, ctype: sc.ctype, persona: sc.persona, name: sc.name, scenario: sc.title, weakness: sc.weakness }, reference: ref };
  }

  /* ---------- Lernfortschritt ---------- */
  function simSummary(uid) {
    const rows = db.prepare("SELECT id, mode, ctype, started_at, ended_at, score, passed, result FROM sim_sessions WHERE uid = ? AND status = 'done' ORDER BY ended_at").all(uid);
    const scores = rows.map(r => r.score).filter(x => x !== null);
    const agg = {};
    for (const r of rows) { let res; try { res = JSON.parse(r.result); } catch (e) { continue; } for (const c of res.categories || []) if (c.applicable) (agg[c.key] = agg[c.key] || []).push(c.pct); }
    const cats = CATS.map(c => ({ key: c.key, label: c.label, pct: agg[c.key] ? Math.round(agg[c.key].reduce((a, b) => a + b, 0) / agg[c.key].length) : null, n: (agg[c.key] || []).length }));
    const rated = cats.filter(c => c.pct !== null).sort((a, b) => b.pct - a.pct);
    const exams = rows.filter(r => r.mode === 'pruefung');
    const lastExam = exams[exams.length - 1];
    const last10 = scores.slice(-10), half = Math.floor(last10.length / 2);
    const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
    return {
      count: rows.length, avg: avg(scores), best: scores.length ? Math.max(...scores) : null,
      trend: last10.length >= 4 ? { from: avg(last10.slice(0, half)), to: avg(last10.slice(half)), n: last10.length } : null,
      scores: rows.slice(-20).map(r => ({ id: r.id, at: r.ended_at, score: r.score, mode: r.mode, exam: r.mode === 'pruefung', passed: r.passed === null ? null : !!r.passed })),
      categories: cats, strongest: rated[0] || null, focus: rated.length >= 2 ? rated[rated.length - 1] : null,
      exams: exams.map(r => ({ id: r.id, at: r.ended_at, score: r.score, passed: !!r.passed })),
      ready: !!(lastExam && lastExam.passed), lastAt: rows.length ? rows[rows.length - 1].ended_at : null
    };
  }
  function progressOf(uid) {
    const items = db.prepare('SELECT id, kind, title, file_id FROM academy WHERE file_id IS NOT NULL ORDER BY kind, sort, id').all();
    const prog = Object.fromEntries(db.prepare('SELECT * FROM ac_progress WHERE uid = ?').all(uid).map(p => [p.item_id, p]));
    const list = items.map(a => { const p = prog[a.id]; return { id: a.id, kind: a.kind, title: a.title,
      status: !p ? 'neu' : a.kind === 'video' ? (p.completed_at ? 'fertig' : 'gestartet') : 'geoeffnet',
      opens: p ? p.opens : 0, first: p ? p.first_at : null, last: p ? p.last_at : null,
      pages: p && p.pages ? p.pages : null, maxPage: p && p.max_page ? p.max_page : null,
      pct: p && a.kind === 'video' && p.dur ? Math.min(100, Math.round(p.played / p.dur * 100)) : null, completed: p ? p.completed_at : null }; });
    const pdfs = list.filter(x => x.kind === 'pdf'), vids = list.filter(x => x.kind === 'video');
    const sim = simSummary(uid);
    const done = pdfs.filter(x => x.status !== 'neu').length + vids.filter(x => x.status === 'fertig').length;
    const lastP = Object.values(prog).map(p => p.last_at).sort().pop() || null;
    return { items: list, pdf: { seen: pdfs.filter(x => x.status !== 'neu').length, total: pdfs.length }, video: { done: vids.filter(x => x.status === 'fertig').length, started: vids.filter(x => x.status !== 'neu').length, total: vids.length },
      pct: list.length ? Math.round(done / list.length * 100) : null, sim, lastActivity: [lastP, sim.lastAt].filter(Boolean).sort().pop() || null };
  }

  /* ====================== Anfragen ====================== */
  async function handle(req, res, p, M, me, meRow, isAdmin) {
    const uid = me.uid;
    let m;
    /* ---- Lernfortschritt ---- */
    if (p === 'progress' && M === 'POST') {  // asynchron aus PDF-Leser / Videoplayer
      const b = await readBody(req).catch(() => null) || {};
      const a = db.prepare('SELECT id, kind FROM academy WHERE id = ? AND file_id IS NOT NULL').get(Number(b.item));
      if (!a) return err(res, 404, 'Nicht gefunden.');
      const t = now(), old = db.prepare('SELECT * FROM ac_progress WHERE uid = ? AND item_id = ?').get(uid, a.id);
      const open = b.event === 'open' ? 1 : 0;
      if (!old) db.prepare('INSERT INTO ac_progress (uid, item_id, kind, first_at, last_at, opens) VALUES (?, ?, ?, ?, ?, 0)').run(uid, a.id, a.kind, t, t);
      if (a.kind === 'pdf') {
        const pages = clamp(b.pages, 0, 5000) || null, page = clamp(b.page, 0, 5000);
        db.prepare('UPDATE ac_progress SET last_at = ?, opens = opens + ?, pages = COALESCE(?, pages), max_page = MAX(COALESCE(max_page, 0), ?) WHERE uid = ? AND item_id = ?').run(t, open, pages, Math.min(page, pages || page), uid, a.id);
      } else {
        const dur = Math.max(0, Math.min(36000, Number(b.dur) || 0)), played = Math.max(0, Math.min(dur || 36000, Number(b.played) || 0));
        db.prepare('UPDATE ac_progress SET last_at = ?, opens = opens + ?, dur = CASE WHEN ? > 0 THEN ? ELSE dur END, played = MAX(COALESCE(played, 0), ?) WHERE uid = ? AND item_id = ?').run(t, open, dur, dur, played, uid, a.id);
        // „vollständig angesehen“ erst ab 90 % tatsächlich abgespielter Zeit (Vorspulen zählt nicht)
        db.prepare('UPDATE ac_progress SET completed_at = ? WHERE uid = ? AND item_id = ? AND completed_at IS NULL AND dur > 0 AND played >= dur * 0.9').run(t, uid, a.id);
      }
      return send(res, 200, { ok: true });
    }
    if (p === 'progress' && M === 'GET') {
      const url = new URL(req.url, 'http://x'), who = url.searchParams.get('uid') || uid;
      if (who !== uid && !isAdmin) return err(res, 403, 'Nur der Administrator sieht den Fortschritt anderer Mitarbeiter.');
      const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(who); if (!u) return err(res, 404, 'Mitarbeiter nicht gefunden.');
      return send(res, 200, { user: u, ...progressOf(who) });
    }
    if (p === 'progress/overview' && M === 'GET') {
      if (!isAdmin) return err(res, 403, 'Nur für den Administrator.');
      const us = db.prepare('SELECT id, name, admin, access FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
      return send(res, 200, us.map(u => { const pr = progressOf(u.id); return { id: u.id, name: u.name, admin: !!u.admin, access: u.access, pct: pr.pct, sims: pr.sim.count, avg: pr.sim.avg, best: pr.sim.best, ready: pr.sim.ready, exams: pr.sim.exams.length, lastActivity: pr.lastActivity, focus: pr.sim.focus ? pr.sim.focus.label : null }; }));
    }
    /* ---- PDF-Texte für die Wissensbasis (liest der Browser des Admins aus) ---- */
    if ((m = /^academy\/(\d+)\/text$/.exec(p)) && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator.');
      const a = db.prepare("SELECT * FROM academy WHERE id = ? AND kind = 'pdf' AND file_id IS NOT NULL").get(Number(m[1])); if (!a) return err(res, 404, 'Nicht gefunden.');
      const b = await readBody(req).catch(() => null) || {}; const text = String(b.text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 400000);
      db.prepare('INSERT OR REPLACE INTO academy_text (file_id, chars, text, created_at) VALUES (?, ?, ?, ?)').run(a.file_id, text.length, text, now());
      setTimeout(() => buildKnowledge(false), 2000);
      return send(res, 200, { ok: true, chars: text.length });
    }
    if (p === 'academy/texts' && M === 'GET') {  // welche PDFs sind schon ausgelesen (nur Admin)
      if (!isAdmin) return err(res, 403, 'Nur der Administrator.');
      return send(res, 200, db.prepare("SELECT a.id, a.file_id, t.chars FROM academy a LEFT JOIN academy_text t ON t.file_id = a.file_id WHERE a.kind = 'pdf' AND a.file_id IS NOT NULL").all());
    }

    /* ---- Simulator ---- */
    if (!p.startsWith('sim/') && p !== 'sim') return false;
    if (p === 'sim/config' && M === 'GET') {
      const cfg = config();
      const out = { ready: !!apiKey(), modes: Object.entries(MODES).map(([k, v]) => ({ key: k, label: v.label })), examPass: cfg.examPass, role: cfg.role };
      if (isAdmin) {
        const k = apiKey();
        Object.assign(out, { admin: { keySet: !!k, keyHint: k ? '…' + k.slice(-4) : '', keyFromEnv: !!process.env.ANTHROPIC_API_KEY, dist: cfg.dist, examPass: cfg.examPass, role: cfg.role, tariff: cfg.tariff, models: cfg.models,
          knowledge: { at: getSet('simKnowledgeAt'), fromPdfs: !!getSet('simKnowledge'), texts: db.prepare('SELECT COUNT(*) n FROM academy_text t JOIN academy a ON a.file_id = t.file_id').get().n, pdfs: db.prepare("SELECT COUNT(*) n FROM academy WHERE kind = 'pdf' AND file_id IS NOT NULL").get().n } } });
      }
      return send(res, 200, out);
    }
    if (p === 'sim/config' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator kann den Simulator einstellen.');
      const b = await readBody(req).catch(() => null) || {};
      if (b.key !== undefined) { const k = String(b.key).trim(); if (k && !/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(k)) return err(res, 400, 'Das sieht nicht wie ein gültiger Anthropic-API-Schlüssel aus (beginnt mit „sk-ant-“).'); setSet('aiKey', k || null); log('Kundensimulator: KI-Schlüssel', k ? 'hinterlegt' : 'entfernt', 'von', meRow.name); if (k) setTimeout(() => buildKnowledge(false), 1000); }
      let c = {}; try { c = JSON.parse(getSet('simConfig') || '{}'); } catch (e) {}
      if (b.dist) { const d = {}; for (const t of Object.keys(TYPES)) d[t] = clamp(b.dist[t], 0, 100); if (!Object.values(d).some(x => x > 0)) return err(res, 400, 'Mindestens ein Kundentyp braucht einen Anteil.'); c.dist = d; }
      if (b.examPass !== undefined) c.examPass = clamp(b.examPass, 50, 100);
      if (b.role !== undefined) { const r = String(b.role).trim().slice(0, 600); c.role = r || DEFAULTS.role; }
      if (b.tariff) { c.tariff = c.tariff || {}; for (const e of ['strom', 'gas']) if (b.tariff[e]) { const t = b.tariff[e], d = DEFAULTS.tariff[e]; c.tariff[e] = { name: String(t.name || d.name).slice(0, 120), ap: Math.max(0, Math.min(200, Number(String(t.ap).replace(',', '.')) || d.ap)), gp: Math.max(0, Math.min(200, Number(String(t.gp).replace(',', '.')) || d.gp)), garantie: String(t.garantie ?? d.garantie).slice(0, 200), laufzeit: String(t.laufzeit ?? d.laufzeit).slice(0, 200) }; } }
      setSet('simConfig', JSON.stringify(c));
      if (b.rebuild) setTimeout(() => buildKnowledge(true), 200);
      return send(res, 200, { ok: true });
    }
    if (p === 'sim/test' && M === 'POST') {
      if (!isAdmin) return err(res, 403, 'Nur der Administrator.');
      try { const t0 = Date.now(); await claude({ model: config().models.customer, maxTokens: 20, messages: [{ role: 'user', content: 'Antworte nur mit: OK' }], timeout: 20000 }); return send(res, 200, { ok: true, ms: Date.now() - t0 }); }
      catch (e) { return err(res, 400, e.message); }
    }
    if (p === 'sim/start' && M === 'POST') {
      if (!apiKey()) return err(res, 503, 'Der Kundensimulator ist noch nicht eingerichtet: Der Administrator muss einmalig den KI-Zugang hinterlegen.', { code: 'nokey' });
      const b = await readBody(req).catch(() => null) || {};
      const mode = MODES[b.mode] ? b.mode : 'komplett';
      let ctype = null;
      if (b.same) { const o = db.prepare('SELECT ctype FROM sim_sessions WHERE id = ? AND uid = ?').get(String(b.same), uid); if (o) ctype = o.ctype; }
      // alte, nicht beendete Trainings dieses Mitarbeiters schließen (nicht gewertet)
      db.prepare("UPDATE sim_sessions SET status = 'aborted', ended_at = ? WHERE uid = ? AND status = 'active'").run(now(), uid);
      const sc = buildScenario(uid, mode, { ctype, weakness: !!b.weakness });
      const iv = INITIAL(sc.ctype); const state = { trust: iv[0], openness: iv[1], time_pressure: iv[2], skepticism: iv[3], buy_readiness: iv[4], annoyance: iv[5], phase: mode === 'vorabschluss' ? 'rechnung' : 'tuer', show_invoice: mode === 'vorabschluss', ended: false, outcome: 'offen', memory: [], objections_raised: [], open_questions: [], trace: [] };
      if (mode === 'vorabschluss') { state.trust = Math.max(state.trust, 55); state.openness = Math.max(state.openness, 55); }
      const id = crypto.randomBytes(12).toString('hex');
      db.prepare('INSERT INTO sim_sessions (id, uid, mode, ctype, scenario, status, started_at, transcript, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, uid, mode, sc.ctype, JSON.stringify(sc), 'active', now(), '[]', JSON.stringify(state));
      const cfg = config();
      const coach = mode === 'pruefung' ? cfg.examStart : pick(cfg.coachStarts);
      return send(res, 200, { ...sessionOut(load(id)), coach });
    }
    if (p === 'sim/active' && M === 'GET') {
      const r = db.prepare("SELECT id FROM sim_sessions WHERE uid = ? AND status = 'active' AND started_at > ? ORDER BY started_at DESC LIMIT 1").get(uid, new Date(Date.now() - 3 * 3600e3).toISOString());
      return send(res, 200, r ? sessionOut(load(r.id)) : null);
    }
    if (p === 'sim/history' && M === 'GET') {
      const url = new URL(req.url, 'http://x'), who = url.searchParams.get('uid') || uid;
      if (who !== uid && !isAdmin) return err(res, 403, 'Nur der Administrator sieht die Trainings anderer Mitarbeiter.');
      return send(res, 200, db.prepare("SELECT id, mode, ctype, started_at, ended_at, score, passed, result FROM sim_sessions WHERE uid = ? AND status = 'done' ORDER BY ended_at DESC LIMIT 100").all(who).map(r => { let x = {}; try { x = JSON.parse(r.result); } catch (e) {} return { id: r.id, mode: r.mode, modeLabel: (MODES[r.mode] || {}).label, type: (TYPES[r.ctype] || {}).label, at: r.ended_at, score: r.score, passed: r.passed === null ? null : !!r.passed, label: x.label, outcome: x.outcome }; }));
    }
    if (!(m = /^sim\/([0-9a-f]{24})(?:\/(turn|finish|abort|result))?$/.exec(p))) return err(res, 404, 'unbekannt');
    const s = load(m[1]);
    if (!s || (s.uid !== uid && !(isAdmin && m[2] === 'result' && M === 'GET'))) return err(res, 404, 'Training nicht gefunden.');
    const act = m[2];
    if (act === 'result' && M === 'GET') {
      if (s.status !== 'done') return err(res, 409, 'Noch nicht ausgewertet.');
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(s.uid);
      return send(res, 200, { ...s.result, id: s.id, mode: s.mode, modeLabel: MODES[s.mode].label, at: s.ended_at, user: u ? u.name : '', transcript: sessionOut(s).transcript, invoice: s.state.show_invoice || s.scenario.bill === 'sofort' ? s.scenario.invoice : null, tariff: s.scenario.tariff });
    }
    if (!act && M === 'GET') return send(res, 200, sessionOut(s, s.status !== 'active'));
    if (act === 'abort' && M === 'POST') { if (s.status === 'active') { db.prepare("UPDATE sim_sessions SET status = 'aborted', ended_at = ? WHERE id = ?").run(now(), s.id); } return send(res, 200, { ok: true }); }
    if (act === 'turn' && M === 'POST') {
      if (s.status !== 'active') return err(res, 409, 'Dieses Training ist bereits beendet.');
      const b = await readBody(req).catch(() => null) || {};
      const seq = Number(b.seq) || 0, text = String(b.text || '').trim().slice(0, 2000), t = Math.max(0, Math.min(36000, Number(b.t) || 0));
      const sellerTurns = s.transcript.filter(x => x.who === 'v' || x.who === 'x').length;
      // Wiederholung derselben Anfrage (z. B. nach Netzwerkabbruch): gespeicherte Antwort liefern, nichts doppelt
      if (seq && seq <= sellerTurns) {
        const idx = s.transcript.findIndex((x, i) => (x.who === 'v' || x.who === 'x') && s.transcript.slice(0, i + 1).filter(y => y.who === 'v' || y.who === 'x').length === seq);
        const ans = idx >= 0 ? s.transcript.slice(idx + 1).find(x => x.who === 'k') : null;
        if (ans) return sse(res, null, { reply: ans.text, invoice: s.state.show_invoice ? s.scenario.invoice : null, ended: !!s.state.ended, repeat: true });
        if (pending.has(s.id)) { try { await pending.get(s.id); } catch (e) {} const s2 = load(s.id); const a2 = s2.transcript.filter(x => x.who === 'k').pop(); return sse(res, null, { reply: a2 ? a2.text : '', invoice: s2.state.show_invoice ? s2.scenario.invoice : null, ended: !!s2.state.ended, repeat: true }); }
      }
      if (pending.has(s.id)) return err(res, 409, 'Der Kunde antwortet noch – einen Moment.');
      if (seq !== sellerTurns + 1) return err(res, 409, 'Das Gespräch ist auf einem anderen Gerät weitergelaufen. Bitte neu laden.');
      if (b.ring) s.transcript.push({ who: 'x', text: s.mode === 'vorabschluss' ? '[Du hast deine Rechnung geholt und stehst wieder an der Tür. Der Verkäufer wartet. Sag kurz etwas und gib ihm die Rechnung.]' : '[Es klingelt an deiner Haustür. Du öffnest. Sag, was du beim Öffnen sagst – noch hat der Verkäufer nichts gesagt.]', t: 0 });
      else { if (!text) return err(res, 400, 'Bitte etwas sagen oder eintippen.'); s.transcript.push({ who: 'v', text, t }); }
      // Antwort streamen: zuerst Text, am Ende Zustand (Rechnung gezeigt? Gespräch beendet?)
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      res.flushHeaders && res.flushHeaders();
      const write = d => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(d) + '\n\n'); };
      const ka = setInterval(() => { if (!res.writableEnded) res.write(': ka\n\n'); }, 10000);
      const parse = partialReply();
      const job = customerTurn(s, chunk => { const add = parse(chunk); if (add) write({ d: add }); });
      pending.set(s.id, job.catch(() => {}));
      try {
        const reply = await job;
        s.transcript.push({ who: 'k', text: reply, t });
        saveSession(s);
        write({ done: true, reply, invoice: s.state.show_invoice ? s.scenario.invoice : null, ended: !!s.state.ended });
      } catch (e) {
        s.transcript.pop();  // Runde nicht gespeichert → kann erneut gesendet werden
        log('Kundensimulator: Antwort fehlgeschlagen –', e.message);
        write({ error: e.message, retry: true });
      } finally { pending.delete(s.id); clearInterval(ka); res.end(); }
      return;
    }
    if (act === 'finish' && M === 'POST') {
      if (s.status === 'done') return send(res, 200, { ...s.result, id: s.id });
      if (s.status !== 'active') return err(res, 409, 'Dieses Training wurde abgebrochen.');
      if (!s.transcript.some(x => x.who === 'v')) { db.prepare("UPDATE sim_sessions SET status = 'aborted', ended_at = ? WHERE id = ?").run(now(), s.id); return err(res, 400, 'Es wurde noch nichts gesagt – das Training wird nicht gewertet.', { code: 'empty' }); }
      if (pending.has(s.id + ':eval')) { try { await pending.get(s.id + ':eval'); } catch (e) {} const s2 = load(s.id); return s2.status === 'done' ? send(res, 200, { ...s2.result, id: s2.id }) : err(res, 502, 'Auswertung fehlgeschlagen – bitte erneut versuchen.'); }
      const job = evaluate(s); pending.set(s.id + ':eval', job.catch(() => {}));
      try {
        const result = await job;
        db.prepare("UPDATE sim_sessions SET status = 'done', ended_at = ?, score = ?, passed = ?, result = ? WHERE id = ? AND status = 'active'").run(now(), result.total, result.passed === null ? null : result.passed ? 1 : 0, JSON.stringify(result), s.id);
        log('Kundensimulator:', meRow.name, MODES[s.mode].label, '→', result.total, 'Punkte' + (result.exam ? (result.passed ? ' (praxisbereit)' : ' (Prüfung nicht bestanden)') : ''));
        return send(res, 200, { ...result, id: s.id });
      } catch (e) { log('Kundensimulator: Auswertung fehlgeschlagen –', e.message); return err(res, 502, e.message, { retry: true }); }
      finally { pending.delete(s.id + ':eval'); }
    }
    return err(res, 404, 'unbekannt');
  }
  function sse(res, _x, done) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('data: ' + JSON.stringify({ done: true, ...done }) + '\n\n'); }

  return { handle, buildKnowledge };
};
module.exports.TYPES = TYPES;

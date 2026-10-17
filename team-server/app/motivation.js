/* Hauskarte BW – Persönliche Motivation
   Zusatzfunktion: begrüßt den angemeldeten Mitarbeiter einmal pro Arbeitstag und gratuliert bei
   persönlichen Vertrags-Meilensteinen. Richtet sich nur nach den eigenen Zahlen.
   Verändert keine Funktion der Hauskarte; wird nur zusätzlich geladen. */
(() => {
  'use strict';
  const AUTHKEY = 'hauskarte-bw-sync-auth';
  const get = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
  const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const auth = () => get(AUTHKEY, null);
  const today = () => new Date().toLocaleDateString('sv-SE');
  const first = n => String(n || '').trim().split(/\s+/)[0];

  /* Abwechslung: nie zweimal hintereinander derselbe Text */
  function pick(list, key) {
    const k = 'hauskarte-motiv-last-' + key, last = get(k, -1);
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === last) i = (i + 1) % list.length;
    set(k, i);
    return list[i];
  }

  const GREET = {
    morgen: [
      n => `Guten Morgen, ${n}! Ich wünsche dir einen erfolgreichen Tag. Viel Energie – auf geht’s!`,
      n => `Guten Morgen, ${n}! Neuer Tag, neue Türen, neue Chancen. Du schaffst das! ☀️`,
      n => `Moin ${n}! Kaffee getankt? Heute wartet die nächste Haustür auf dich. ⚡`,
      n => `Guten Morgen, ${n}! Lächeln, klingeln, überzeugen – du kennst das Spiel. Viel Erfolg heute!`,
      n => `Guten Morgen, ${n}! Jedes Gespräch bringt dich weiter. Starte mit voller Energie!`
    ],
    tag: [
      n => `Hallo ${n}! Schön, dass du da bist. Volle Energie für die nächsten Türen! ⚡`,
      n => `Hallo ${n}! Der Tag ist noch jung genug für richtig gute Gespräche. Auf geht’s!`,
      n => `Hi ${n}! Tür für Tür zum Erfolg – du bist bereit. 💪`
    ],
    abend: [
      n => `Guten Abend, ${n}! Danke für deinen Einsatz heute. Gerade abends sind viele zu Hause – nutz die Chance!`,
      n => `Hallo ${n}! Endspurt für heute – jede Tür kann die richtige sein. 🔥`
    ]
  };
  const CONTRACT = {
    1: ['Starker Start! Der erste ist drin. Weiter geht’s! 🔥', 'Der erste Vertrag ist im Kasten – der Knoten ist geplatzt! 🎉', 'Erster Abschluss geschafft! Genau so geht’s weiter. ⚡'],
    2: ['Wow – du kommst in den Flow. Bleib dran! 💪', 'Nummer zwei! Die Energie stimmt. 🔥', 'Zweiter Vertrag – du bist auf Kurs!'],
    3: ['Sehr stark! Behalte deine positive Energie und zieh weiter durch.', 'Drei Abschlüsse – das läuft! Weiter so. 🚀', 'Hattrick! Deine Ausdauer zahlt sich aus. 💪'],
    viele: [
      'Weiter so! 💪', 'Starke Leistung!', 'Du bist im Flow! 🔥', 'Nächstes Haus, nächste Chance! 🚀', 'Ausdauer zahlt sich aus – stark gemacht!',
      'Energie pur! ⚡', 'Klasse Gespräch – und gleich die nächste Tür!', 'Dranbleiben lohnt sich. Weiter geht’s!', 'Top! Deine positive Art kommt an. 😊'
    ]
  };
  const FIVES = [
    (n, c) => `${c} Verträge in diesem Monat, ${n}! Das ist echte Ausdauer. 🏆`,
    (n, c) => `Meilenstein: ${c} Verträge! Stark, ${n} – weiter so! 🚀`,
    (n, c) => `${c} Abschlüsse! ${n}, du bist richtig im Flow. 🔥`
  ];

  /* Anzeige als kleine Karte oben, verschwindet von selbst */
  function show(text, big) {
    if (!document.getElementById('hk-motiv-style')) {
      const s = document.createElement('style'); s.id = 'hk-motiv-style';
      s.textContent = `.hk-motiv{position:fixed;left:50%;top:calc(14px + env(safe-area-inset-top,0px));transform:translate(-50%,-140%);z-index:2147482000;width:min(460px,calc(100% - 28px));box-sizing:border-box;background:#173a34;color:#fff;border-radius:16px;padding:14px 16px;display:flex;gap:12px;align-items:flex-start;box-shadow:0 10px 30px rgba(0,0,0,.25);font:500 15px/1.45 system-ui,-apple-system,Arial,sans-serif;transition:transform .35s ease}
.hk-motiv.on{transform:translate(-50%,0)}
.hk-motiv .i{flex:0 0 auto;width:38px;height:38px;border-radius:50%;background:#22ba57;display:grid;place-items:center;font-size:20px}
.hk-motiv.big{padding:18px}
.hk-motiv p{margin:0;flex:1;min-width:0}
.hk-motiv button{all:unset;cursor:pointer;color:rgba(255,255,255,.75);font-size:20px;line-height:1;padding:2px 4px}
@media (prefers-reduced-motion: reduce){.hk-motiv{transition:none}}`;
      document.head.append(s);
    }
    document.querySelector('.hk-motiv')?.remove();
    const box = document.createElement('div');
    box.className = 'hk-motiv' + (big ? ' big' : ''); box.setAttribute('role', 'status');
    const ic = document.createElement('span'); ic.className = 'i'; ic.textContent = big ? '☀️' : '⚡';
    const p = document.createElement('p'); p.textContent = text;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Schließen');
    box.append(ic, p, x); document.body.append(box);
    const close = () => { box.classList.remove('on'); setTimeout(() => box.remove(), 400); };
    x.onclick = close; box.onclick = e => { if (e.target !== x) close(); };
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('on')));
    setTimeout(close, big ? 7000 : 4500);
  }

  /* Begrüßung: einmal pro Tag und Mitarbeiter, nicht am Sonntag */
  async function greet() {
    const a = auth();
    if (!a || !a.name || new Date().getDay() === 0) return;
    const key = 'hauskarte-motiv-greet-' + (a.uid || a.name);
    if (get(key, '') === today()) return;
    set(key, today());
    const n = first(a.name), hr = new Date().getHours();
    let text = pick(GREET[hr < 11 ? 'morgen' : hr < 17 ? 'tag' : 'abend'], 'greet')(n);
    try {
      if (a.access && navigator.onLine) {
        const r = await fetch('/api/contracts', { headers: { Authorization: 'Bearer ' + a.access } });
        if (r.status === 403) return;  // „Nur Academy“: keine Vertrags-Begrüßung
        if (r.ok) { const d = await r.json(); if (d.myCount > 0) text += ` Du hast diesen Monat schon ${d.myCount} ${d.myCount === 1 ? 'Vertrag' : 'Verträge'} – heute kommen neue dazu!`; }
      }
    } catch (e) {}
    show(text, true);
  }

  /* Nach einem eigenen neuen Vertrag: nur bei 1, 2, 3, jedem 5. und beim persönlichen Monatsrekord */
  function contract(count, prevMonthCount) {
    const a = auth(), n = first(a && a.name);
    let text = null;
    if (count >= 1 && count <= 3) text = pick(CONTRACT[count], 'c' + count);
    else if (prevMonthCount > 0 && count === prevMonthCount + 1) text = `Neuer persönlicher Rekord, ${n}! Mehr als im ganzen letzten Monat. 🏆`;
    else if (count % 5 === 0) text = pick(FIVES, 'five')(n, count);
    else if (count % 2 === 0 && Math.random() < .35) text = pick(CONTRACT.viele, 'viele');
    if (text) show(text, false);
    return !!text;
  }

  window.HauskarteMotivation = { greet, contract, show };
  const start = () => setTimeout(greet, 1500);
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();

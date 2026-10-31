/* Bedienseite der Klang-Box: die Mess-Seite, ausgeliefert von der Box selbst (http://klangbox.local).
 *
 * Der Box-Dienst (klangbox/dienst/server.py) setzt in index.html <meta name="klangbox-bedienseite" content="box"> und
 * lädt diese Datei vor der Seite. Nur dann wird sie aktiv; auf GitHub Pages und in der App tut sie nichts.
 *
 * Was sie tut:
 * - Sie spielt für die Seite die Brücke der App (window.klangboxNativ, webkit.messageHandlers.klangbox) und schickt
 *   jeden Box-Aufruf direkt an /api/… derselben Herkunft (kein CORS, kein Mixed Content). Damit läuft „Zuhause“
 *   mit genau dem Code, den auch die App nutzt. Schreiben braucht das Token: Die Seite koppelt sich beim ersten
 *   Mal selbst (POST /api/koppeln) und merkt sich das Token in diesem Browser.
 * - Die Seite zeigt nur Zuhause. Einmessen braucht das Mikrofon, und das gibt der Browser nur auf einer sicheren
 *   Seite (https) frei. Darum führt jeder Weg zum Einmessen zur Mess-Seite im Internet.
 * - Ergebnisse kommen per Kopieren und Einfügen (oder als Datei) zurück: Die Mess-Seite liegt auf https, die Box auf
 *   http; direkt darf die Mess-Seite die Box im Browser nicht ansprechen.
 * - Unter Zuhause steht die Adresse der Box (IP), falls klangbox.local im Netz einmal nicht geht.
 */
(function () {
  "use strict";
  const meta = document.querySelector('meta[name="klangbox-bedienseite"]');
  if (!meta || meta.content !== "box") return;
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.klangbox) return;  // echte App

  const MESS_SEITE = "https://ht8dfm5m6j-beep.github.io/klangbox-messen/";
  const TOKEN = "klangbox-bedien-token";
  const lesen = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const merken = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* privat: dann jedes Mal koppeln */ } };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MODUS_NAME = { stereo: "Stereo", kino: "Kino" };

  let status = null;
  const boxen = { verfuegbar: true, version: 1, haupt: "box", layout: "2.0", boxen: [], bedienseite: true };
  const N = window.klangboxNativ = { version: 1, raum: null, kannAufnehmen: false, boxen };

  // --- Box-Schnittstelle über dieselbe Herkunft ----------------------------------------------------------------------
  async function anfrage(methode, pfad, daten) {
    const kopf = { "Content-Type": "application/json" }, t = lesen(TOKEN);
    if (t) kopf["X-Klangbox-Token"] = t;
    try {
      const r = await fetch(pfad, { method: methode, headers: kopf, cache: "no-store", body: methode === "GET" ? undefined : JSON.stringify(daten || {}) });
      let d = null; try { d = await r.json(); } catch (e) { d = null; }
      if (!d || typeof d !== "object") d = { ok: false, grund: "format", fehler: "Die Box hat unklar geantwortet." };
      return { code: r.status, d };
    } catch (e) {
      return { code: 0, d: { ok: false, grund: "netz", fehler: "Die Klang-Box ist gerade nicht erreichbar." } };
    }
  }
  async function koppeln() {
    const { code, d } = await anfrage("POST", "/api/koppeln", {});
    if (code === 200 && d.token) { merken(TOKEN, d.token); return { ok: true }; }
    if (d.grund === "kopplung_zu") return { ok: false, grund: "kopplung_zu", fehler: "Diese Seite darf die Box noch nicht steuern. "
      + "Box kurz ausstecken, wieder einstecken und innerhalb von 2 Minuten noch einmal tippen." };
    return { ok: false, grund: d.grund || "koppeln", fehler: d.fehler || "Koppeln ging nicht." };
  }
  function statusMerken(d) {
    status = d;
    if (d.id) boxen.haupt = d.id;
    if (d.layout) boxen.layout = d.layout;
    if (Array.isArray(d.satelliten)) boxen.boxen = [{ id: d.id, name: d.name, rolle: d.rolle }, ...d.satelliten.map((s) => ({ id: s.id, name: s.name, rolle: "satellit" }))];
    adresseZeigen(); obenZeigen();
  }
  // Lesende Aufrufe des Alltags (Jetzt läuft, Bibliothek …): ohne Daten per GET, die Abfrage steht im Namen
  const LESEN = new Set(["status", "jetzt", "jetzt/details", "signalweg", "diagnose", "bericht", "bibliothek", "warteschlange", "sicherung", "wlan"]);
  const leer = (d) => !d || (typeof d === "object" && !Object.keys(d).length);
  async function aufruf(name, daten, boxId) {
    const sat = boxId && boxId !== "box" && status && boxId !== status.id;
    const pfad = sat ? `/api/satellit/${encodeURIComponent(boxId)}/${name}` : `/api/${name}`;
    // Cover: dieselbe Herkunft, das Bild lädt die Seite direkt (kein Umweg über JSON)
    if (name.startsWith("cover/")) return { ok: true, bild: pfad };
    const methode = name === "status" || (LESEN.has(name.split("?")[0]) && leer(daten)) ? "GET" : "POST";
    let { code, d } = await anfrage(methode, pfad, daten);
    if (code === 401 && d.grund === "kein_token") {
      const k = await koppeln(); if (!k.ok) return k;
      ({ code, d } = await anfrage(methode, pfad, daten));
    }
    if (typeof d.ok !== "boolean") d.ok = code >= 200 && code < 300;
    if (name === "status" && !sat && d.ok) statusMerken(d);
    return d;
  }
  const NUR_APP = new Set(["suchen", "einrichtung"]);
  const antworten = (fn, ...a) => setTimeout(() => { try { if (typeof N[fn] === "function") N[fn](...a); } catch (e) { /* Seite noch nicht bereit */ } }, 0);
  const bruecke = { postMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.art === "box") {
      if (NUR_APP.has(m.aufruf)) return antworten("boxAntwort", m.reqId, { ok: false, grund: "nur_app", fehler: "Das geht nur in der App." });
      const p = m.aufruf === "koppeln" ? koppeln() : aufruf(m.aufruf, m.daten, m.box);
      p.then((d) => antworten("boxAntwort", m.reqId, d));
    } else if (m.art === "aufnahmeStart") antworten("aufnahmeFehler", m.id, "Messen geht auf der Mess-Seite im Internet.");
    else if (typeof m.art === "string" && m.art.startsWith("kef")) antworten("kefAntwort", m.reqId, { ok: false, grund: "nur_app", fehler: "Das geht nur in der App." });
  } };
  try {
    if (!window.webkit) window.webkit = {};
    if (!window.webkit.messageHandlers) window.webkit.messageHandlers = {};
    window.webkit.messageHandlers.klangbox = bruecke;
  } catch (e) { return; }  // nicht beschreibbar: die Seite läuft dann wie ohne Box

  // Zustand frisch halten: Zuhause fragt selbst alle paar Sekunden; „klangboxbox“ (wie bei der App) lädt sofort neu,
  // z. B. nach dem Übernehmen oder wenn die App wieder in den Vordergrund kommt
  const melden = () => window.dispatchEvent(new CustomEvent("klangboxbox", { detail: { box: boxen.haupt, status } }));
  aufruf("status").then((d) => { if (d.ok) melden(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) melden(); });

  // --- Dialoge -------------------------------------------------------------------------------------------------------
  const STIL = `
.bs-schleier { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, .55); display: grid; align-items: end; justify-items: center; }
.bs-dialog { width: min(560px, 100%); max-height: 92vh; overflow: auto; background: var(--panel); color: var(--ink); border-radius: 26px 26px 0 0;
  padding: 20px max(16px, env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
  display: grid; gap: 12px; box-shadow: 0 -10px 40px rgba(0, 0, 0, .35); }
.bs-dialog h2 { margin: 0; }
.bs-dialog p, .bs-dialog ol { margin: 0; }
.bs-dialog ol { padding-left: 20px; display: grid; gap: 6px; }
.bs-dialog textarea { width: 100%; min-height: 110px; border-radius: 16px; border: 1.5px solid var(--line2); background: var(--panel2, var(--panel));
  color: var(--ink); font: 14px/1.35 ui-monospace, Menlo, monospace; padding: 10px 12px; resize: vertical; }
.bs-dialog .knoepfe { display: grid; gap: 10px; }
.bs-dialog a.knopf { display: grid; place-items: center; text-decoration: none; }
.bs-box { display: grid; gap: 10px; }
.bs-box .reihe { display: flex; gap: 10px; flex-wrap: wrap; }
.bs-box .reihe button { flex: 1 1 140px; }
.bs-adresse { overflow-wrap: anywhere; }
`;
  function stil() {
    if (document.getElementById("bs-stil")) return;
    const s = document.createElement("style"); s.id = "bs-stil"; s.textContent = STIL; document.head.appendChild(s);
  }
  let offen = null;
  function zu() { if (offen) { offen.remove(); offen = null; } }
  function dialog(html) {
    stil(); zu();
    const s = document.createElement("div");
    s.className = "bs-schleier";
    s.innerHTML = `<div class="bs-dialog" role="dialog" aria-modal="true" aria-labelledby="bs-titel">${html}</div>`;
    s.addEventListener("click", (ev) => { if (ev.target === s || ev.target.closest("[data-bs-zu]")) zu(); });
    document.body.appendChild(s); offen = s;
    const f = s.querySelector("textarea, button, a"); if (f) f.focus({ preventScroll: true });
    return s;
  }
  const messLink = (text, klasse = "knopf") => `<a class="${klasse}" href="${MESS_SEITE}" target="_blank" rel="noopener">${esc(text)}</a>`;

  function dialogEinmessen(n) {
    const anlage = n === 2;
    dialog(`<span class="eyebrow">${anlage ? "Meine Anlage" : "Einmessen"}</span><h2 id="bs-titel">${anlage ? "Das geht auf der Mess-Seite" : "Einmessen auf der Mess-Seite"}</h2>
      <p class="klein">Einmessen braucht das Mikrofon. Das gibt der Browser nur auf einer sicheren Seite frei, darum geht es über die Mess-Seite im Internet. Diese Seite hier ist zum Bedienen.</p>
      <ol class="klein"><li>Mess-Seite öffnen und dort einmessen.</li><li>Am Ende dort „Kopieren“ tippen.</li><li>Zurück hierher, „Ergebnis übernehmen“, einfügen.</li><li>Auf der Mess-Seite nachmessen, das Ergebnis genauso hierher.</li></ol>
      <div class="knoepfe">${messLink("Mess-Seite öffnen")}<button type="button" class="zweit" id="bs-zu-uebernehmen">Ergebnis übernehmen</button><button type="button" class="leise" data-bs-zu>Zurück</button></div>`);
    offen.querySelector("#bs-zu-uebernehmen").addEventListener("click", dialogUebernehmen);
  }

  function dialogUebernehmen() {
    dialog(`<span class="eyebrow">Von der Mess-Seite</span><h2 id="bs-titel">Ergebnis übernehmen</h2>
      <p class="klein">Auf der Mess-Seite „Kopieren“ tippen, dann hier lange ins Feld tippen und „Einfügen“. Oder die gespeicherte Datei wählen.</p>
      <textarea id="bs-text" placeholder="Hier einfügen" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Ergebnis der Mess-Seite"></textarea>
      <input type="file" id="bs-datei" accept=".json,application/json,text/plain" hidden>
      <div class="knoepfe"><button type="button" id="bs-los">Übernehmen</button><button type="button" class="zweit" id="bs-datei-wahl">Datei wählen</button><button type="button" class="leise" data-bs-zu>Zurück</button></div>
      <div id="bs-antwort" class="klein" aria-live="polite"></div>`);
    const text = offen.querySelector("#bs-text"), datei = offen.querySelector("#bs-datei");
    offen.querySelector("#bs-datei-wahl").addEventListener("click", () => datei.click());
    datei.addEventListener("change", async () => { const f = datei.files && datei.files[0]; if (!f) return; text.value = await f.text(); uebernehmen(text.value); });
    offen.querySelector("#bs-los").addEventListener("click", () => uebernehmen(text.value));
  }

  // Übergabe: das Export-Objekt der Mess-Seite (art „klangbox-einstellungen“). stand sagt, was die Box tun soll:
  // „neu“ laden (vorhergesagt), „bestaetigt“ nach der Nachmessung bestätigen, „vorher“/„neutral“ zurücknehmen.
  async function uebernehmen(roh) {
    const ziel = offen && offen.querySelector("#bs-antwort"); if (!ziel) return;
    const zeige = (html) => { ziel.innerHTML = html; };
    let obj = null;
    try { obj = JSON.parse(String(roh || "").trim()); } catch (e) { obj = null; }
    if (!obj || obj.art !== "klangbox-einstellungen" || !obj.einstellungen || typeof obj.einstellungen !== "object")
      return zeige(`<span class="warn">Das ist kein Ergebnis der Mess-Seite. Tippe dort „Kopieren“ und füge es hier ein.</span>`);
    const modus = obj.modus === "kino" ? "kino" : "stereo", name = MODUS_NAME[modus];
    const knopf = offen.querySelector("#bs-los"); knopf.disabled = true;
    zeige(`<span class="laeuft">Gebe es an die Klang-Box…</span>`);
    let html;
    if (obj.stand === "neu") {
      const a = await aufruf("einstellungen", { einstellungen: obj, profil: obj.einstellungen.profil || null, runde: obj.runde ?? null, modus });
      const abgelehnt = (a.abgelehnt || []).map((x) => `<li>${esc(x.text)}</li>`).join("");
      html = a.ok && a.geladen !== false
        ? `<p class="ok">✓ Die Box spielt jetzt die neuen Einstellungen für ${name}. Sie gelten erst nach dem Nachmessen.</p>
           <p>Jetzt auf der Mess-Seite nachmessen und das Ergebnis wieder hierher geben.</p>${messLink("Zur Mess-Seite", "knopf zweit")}`
        : `<p class="warn">Die Box hat nichts geladen${a.fehler && !abgelehnt ? `: ${esc(a.fehler)}` : "."} Es bleibt der bisherige Stand.</p>${abgelehnt ? `<ul>${abgelehnt}</ul>` : ""}`;
    } else if (obj.stand === "bestaetigt") {
      const a = await aufruf("bestaetigen", { modus, ...(obj.runde != null ? { runde: obj.runde } : {}) });
      html = a.ok ? `<p class="ok">✓ Nachgemessen und bestätigt: ${name} bleibt so.</p>`
        : a.grund === "runde" ? `<p class="warn">Das Ergebnis gehört zu einer anderen Messung. Nimm das neueste von der Mess-Seite.</p>`
        : a.grund === "falsche_eingabe" ? `<p class="warn">Auf der Box wartet in ${name} nichts auf eine Bestätigung. Zuerst die neuen Einstellungen übernehmen, dann nachmessen.</p>`
        : `<p class="warn">${esc(a.fehler || "Das ging nicht.")}</p>`;
    } else if (obj.stand === "vorher" || obj.stand === "neutral") {
      const a = await aufruf("zuruecknehmen", { modus });
      html = a.ok ? `<p class="ok">✓ Zurückgenommen: ${name} spielt wieder ${a.einstellungen && a.einstellungen.id ? "den letzten nachgemessenen Stand" : "ohne Raumanpassung"}.</p>`
        : `<p class="warn">${esc(a.fehler || "Das ging nicht.")}</p>`;
    } else {
      html = `<p class="warn">Diesen Stand kenne ich nicht. Nimm das neueste Ergebnis der Mess-Seite.</p>`;
    }
    knopf.disabled = false;
    zeige(html);
    melden();
  }

  // --- Unter Zuhause: Einmessen, Ergebnis übernehmen, Adresse ---------------------------------------------------------
  function adresseZeigen() {
    const el = document.getElementById("bs-adresse"); if (!el || !status) return;
    // Rückfall, falls klangbox.local im Netz nicht geht: die IP (dieselbe Seite, auch als eigene Home-Bildschirm-App)
    const n = status.netz || {}, ueberIp = n.ip && location.hostname === n.ip;
    const name = n.alias || (/\.local$/.test(location.hostname) ? location.hostname : null);
    el.innerHTML = name && n.ip ? `Adresse: <b>http://${esc(name)}</b> · falls das nicht geht: <b>http://${esc(n.ip)}/</b>`
      : n.ip && !ueberIp ? `Adresse der Box: <b>http://${esc(n.ip)}/</b>`
      : `Adresse der Box: <b>http://${esc(location.host)}/</b>`;
    const sat = document.getElementById("bs-satellit");
    if (sat) sat.hidden = status.rolle !== "satellit";
  }
  // Solange nichts eingemessen ist oder eine Nachmessung offen ist, ist „Ergebnis übernehmen“ der Hauptknopf oben
  // (Ablaufprüfung P1-9: der Laden-Weg ohne App führt hierher, der Knopf darf nicht unter elf Kacheln liegen)
  function uebernahmeOffen() {
    if (!status) return true;
    const p = status.profile && status.profil_aktiv ? status.profile[status.profil_aktiv] : status.modi ? status.modi[status.modus] : null;
    return !p || !p.eingemessen || p.status === "vorhergesagt";
  }
  function obenZeigen() {
    const held = document.getElementById("zh-held"); if (!held) return;
    let k = document.getElementById("bs-oben");
    if (!k) {
      stil();
      k = document.createElement("div"); k.id = "bs-oben"; k.className = "kasten bs-box";
      k.innerHTML = `<span class="eyebrow">Von der Mess-Seite</span><p class="klein">Auf der Mess-Seite „Kopieren“ getippt? Dann hier übernehmen.</p>
        <button type="button" id="bs-oben-los">Ergebnis übernehmen</button>`;
      held.insertAdjacentElement("beforebegin", k);
      k.querySelector("#bs-oben-los").addEventListener("click", dialogUebernehmen);
    }
    k.hidden = !uebernahmeOffen();
    const u = document.getElementById("bs-uebernehmen"); if (u) u.hidden = uebernahmeOffen();
  }
  function zuhauseErgaenzen() {
    const nach = document.getElementById("zh-aktionen"); if (!nach || document.getElementById("bs-box")) return;
    stil();
    const k = document.createElement("div");
    k.className = "kasten bs-box"; k.id = "bs-box";
    k.innerHTML = `<div class="reihe"><button type="button" class="zweit klein" id="bs-uebernehmen">Ergebnis von der Mess-Seite übernehmen</button></div>
      <p class="klein warn" id="bs-satellit" hidden>Das ist ein Satellit. Bedienen geht über die Hauptbox.</p>
      <p class="klein bs-adresse" id="bs-adresse"></p>`;
    nach.insertAdjacentElement("afterend", k);
    k.querySelector("#bs-uebernehmen").addEventListener("click", dialogUebernehmen);
    adresseZeigen(); obenZeigen();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", zuhauseErgaenzen); else zuhauseErgaenzen();

  window.klangboxBedienseite = { einmessen: dialogEinmessen, uebernehmen: dialogUebernehmen, messSeite: MESS_SEITE };
})();

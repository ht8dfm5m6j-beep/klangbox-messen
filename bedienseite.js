/* Bedienseite der Klång-Box: die Mess-Seite, ausgeliefert von der Box selbst (http://klangbox.local).
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
 * - Über dem Kopf steht nichts (wie auf Hören): Die Adresse der Box (IP, falls klangbox.local im Netz einmal nicht geht)
 *   steht leise unter Box › Mehr › WLAN, „Ergebnis übernehmen“ unter Einmessen (oben, solange nichts eingemessen ist,
 *   sonst in Einmessen › Mehr), der Hinweis für eine Rear-Box im Zustand der Box (Vorlage: boxAdresseHtml, boxStatusHtml).
 */
(function () {
  "use strict";
  const meta = document.querySelector('meta[name="klangbox-bedienseite"]');
  if (!meta || meta.content !== "box") return;
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.klangbox) return;  // echte App

  const MESS_SEITE = "https://ht8dfm5m6j-beep.github.io/klangbox-messen/";
  // https://klangbox.local (tls.py, Zertifikat der Box vertraut): Safari gibt das Mikrofon frei, eingemessen wird direkt
  // hier, die Box spielt den Messton selbst. Über http bleibt nur Bedienen, mit dem Weg dorthin.
  const DIREKT = !!window.isSecureContext && location.protocol === "https:";
  const HTTPS_ADRESSE = `https://${location.hostname}/`;
  const TOKEN = "klangbox-bedien-token";
  const lesen = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const merken = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* privat: dann jedes Mal koppeln */ } };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MODUS_NAME = { stereo: "Stereo", kino: "Kino" };

  let status = null;
  const boxen = { verfuegbar: true, version: 1, haupt: "box", layout: "2.0", boxen: [], bedienseite: true };
  const N = window.klangboxNativ = { version: 1, raum: null, kannAufnehmen: false, boxen };

  // --- Box-Schnittstelle über dieselbe Herkunft ----------------------------------------------------------------------
  // Token: im Browser gemerkt; im privaten Modus (kein localStorage) wenigstens bis zum Neuladen
  let tokenHier = null;
  const token = () => lesen(TOKEN) || tokenHier;
  // zeitMs (optional): nach so vielen ms abbrechen (dann „netz“), z. B. die Probe vor dem Neuladen nach einem Update
  async function anfrage(methode, pfad, daten, zeitMs = 0) {
    const kopf = { "Content-Type": "application/json" }, t = token();
    if (t) kopf["X-Klangbox-Token"] = t;
    const ab = zeitMs && typeof AbortController === "function" ? new AbortController() : null;
    const uhr = ab ? setTimeout(() => ab.abort(), zeitMs) : 0;
    try {
      const r = await fetch(pfad, { method: methode, headers: kopf, cache: "no-store", body: methode === "GET" ? undefined : JSON.stringify(daten || {}),
        ...(ab ? { signal: ab.signal } : {}) });
      let d = null; try { d = await r.json(); } catch (e) { d = null; }
      if (!d || typeof d !== "object") d = { ok: false, grund: "format", fehler: "Die Box hat unklar geantwortet." };
      return { code: r.status, d, t };
    } catch (e) {
      return { code: 0, t, d: { ok: false, grund: "netz", fehler: "Die Klång-Box ist gerade nicht erreichbar." } };
    } finally {
      if (uhr) clearTimeout(uhr);
    }
  }
  async function koppeln() {
    const { code, d } = await anfrage("POST", "/api/koppeln", {});
    if (code === 200 && d.token) { tokenHier = d.token; merken(TOKEN, d.token); return { ok: true }; }
    if (d.grund === "kopplung_zu") return { ok: false, grund: "kopplung_zu", fehler: "Diese Seite darf die Box noch nicht steuern. "
      + "Am einfachsten: auf einer schon gekoppelten Seite (z. B. in Safari) „Zum Home-Bildschirm“ wählen, dann ist die neue gleich gekoppelt. "
      + "Sonst die Box kurz ausstecken, wieder einstecken und innerhalb von 2 Minuten noch einmal tippen." };
    return { ok: false, grund: d.grund || "koppeln", fehler: d.fehler || "Koppeln ging nicht." };
  }
  // Nur ein Koppelversuch zur Zeit, für alle Aufrufe der Seite: Antworten mehrere Aufrufe (etwa vier Cover im Regal)
  // zugleich mit 401, koppeln sie gemeinsam einmal. Jede Kopplung legt ein Token an, und die Box behält höchstens 8:
  // mehrere auf einmal verdrängten still die Tokens anderer Geräte. benutzt: das Token, mit dem der Aufruf abgewiesen
  // wurde; gibt es inzwischen ein anderes, reicht ein neuer Versuch damit.
  // Abgelehnt (kopplung_zu): ein paar Sekunden lang dieselbe Antwort, ohne die Box noch einmal zu fragen (die übrigen
  // Antworten mit 401 kommen oft erst nach der Ablehnung an). Ein Tipp auf „Koppeln“ fragt immer neu.
  const KOPPELN_NEIN_MS = 5000;
  let koppelnLaeuft = null, koppelnNein = null;
  function koppelnEinmal(benutzt) {
    const t = token();
    if (benutzt !== undefined && t && t !== benutzt) return Promise.resolve({ ok: true });
    if (benutzt !== undefined && koppelnNein && Date.now() - koppelnNein.zeit < KOPPELN_NEIN_MS) return Promise.resolve(koppelnNein.d);
    if (!koppelnLaeuft) koppelnLaeuft = koppeln().then((d) => { koppelnNein = d.ok ? null : { d, zeit: Date.now() }; return d; })
      .finally(() => { koppelnLaeuft = null; });
    return koppelnLaeuft;
  }
  // --- Koppeln ohne Ausstecken -----------------------------------------------------------------------------------------
  // Jede Home-Bildschirm-App und http/https haben ihren eigenen Speicher, also ihr eigenes Token. Eine gekoppelte Seite
  // holt darum einen Einmal-Code (POST /api/koppeln/einladung) und gibt ihn weiter: in die Adresse und ins Manifest
  // (start_url der Home-App) und in den Link zur sicheren Seite. Die neue Seite koppelt sich damit selbst.
  async function mitCodeKoppeln() {
    const q = new URLSearchParams(location.search), code = q.get("koppeln");
    if (!code) return;
    if (!lesen(TOKEN)) {
      const { code: c, d } = await anfrage("POST", "/api/koppeln", { code });
      if (c === 200 && d.token) merken(TOKEN, d.token);
    }
    q.delete("koppeln");
    try { history.replaceState(null, "", location.pathname + (q.toString() ? `?${q}` : "") + location.hash); } catch (e) { /* egal */ }
  }
  let einladungCode = null;
  async function einladen() {
    if (!lesen(TOKEN)) return null;
    const { code, d } = await anfrage("POST", "/api/koppeln/einladung", {});
    if (code !== 200 || !d.code) return null;
    einladungCode = d.code;
    const m = document.querySelector('link[rel="manifest"]');
    if (m) m.setAttribute("href", `bedienseite.webmanifest?koppeln=${encodeURIComponent(d.code)}`);
    // auch in die Adresse: manche iOS-Versionen nehmen für die Home-App die Adresse statt des Manifests
    try {
      const q = new URLSearchParams(location.search); q.set("koppeln", d.code); if (!q.has("zuhause")) q.set("zuhause", "");
      history.replaceState(null, "", location.pathname + "?" + q.toString().replace("zuhause=&", "zuhause&").replace(/zuhause=$/, "zuhause") + location.hash);
    } catch (e) { /* egal */ }
    return d.code;
  }
  mitCodeKoppeln().then(() => einladen());
  setInterval(() => { if (!document.hidden) einladen(); }, 10 * 60 * 1000);

  // Neue Software auf der Box (Update, auch nachts von selbst; Zurück zur alten Version): Die Seite kam mit der alten
  // Version und spricht deren Schnittstelle (0.3.56: Lautstärke-Stufen nur mit passender Skala, sonst 409). Meldet der
  // Status eine andere Version als beim Laden, lädt sie sich einmal neu, aber nur
  // - sichtbar (im Hintergrund erst beim Wiederkommen),
  // - wenn nichts in Arbeit ist (seiteRuhig: Zuhause, kein Sheet/Dialog, keine Messansicht, Hörprobe, Verbindungstest,
  //   keine ungesicherte Messung, keine Eingabe); sonst ein ruhiger Hinweis „Neue Version da“ unter dem Kopf (nur auf Zuhause ohne
  //   Sheet, Dialog und Messansicht, sonst still), und beim nächsten Status wird erneut geprüft,
  // - wenn die Box gerade antwortet (GET /api/status, höchstens NEU_PROBE_MS; sonst bliebe die Home-Bildschirm-App auf
  //   der Fehlerseite stehen),
  // - je Version höchstens einmal von selbst (sessionStorage), damit eine Box, die zwischen zwei Versionen wechselt,
  //   keine Schleife auslöst.
  const NEU_FUER = "klangbox-neu-geladen-fuer";
  const NEU_PROBE_MS = 5000;  // so lange auf GET /api/status warten, bevor neu geladen wird
  let versionGeladen = null, versionNeu = null, neuPrueft = false;
  // Ungesicherte Messung (Vorlage): Neu laden verlöre sie. Nicht dazu zählt, was die Box schon hat und die Seite jederzeit
  // zurückholt (nach.vorher einer Runde mit messdaten_box, nachVorherVonDerBox).
  // (1) Aufnahmen der laufenden Messung (dateien; nach dem Auswerten geleert und in messdaten)
  // (2) Aufnahmen vom Einmessen zum Nachmessen, deren Runde noch nicht auf der Box liegt (messdaten_box)
  // (3) Nachmessung ohne Urteil oder noch nicht auf der Box (pruefung_box, pruefungHochladenJetzt)
  // (4) ein weiterer Platz halb gemessen (nach.extraName: vorher da, nachher fehlt)
  // (5) Upload zur Box läuft oder wartet (mdKette, mdOffen)
  function ungesichert() {
    /* global dateien, nach, runden, mdOffen */
    if (typeof dateien === "undefined" || typeof nach === "undefined" || typeof runden === "undefined") return true;
    if (dateien.length) return true;
    const n = nach || {}, r = n.rundeId ? runden.find((x) => x && x.id === n.rundeId) : null;
    if (n.rundeId && Object.keys(n.vorher || {}).length && (!r || r.messdaten_box !== n.rundeId)) return true;
    if (Object.keys(n.nachher || {}).length && (!r || !r.urteil || r.pruefung_box !== r.id)) return true;
    if (n.extraName) return true;
    return typeof mdOffen !== "undefined" && mdOffen > 0;
  }
  // Zustandsmerker der Seite (Vorlage, lautstaerke.js, verbindungstest.js); fehlt einer oder geht etwas schief: nicht ruhig
  function seiteRuhig() {
    try {
      /* global schrittJetzt, sheet, LAUT, zhFunkLaeuft */
      if (typeof schrittJetzt === "undefined" || schrittJetzt !== 18) return false;  // nur auf Zuhause (Messen, Kanal-Check, Einrichten: andere Schritte)
      if (typeof sheet === "undefined" || sheet.offen() || offen || document.querySelector(".bs-schleier")) return false;
      if (document.body.classList.contains("vt-an")) return false;  // Verbindungstest
      const sichtbar = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0; };
      if (sichtbar("messlage") || sichtbar("hp")) return false;  // Messansicht, Hörprobe
      if (typeof LAUT !== "undefined" && LAUT._z && (LAUT._z.ziehen || LAUT._z.offen != null || LAUT._z.inFlug)) return false;
      if (typeof zhFunkLaeuft !== "undefined" && zhFunkLaeuft) return false;
      if (ungesichert()) return false;
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
      if ([...document.querySelectorAll("textarea")].some((x) => x.value.trim())) return false;
      return true;
    } catch (e) { return false; }
  }
  // Der Hinweis steht im Fluss direkt unter dem Kopf von Hören bzw. Einmessen (.zh-kopf), nie über Bedienelementen:
  // nur auf Zuhause, wenn dieser Kopf sichtbar ist und kein Sheet, Dialog, keine Messansicht und kein Verbindungstest
  // offen ist. Sonst wartet die Seite still. Antippen: ruhig neu laden, sonst Rückfrage; immer erst, wenn die Box antwortet.
  function hinweisPlatz() {
    try {
      if (typeof schrittJetzt === "undefined" || schrittJetzt !== 18) return null;
      if (typeof sheet === "undefined" || sheet.offen() || offen || document.querySelector(".bs-schleier")) return null;
      if (document.body.classList.contains("vt-an")) return null;
      const ml = document.getElementById("messlage"); if (ml && !ml.hidden) return null;
      const k = document.querySelector('.schritt[data-s="18"] > .zh-kopf');
      return k && k.getClientRects().length ? k : null;
    } catch (e) { return null; }
  }
  function neuHinweis(an) {
    let h = document.getElementById("bs-neu");
    const k = an ? hinweisPlatz() : null;
    if (!k) { if (h) h.hidden = true; return; }
    if (!h) {
      stil();
      h = document.createElement("button");
      h.type = "button"; h.id = "bs-neu"; h.className = "bs-neu";
      h.textContent = "Neue Version da – Seite neu laden";
      h.addEventListener("click", () => { if (versionNeu && !h.hidden) antippen(); });
    }
    if (h.previousElementSibling !== k) k.after(h);
    h.hidden = false;
  }
  // Antippen: ruhig gleich (nach der Probe); sonst eine Rückfrage, nie wirkungslos
  function antippen() {
    if (seiteRuhig()) { neuLaden(true); return; }
    dialog(`<h2 id="bs-titel">Eine ungesicherte Messung geht verloren – trotzdem neu laden?</h2>
      <div class="knoepfe"><button type="button" id="bs-neu-ja">Ja, neu laden</button><button type="button" class="zweit" id="bs-neu-nein" data-bs-zu>Nein</button></div>`);
    document.getElementById("bs-neu-ja").addEventListener("click", () => { zu(); neuLaden(true, true); });
  }
  async function neuLaden(getippt = false, trotzdem = false) {
    const ruhig = () => trotzdem || seiteRuhig();
    if (neuPrueft || !ruhig()) { neuHinweis(true); return; }  // in Arbeit: von selbst nie
    neuPrueft = true;
    const { code, d } = await anfrage("GET", "/api/status", null, NEU_PROBE_MS);
    neuPrueft = false;
    if (code !== 200 || !d || d.ok === false || document.hidden || !ruhig()) { neuHinweis(true); return; }  // später erneut
    if (!getippt) try { sessionStorage.setItem(NEU_FUER, versionNeu); } catch (e) { /* egal */ }
    location.reload();
  }
  async function versionPruefen(v) {
    if (typeof v !== "string" || !v) return;
    if (versionGeladen === null) { versionGeladen = v; return; }
    versionNeu = v !== versionGeladen ? v : null;  // wieder die alte (zurückgerollt, bevor neu geladen wurde): nichts
    if (!versionNeu) { neuHinweis(false); return; }
    if (document.hidden || neuPrueft) return;
    let schon = null; try { schon = sessionStorage.getItem(NEU_FUER); } catch (e) { /* privat: dann ohne Merken */ }
    if (schon === versionNeu) { neuHinweis(true); return; }
    neuLaden();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && versionNeu) versionPruefen(versionNeu); });
  N.versionGeladen = () => versionGeladen;  // für Tests

  function statusMerken(d) {
    status = d;
    versionPruefen(d.version);
    if (d.id) boxen.haupt = d.id;
    if (d.layout) boxen.layout = d.layout;
    // Kanal-Check der Seite braucht Layout und Zuordnung der Box (sonst nur in der App eingerichtet)
    try { if (typeof ein !== "undefined" && ein && !ein.layout && d.layout && d.zuordnung) { ein.layout = d.layout; ein.zuordnung = d.zuordnung; } } catch (e) { /* Seite noch nicht bereit */ }
    if (Array.isArray(d.satelliten)) boxen.boxen = [{ id: d.id, name: d.name, rolle: d.rolle }, ...d.satelliten.map((s) => ({ id: s.id, name: s.name, rolle: "satellit" }))];
    obenZeigen();
  }
  // Lesende Aufrufe des Alltags (Jetzt läuft, Bibliothek …): ohne Daten per GET, die Abfrage steht im Namen
  const LESEN = new Set(["status", "ausgangspegel", "jetzt", "jetzt/details", "jetzt/pegel", "signalweg", "diagnose", "bericht", "funk/protokoll", "bibliothek", "warteschlange", "sicherung", "wlan", "regal", "regal/booklet", "regal/suche", "regal/titel", "regal/import"]);
  const leer = (d) => !d || (typeof d === "object" && !Object.keys(d).length);
  async function aufruf(name, daten, boxId) {
    const sat = boxId && boxId !== "box" && status && boxId !== status.id;
    const pfad = sat ? `/api/satellit/${encodeURIComponent(boxId)}/${name}` : `/api/${name}`;
    // Cover: dieselbe Herkunft, das Bild lädt die Seite direkt (kein Umweg über JSON)
    if (name.startsWith("cover/")) return { ok: true, bild: pfad };
    // Bilder des CD-Regals: nur mit Token (Kopfzeile), darum nicht als <img src>. Die Box liefert das Bild selbst
    // (kein JSON); hier wird daraus eine data-URL wie in der App.
    if (name.startsWith("regal/bild/")) return regalBild(pfad);
    const methode = name === "status" || (LESEN.has(name.split("?")[0]) && leer(daten)) ? "GET" : "POST";
    let { code, d, t } = await anfrage(methode, pfad, daten);
    if (code === 401 && d.grund === "kein_token") {
      const k = await koppelnEinmal(t); if (!k.ok) return k;
      ({ code, d } = await anfrage(methode, pfad, daten));
    }
    if (typeof d.ok !== "boolean") d.ok = code >= 200 && code < 300;
    if (name === "status" && !sat && d.ok) statusMerken(d);
    return d;
  }
  async function regalBild(pfad, nochmal = true) {
    const t = token();
    try {
      const r = await fetch(pfad, { headers: t ? { "X-Klangbox-Token": t } : {} });
      if (r.status === 401) {  // neu koppeln nur ohne gültiges Token, einmal und gemeinsam mit allen anderen Aufrufen
        let d = null; try { d = await r.json(); } catch (e) { d = null; }
        if (!nochmal || !d || d.grund !== "kein_token") return { ok: false, grund: (d && d.grund) || "kein_token", fehler: (d && d.fehler) || "Kein Zugang." };
        const k = await koppelnEinmal(t); return k.ok ? regalBild(pfad, false) : k;
      }
      const typ = r.headers.get("Content-Type") || "";
      if (!r.ok || !typ.startsWith("image/")) return { ok: false, grund: "kein_cover", fehler: "Kein Cover." };
      const blob = await r.blob();
      const bild = await new Promise((fertig) => { const l = new FileReader(); l.onload = () => fertig(String(l.result || "")); l.onerror = () => fertig(""); l.readAsDataURL(blob); });
      return bild ? { ok: true, bild } : { ok: false, grund: "kein_cover", fehler: "Kein Cover." };
    } catch (e) {
      return { ok: false, grund: "netz", fehler: "Die Klång-Box ist gerade nicht erreichbar." };
    }
  }
  // Boxen einrichten ohne App (Rear-Box): Die App sucht per Bonjour und koppelt jede Box selbst. Hier tut das die
  // Hauptbox (POST /api/satelliten): Sie sucht im Heimnetz, koppelt den Satelliten Box zu Box und behält sein Token;
  // der Browser bekommt es nie. Danach gehen Rollen, Funk (partner {id}) und Kanäle wie in der App.
  async function suchen() {
    const s = status && status.id ? status : await aufruf("status");
    if (!s || !s.id) return { ok: false, grund: "netz", fehler: "Die Klång-Box ist gerade nicht erreichbar." };
    const r = await aufruf("satelliten", { aktion: "suchen" });
    if (!r.ok) return r;
    return { ok: true, boxen: [{ id: s.id, name: s.name, rolle: s.rolle, gekoppelt: true },
      ...(r.boxen || []).filter((b) => b.rolle !== "haupt").map((b) => ({ id: b.id, name: b.name, rolle: b.rolle, gekoppelt: !!b.gekoppelt, ...(b.erreichbar_ueber ? { erreichbar_ueber: b.erreichbar_ueber } : {}) }))] };
  }
  const satKoppeln = (daten, boxId) => aufruf("satelliten", daten && daten.adresse ? { aktion: "koppeln", adresse: daten.adresse } : { aktion: "koppeln", id: boxId });
  const hierSelbst = (boxId) => !boxId || boxId === "box" || (status && boxId === status.id);
  const antworten = (fn, ...a) => setTimeout(() => { try { if (typeof N[fn] === "function") N[fn](...a); } catch (e) { /* Seite noch nicht bereit */ } }, 0);
  const bruecke = { postMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.art === "box") {
      // einrichtung: Die App merkt sich die Einrichtung; hier steht sie in der Box (Status: layout, satelliten)
      if (m.aufruf === "einrichtung") { if (m.daten && m.daten.layout) boxen.layout = m.daten.layout; return antworten("boxAntwort", m.reqId, { ok: true }); }
      const p = m.aufruf === "suchen" ? suchen()
        : m.aufruf === "koppeln" ? ((m.daten && m.daten.adresse) || !hierSelbst(m.box) ? satKoppeln(m.daten, m.box) : koppelnEinmal())
        : aufruf(m.aufruf, m.daten, m.box);
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
.bs-schleier { position: fixed; inset: 0; z-index: 60; background: var(--kb-schleier); display: grid; align-items: end; justify-items: center; }
.bs-dialog { width: min(var(--kb-inhalt), 100%); max-height: 92vh; overflow: auto; background: var(--kb-grund); color: var(--kb-text);
  border-radius: var(--kb-r-sheet) var(--kb-r-sheet) 0 0; border-top: 1px solid var(--kb-linie);
  padding: 16px var(--kb-rand-rechts) calc(32px + var(--kb-sicher-unten-ist)) var(--kb-rand-links); display: grid; gap: 16px; }
.bs-dialog h2 { margin: 0; font: var(--kb-t-titel3); }
.bs-dialog p, .bs-dialog ol { margin: 0; }
.bs-dialog ol { padding-left: 20px; display: grid; gap: 8px; }
.bs-dialog textarea { width: 100%; min-height: 112px; border-radius: var(--kb-r); border: 1px solid var(--kb-linie); background: var(--kb-grund);
  color: var(--kb-text); font: 400 15px/20px var(--kb-schrift); padding: 12px; resize: vertical; }
.bs-dialog .knoepfe { display: grid; gap: 12px; }
.bs-dialog a.knopf { display: grid; place-items: center; text-decoration: none; }
.bs-neu { display: block; width: 100%; margin: 0 0 12px; text-align: left; background: var(--kb-flaeche); color: var(--kb-text);
  border: 1px solid var(--kb-linie); border-radius: var(--kb-r-gruppe); padding: 10px 16px; font: var(--kb-t-bedien); cursor: pointer; }
.bs-neu[hidden] { display: none; }
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

  // http (nur dann leitet die Seite um, für Schritte mit Mikrofon): einmalig das Zertifikat der Box vertrauen, dann
  // https://klangbox.local und dort direkt einmessen. Boxen einrichten geht auf beiden Seiten hier (Hauptbox koppelt).
  function dialogDirekt() {
    dialog(`<span class="eyebrow">Einmessen</span><h2 id="bs-titel">Direkt hier einmessen</h2>
      <p class="klein">Das Mikrofon gibt Safari nur auf einer sicheren Seite frei. Die Box hat dafür ein eigenes Zertifikat. Einmalig, etwa 2 Minuten:</p>
      <ol class="klein"><li><a href="/klangbox-zertifikat.crt">Zertifikat der Box laden</a> und „Zulassen“ tippen.</li>
      <li>Einstellungen öffnen, oben „Profil geladen“ tippen und installieren.</li>
      <li>In den Einstellungen unter Allgemein, Info, Zertifikatsvertrauenseinstellungen den Eintrag „Klång-Box“ einschalten.</li>
      <li>Dann <b>${esc(HTTPS_ADRESSE)}</b> öffnen und diese Seite neu zum Home-Bildschirm hinzufügen. Dort misst du direkt ein: Die Box spielt den Messton selbst.</li></ol>
      <div class="knoepfe"><a class="knopf" id="bs-https" href="${esc(HTTPS_ADRESSE)}">Sichere Seite öffnen</a>
      <button type="button" class="leise" id="bs-mess-seite">Lieber über die Mess-Seite im Internet</button>
      <button type="button" class="leise" data-bs-zu>Zurück</button></div>`);
    offen.querySelector("#bs-mess-seite").addEventListener("click", dialogMessSeite);
    // mit Einmal-Code: die sichere Seite ist gleich gekoppelt (kein Ausstecken)
    offen.querySelector("#bs-https").addEventListener("click", async (ev) => {
      const code = einladungCode || await einladen(); if (!code) return;
      ev.preventDefault(); location.href = `${HTTPS_ADRESSE}?zuhause&koppeln=${encodeURIComponent(code)}`;
    });
  }

  function dialogMessSeite() {
    dialog(`<span class="eyebrow">Einmessen</span><h2 id="bs-titel">Einmessen auf der Mess-Seite</h2>
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
    zeige(`<span class="laeuft">Gebe es an die Klång-Box…</span>`);
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

  // --- Unter dem Kopf von Einmessen: Ergebnis übernehmen ---------------------------------------------------------------
  // Solange nichts eingemessen ist oder eine Nachmessung offen ist, ist „Ergebnis übernehmen“ der Hauptknopf oben
  // (Ablaufprüfung P1-9: der Laden-Weg ohne App führt hierher, der Knopf darf nicht unter elf Kacheln liegen)
  // Geprüft wird das Profil, das Einmessen zeigt: In 2.0/2.1 kommt Kino (stereo_kino) aus Stereo, solange Kino Stereo
  // folgt oder kein eigenes Kino eingemessen ist; dann zählt Stereo (ein Film allein öffnet den Kasten nicht).
  function uebernahmeOffen() {
    if (!status) return true;
    let id = status.profil_aktiv;
    const pr = status.profile, kf = status.kino_aus_stereo && status.kino_aus_stereo.folgt;
    if (pr && id === "stereo_kino" && ((kf && kf.folgt) || !(pr.stereo_kino && pr.stereo_kino.eingemessen))) id = "stereo";
    const p = pr && id ? pr[id] : status.modi ? status.modi[status.modus] : null;
    return !p || !p.eingemessen || p.status === "vorhergesagt";
  }
  function obenZeigen() {
    if (DIREKT) return;  // https: Ergebnisse kommen direkt in die Box, nichts zu übernehmen
    const held = document.getElementById("zh-held"); if (!held) return;
    let k = document.getElementById("bs-oben");
    if (!k) {
      stil();
      k = document.createElement("div"); k.id = "bs-oben"; k.className = "kasten bs-oben";
      k.innerHTML = `<span class="eyebrow">Von der Mess-Seite</span><p class="klein">Auf der Mess-Seite „Kopieren“ getippt? Dann hier übernehmen.</p>
        <button type="button" class="zweit" id="bs-oben-los">Ergebnis übernehmen</button>`;
      held.insertAdjacentElement("beforebegin", k);
      k.querySelector("#bs-oben-los").addEventListener("click", dialogUebernehmen);
    }
    k.hidden = !uebernahmeOffen();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", obenZeigen); else obenZeigen();

  window.klangboxBedienseite = { einmessen: dialogDirekt, uebernehmen: dialogUebernehmen, messSeite: MESS_SEITE, direkt: DIREKT };
})();

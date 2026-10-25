// Pegelautomatik: stellt die Lautstärke der Box (KEF über die iPhone-App) in kleinen Schritten ein, bis das
// Prüfsignal (pegel.wav: 2 s Stille, 3 s rosa Rauschen, 2 s Stille) sauber und mit genug Abstand zum
// Raumgeräusch am Mikrofon ankommt. Reine Logik, ohne Browser: läuft auch in node (tests/pegelautomatik_test.js).
//
// PegelAutomatik.einpegeln({
//   setzeLautstaerke(v) → Promise<Zahl | {wert}>  (die App meldet den Wert, der wirklich in der Box steht)
//   messe()             → Promise<{pegel_db, stoer_db, clip, spitze_db?}>  (eine Aufnahme mit Prüfsignal)
//   start, max, ziel, ursprung | leseLautstaerke(), ursache?(befund), abbruch?(), melde?(info),
//   zurueckstellen?(ursprung) → Promise<bool>, maxVersuche
// }) → Promise<{ok, lautstaerke, pegel_db, abstand_db, grund, text, ursprung, wiederhergestellt, versuche, verlauf, db_je_schritt}>
//
// Wächter:
// - nie über `max`; meldet die App weniger als verlangt (Grenze der Box), gilt das als neue Obergrenze;
//   nach einer Übersteuerung nie wieder bis zu dieser Stufe,
// - je Schritt höchstens 3 dB und höchstens 6 Stufen. Wie viele dB eine KEF-Stufe sind, ist nicht belegt
//   (ios/KEF-PROTOKOLL.md, die Faustregel 0,5 dB ist ungeprüft): Der erste Schritt mit Signal ist darum nur
//   1 Stufe; danach rechnet die Automatik mit der gemessenen Steigung (Ausgleichsgerade über die letzten
//   Messungen) plus Sicherheitszuschlag für das Messrauschen. Solange gar kein Signal ankommt, ist die Steigung
//   nicht messbar; dann höchstens 3 Stufen je Schritt und insgesamt höchstens 6 Stufen „blind“,
// - Übersteuerung: sofort zwei Stufen zurück (eine Stufe = ein Schritt der Automatik, ≈ 3 dB),
// - Start: `start` (leise), aber höchstens 6 Lautstärke-Stufen über der Ursprungslautstärke,
// - kommt nichts an (Box aus, falsche Quelle, AirPlay nicht verbunden): mit genauer Ursache abbrechen statt messen,
// - feste Höchstzahl an Versuchen, Zeitlimit je Befehl und je Messung,
// - bei jedem Abbruch und Fehler die Ursprungslautstärke wiederherstellen. Bei Erfolg bleibt der gefundene
//   Wert stehen, bis der Aufrufer nach der Messung `wiederherstellen()` ruft.
(function (wurzel) {
  "use strict";

  // Zielwerte wie pegelBewerten in Schritt 4 der Seite: Abstand Ton zu Raumrauschen mindestens 30 dB,
  // Spitze unter −3 dBFS, Raum „zu laut“ ab Rauschen über −50 dB. Reserve: 3 dB über dem Mindestabstand zielen.
  const ZIEL = { abstand_db: 30, reserve_db: 3, spitze_max_db: -3, rausch_laut_db: -50 };
  const STANDARD = {
    start: 20, max: 60, maxVersuche: 16, schrittDbMax: 3, schrittMax: 6, blindSchritt: 3, blindGesamt: 6, mindestHoerbar: 15,
    keinSignalDb: 6, messunsicherheitDb: 0.6, zeitSetzenMs: 12000, zeitMessenMs: 45000, maxUebersteuerungen: 3,
  };
  const HARTES_MAXIMUM = 100;

  const TEXTE = {
    ok: (e) => `Passt: ${Math.round(e.abstand_db)} dB Abstand zum Raumgeräusch bei Lautstärke ${e.lautstaerke}.`,
    knapp: (e) => `Passt knapp: ${Math.round(e.abstand_db)} dB Abstand bei Lautstärke ${e.lautstaerke} (lauter darf ich nicht).`,
    kein_signal: () => "Vom Prüfton kommt am Mikrofon nichts an.",
    raum_zu_laut: (e) => `Im Raum ist es zu laut (${Math.round(e.abstand_db)} dB Abstand, nötig ${ZIEL.abstand_db} dB). Fenster zu, Geräte aus, still sein, dann noch einmal.`,
    zu_leise_bei_max: (e) => `Auch bei der höchsten erlaubten Lautstärke (${e.grenze}) ist der Prüfton zu leise (${Math.round(e.abstand_db)} dB Abstand, nötig ${ZIEL.abstand_db} dB). Setz dich näher an die Boxen oder erhöhe das Maximum in den Einstellungen der App.`,
    uebersteuert: () => "Das Mikrofon übersteuert schon bei leiser Lautstärke. Halte das iPhone weiter weg von den Boxen.",
    lautstaerke_wirkt_nicht: () => "Die Lautstärke der Box ändert sich, aber der Prüfton wird nicht lauter. Spielt er wirklich über die KEF (AirPlay)?",
    zeitueberschreitung: (e) => `${e.was} hat zu lange gedauert. Ich habe abgebrochen.`,
    abgebrochen: () => "Abgebrochen.",
    versuche_aus: () => "Ich habe nach mehreren Versuchen keine passende Lautstärke gefunden.",
    ueber_maximum: (e) => `Die Box meldet Lautstärke ${e.lautstaerke}, erlaubt sind höchstens ${e.max}. Ich habe abgebrochen.`,
    ursprung_unbekannt: () => "Die jetzige Lautstärke der Box ist unbekannt, darum stelle ich nichts um.",
    messung_ungueltig: () => "Die Messung lieferte keine gültigen Werte.",
    fehler: (e) => `Fehler: ${e.meldung}`,
  };

  const endlich = (x) => typeof x === "number" && Number.isFinite(x);

  class Zeitueberschreitung extends Error {
    constructor(was) { super(`${was}: Zeitüberschreitung`); this.was = was; }
  }

  function mitZeit(versprechen, ms, was) {
    let t;
    const zeit = new Promise((_, nein) => { t = setTimeout(() => nein(new Zeitueberschreitung(was)), ms); });
    return Promise.race([Promise.resolve().then(() => versprechen), zeit]).finally(() => clearTimeout(t));
  }

  function zielAus(z) {
    if (endlich(z)) return { ...ZIEL, abstand_db: z };
    return { ...ZIEL, ...(z && typeof z === "object" ? z : {}) };
  }

  // Wert aus der Antwort der App (Zahl oder {wert}); ohne Wert in der Antwort der angefragte.
  function istWert(antwort, angefragt) {
    if (endlich(antwort)) return Math.round(antwort);
    if (antwort && endlich(antwort.wert)) return Math.round(antwort.wert);
    return angefragt;
  }

  // Steigung dB je Stufe, obere Schranke: Ausgleichsgerade über die letzten Messungen mit Signal
  // plus Messunsicherheit / Spannweite. null, solange es keine zwei Stufen gibt.
  function steigungOben(punkte, unsicherheit) {
    const p = punkte.slice(-4);
    if (p.length < 2) return null;
    const mx = p.reduce((s, q) => s + q.v, 0) / p.length, my = p.reduce((s, q) => s + q.db, 0) / p.length;
    let sxx = 0, sxy = 0;
    for (const q of p) { sxx += (q.v - mx) ** 2; sxy += (q.v - mx) * (q.db - my); }
    if (sxx <= 0) return null;
    const spann = Math.max(...p.map((q) => q.v)) - Math.min(...p.map((q) => q.v));
    return Math.max(0.05, sxy / sxx) + unsicherheit / Math.max(1, spann);
  }

  // Ursprungslautstärke zurückstellen. Die App lässt je Befehl höchstens +6 Stufen zu; darum so lange
  // wiederholen, bis der Wert stimmt (höchstens 30 Befehle, Abbruch ohne Fortschritt). true = geklappt.
  async function wiederherstellen(o, ursprung) {
    if (!endlich(ursprung)) return false;
    const zeitMs = (o && o.zeitSetzenMs) || STANDARD.zeitSetzenMs;
    let letzter = null, ohneFortschritt = 0;
    for (let i = 0; i < 30 && ohneFortschritt < 3; i++) {
      try {
        const ist = istWert(await mitZeit(o.setzeLautstaerke(ursprung), zeitMs, "Zurückstellen"), ursprung);
        if (ist === ursprung) return true;
        ohneFortschritt = letzter !== null && Math.abs(ursprung - ist) >= Math.abs(ursprung - letzter) ? ohneFortschritt + 1 : 0;
        letzter = ist;
      } catch (e) { ohneFortschritt++; }
    }
    return false;
  }

  async function einpegeln(o) {
    o = o || {};
    const p = { ...STANDARD, ...o };
    const ziel = zielAus(o.ziel);
    const max = Math.max(0, Math.min(HARTES_MAXIMUM, endlich(o.max) ? Math.floor(o.max) : STANDARD.max));
    const melde = typeof o.melde === "function" ? o.melde : () => {};
    const abbruch = typeof o.abbruch === "function" ? o.abbruch : () => false;
    const verlauf = [], punkte = [];
    let ursprung = endlich(o.ursprung) ? Math.round(o.ursprung) : null;
    let aktuell = null, verstellt = false, obergrenze = max, letzteStufe = 1, uebersteuert = 0, versuche = 0;
    let blindAb = null, ohneWirkung = 0, letzte = null, steigung = null;

    const ergebnis = (ok, grund, extra) => {
      const e = {
        ok, grund, lautstaerke: aktuell, ursprung, max, grenze: obergrenze, versuche, verlauf,
        pegel_db: letzte ? letzte.pegel_db : null, stoer_db: letzte ? letzte.stoer_db : null,
        abstand_db: letzte ? letzte.abstand_db : null,
        db_je_schritt: steigung === null ? null : Math.round((steigung - p.messunsicherheitDb / Math.max(1, spannweite())) * 100) / 100,
        wiederhergestellt: false, ...extra,
      };
      e.text = e.text || (TEXTE[e.textArt || grund] || TEXTE.fehler)({ ...e, meldung: e.meldung || grund });
      if (ok) melde({ art: "ende", ergebnis: e });
      return e;
    };
    const spannweite = () => (punkte.length < 2 ? 1 : Math.max(...punkte.slice(-4).map((q) => q.v)) - Math.min(...punkte.slice(-4).map((q) => q.v)));

    // Abbruch: Ursprung wiederherstellen
    const scheitern = async (grund, extra) => {
      const e = ergebnis(false, grund, extra);
      if (verstellt) {
        melde({ art: "zurueck", lautstaerke: ursprung });
        e.wiederhergestellt = typeof o.zurueckstellen === "function"
          ? await mitZeit(o.zurueckstellen(ursprung), p.zeitSetzenMs, "Zurückstellen").then((x) => x !== false, () => false)
          : await wiederherstellen(p, ursprung);
        if (e.wiederhergestellt) e.lautstaerke = ursprung;
        else e.text += " Die alte Lautstärke ließ sich nicht zurückstellen, bitte von Hand prüfen.";
      } else {
        e.wiederhergestellt = true;  // nichts verstellt
      }
      melde({ art: "ende", ergebnis: e });
      return e;
    };

    const setze = async (v) => {
      v = Math.max(0, Math.min(obergrenze, Math.round(v)));
      const von = aktuell === null ? ursprung : aktuell;
      if (v > von + p.schrittMax) v = von + p.schrittMax;
      melde({ art: "setze", lautstaerke: v });
      verstellt = true;
      const ist = istWert(await mitZeit(o.setzeLautstaerke(v), p.zeitSetzenMs, "Das Einstellen der Lautstärke"), v);
      aktuell = ist;
      if (ist < v && v > von) obergrenze = Math.min(obergrenze, Math.max(ist, 0));  // App oder Box begrenzt
      return ist;
    };

    // Nächste Lautstärke mit Signal: höchstens 3 dB (nach gemessener Steigung), höchstens 6 Stufen.
    const naechsteStufe = (fehltDb) => {
      if (steigung === null) return 1;
      return Math.max(1, Math.min(p.schrittMax, Math.floor(Math.min(p.schrittDbMax, fehltDb) / steigung + 1e-9)));
    };

    try {
      if (typeof o.setzeLautstaerke !== "function" || typeof o.messe !== "function") {
        return await scheitern("fehler", { meldung: "setzeLautstaerke und messe fehlen." });
      }
      if (ursprung === null && typeof o.leseLautstaerke === "function") {
        const v = await mitZeit(o.leseLautstaerke(), p.zeitSetzenMs, "Das Lesen der Lautstärke");
        ursprung = endlich(v) ? Math.round(v) : (v && endlich(v.lautstaerke) ? Math.round(v.lautstaerke) : null);
      }
      if (ursprung === null) return await scheitern("ursprung_unbekannt");

      // leise starten
      let soll = Math.min(endlich(o.start) ? o.start : STANDARD.start, max);

      while (versuche < p.maxVersuche) {
        if (abbruch()) return await scheitern("abgebrochen");
        const ist = await setze(soll);
        if (ist > max) return await scheitern("ueber_maximum");
        if (abbruch()) return await scheitern("abgebrochen");
        versuche++;
        melde({ art: "messe", lautstaerke: ist, versuch: versuche });
        const m = await mitZeit(o.messe(), p.zeitMessenMs, "Die Messung");
        if (abbruch()) return await scheitern("abgebrochen");
        if (!m || !endlich(m.pegel_db) || !endlich(m.stoer_db)) return await scheitern("messung_ungueltig");
        const clip = !!m.clip || (endlich(m.spitze_db) && m.spitze_db > ziel.spitze_max_db);
        const eintrag = { lautstaerke: ist, pegel_db: m.pegel_db, stoer_db: m.stoer_db, abstand_db: m.pegel_db - m.stoer_db, clip };
        if (endlich(m.spitze_db)) eintrag.spitze_db = m.spitze_db;
        const vorher = verlauf.length ? verlauf[verlauf.length - 1] : null;
        verlauf.push(eintrag);
        letzte = eintrag;
        melde({ art: "gemessen", ...eintrag });
        const signal = eintrag.abstand_db >= p.keinSignalDb;

        if (clip) {
          uebersteuert++;
          obergrenze = Math.min(obergrenze, ist - 1);
          punkte.length = 0;  // Steigung nach der Übersteuerung neu lernen
          if (uebersteuert >= p.maxUebersteuerungen || ist <= 0 || obergrenze < 0) return await scheitern("uebersteuert");
          // sofort zwei Stufen zurück; eine Stufe = ein Schritt der Automatik (≈ 3 dB, ohne Messung 3 Lautstärke-Stufen)
          const stufe = Math.max(letzteStufe, steigung === null ? p.blindSchritt : Math.max(1, Math.floor(p.schrittDbMax / steigung)));
          soll = Math.max(0, ist - 2 * stufe);
          letzteStufe = 1;
          continue;
        }

        if (!signal) {
          // Nichts kommt an. Steigt der Pegel beim Lauterdrehen wenigstens (Signal knapp unter dem Rauschen),
          // weiter vorsichtig lauter; sonst nach höchstens 6 Stufen mit Ursache abbrechen.
          if (blindAb === null) blindAb = { v: ist, abstand: eintrag.abstand_db };
          const erhoeht = ist - blindAb.v, steigt = eintrag.abstand_db - blindAb.abstand >= 1.5;
          // Abbruch erst, wenn die Box sicher hörbar laut steht (mindestHoerbar) und 6 Stufen nichts gebracht haben
          if (ist >= obergrenze || (erhoeht >= p.blindGesamt && !steigt && ist >= Math.min(p.mindestHoerbar, obergrenze))) {
            let u = null;
            if (typeof o.ursache === "function") {
              try { u = await mitZeit(o.ursache({ verlauf, lautstaerke: ist }), p.zeitSetzenMs, "Die Ursachensuche"); } catch (e) { u = null; }
            }
            if (eintrag.stoer_db > ziel.rausch_laut_db && !(u && u.grund)) return await scheitern("raum_zu_laut");
            return await scheitern("kein_signal", u && u.text ? { ursache: u.grund || null, text: `${TEXTE.kein_signal()} ${u.text}` } : {});
          }
          if (steigt) blindAb = { v: ist, abstand: eintrag.abstand_db };
          letzteStufe = Math.min(p.blindSchritt, obergrenze - ist);
          soll = ist + letzteStufe;
          continue;
        }
        blindAb = null;

        // Steigung lernen (nur saubere Messungen mit Signal, Pegel ohne Raumrauschen-Anteil)
        const reinDb = 10 * Math.log10(Math.max(1e-12, 10 ** (eintrag.pegel_db / 10) - 10 ** (eintrag.stoer_db / 10)));
        if (!punkte.length || punkte[punkte.length - 1].v !== ist) punkte.push({ v: ist, db: reinDb });
        steigung = steigungOben(punkte, p.messunsicherheitDb);
        if (vorher && !vorher.clip && vorher.abstand_db >= p.keinSignalDb && ist - vorher.lautstaerke >= 2) {
          ohneWirkung = eintrag.pegel_db - vorher.pegel_db < 0.3 ? ohneWirkung + 1 : 0;
          if (ohneWirkung >= 2) return await scheitern("lautstaerke_wirkt_nicht");
        }

        const fehlt = ziel.abstand_db + ziel.reserve_db - eintrag.abstand_db;
        if (fehlt <= 0) return ergebnis(true, "ok");
        if (ist >= obergrenze) {
          if (eintrag.abstand_db >= ziel.abstand_db) return ergebnis(true, "ok", { textArt: "knapp" });
          return await scheitern(eintrag.stoer_db > ziel.rausch_laut_db ? "raum_zu_laut" : "zu_leise_bei_max");
        }
        // Vorhersage: auch bei der Obergrenze klar unerreichbar? Dann gleich mit Grund abbrechen.
        if (punkte.length >= 3 && steigung !== null) {
          const s = steigung - p.messunsicherheitDb / Math.max(1, spannweite());
          if (ziel.abstand_db - eintrag.abstand_db > (obergrenze - ist) * Math.max(s, 0.05) * 1.5 + 3) {
            return await scheitern(eintrag.stoer_db > ziel.rausch_laut_db ? "raum_zu_laut" : "zu_leise_bei_max");
          }
        }
        letzteStufe = Math.min(naechsteStufe(fehlt), obergrenze - ist);
        soll = ist + letzteStufe;
      }
      if (letzte && !letzte.clip && letzte.abstand_db >= ziel.abstand_db) return ergebnis(true, "ok", { textArt: "knapp" });
      return await scheitern("versuche_aus");
    } catch (fehler) {
      if (abbruch()) return await scheitern("abgebrochen");
      if (fehler instanceof Zeitueberschreitung) return await scheitern("zeitueberschreitung", { was: fehler.was });
      return await scheitern("fehler", { meldung: String((fehler && fehler.message) || fehler) });
    }
  }

  const api = { einpegeln, wiederherstellen, ZIEL, STANDARD, TEXTE };
  wurzel.PegelAutomatik = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

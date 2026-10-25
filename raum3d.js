/* raum3d.js – Klang-Box: 3D-Nachbau eines Raum-Scans (Apple RoomPlan) mit Anlage und ersten Reflexionen.
 *
 * Klassisches Script (kein Build-Tool, läuft offline in WKWebView). Erwartet three.js als globales THREE:
 *   <script src="three.min.js"></script>   three.js r160 (0.160.0), MIT-Lizenz,
 *                                           Copyright © 2010-2023 three.js authors, https://threejs.org
 *   <script src="raum3d.js"></script>       stellt das globale Objekt Raum3D bereit.
 *
 * API
 *   const ansicht = Raum3D.zeigen(container, raum, anlage, optionen)
 *     ansicht.aktualisieren(anlage[, optionen])  Anlage (und ggf. Optionen) neu setzen
 *     ansicht.reflexionen()                      berechnete erste Reflexionen (Liste, s. u.)
 *     ansicht.zuruecksetzen()                    Kamera auf Startansicht
 *     ansicht.setAkzent(farbe) / ansicht.akzent() Akzent live umfärben (Direktschall, Hörplatz-Kugel) / lesen
 *   Raum3D.setAkzent(farbe)                     dasselbe für alle offenen Ansichten; ohne Argument --akzent neu lesen
 *   Akzentfarbe: beim Start aus der CSS-Variable --akzent auf :root (Blau #7FB0FF, Mint #8CE0C4, Violett #B79CFF),
 *   fehlt sie, gilt #7FB0FF. Reflexionen bleiben fest #FFB547, der Vorschlags-Geist bleibt #7FB0FF.
 *     ansicht.zerstoeren()                       WebGL, Listener und Canvas freigeben
 *   Raum3D.berechneReflexionen(raum, anlage, optionen)   reine Geometrie, ohne WebGL (auch in Node nutzbar)
 *   Raum3D.beschreibung(raum)                            Kurztext für aria-label
 *
 * Koordinaten wie in klangbox/sweetspot.py und dem 2D-Grundriss der Mess-Seite: Meter, x quer (0 = linke Wand),
 * y längs (0 = Wand hinter den Boxen, wächst zum Hörer hin), z = Höhe. Bildschirm: Grundriss mit y nach unten.
 * Objekte: drehung_grad dreht von +x nach +y; bei 0° zeigt die Vorderseite (Sitzfläche, Bildschirm) nach +y.
 * optionen.spiegeln = true spiegelt die Darstellung (falls ein Scan rechtshändig mit y „nach oben“ geliefert wird).
 *
 * Reflexion (Spiegelquellen-Methode, 1. Ordnung): Box an der Wandebene spiegeln, Gerade Spiegelquelle → Ohr mit der
 * Ebene schneiden. Gültig nur, wenn Box und Ohr innen vor der Wand liegen, der Punkt im Wandsegment (0…Länge) und
 * zwischen 0 und Wandhöhe liegt, nicht in einer offenen Öffnung, und die Wege Box → Punkt → Ohr keine andere Wand
 * kreuzen (wichtig für L-förmige Räume). Boden/Decke: Punkt muss im Grundriss-Polygon liegen.
 *   { box:"FL"|"FR", flaeche:"links"|"rechts"|"boden"|"decke"|"vorne"(|"hinten" mit optionen.hinten),
 *     punkt:[x,y,z], umweg_m, verzoegerung_ms, daempfung_db, auf_fenster, auf_tuer, wand_id }
 * "links"/"rechts" ergibt sich aus der Lage von FL/FR (nicht aus der Händigkeit der Koordinaten).
 */
(function (global) {
  "use strict";

  const SCHALL = 343;            // m/s
  const EPS = 1e-6;
  const WANDSTAERKE = 0.1;       // nur Optik, nach außen
  // Farben nach docs/app/mockups/STIL.md und Raum.dc.html
  const FARBEN = {
    hintergrund: 0x0b0d10, wand: 0x1c222b, wandInnen: 0x171c24, wandkante: 0x3a4452, krone: 0x2a313b, bodenSeite: 0x1a1510,
    glas: 0x7fb0ff, glasRand: 0x9cc8ff, tuerrahmen: 0xffb547,
    sofa: 0xc9623f, sofaKissen: 0xd06a46, sofaDunkel: 0xa84f31, holz: 0x6b5140, holzHell: 0x7a5d45, stuhl: 0x4a5563, tv: 0x0a0c0f,
    bett: 0x4a5563, matratze: 0xd9dde3, decke: 0x5f7387, schrank: 0x3a4452, kamin: 0x4a5563, sonst: 0x4a5563,
    box: 0xe9ecf0, ständer: 0x3a4452, membran: 0x0b0d10, kalotte: 0x2a313b, kopf: 0x7fb0ff,
    direkt: 0x7fb0ff, reflex: 0xffb547, fenster: 0xffb547, geist: 0x7fb0ff, text: "#F2F4F7", karte: "rgba(23,27,33,0.9)", rand: "rgba(58,68,82,0.9)",
  };
  const FLAECHEN_TEXT = { links: "linke Seitenwand", rechts: "rechte Seitenwand", boden: "Boden", decke: "Decke", vorne: "Wand hinter den Boxen", hinten: "Rückwand" };

  // ---------------------------------------------------------------------------------------------
  // Geometrie (ohne THREE)
  // ---------------------------------------------------------------------------------------------
  const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));
  const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];

  function flaecheSigned(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }
  function imPolygon(pt, poly) {
    let drin = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) drin = !drin;
    }
    return drin;
  }
  // echte Kreuzung zweier Strecken (Berührung an den Enden zählt nicht)
  function kreuzen(p, q, a, b) {
    const r = [q[0] - p[0], q[1] - p[1]], s = [b[0] - a[0], b[1] - a[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return false;
    const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / den;
    const u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / den;
    return t > 1e-4 && t < 1 - 1e-4 && u > 1e-4 && u < 1 - 1e-4;
  }

  function grundrissVon(raum) {
    if (Array.isArray(raum.grundriss) && raum.grundriss.length >= 3) return raum.grundriss.map((p) => [+p[0], +p[1]]);
    if (Array.isArray(raum.waende) && raum.waende.length >= 3) return raum.waende.map((w) => [+w.a[0], +w.a[1]]);
    if (raum.breite && raum.laenge) return [[0, 0], [raum.breite, 0], [raum.breite, raum.laenge], [0, raum.laenge]];
    throw new Error("Raum3D: Raum ohne Grundriss und Wände");
  }
  function raumHoehe(raum) {
    if (raum.hoehe > 0) return +raum.hoehe;
    const hs = (raum.waende || []).map((w) => +w.hoehe).filter((h) => h > 0);
    return hs.length ? Math.max(...hs) : 2.5;
  }

  // Wände normalisieren: Länge, Richtung u, Normale n nach außen, Öffnungen in Wandkoordinaten
  function aufbereiten(raum) {
    const poly = grundrissVon(raum), H = raumHoehe(raum);
    const ccw = flaecheSigned(poly) > 0;
    let roh = Array.isArray(raum.waende) && raum.waende.length ? raum.waende
      : poly.map((a, i) => ({ id: "w" + (i + 1), a, b: poly[(i + 1) % poly.length], hoehe: H }));
    const waende = roh.map((w, i) => {
      const a = [+w.a[0], +w.a[1]], b = [+w.b[0], +w.b[1]], L = d2(a, b);
      const u = L > EPS ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0];
      let n = [u[1], -u[0]];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], e = 0.05;
      const plus = imPolygon([m[0] + n[0] * e, m[1] + n[1] * e], poly), minus = imPolygon([m[0] - n[0] * e, m[1] - n[1] * e], poly);
      if (plus && !minus) n = [-n[0], -n[1]];
      else if (plus === minus && !ccw) n = [-n[0], -n[1]];   // Wand nicht auf dem Polygonrand: Umlaufsinn entscheidet
      return { id: w.id != null ? String(w.id) : "w" + (i + 1), a, b, L, u, n, hoehe: +w.hoehe > 0 ? +w.hoehe : H, oeffnungen: [] };
    });
    const zuWand = (o) => {
      let w = waende.find((x) => x.id === String(o.wand));
      const m = o.mitte || [0, 0];
      if (!w) { // nächste Wand zur Mitte
        let best = Infinity;
        for (const x of waende) {
          const t = Math.max(0, Math.min(x.L, dot2([m[0] - x.a[0], m[1] - x.a[1]], x.u)));
          const dd = d2(m, [x.a[0] + x.u[0] * t, x.a[1] + x.u[1] * t]);
          if (dd < best) { best = dd; w = x; }
        }
      }
      return w;
    };
    const eintragen = (liste, art) => {
      for (const o of liste || []) {
        const w = zuWand(o); if (!w) continue;
        const m = o.mitte || [0, 0], s = dot2([m[0] - w.a[0], m[1] - w.a[1]], w.u);
        const br = +o.breite || 0.9, h = +o.hoehe || (art === "fenster" ? 1.2 : 2.0);
        const v0 = art === "fenster" ? (o.bruestung != null ? +o.bruestung : 0.9) : 0;
        w.oeffnungen.push({ art, u0: Math.max(0, s - br / 2), u1: Math.min(w.L, s + br / 2), v0, v1: Math.min(w.hoehe, v0 + h), quelle: o });
      }
    };
    eintragen(raum.fenster, "fenster"); eintragen(raum.tueren, "tuer"); eintragen(raum.oeffnungen, "oeffnung");
    return { poly, H, waende, ccw };
  }

  function berechneReflexionen(raum, anlage, optionen) {
    optionen = optionen || {};
    if (!anlage || !anlage.hoerplatz) return [];
    const geo = raum && raum.waende && raum.waende[0] && raum.waende[0].n ? raum : aufbereiten(raum);
    const { poly, H, waende } = geo, ohr = anlage.hoerplatz.map(Number);
    if (ohr.length < 3) ohr[2] = 1.1;
    const boxen = [["FL", anlage.fl], ["FR", anlage.fr]].filter(([, p]) => Array.isArray(p));
    // Blickrichtung (Ohr → Mitte der Boxen) und „links“ (Richtung FR → FL)
    let f = [0, -1], l = [-1, 0];
    if (anlage.fl && anlage.fr) {
      const mid = [(anlage.fl[0] + anlage.fr[0]) / 2, (anlage.fl[1] + anlage.fr[1]) / 2];
      const fl = d2(mid, ohr); if (fl > EPS) f = [(mid[0] - ohr[0]) / fl, (mid[1] - ohr[1]) / fl];
      // links = Komponente von FR→FL senkrecht zu f
      const v = [anlage.fl[0] - anlage.fr[0], anlage.fl[1] - anlage.fr[1]], k = dot2(v, f);
      const s = [v[0] - k * f[0], v[1] - k * f[1]], sl = Math.hypot(s[0], s[1]);
      l = sl > EPS ? [s[0] / sl, s[1] / sl] : [f[1], -f[0]];
    }
    const art = (n) => {
      const df = dot2(n, f), dl = dot2(n, l);
      if (Math.abs(df) >= Math.abs(dl)) return df > 0 ? "vorne" : "hinten";
      return dl > 0 ? "links" : "rechts";
    };
    const frei = (p, q, ausser) => !waende.some((w) => w !== ausser && kreuzen(p, q, w.a, w.b));
    const r4 = (x) => Math.round(x * 1e4) / 1e4;
    const erg = [];
    const ablegen = (name, quelle, flaeche, P, bild, w, extra) => {
      const direkt = d3(quelle, ohr), umweg = d3(bild, ohr) - direkt;
      erg.push(Object.assign({
        box: name, flaeche, punkt: P.map(r4), umweg_m: r4(umweg), verzoegerung_ms: r4(umweg / SCHALL * 1000),
        daempfung_db: r4(20 * Math.log10(d3(bild, ohr) / Math.max(direkt, EPS))),
        auf_fenster: false, auf_tuer: false, wand_id: w ? w.id : null,
      }, extra || {}));
    };
    for (const [name, pRoh] of boxen) {
      const q = pRoh.map(Number); if (q.length < 3) q[2] = 1.0;
      for (const w of waende) {
        const fl = art(w.n);
        if (fl === "hinten" && !optionen.hinten) continue;
        const ds = dot2([q[0] - w.a[0], q[1] - w.a[1]], w.n), de = dot2([ohr[0] - w.a[0], ohr[1] - w.a[1]], w.n);
        if (ds >= -EPS || de >= -EPS) continue;          // beide müssen innen vor der Wand liegen
        const bild = [q[0] - 2 * ds * w.n[0], q[1] - 2 * ds * w.n[1], q[2]];
        const k = ds / (ds + de);                         // Anteil von der Spiegelquelle zum Ohr
        const P = [bild[0] + k * (ohr[0] - bild[0]), bild[1] + k * (ohr[1] - bild[1]), bild[2] + k * (ohr[2] - bild[2])];
        const s = dot2([P[0] - w.a[0], P[1] - w.a[1]], w.u);
        if (s < -1e-4 || s > w.L + 1e-4 || P[2] < -1e-4 || P[2] > w.hoehe + 1e-4) continue;
        const treffer = w.oeffnungen.find((o) => s >= o.u0 && s <= o.u1 && P[2] >= o.v0 && P[2] <= o.v1);
        if (treffer && treffer.art === "oeffnung") continue;        // offener Durchgang reflektiert nicht
        if (!frei(q, P, w) || !frei(P, ohr, w)) continue;
        ablegen(name, q, fl, P, bild, w, { auf_fenster: !!treffer && treffer.art === "fenster", auf_tuer: !!treffer && treffer.art === "tuer" });
      }
      for (const [fl, hz] of [["boden", 0], ["decke", H]]) {
        const ds = Math.abs(q[2] - hz), de = Math.abs(ohr[2] - hz);
        if (ds < EPS || de < EPS || (fl === "decke" && (q[2] >= H || ohr[2] >= H))) continue;
        const k = ds / (ds + de);
        const P = [q[0] + k * (ohr[0] - q[0]), q[1] + k * (ohr[1] - q[1]), hz];
        if (!imPolygon(P, poly) || !frei(q, P, null) || !frei(P, ohr, null)) continue;
        ablegen(name, q, fl, P, [q[0], q[1], 2 * hz - q[2]], null);
      }
    }
    const ord = { links: 0, rechts: 1, vorne: 2, boden: 3, decke: 4, hinten: 5 };
    erg.sort((a, b) => a.box.localeCompare(b.box) || ord[a.flaeche] - ord[b.flaeche] || a.umweg_m - b.umweg_m);
    return erg;
  }

  const zahl = (x, n) => Number(x).toLocaleString("de-DE", { minimumFractionDigits: n, maximumFractionDigits: n });
  function beschreibung(raum) {
    const g = aufbereiten(raum), xs = g.poly.map((p) => p[0]), ys = g.poly.map((p) => p[1]);
    const b = Math.max(...xs) - Math.min(...xs), t = Math.max(...ys) - Math.min(...ys);
    const fl = raum.flaeche_m2 || Math.abs(flaecheSigned(g.poly));
    const nf = (raum.fenster || []).length, nt = (raum.tueren || []).length, no = (raum.objekte || []).length;
    const form = raum.rechteckig === false || g.poly.length !== 4 ? `${g.poly.length}-eckiger Raum` : "Rechteckiger Raum";
    return `3D-Modell: ${form}, ${zahl(b, 2)} × ${zahl(t, 2)} m, Höhe ${zahl(g.H, 2)} m, ${zahl(fl, 1)} m², ` +
      `${nf} Fenster, ${nt} ${nt === 1 ? "Tür" : "Türen"}, ${no} Möbel. ` +
      "Ein Finger dreht, zwei Finger zoomen, Doppeltipp setzt die Ansicht zurück.";
  }

  // Akzentfarbe (wählbar: Blau #7FB0FF, Mint #8CE0C4, Violett #B79CFF) aus der CSS-Variable --akzent
  const AKZENT_STANDARD = "#7FB0FF";
  const offene = new Set();   // laufende Ansichten, für Raum3D.setAkzent
  function hexFarbe(farbe) {
    const f = String(farbe == null ? "" : farbe).trim();
    if (/^#[0-9a-f]{6}$/i.test(f)) return f.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(f)) return ("#" + f[1] + f[1] + f[2] + f[2] + f[3] + f[3]).toLowerCase();
    const m = f.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return "#" + [m[1], m[2], m[3]].map((x) => Math.min(255, +x).toString(16).padStart(2, "0")).join("");
    return null;
  }
  function akzentAusCss() {
    try {
      if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return AKZENT_STANDARD.toLowerCase();
      return hexFarbe(getComputedStyle(document.documentElement).getPropertyValue("--akzent")) || AKZENT_STANDARD.toLowerCase();
    } catch (e) { return AKZENT_STANDARD.toLowerCase(); }
  }

  // ---------------------------------------------------------------------------------------------
  // Darstellung (THREE)
  // ---------------------------------------------------------------------------------------------
  function zeigen(container, raum, anlage, optionen) {
    const T = global.THREE;
    if (!T) throw new Error("Raum3D: three.js (globales THREE) fehlt – three.min.js vor raum3d.js laden");
    if (!container) throw new Error("Raum3D: Container fehlt");
    let akzent = akzentAusCss();
    let akzentMats = [];   // Direktschall, Hörplatz-Kugel, Bodenring/Lot des Hörplatzes
    let opt = Object.assign({ reflexionen: true, beschriftung: true, autoDrehen: false, schatten: true, hinten: false, spiegeln: false }, optionen || {});
    const geo = aufbereiten(raum), H = geo.H;
    const spiegel = opt.spiegeln ? -1 : 1;
    // Raum (x, y, z) → three (x, z, y): Grundriss wie auf dem Bildschirm (y nach unten = zur Kamera hin)
    const V = (x, y, z) => new T.Vector3(x, z || 0, spiegel * y);
    const Vp = (p) => V(p[0], p[1], p[2] || 0);

    // --- Renderer, Szene, Kamera
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: !!opt.preserveDrawingBuffer });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(FARBEN.hintergrund, 1);
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !!opt.schatten;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none;cursor:grab;";
    canvas.setAttribute("aria-hidden", "true");
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(canvas);
    container.setAttribute("role", "img");
    container.setAttribute("aria-label", beschreibung(raum));

    const scene = new T.Scene();
    scene.background = new T.Color(FARBEN.hintergrund);
    const camera = new T.PerspectiveCamera(26, 1, 0.05, 400);
    const entsorgen = [];  // Texturen u. ä.

    // Licht: weicher Himmel + Sonne von schräg oben
    scene.add(new T.HemisphereLight(0xe6eefc, 0x3a2f25, 1.6));
    scene.add(new T.AmbientLight(0xffffff, 0.25));
    const xs = geo.poly.map((p) => p[0]), ys = geo.poly.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const mitte = V((minX + maxX) / 2, (minY + maxY) / 2, 0);
    const radius = Math.hypot(maxX - minX, maxY - minY, H) / 2;
    const sonne = new T.DirectionalLight(0xfff3e2, 2.2);
    sonne.position.copy(mitte).add(new T.Vector3(-radius * 0.9, radius * 2.2, radius * 1.3));
    sonne.target.position.copy(mitte);
    scene.add(sonne, sonne.target);
    if (opt.schatten) {
      sonne.castShadow = true;
      sonne.shadow.mapSize.set(1024, 1024);
      const sc = sonne.shadow.camera; sc.left = sc.bottom = -radius * 1.3; sc.right = sc.top = radius * 1.3; sc.near = 0.1; sc.far = radius * 6;
      sonne.shadow.bias = -0.0008; sonne.shadow.normalBias = 0.02; sonne.shadow.radius = 4;
    }

    // --- Hilfen
    const mat = (farbe, extra) => new T.MeshStandardMaterial(Object.assign({ color: farbe, roughness: 0.75, metalness: 0 }, extra || {}));
    function rundQuader(b, h, t, r) {   // Quader mit runden Kanten (Breite x, Höhe y, Tiefe z), zentriert
      r = Math.max(0.002, Math.min(r, b / 2 - 0.001, h / 2 - 0.001, t / 2 - 0.001));
      const e = 0.0001, s = new T.Shape(), w = b - 2 * r, hh = h - 2 * r;
      s.absarc(e, e, e, -Math.PI / 2, -Math.PI, true);
      s.absarc(e, hh - e, e, Math.PI, Math.PI / 2, true);
      s.absarc(w - e, hh - e, e, Math.PI / 2, 0, true);
      s.absarc(w - e, e, e, 0, -Math.PI / 2, true);
      const g = new T.ExtrudeGeometry(s, { depth: Math.max(0.0001, t - 2 * r), bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: r - e, bevelThickness: r, curveSegments: 3 });
      g.center();
      return g;
    }
    function teil(gruppe, geom, material, x, y, z, schatten) {  // Position in three-Lokalkoordinaten
      const m = new T.Mesh(geom, material);
      m.position.set(x, y, z);
      if (schatten !== false && opt.schatten) { m.castShadow = true; m.receiveShadow = true; }
      gruppe.add(m);
      return m;
    }
    // Quader im Objekt-Lokalsystem (Raum: lx quer, ly vorne(+)/hinten(−), z0 Unterkante)
    const klotz = (g, m, lx, ly, z0, b, t, h, r) => teil(g, rundQuader(b, h, t, r == null ? 0.02 : r), m, lx, z0 + h / 2, spiegel * ly);

    function roehren(strecken, r, segmente) {   // viele dünne Zylinder zu einer Geometrie
      const basis = new T.CylinderGeometry(r, r, 1, segmente || 6, 1, true).toNonIndexed();
      const bp = basis.attributes.position, bn = basis.attributes.normal, n = bp.count;
      const pos = new Float32Array(strecken.length * n * 3), nor = new Float32Array(strecken.length * n * 3);
      const m = new T.Matrix4(), nm = new T.Matrix3(), q = new T.Quaternion(), sk = new T.Vector3(), up = new T.Vector3(0, 1, 0), v = new T.Vector3();
      strecken.forEach(([a, b], i) => {
        const dir = new T.Vector3().subVectors(b, a), len = dir.length();
        if (len < 1e-5) return;
        q.setFromUnitVectors(up, dir.clone().normalize());
        m.compose(new T.Vector3().addVectors(a, b).multiplyScalar(0.5), q, sk.set(1, len, 1));
        nm.getNormalMatrix(m);
        for (let k = 0; k < n; k++) {
          v.fromBufferAttribute(bp, k).applyMatrix4(m); pos.set([v.x, v.y, v.z], (i * n + k) * 3);
          v.fromBufferAttribute(bn, k).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], (i * n + k) * 3);
        }
      });
      basis.dispose();
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("normal", new T.BufferAttribute(nor, 3));
      return g;
    }
    function gestrichelt(punkte, strich, luecke) {
      const s = [];
      for (let i = 0; i + 1 < punkte.length; i++) {
        const a = punkte[i], b = punkte[i + 1], len = a.distanceTo(b);
        for (let t = 0; t < len; t += strich + luecke) s.push([a.clone().lerp(b, t / len), a.clone().lerp(b, Math.min(len, t + strich) / len)]);
      }
      return s;
    }

    // Beschriftungen: Sprites mit Canvas-Text, konstante Bildschirmgröße
    const etiketten = [];
    function etikett(text, pos, art, unten) {
      const px = 3, fs = art === "klein" ? 12 : 14, c = document.createElement("canvas"), ctx = c.getContext("2d");
      const font = `600 ${fs * px}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(text).width) + 16 * px, h = (fs + 10) * px;
      c.width = w; c.height = h;
      ctx.font = font;
      const rr = h / 2;
      ctx.fillStyle = art === "geist" ? "rgba(19,32,47,0.92)" : art === "warn" ? "rgba(48,34,12,0.92)" : FARBEN.karte;
      ctx.beginPath(); ctx.moveTo(rr, 0); ctx.arcTo(w, 0, w, h, rr); ctx.arcTo(w, h, 0, h, rr); ctx.arcTo(0, h, 0, 0, rr); ctx.arcTo(0, 0, w, 0, rr); ctx.fill();
      ctx.strokeStyle = art === "geist" ? "rgba(127,176,255,0.7)" : art === "warn" ? "rgba(255,181,71,0.85)" : FARBEN.rand;
      ctx.lineWidth = px; ctx.stroke();
      ctx.fillStyle = art === "geist" ? "#A8C8EE" : art === "warn" ? "#FFB547" : FARBEN.text;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, w / 2, h / 2 + px * 0.5);
      const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
      const sm = new T.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
      const sp = new T.Sprite(sm);
      sp.position.copy(pos); sp.renderOrder = 20; sp.center.set(0.5, unten ? 1.15 : 0);
      sp.userData.pxH = fs + 10; sp.userData.verh = w / h;
      etiketten.push(sp);
      return sp;
    }

    // --- Raum bauen
    const raumGruppe = new T.Group(); scene.add(raumGruppe);
    const verschiebe = new T.Vector2();
    // Holzboden-Textur (prozedural, Dielen ~18 cm)
    function holzTextur() {
      const c = document.createElement("canvas"); c.width = c.height = 1024;
      const ctx = c.getContext("2d");
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const dielen = 11, dh = 1024 / dielen;
      for (let i = 0; i < dielen; i++) {
        let x = -rnd() * 600;
        while (x < 1024) {
          const len = 380 + rnd() * 500, l = 0.9 + rnd() * 0.18;
          const r = Math.round(74 * l), g = Math.round(58 * l), b = Math.round(43 * l);
          ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, i * dh, len, dh);
          ctx.strokeStyle = `rgba(20,14,9,0.18)`; ctx.lineWidth = 1.5;
          for (let k = 0; k < 6; k++) { const yy = i * dh + 4 + rnd() * (dh - 8); ctx.beginPath(); ctx.moveTo(x, yy); ctx.bezierCurveTo(x + len * .3, yy + rnd() * 4 - 2, x + len * .6, yy + rnd() * 4 - 2, x + len, yy + rnd() * 3 - 1.5); ctx.stroke(); }
          ctx.fillStyle = "rgba(12,9,6,0.5)"; ctx.fillRect(x, i * dh, 2, dh);
          x += len;
        }
        ctx.fillStyle = "rgba(12,9,6,0.45)"; ctx.fillRect(0, i * dh, 1024, 2);
      }
      const t = new T.CanvasTexture(c);
      t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(0.5, 0.5); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8;
      entsorgen.push(t);
      return t;
    }
    // Außenkontur (Polygon um Wandstärke nach außen versetzt, Gehrung)
    function versetzt(poly, d) {
      const n = poly.length, ccw = flaecheSigned(poly) > 0, out = [];
      const norm = (a, b) => { const L = d2(a, b) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; return ccw ? [u[1], -u[0]] : [-u[1], u[0]]; };
      for (let i = 0; i < n; i++) {
        const p = poly[(i + n - 1) % n], c = poly[i], q = poly[(i + 1) % n];
        const n1 = norm(p, c), n2 = norm(c, q), k = 1 + dot2(n1, n2);
        const f = k > 0.2 ? d / k : d / 0.2;
        out.push([c[0] + (n1[0] + n2[0]) * f, c[1] + (n1[1] + n2[1]) * f]);
      }
      return out;
    }
    const aussen = versetzt(geo.poly, WANDSTAERKE);
    const shapeAus = (pts) => { const s = new T.Shape(); pts.forEach((p, i) => (i ? s.lineTo(p[0], spiegel * p[1]) : s.moveTo(p[0], spiegel * p[1]))); return s; };
    {
      const BODEN = 0.14;
      const g = new T.ExtrudeGeometry(shapeAus(aussen), { depth: BODEN, bevelEnabled: false });
      g.rotateX(Math.PI / 2);   // (x, y, z) → (x, −z, y): Oberseite bei Y = 0
      const top = mat(0xffffff, { map: holzTextur(), roughness: 0.55 });
      const seite = mat(FARBEN.bodenSeite, { roughness: 0.9 });
      const m = teil(raumGruppe, g, [top, seite], 0, 0, 0, false);
      m.receiveShadow = true;
      // dunkle Standfläche unter dem Modell
      const glanz = new T.Mesh(new T.RingGeometry(0, radius * 1.6, 64), new T.MeshBasicMaterial({ color: 0x161a20, transparent: true, opacity: 0.7, depthWrite: false }));
      glanz.rotation.x = -Math.PI / 2; glanz.position.set(mitte.x, -BODEN - 0.004, mitte.z);
      raumGruppe.add(glanz);
    }
    // Wandkrone (Draufsicht-Schnitt wie im Architekturmodell)
    const kroneMat = mat(FARBEN.krone, { roughness: 0.85, side: T.DoubleSide });
    {
      const s = shapeAus(aussen); s.holes.push(shapeAus(geo.poly));
      const g = new T.ShapeGeometry(s); g.rotateX(Math.PI / 2);
      const m = teil(raumGruppe, g, kroneMat, 0, H, 0, false);
      m.renderOrder = 3;
    }

    const wandObjekte = [];
    for (const w of geo.waende) {
      const wg = new T.Group(); raumGruppe.add(wg);
      const flMat = mat(FARBEN.wand, { transparent: true, opacity: 0.88, depthWrite: false, side: T.DoubleSide, roughness: 0.95 });
      const glasMat = new T.MeshBasicMaterial({ color: FARBEN.glas, transparent: true, opacity: 0.18, depthWrite: false, side: T.DoubleSide, toneMapped: false });
      const rahmenMat = new T.MeshBasicMaterial({ color: FARBEN.glasRand, transparent: true, opacity: 1, toneMapped: false });
      const tuerMat = new T.MeshBasicMaterial({ color: FARBEN.tuerrahmen, transparent: true, opacity: 1, toneMapped: false });
      const kanteMat = new T.LineBasicMaterial({ color: FARBEN.wandkante, transparent: true, opacity: 1 });
      // Wandfläche als Streifen ohne Öffnungen
      const brueche = new Set([0, w.L]);
      for (const o of w.oeffnungen) { brueche.add(o.u0); brueche.add(o.u1); }
      const us = [...brueche].filter((u) => u >= 0 && u <= w.L).sort((a, b) => a - b);
      const pos = [];
      const P = (u, v) => V(w.a[0] + w.u[0] * u, w.a[1] + w.u[1] * u, v);
      const quad = (u0, u1, v0, v1) => {
        const a = P(u0, v0), b = P(u1, v0), c = P(u1, v1), d = P(u0, v1);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      };
      for (let i = 0; i + 1 < us.length; i++) {
        const u0 = us[i], u1 = us[i + 1], um = (u0 + u1) / 2; if (u1 - u0 < 1e-4) continue;
        const loecher = w.oeffnungen.filter((o) => o.u0 <= um && o.u1 >= um).map((o) => [o.v0, o.v1]).sort((a, b) => a[0] - b[0]);
        let v = 0;
        for (const [v0, v1] of loecher) { if (v0 > v + 1e-4) quad(u0, u1, v, v0); v = Math.max(v, v1); }
        if (w.hoehe > v + 1e-4) quad(u0, u1, v, w.hoehe);
      }
      const g = new T.BufferGeometry(); g.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
      const flaeche = new T.Mesh(g, flMat); flaeche.renderOrder = 1; flaeche.receiveShadow = !!opt.schatten; wg.add(flaeche);
      // Kanten: Oberkante innen, Ecken
      const kp = [P(0, w.hoehe), P(w.L, w.hoehe), P(0, 0), P(0, w.hoehe)];
      const out = new T.Vector3(w.n[0], 0, spiegel * w.n[1]).multiplyScalar(WANDSTAERKE);
      // Öffnungen: Rahmen, Glas
      const nIn = new T.Vector3(-w.n[0], 0, -spiegel * w.n[1]);
      const richtung = new T.Vector3(w.u[0], 0, spiegel * w.u[1]);
      const drehung = Math.atan2(-richtung.z, richtung.x);
      for (const o of w.oeffnungen) {
        const br = o.u1 - o.u0, hh = o.v1 - o.v0, um = (o.u0 + o.u1) / 2;
        const zentrum = P(um, o.v0 + hh / 2).add(out.clone().multiplyScalar(0.5));
        const leiste = (lx, ly, sx, sy, sz, m) => {
          const mesh = new T.Mesh(new T.BoxGeometry(sx, sy, sz), m);
          mesh.position.copy(zentrum).add(richtung.clone().multiplyScalar(lx)).add(new T.Vector3(0, ly, 0));
          mesh.rotation.y = drehung; mesh.castShadow = !!opt.schatten; wg.add(mesh);
        };
        const tiefe = WANDSTAERKE + 0.02;
        if (o.art === "fenster") {
          const r = 0.03;
          leiste(0, hh / 2 - r / 2, br, r, tiefe, rahmenMat); leiste(0, -hh / 2 + r / 2, br, r, tiefe, rahmenMat);
          leiste(-br / 2 + r / 2, 0, r, hh, tiefe, rahmenMat); leiste(br / 2 - r / 2, 0, r, hh, tiefe, rahmenMat);
          const teile = Math.max(1, Math.round(br / 1.1));
          for (let k = 1; k < teile; k++) leiste(-br / 2 + br * k / teile, 0, 0.02, hh, tiefe * 0.8, rahmenMat);
          const glas = new T.Mesh(new T.PlaneGeometry(br - 2 * r, hh - 2 * r), glasMat);
          glas.position.copy(zentrum); glas.rotation.y = drehung; glas.renderOrder = 2; wg.add(glas);
          // Fensterbank innen
          const bank = new T.Mesh(new T.BoxGeometry(br + 0.06, 0.03, 0.08), rahmenMat);
          bank.position.copy(P(um, o.v0 - 0.015)).add(nIn.clone().multiplyScalar(0.03)); bank.rotation.y = drehung; wg.add(bank);
        } else if (o.art === "tuer") {
          const r = 0.035;
          leiste(0, hh / 2 - r / 2, br, r, tiefe + 0.03, tuerMat);
          leiste(-br / 2 + r / 2, 0, r, hh, tiefe + 0.03, tuerMat); leiste(br / 2 - r / 2, 0, r, hh, tiefe + 0.03, tuerMat);
        }
        // Umriss der Öffnung
        kp.push(P(o.u0, o.v0), P(o.u0, o.v1), P(o.u0, o.v1), P(o.u1, o.v1), P(o.u1, o.v1), P(o.u1, o.v0));
        if (o.v0 > 0.01) kp.push(P(o.u1, o.v0), P(o.u0, o.v0));
      }
      const kg = new T.BufferGeometry().setFromPoints(kp);
      const kanten = new T.LineSegments(kg, kanteMat); kanten.renderOrder = 4; wg.add(kanten);
      wandObjekte.push({ w, flMat, glasMat, rahmenMat, tuerMat, kanteMat, grundOpazitaet: 0.88, ausgeblendet: null });
    }

    // --- Möbel
    function moebel(o) {
      const g = new T.Group();
      const [b, t, h] = (o.groesse || [0.5, 0.5, 0.5]).map(Number);
      const m = o.mitte || [0, 0];
      const z0 = m.length > 2 && m[2] != null ? Math.max(0, +m[2] - h / 2) : 0;
      g.position.copy(V(+m[0], +m[1], z0));
      g.rotation.y = -spiegel * ((+o.drehung_grad || 0) * Math.PI / 180);
      const art = String(o.art || "sonstiges").toLowerCase();
      if (art === "sofa") {
        const sm = mat(FARBEN.sofaDunkel, { roughness: 0.92 }), km = mat(FARBEN.sofa, { roughness: 0.95 }), am = mat(FARBEN.sofa, { roughness: 0.92 });
        const arm = Math.min(0.2, b * 0.1), lehne = Math.min(0.24, t * 0.26), sitzH = h * 0.5;
        klotz(g, sm, 0, 0, 0.06, b, t, sitzH - 0.06 - 0.12, 0.04);
        const n = b - 2 * arm > 1.7 ? 3 : 2, kb = (b - 2 * arm) / n;
        for (let i = 0; i < n; i++) klotz(g, km, -b / 2 + arm + kb * (i + 0.5), lehne / 2, sitzH - 0.13, kb - 0.02, t - lehne - 0.02, 0.15, 0.05);
        klotz(g, am, 0, -t / 2 + lehne / 2, 0.06, b, lehne, h - 0.06, 0.05);
        klotz(g, am, -b / 2 + arm / 2, 0, 0.06, arm, t, h * 0.72 - 0.06, 0.05);
        klotz(g, am, b / 2 - arm / 2, 0, 0.06, arm, t, h * 0.72 - 0.06, 0.05);
        const fm = mat(0x0b0d10);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) klotz(g, fm, sx * (b / 2 - 0.08), sy * (t / 2 - 0.08), 0, 0.05, 0.05, 0.06, 0.01);
      } else if (art === "tisch" || art === "stuhl") {
        const hm = mat(art === "tisch" ? FARBEN.holz : FARBEN.holzHell, { roughness: 0.6 });
        if (art === "tisch") {
          klotz(g, hm, 0, 0, h - 0.04, b, t, 0.04, 0.015);
          const bein = 0.05, ix = b / 2 - Math.min(0.08, b * 0.12), iy = t / 2 - Math.min(0.08, t * 0.12);
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) klotz(g, hm, sx * ix, sy * iy, 0, bein, bein, h - 0.04, 0.008);
        } else {
          const sm = mat(FARBEN.stuhl, { roughness: 0.9 }), sitz = Math.min(0.47, h * 0.55);
          klotz(g, sm, 0, 0.02, sitz - 0.05, b, t * 0.92, 0.06, 0.02);
          klotz(g, sm, 0, -t / 2 + 0.03, sitz, b * 0.92, 0.04, h - sitz, 0.015);
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) klotz(g, hm, sx * (b / 2 - 0.04), sy * (t / 2 - 0.04), 0, 0.035, 0.035, sitz - 0.05, 0.006);
        }
      } else if (art === "regal") {
        const hm = mat(FARBEN.holz, { roughness: 0.7 }), st = 0.025;
        klotz(g, hm, -b / 2 + st / 2, 0, 0, st, t, h, 0.006); klotz(g, hm, b / 2 - st / 2, 0, 0, st, t, h, 0.006);
        klotz(g, mat(0x4a382a), 0, -t / 2 + 0.01, 0, b, 0.02, h, 0.004);
        const faecher = Math.max(1, Math.round(h / 0.38));
        const buchFarben = [0x9aa3ad, 0x7fb0ff, 0xc9623f, 0x5f7387, 0xd9dde3, 0x8ce0c4];
        let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i <= faecher; i++) {
          const z = Math.min(h - st, i * (h - st) / faecher);
          klotz(g, hm, 0, 0, z, b - 2 * st, t, st, 0.004);
          if (i < faecher) {
            let x = -b / 2 + st + 0.02, fh = (h - st) / faecher - st;
            while (x < b / 2 - st - 0.1 && rnd() < 0.93) {
              const bw = 0.025 + rnd() * 0.04, bh = Math.min(fh - 0.03, 0.18 + rnd() * 0.12);
              klotz(g, mat(buchFarben[Math.floor(rnd() * buchFarben.length)], { roughness: 0.9 }), x + bw / 2, 0, z + st, bw, t * 0.8, bh, 0.004);
              x += bw + 0.003 + (rnd() < 0.12 ? 0.12 : 0);
            }
          }
        }
      } else if (art === "fernseher") {
        const tm = mat(FARBEN.tv, { roughness: 0.35, metalness: 0.2 });
        klotz(g, tm, 0, 0, 0, b, t, h, 0.01);
        const bild = new T.Mesh(new T.PlaneGeometry(b - 0.04, h - 0.04), new T.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.15, metalness: 0.3, emissive: 0x1b2a3a, emissiveIntensity: 0.6 }));
        bild.position.set(0, h / 2, spiegel * (t / 2 + 0.002)); bild.material.emissive.set(0x0d1520); if (spiegel < 0) bild.rotation.y = Math.PI; g.add(bild);
      } else if (art === "bett") {
        klotz(g, mat(FARBEN.bett), 0, 0, 0, b, t, h * 0.55, 0.03);
        klotz(g, mat(FARBEN.matratze, { roughness: 0.95 }), 0, 0, h * 0.55, b - 0.06, t - 0.06, h * 0.25, 0.06);
        klotz(g, mat(FARBEN.decke, { roughness: 0.95 }), 0, t * 0.12, h * 0.55, b - 0.02, t * 0.62, h * 0.29, 0.06);
        for (const sx of b > 1.3 ? [-1, 1] : [0]) klotz(g, mat(0xd9dde3), sx * b / 4, -t / 2 + 0.25, h * 0.8, Math.min(0.6, b * 0.4), 0.35, 0.12, 0.05);
        klotz(g, mat(FARBEN.bett), 0, -t / 2 + 0.04, 0, b, 0.08, Math.max(h, 0.9), 0.03);
      } else if (art === "schrank") {
        const sm = mat(FARBEN.schrank, { roughness: 0.7 });
        klotz(g, sm, 0, 0, 0, b, t, h, 0.015);
        const tueren = Math.max(1, Math.round(b / 0.5));
        for (let i = 1; i < tueren; i++) klotz(g, mat(0x2a313b), -b / 2 + b * i / tueren, t / 2, 0.02, 0.008, 0.006, h - 0.04, 0.002);
      } else if (art === "kamin") {
        klotz(g, mat(FARBEN.kamin, { roughness: 0.95 }), 0, 0, 0, b, t, h, 0.02);
        klotz(g, mat(0x141414, { roughness: 1 }), 0, t / 2 - 0.02, h * 0.15, b * 0.55, 0.05, h * 0.45, 0.01);
      } else {
        klotz(g, mat(FARBEN.sonst), 0, 0, 0, b, t, h, 0.04);
      }
      return g;
    }
    for (const o of raum.objekte || []) raumGruppe.add(moebel(o));

    // Maßketten
    const beschriftungGruppe = new T.Group(); scene.add(beschriftungGruppe);
    if (opt.beschriftung) {
      for (const w of geo.waende) {
        if (w.L < 0.6) continue;
        const m = [w.a[0] + w.u[0] * w.L / 2 + w.n[0] * 0.3, w.a[1] + w.u[1] * w.L / 2 + w.n[1] * 0.3];
        const e = etikett(`${zahl(w.L, 2)} m`, V(m[0], m[1], w.hoehe + 0.04), "klein");
        // vordere (ausgeblendete) Wände: Maß unten am Boden, hintere: auf der Wandkrone
        e.userData.oben = V(m[0], m[1], w.hoehe + 0.04); e.userData.unten = V(m[0], m[1], 0.02);
        const wo = wandObjekte.find((x) => x.w === w); if (wo) wo.mass = e;
        beschriftungGruppe.add(e);
      }
    }

    // --- Anlage + Reflexionen
    const anlageGruppe = new T.Group(); scene.add(anlageGruppe);
    let refl = [];
    function boxModell(p, ziel, material) {
      const g = new T.Group(); g.position.copy(Vp(p));
      const zz = Vp(ziel); g.lookAt(new T.Vector3(zz.x, g.position.y, zz.z));  // +Z zeigt zum Hörplatz
      const bm = material || mat(FARBEN.box, { roughness: 0.5 });
      const B = 0.2, Hh = 0.34, Tt = 0.26, oben = 0.08;
      teil(g, rundQuader(B, Hh, Tt, 0.018), bm, 0, oben - Hh / 2, 0);
      const mm = material || mat(FARBEN.membran, { roughness: 0.8 }), km = material || mat(FARBEN.kalotte, { roughness: 0.3, metalness: 0.6 });
      const ring = (r, y, m2) => { const c = new T.Mesh(new T.CylinderGeometry(r, r, 0.012, 24), m2); c.rotation.x = Math.PI / 2; c.position.set(0, y, Tt / 2 + 0.002); g.add(c); };
      ring(0.035, 0, mm); ring(0.014, 0, km); ring(0.075, -0.15, km); ring(0.03, -0.15, mm);
      const unten = p[2] + oben - Hh;   // Unterkante über Boden
      if (unten > 0.06) {
        const sm = material || mat(FARBEN.ständer, { roughness: 0.5, metalness: 0.4 });
        teil(g, new T.CylinderGeometry(0.022, 0.022, unten - 0.02, 12), sm, 0, oben - Hh - (unten - 0.02) / 2, 0);
        teil(g, rundQuader(0.24, 0.02, 0.24, 0.006), sm, 0, -p[2] + 0.01, 0);
        teil(g, rundQuader(0.17, 0.015, 0.17, 0.005), sm, 0, oben - Hh - 0.0075, 0);
      }
      return g;
    }
    function subModell(p, ziel, material) {
      const g = new T.Group(); const s = 0.36;
      g.position.copy(V(p[0], p[1], 0));
      const zz = Vp(ziel); g.lookAt(new T.Vector3(zz.x, 0, zz.z));
      teil(g, rundQuader(s, s, s, 0.02), material || mat(FARBEN.box, { roughness: 0.5 }), 0, s / 2 + 0.01, 0);
      const mm = material || mat(FARBEN.membran, { roughness: 0.8 });
      const c = new T.Mesh(new T.CylinderGeometry(0.12, 0.12, 0.012, 32), mm); c.rotation.x = Math.PI / 2; c.position.set(0, s / 2 + 0.01, s / 2 + 0.003); g.add(c);
      return g;
    }
    function kopfModell(p, material) {
      const g = new T.Group(); g.position.copy(Vp(p));
      let kugelM = material;
      if (!kugelM) { kugelM = mat(akzent, { roughness: 0.4, emissiveIntensity: 0.5 }); kugelM.emissive.set(akzent).multiplyScalar(0.25); akzentMats.push(kugelM); }
      teil(g, new T.SphereGeometry(0.1, 32, 20), kugelM, 0, 0, 0);
      const ringM = new T.MeshBasicMaterial({ color: material ? FARBEN.geist : akzent, transparent: true, opacity: 0.55, depthWrite: false, side: T.DoubleSide });
      if (!material) akzentMats.push(ringM);
      const r = new T.Mesh(new T.RingGeometry(0.17, 0.2, 40), ringM); r.rotation.x = -Math.PI / 2; r.position.y = -p[2] + 0.004; g.add(r);
      const lot = new T.Mesh(roehren([[new T.Vector3(0, -p[2] + 0.005, 0), new T.Vector3(0, -0.1, 0)]], 0.004), ringM); g.add(lot);
      return g;
    }

    function anlageBauen() {
      anlageGruppe.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); });
      anlageGruppe.clear();
      akzentMats = [];
      for (let i = etiketten.length - 1; i >= 0; i--) if (etiketten[i].userData.anlage) etiketten.splice(i, 1);
      refl = [];
      if (!anlage || !anlage.hoerplatz) return;
      const a = anlage, ohr = a.hoerplatz;
      const anl = (o) => { anlageGruppe.add(o); return o; };
      const lab = (text, pos, art, unten) => { const e = etikett(text, pos, art, unten); e.userData.anlage = true; anl(e); };
      for (const [n, p] of [["FL", a.fl], ["FR", a.fr]]) if (p) { anl(boxModell(p, ohr)); if (opt.beschriftung) lab(n, Vp(p).add(new T.Vector3(0, 0.15, 0))); }
      if (a.sub) { anl(subModell(a.sub, ohr)); if (opt.beschriftung) lab("Sub", V(a.sub[0], a.sub[1], 0.42)); }
      anl(kopfModell(ohr)); if (opt.beschriftung) lab("Hörplatz", Vp(ohr).add(new T.Vector3(0, 0.16, 0)));
      // Direktschall
      const direkt = [];
      for (const p of [a.fl, a.fr]) if (p) direkt.push([Vp(p), Vp(ohr)]);
      const dm = new T.MeshBasicMaterial({ color: akzent, toneMapped: false });
      akzentMats.push(dm);
      anl(new T.Mesh(roehren(direkt, 0.009), dm));
      // Reflexionen
      refl = berechneReflexionen(geo, a, opt);
      if (opt.reflexionen) {
        const normal = [], glas = [];
        const pm = new T.MeshBasicMaterial({ color: FARBEN.reflex, transparent: true, opacity: 0.6, toneMapped: false });
        const pmw = new T.MeshBasicMaterial({ color: FARBEN.fenster, toneMapped: false });
        const scheibe = new T.MeshBasicMaterial({ color: FARBEN.reflex, transparent: true, opacity: 0.45, side: T.DoubleSide, depthWrite: false, toneMapped: false });
        const scheibeW = new T.MeshBasicMaterial({ color: FARBEN.fenster, transparent: true, opacity: 1, side: T.DoubleSide, depthWrite: false, toneMapped: false });
        const kugel = new T.SphereGeometry(0.03, 16, 12);
        let warnLabel = false;
        for (const r of refl) {
          const q = r.box === "FL" ? a.fl : a.fr, P = Vp(r.punkt);
          (r.auf_fenster ? glas : normal).push(...gestrichelt([Vp(q), P, Vp(ohr)], 0.07, 0.05));
          const k = new T.Mesh(kugel, r.auf_fenster ? pmw : pm); k.position.copy(P); k.renderOrder = 6; anl(k);
          const s = new T.Mesh(new T.RingGeometry(r.auf_fenster ? 0.1 : 0.06, r.auf_fenster ? 0.135 : 0.085, 40), r.auf_fenster ? scheibeW : scheibe);
          s.position.copy(P);
          if (r.wand_id) { const w = geo.waende.find((x) => x.id === r.wand_id); s.lookAt(P.clone().add(new T.Vector3(-w.n[0], 0, -spiegel * w.n[1]))); s.position.add(new T.Vector3(-w.n[0], 0, -spiegel * w.n[1]).multiplyScalar(0.006)); }
          else { s.rotation.x = -Math.PI / 2; s.position.y += r.flaeche === "boden" ? 0.006 : -0.006; }
          anl(s);
          if (r.auf_fenster && opt.beschriftung && !warnLabel) { warnLabel = true; lab("Glas spiegelt", P.clone().add(new T.Vector3(0, 0.12, 0)), "warn"); }
        }
        if (normal.length) anl(new T.Mesh(roehren(normal, 0.005), new T.MeshBasicMaterial({ color: FARBEN.reflex, transparent: true, opacity: 0.42, toneMapped: false })));
        if (glas.length) anl(new T.Mesh(roehren(glas, 0.0075), new T.MeshBasicMaterial({ color: FARBEN.fenster, transparent: true, opacity: 1, toneMapped: false })));
      }
      // Vorschlag als Geist mit Pfeilen
      const v = a.vorschlag;
      if (v) {
        const gm = new T.MeshStandardMaterial({ color: FARBEN.geist, transparent: true, opacity: 0.32, depthWrite: false, roughness: 0.4, emissive: 0x1c3a70, emissiveIntensity: 0.6 });
        const pfeilM = new T.MeshBasicMaterial({ color: FARBEN.geist, transparent: true, opacity: 0.95, toneMapped: false });
        const vohr = v.hoerplatz || ohr;
        const pfeil = (alt, neu, hoeheFix) => {
          if (!alt || !neu) return;
          const A = hoeheFix != null ? V(alt[0], alt[1], hoeheFix) : Vp(alt), B = hoeheFix != null ? V(neu[0], neu[1], hoeheFix) : Vp(neu);
          const len = A.distanceTo(B); if (len < 0.03) return;
          const dir = B.clone().sub(A).normalize(), spitze = Math.min(0.12, len * 0.4);
          const ende = B.clone().sub(dir.clone().multiplyScalar(spitze));
          anl(new T.Mesh(roehren([[A, ende]], 0.008), pfeilM));
          const c = new T.Mesh(new T.ConeGeometry(0.035, spitze, 16), pfeilM);
          c.position.copy(ende).add(dir.clone().multiplyScalar(spitze / 2)); c.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir); anl(c);
        };
        for (const [n, alt, neu] of [["FL", a.fl, v.fl], ["FR", a.fr, v.fr]]) if (neu) {
          anl(boxModell(neu, vohr, gm)); pfeil(alt, neu);
          if (opt.beschriftung) lab(n + " neu", V(neu[0], neu[1], 0.02), "geist", true);
        }
        if (v.sub) { anl(subModell(v.sub, vohr, gm)); pfeil(a.sub, v.sub, 0.2); }
        if (v.hoerplatz) { anl(kopfModell(v.hoerplatz, gm)); pfeil(ohr, v.hoerplatz); if (opt.beschriftung) lab("Platz neu", V(v.hoerplatz[0], v.hoerplatz[1], 0.02), "geist", true); }
      }
      anlageGruppe.traverse((o) => { if (o.isMesh && opt.schatten && !(o.material && o.material.transparent) && o.material && o.material.isMeshStandardMaterial) o.castShadow = true; });
    }
    anlageBauen();

    // --- Kamera-Steuerung (eigene Orbit-Steuerung: 1 Finger drehen, 2 Finger zoomen/verschieben, Doppeltipp zurück)
    let f2 = [0, -1];
    if (anlage && anlage.fl && anlage.fr && anlage.hoerplatz) {
      const mx = (anlage.fl[0] + anlage.fr[0]) / 2 - anlage.hoerplatz[0], my = (anlage.fl[1] + anlage.fr[1]) / 2 - anlage.hoerplatz[1], l = Math.hypot(mx, my);
      if (l > EPS) f2 = [mx / l, my / l];
    }
    const start = {
      theta: Math.atan2(-f2[0], -spiegel * f2[1]) - Math.PI / 4,
      phi: 0.96,
      radius: 1,
      ziel: mitte.clone().add(new T.Vector3(0, H * 0.22, 0)),
    };
    const ist = { theta: start.theta, phi: start.phi, radius: 1, ziel: start.ziel.clone() };
    const soll = { theta: start.theta, phi: start.phi, radius: 1, ziel: start.ziel.clone() };
    let breite = 1, hoehe = 1;
    // Startabstand so, dass alle Raumecken (Boden und Decke) knapp ins Bild passen
    const ecken = [];
    for (const p of aussen) { ecken.push(V(p[0], p[1], -0.14), V(p[0], p[1], H)); }
    function passendeEntfernung() {
      const cam = camera.clone(), v = new T.Vector3();
      const rand = (r) => {
        const sp = Math.sin(start.phi);
        cam.position.set(start.ziel.x + r * sp * Math.sin(start.theta), start.ziel.y + r * Math.cos(start.phi), start.ziel.z + r * sp * Math.cos(start.theta));
        cam.lookAt(start.ziel); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
        let m = 0;
        for (const e of ecken) { v.copy(e).project(cam); if (v.z > 1) return 9; m = Math.max(m, Math.abs(v.x), Math.abs(v.y)); }
        return m;
      };
      let lo = radius * 0.5, hi = radius * 8;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (rand(mid) > 0.9) lo = mid; else hi = mid; }
      return hi;
    }
    function groesse() {
      const r = container.getBoundingClientRect();
      breite = Math.max(1, Math.round(r.width)); hoehe = Math.max(1, Math.round(r.height || r.width * 0.75));
      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
      renderer.setSize(breite, hoehe, false);
      camera.aspect = breite / hoehe; camera.updateProjectionMatrix();
      const neu = passendeEntfernung();
      if (Math.abs(start.radius - neu) > 1e-3) {
        const k = neu / start.radius; start.radius = neu; soll.radius *= k; ist.radius *= k;
        if (!initialisiert) { soll.radius = ist.radius = neu; initialisiert = true; }
      }
      dirty = true;
    }
    let initialisiert = false, dirty = true;
    const zeiger = new Map();
    let letzterTipp = 0, tippStart = null, bewegt = 0, interaktion = 0;
    const pinch = () => { const [a, b] = [...zeiger.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    let pinchAlt = null;
    function verschieben(dx, dy) {
      const s = 2 * ist.radius * Math.tan(camera.fov * Math.PI / 360) / hoehe;
      const rechts = new T.Vector3().setFromMatrixColumn(camera.matrix, 0); rechts.y = 0; rechts.normalize();
      const vor = new T.Vector3(-Math.sin(ist.theta), 0, -Math.cos(ist.theta));
      soll.ziel.addScaledVector(rechts, -dx * s).addScaledVector(vor, dy * s);
      const lim = radius * 1.2; soll.ziel.x = Math.max(mitte.x - lim, Math.min(mitte.x + lim, soll.ziel.x)); soll.ziel.z = Math.max(mitte.z - lim, Math.min(mitte.z + lim, soll.ziel.z));
      soll.ziel.y = Math.max(-0.2, Math.min(H * 1.5, soll.ziel.y));
    }
    const begrenzen = () => { soll.phi = Math.max(0.12, Math.min(1.48, soll.phi)); soll.radius = Math.max(start.radius * 0.25, Math.min(start.radius * 2.5, soll.radius)); };
    function zuruecksetzen() { soll.theta = start.theta; soll.phi = start.phi; soll.radius = start.radius; soll.ziel.copy(start.ziel); dirty = true; }
    const onDown = (e) => {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY, knopf: e.button, shift: e.shiftKey });
      interaktion = performance.now();
      if (zeiger.size === 1) { tippStart = { x: e.clientX, y: e.clientY, t: performance.now() }; bewegt = 0; canvas.style.cursor = "grabbing"; }
      if (zeiger.size === 2) { pinchAlt = pinch(); tippStart = null; }
    };
    const onMove = (e) => {
      const z = zeiger.get(e.pointerId); if (!z) return;
      const dx = e.clientX - z.x, dy = e.clientY - z.y;
      z.x = e.clientX; z.y = e.clientY; bewegt += Math.abs(dx) + Math.abs(dy); interaktion = performance.now();
      if (zeiger.size === 1) {
        if (z.knopf === 2 || z.shift) verschieben(dx, dy);
        else { soll.theta -= dx * 2 * Math.PI / Math.max(breite, 320) * 0.8; soll.phi -= dy * Math.PI / Math.max(hoehe, 240) * 0.8; }
      } else if (zeiger.size === 2 && pinchAlt) {
        const p = pinch();
        if (p.d > 10 && pinchAlt.d > 10) soll.radius *= pinchAlt.d / p.d;
        verschieben(p.x - pinchAlt.x, p.y - pinchAlt.y);
        pinchAlt = p;
      }
      begrenzen(); dirty = true;
      e.preventDefault();
    };
    const onUp = (e) => {
      zeiger.delete(e.pointerId);
      if (zeiger.size < 2) pinchAlt = null;
      if (zeiger.size === 0) {
        canvas.style.cursor = "grab";
        const jetzt = performance.now();
        if (tippStart && bewegt < 10 && jetzt - tippStart.t < 350) {
          if (jetzt - letzterTipp < 350) { zuruecksetzen(); letzterTipp = 0; } else letzterTipp = jetzt;
        }
        tippStart = null;
      }
    };
    const onWheel = (e) => { e.preventDefault(); soll.radius *= Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015)); begrenzen(); interaktion = performance.now(); dirty = true; };
    const onMenu = (e) => e.preventDefault();
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onMenu);

    // Wände zur Kamera hin ausblenden (Puppenhaus-Ansicht)
    function waendeAusblenden() {
      const cx = camera.position.x, cy = spiegel * camera.position.z;
      for (const o of wandObjekte) {
        const seite = dot2([cx - o.w.a[0], cy - o.w.a[1]], o.w.n);
        const steil = ist.phi < 0.35;   // fast von oben: alles halbtransparent
        const aus = !steil && seite > 0;
        if (aus === o.ausgeblendet) continue;
        o.ausgeblendet = aus;
        o.flMat.opacity = aus ? 0.1 : o.grundOpazitaet;
        o.glasMat.opacity = aus ? 0.06 : 0.18;
        o.rahmenMat.opacity = o.tuerMat.opacity = aus ? 0.22 : 1;
        o.kanteMat.opacity = aus ? 0.5 : 1;
        if (o.mass) o.mass.position.copy(aus ? o.mass.userData.unten : o.mass.userData.oben);
      }
    }
    const tmp = new T.Vector3();
    function kameraSetzen() {
      const s = Math.sin(ist.phi);
      camera.position.set(ist.ziel.x + ist.radius * s * Math.sin(ist.theta), ist.ziel.y + ist.radius * Math.cos(ist.phi), ist.ziel.z + ist.radius * s * Math.cos(ist.theta));
      camera.lookAt(ist.ziel);
      camera.updateMatrixWorld();
      waendeAusblenden();
      const k = 2 * Math.tan(camera.fov * Math.PI / 360) / hoehe;
      for (const e of etiketten) {
        const d = tmp.copy(e.position).applyMatrix4(e.parent ? e.parent.matrixWorld : new T.Matrix4()).sub(camera.position).length();
        const sy = d * k * e.userData.pxH; e.scale.set(sy * e.userData.verh, sy, 1);
      }
    }
    function rendern() { kameraSetzen(); renderer.render(scene, camera); dirty = false; }

    let raf = 0, letzteZeit = performance.now(), aktiv = true;
    function schleife(t) {
      if (!aktiv) return;
      raf = requestAnimationFrame(schleife);
      const dt = Math.min(0.1, (t - letzteZeit) / 1000); letzteZeit = t;
      if (opt.autoDrehen && zeiger.size === 0 && performance.now() - interaktion > 2500) { soll.theta += dt * 0.25; dirty = true; }
      const a = 1 - Math.pow(0.0001, dt);  // weiche Dämpfung
      let bewegung = false;
      for (const k of ["theta", "phi", "radius"]) { const d = soll[k] - ist[k]; if (Math.abs(d) > 1e-4) { ist[k] += d * a; bewegung = true; } else ist[k] = soll[k]; }
      if (ist.ziel.distanceToSquared(soll.ziel) > 1e-8) { ist.ziel.lerp(soll.ziel, a); bewegung = true; } else ist.ziel.copy(soll.ziel);
      if (bewegung || dirty) rendern();
    }
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { groesse(); }) : null;
    if (ro) ro.observe(container); else global.addEventListener("resize", groesse);
    groesse();
    rendern();
    raf = requestAnimationFrame(schleife);

    const ansicht = {
      aktualisieren(neueAnlage, neueOptionen) {
        if (neueAnlage !== undefined) anlage = neueAnlage;
        if (neueOptionen) opt = Object.assign(opt, neueOptionen);
        anlageBauen(); dirty = true;
        return this;
      },
      reflexionen() { return refl.map((r) => Object.assign({}, r, { punkt: r.punkt.slice() })); },
      zuruecksetzen() { zuruecksetzen(); },
      _rendern: rendern,
      setAkzent(farbe) {
        const f = hexFarbe(farbe);
        if (!f) return false;
        akzent = f;
        for (const m of akzentMats) {
          m.color.set(f);
          if (m.emissive) m.emissive.set(f).multiplyScalar(0.25);
        }
        dirty = true;
        return true;
      },
      akzent() { return akzent; },
      _canvas: canvas,
      zerstoeren() {
        offene.delete(ansicht);
        aktiv = false; cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else global.removeEventListener("resize", groesse);
        canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("pointercancel", onUp);
        canvas.removeEventListener("wheel", onWheel); canvas.removeEventListener("contextmenu", onMenu);
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) [].concat(o.material).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        });
        entsorgen.forEach((t) => t.dispose());
        renderer.dispose();
        if (renderer.forceContextLoss) renderer.forceContextLoss();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        container.removeAttribute("aria-label");
      },
    };
    offene.add(ansicht);
    return ansicht;
  }

  // Akzent für alle offenen Ansichten; ohne Argument wird --akzent neu aus dem CSS gelesen
  function setAkzent(farbe) {
    const f = farbe == null ? akzentAusCss() : hexFarbe(farbe);
    if (!f) return false;
    offene.forEach((a) => a.setAkzent(f));
    return true;
  }

  const Raum3D = { zeigen, setAkzent, berechneReflexionen, beschreibung, FLAECHEN_TEXT, AKZENT_STANDARD, version: "1.1" };
  global.Raum3D = Raum3D;
  if (typeof module !== "undefined" && module.exports) module.exports = Raum3D;
})(typeof window !== "undefined" ? window : globalThis);

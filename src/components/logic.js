// Circuits logiques 74HC (CMOS rapide), en boîtier DIP avec leur brochage réel.
// Électrique : seuils d'entrée et résistance de sortie de la fiche technique, alimentation 2 à 6 V.
// Logique : chaque puce décrit ses sorties en fonction de ses entrées (et de son état interne).
import { fmt } from "../engine/units.js";
import { dipPins, dipBounds, dipSymbol, plainName } from "./shapes.js";

// Nexperia 74HC00 (valeurs typiques à 25 °C) : VOH = 4,32 V à −4 mA sous 4,5 V ; 5,81 V à −5,2 mA sous 6 V.
//                                               VOL = 0,15 V à 4 mA sous 4,5 V ; 0,16 V à 5,2 mA sous 6 V.
const lerp = (v, a, b) => Math.max(20, a + (b - a) * (v - 4.5) / 1.5);
const rOH = (vcc) => lerp(vcc, 45, 36.5);
const rOL = (vcc) => lerp(vcc, 37.5, 30.8);
const HC = { Vmin: 2, Vmax: 6, absMax: 7, Imax: 0.025 };

function hcChip({ type, name, summary, pinNames, outputs, logic, schmitt = false, notes = [] }) {
  const n = pinNames.length;
  const iGnd = pinNames.indexOf("GND"), iVcc = pinNames.indexOf("VCC");
  const outIdx = outputs.map((o) => pinNames.indexOf(o));
  const inIdx = pinNames.map((_, i) => i).filter((i) => i !== iGnd && i !== iVcc && !outIdx.includes(i));
  const ALLZ = outIdx.reduce((m, i) => m | (1 << i), 0);
  // Clé d'une broche dans la fonction logique : son nom sans le « ~ » (ex. I.CLR) ; une sortie
  // complémentée dont le nom existe déjà (« ~1Q » à côté de « 1Q ») devient « 1Qn ».
  const keyOf = (name) => (!name.startsWith("~") ? name : pinNames.includes(name.slice(1)) ? `${name.slice(1)}n` : name.slice(1));
  const levels = (mask) => Object.fromEntries(inIdx.map((i) => [keyOf(pinNames[i]), (mask >> i) & 1]));
  const fresh = () => ({ on: 0, in: 0, out: 0, z: ALLZ, q: 0, q2: 0 });
  return {
    type, name, summary,
    category: "Logique 74HC",
    pins: dipPins(pinNames),
    bounds: dipBounds(pinNames),
    rotatable: false,
    params: [],
    datasheet: {
      source: `Famille 74HC (Nexperia / TI ${name.split(" ")[0]}) : alimentation 2 à 6 V (7 V max absolu), entrées CMOS, sorties ±25 mA max.`,
      notes: [
        schmitt ? "Entrées à trigger de Schmitt : basculement à 0,53·VCC en montant et 0,31·VCC en descendant (2,38 V et 1,4 V typ. sous 4,5 V)." : "Seuils d'entrée : niveau haut au-dessus de 0,7·VCC, niveau bas en dessous de 0,3·VCC ; entre les deux, l'ancien niveau est conservé.",
        "Sorties : ~45 Ω vers VCC à l'état haut, ~37 Ω vers la masse à l'état bas (VOH 4,32 V à 4 mA, VOL 0,15 V à 4 mA sous 4,5 V).",
        ...notes,
        "Une entrée CMOS laissée en l'air est indéterminée en vrai (ici elle est lue à 0) : reliez toujours les entrées inutilisées. Non modélisé : temps de propagation (~10 ns), consommation dynamique.",
      ],
    },
    stamp(ctx, inst, nodes) {
      const s = inst.rt?.s;
      if (!s?.on) return;
      const vcc = ctx.v(nodes[iVcc]) - ctx.v(nodes[iGnd]);
      for (const i of outIdx) {
        if ((s.z >> i) & 1) continue;
        if ((s.out >> i) & 1) ctx.conductance(nodes[iVcc], nodes[i], 1 / rOH(vcc));
        else ctx.conductance(nodes[i], nodes[iGnd], 1 / rOL(vcc));
      }
    },
    update(ctx, inst, nodes) {
      const rt = (inst.rt ??= {});
      let s = (rt.s ??= fresh());
      const g = ctx.v(nodes[iGnd]), vcc = ctx.v(nodes[iVcc]) - g;
      if (vcc < (s.on ? 1.8 : HC.Vmin)) {
        if (!s.on) return false;
        rt.s = fresh();
        return true;
      }
      let inMask = 0;
      for (const i of inIdx) {
        const v = ctx.v(nodes[i]) - g, was = (s.in >> i) & 1;
        const hi = schmitt ? (was ? v > 0.31 * vcc : v > 0.53 * vcc) : v > 0.7 * vcc ? 1 : v < 0.3 * vcc ? 0 : was;
        if (hi) inMask |= 1 << i;
      }
      if (s.on && inMask === s.in) return false;
      const I = levels(inMask), P = s.on ? levels(s.in) : I; // à la mise sous tension : pas de faux front
      const res = logic(I, P, s);
      let out = 0, z = 0;
      for (const i of outIdx) {
        const lv = res[keyOf(pinNames[i])];
        if (lv === null || lv === undefined) z |= 1 << i; else if (lv) out |= 1 << i;
      }
      const changed = !s.on || out !== s.out || z !== s.z;
      s.on = 1; s.in = inMask; s.out = out; s.z = z;
      return changed;
    },
    evaluate(ctx, inst, nodes) {
      const s = inst.rt?.s;
      const g = ctx.v(nodes[iGnd]), Vcc = ctx.v(nodes[iVcc]) - g;
      const r = { Vcc, Icc: 0, Imax: 0, Vhi: -Infinity, Vlo: Infinity };
      for (let i = 0; i < n; i++) {
        if (i === iGnd || i === iVcc) continue;
        const v = ctx.v(nodes[i]) - g;
        r[`V${i + 1}`] = v;
        if (outIdx.includes(i)) {
          let I = 0;
          if (s?.on && !((s.z >> i) & 1)) I = (s.out >> i) & 1 ? (Vcc - v) / rOH(Vcc) : -v / rOL(Vcc);
          r[`I${i + 1}`] = I;
          if (I > 0) r.Icc += I;
          r.Imax = Math.max(r.Imax, Math.abs(I));
        } else { r.Vhi = Math.max(r.Vhi, v - Vcc); r.Vlo = Math.min(r.Vlo, v); }
      }
      if (!inIdx.length) { r.Vhi = 0; r.Vlo = 0; }
      r.Vminlo = r.Vlo; delete r.Vlo;
      return r;
    },
    describe(inst, avg, peak) {
      const warnings = [];
      let damage;
      if (avg.Vcc > HC.absMax) damage = `Détruite : ${fmt(avg.Vcc, "V")} d'alimentation (max absolu 7 V).`;
      else if (avg.Vcc > HC.Vmax) warnings.push({ level: "danger", text: `Alimentation ${fmt(avg.Vcc, "V")} > 6 V : hors spécification.` });
      else if (avg.Vcc < HC.Vmin) warnings.push({ level: "warn", text: avg.Vcc < 0.3 ? `Non alimentée : reliez VCC (${iVcc + 1}) et GND (${iGnd + 1}).` : `Alimentation ${fmt(avg.Vcc, "V")} sous les 2 V minimum.` });
      if (avg.Vcc >= HC.Vmin) {
        if (peak.Imax > HC.Imax) warnings.push({ level: "danger", text: `Une sortie débite ${fmt(peak.Imax, "A")} : au-delà de 25 mA par sortie.` });
        if (peak.Vhi > 0.5 || peak.Vminlo < -0.5) warnings.push({ level: "danger", text: "Une entrée dépasse les rails d'alimentation de plus de 0,5 V : les diodes de protection conduisent." });
      }
      const readings = [["Alimentation", `${fmt(avg.Vcc, "V")} · ${fmt(avg.Icc, "A")}`]];
      const lvl = (v) => (v > 0.7 * avg.Vcc ? "1" : v < 0.3 * avg.Vcc ? "0" : "?");
      for (let i = 0; i < n; i++) {
        if (i === iGnd || i === iVcc) continue;
        const v = avg[`V${i + 1}`];
        const isOut = outIdx.includes(i);
        readings.push([`${i + 1} · ${plainName(pinNames[i])}${isOut ? " (sortie)" : ""}`, `${avg.Vcc >= HC.Vmin ? lvl(v) : "—"} · ${fmt(v, "V")}${isOut ? ` · ${fmt(avg[`I${i + 1}`], "A")}` : ""}`]);
      }
      return { readings, warnings, damage };
    },
    label: () => name.split(" ")[0],
    symbol(inst, avg) {
      return dipSymbol(pinNames, "", (i) => {
        if (!avg || i === iGnd) return "";
        if (i === iVcc) return avg.Vcc >= HC.Vmin ? "pwr" : "";
        const v = avg[`V${i + 1}`];
        return `${v > 0.7 * avg.Vcc ? "hi" : v < 0.3 * avg.Vcc ? "lo" : "mid"}${outIdx.includes(i) ? " out" : ""}`;
      });
    },
  };
}

// ---------- Portes ----------
const QUAD = ["1A", "1B", "1Y", "2A", "2B", "2Y", "GND", "3Y", "3A", "3B", "4Y", "4A", "4B", "VCC"];
const quad = (fn) => (I) => Object.fromEntries([1, 2, 3, 4].map((k) => [`${k}Y`, fn(I[`${k}A`], I[`${k}B`]) ? 1 : 0]));
const HEX = ["1A", "1Y", "2A", "2Y", "3A", "3Y", "GND", "4Y", "4A", "5Y", "5A", "6Y", "6A", "VCC"];
const hexInv = (I) => Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [`${k}Y`, I[`${k}A`] ? 0 : 1]));
const Y4 = ["1Y", "2Y", "3Y", "4Y"], Y6 = ["1Y", "2Y", "3Y", "4Y", "5Y", "6Y"];

export const hc00 = hcChip({ type: "74hc00", name: "74HC00 (4 × NON-ET)", summary: "Quatre portes NON-ET (NAND) à 2 entrées.", pinNames: QUAD, outputs: Y4, logic: quad((a, b) => !(a && b)) });
export const hc02 = hcChip({ type: "74hc02", name: "74HC02 (4 × NON-OU)", summary: "Quatre portes NON-OU (NOR) à 2 entrées.",
  pinNames: ["1Y", "1A", "1B", "2Y", "2A", "2B", "GND", "3A", "3B", "3Y", "4A", "4B", "4Y", "VCC"], outputs: Y4, logic: quad((a, b) => !(a || b)) });
export const hc04 = hcChip({ type: "74hc04", name: "74HC04 (6 × NON)", summary: "Six inverseurs.", pinNames: HEX, outputs: Y6, logic: hexInv });
export const hc08 = hcChip({ type: "74hc08", name: "74HC08 (4 × ET)", summary: "Quatre portes ET (AND) à 2 entrées.", pinNames: QUAD, outputs: Y4, logic: quad((a, b) => a && b) });
export const hc14 = hcChip({ type: "74hc14", name: "74HC14 (6 × NON, trigger de Schmitt)", summary: "Six inverseurs à hystérésis : remet en forme un signal lent ou bruité, sert d'oscillateur RC.", pinNames: HEX, outputs: Y6, logic: hexInv, schmitt: true });
export const hc32 = hcChip({ type: "74hc32", name: "74HC32 (4 × OU)", summary: "Quatre portes OU (OR) à 2 entrées.", pinNames: QUAD, outputs: Y4, logic: quad((a, b) => a || b) });
export const hc86 = hcChip({ type: "74hc86", name: "74HC86 (4 × OU exclusif)", summary: "Quatre portes OU exclusif (XOR) à 2 entrées.", pinNames: QUAD, outputs: Y4, logic: quad((a, b) => a !== b) });

// ---------- Bascules, registres, compteurs ----------
const rise = (I, P, k) => I[k] && !P[k];

export const hc74 = hcChip({
  type: "74hc74", name: "74HC74 (2 × bascule D)", summary: "Deux bascules D déclenchées sur front montant, avec mise à 1 et remise à 0 asynchrones.",
  pinNames: ["~1CLR", "1D", "1CLK", "~1PRE", "1Q", "~1Q", "GND", "~2Q", "2Q", "~2PRE", "2CLK", "2D", "~2CLR", "VCC"],
  outputs: ["1Q", "~1Q", "2Q", "~2Q"],
  notes: ["Q recopie D à chaque front montant de CLK. PRE et CLR (actifs bas) forcent Q à 1 ou 0 immédiatement."],
  logic(I, P, s) {
    const out = {};
    for (const k of [1, 2]) {
      const bit = 1 << (k - 1), pre = !I[`${k}PRE`], clr = !I[`${k}CLR`];
      if (pre) s.q |= bit;
      else if (clr) s.q &= ~bit;
      else if (rise(I, P, `${k}CLK`)) s.q = I[`${k}D`] ? s.q | bit : s.q & ~bit;
      const q = s.q & bit ? 1 : 0;
      out[`${k}Q`] = q;
      out[`${k}Qn`] = pre && clr ? 1 : 1 - q; // PRE et CLR ensemble : les deux sorties à 1
    }
    return out;
  },
});

export const hc595 = hcChip({
  type: "74hc595", name: "74HC595 (registre à décalage 8 bits)", summary: "Série → parallèle : 3 broches de microcontrôleur pilotent 8 sorties (ou plus en cascade).",
  pinNames: ["QB", "QC", "QD", "QE", "QF", "QG", "QH", "GND", "QH'", "~SRCLR", "SRCLK", "RCLK", "~OE", "SER", "QA", "VCC"],
  outputs: ["QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH", "QH'"],
  notes: ["Chaque front montant de SRCLK décale le registre et y fait entrer SER. Un front montant de RCLK recopie le registre sur les sorties QA…QH. OE (actif bas) met les sorties en haute impédance. QH' sert à chaîner plusieurs registres."],
  logic(I, P, s) {
    const before = s.q;
    if (!I.SRCLR) s.q = 0;
    else if (rise(I, P, "SRCLK")) s.q = ((s.q << 1) | I.SER) & 0xff;
    if (rise(I, P, "RCLK")) s.q2 = before;
    const out = { "QH'": (s.q >> 7) & 1 };
    "ABCDEFGH".split("").forEach((c, i) => { out[`Q${c}`] = I.OE ? null : (s.q2 >> i) & 1; });
    return out;
  },
});

export const hc138 = hcChip({
  type: "74hc138", name: "74HC138 (décodeur 3 vers 8)", summary: "Active (à l'état bas) une sortie parmi huit selon l'adresse A, B, C.",
  pinNames: ["A", "B", "C", "~G2A", "~G2B", "G1", "~Y7", "GND", "~Y6", "~Y5", "~Y4", "~Y3", "~Y2", "~Y1", "~Y0", "VCC"],
  outputs: ["~Y0", "~Y1", "~Y2", "~Y3", "~Y4", "~Y5", "~Y6", "~Y7"],
  notes: ["Validé quand G1 = 1 et G2A = G2B = 0. La sortie sélectionnée passe à 0, les autres restent à 1."],
  logic(I) {
    const en = I.G1 && !I.G2A && !I.G2B, addr = I.A | (I.B << 1) | (I.C << 2);
    return Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((k) => [`Y${k}`, en && k === addr ? 0 : 1]));
  },
});

export const hc161 = hcChip({
  type: "74hc161", name: "74HC161 (compteur binaire 4 bits)", summary: "Compteur synchrone 0 à 15 avec chargement parallèle et remise à zéro asynchrone.",
  pinNames: ["~CLR", "CLK", "A", "B", "C", "D", "ENP", "GND", "~LOAD", "ENT", "QD", "QC", "QB", "QA", "RCO", "VCC"],
  outputs: ["QA", "QB", "QC", "QD", "RCO"],
  notes: ["Compte sur front montant de CLK si ENP = ENT = 1. LOAD (actif bas) charge DCBA au front suivant. CLR (actif bas) remet à zéro immédiatement. RCO = 1 à la valeur 15 (retenue)."],
  logic(I, P, s) {
    if (!I.CLR) s.q = 0;
    else if (rise(I, P, "CLK")) {
      if (!I.LOAD) s.q = I.A | (I.B << 1) | (I.C << 2) | (I.D << 3);
      else if (I.ENP && I.ENT) s.q = (s.q + 1) & 15;
    }
    return { QA: s.q & 1, QB: (s.q >> 1) & 1, QC: (s.q >> 2) & 1, QD: (s.q >> 3) & 1, RCO: I.ENT && s.q === 15 ? 1 : 0 };
  },
});

export const hc4017 = hcChip({
  type: "74hc4017", name: "74HC4017 (compteur décimal à 10 sorties)", summary: "Compteur de Johnson : une seule des dix sorties Q0…Q9 est à 1, elle avance à chaque impulsion (chenillard).",
  pinNames: ["Q5", "Q1", "Q0", "Q2", "Q6", "Q7", "Q3", "GND", "Q8", "Q4", "Q9", "CO", "~CE", "CLK", "MR", "VCC"],
  outputs: ["Q0", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "CO"],
  notes: ["Avance sur front montant de CLK quand CE (actif bas) est à 0. MR = 1 revient à Q0. CO est à 1 pendant les comptes 0 à 4 : son front montant cadence un second compteur. Même brochage que le CD4017."],
  logic(I, P, s) {
    if (I.MR) s.q = 0;
    else if ((rise(I, P, "CLK") && !I.CE) || (P.CE && !I.CE && I.CLK)) s.q = (s.q + 1) % 10;
    const out = { CO: s.q < 5 ? 1 : 0 };
    for (let k = 0; k < 10; k++) out[`Q${k}`] = s.q === k ? 1 : 0;
    return out;
  },
});

const SEG = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "cdefg", "abc", "abcdefg", "abcfg"];
export const hc4511 = hcChip({
  type: "74hc4511", name: "74HC4511 (décodeur BCD → 7 segments)", summary: "Convertit un chiffre binaire (DCBA) en commande des 7 segments d'un afficheur à cathode commune.",
  pinNames: ["B", "C", "~LT", "~BL", "LE", "D", "A", "GND", "e", "d", "c", "b", "a", "g", "f", "VCC"],
  outputs: ["a", "b", "c", "d", "e", "f", "g"],
  notes: ["LE = 0 : les sorties suivent DCBA ; LE = 1 : la valeur est mémorisée. LT (actif bas) allume tous les segments (test), BL (actif bas) les éteint. Au-delà de 9 l'afficheur est éteint. Même brochage que le CD4511 ; prévoir une résistance par segment."],
  logic(I, P, s) {
    if (!I.LE) s.q = I.A | (I.B << 1) | (I.C << 2) | (I.D << 3);
    const on = !I.LT ? "abcdefg" : !I.BL ? "" : SEG[s.q] ?? "";
    return Object.fromEntries("abcdefg".split("").map((c) => [c, on.includes(c) ? 1 : 0]));
  },
});

export const LOGIC_CHIPS = [hc00, hc02, hc04, hc08, hc14, hc32, hc86, hc74, hc595, hc138, hc161, hc4017, hc4511];

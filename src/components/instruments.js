// Instruments de mesure : oscilloscope deux voies.
// Ses traces s'affichent dans l'onglet Oscilloscope après une analyse transitoire.
import { fmt } from "../engine/units.js";

export const oscilloscope = {
  type: "scope",
  name: "Oscilloscope",
  category: "Instruments",
  summary: "Deux voies par rapport à la masse, 1 MΩ ∥ 15 pF, avec décodeur LTC. Lancez l'analyse dans l'onglet Oscilloscope.",
  pins: [{ id: "CH1", label: "Voie 1", x: 0, y: 0 }, { id: "CH2", label: "Voie 2", x: 0, y: 2 }],
  bounds: { x: 0, y: -1, w: 5, h: 4 },
  rotatable: false,
  isScope: true,
  params: [
    { key: "name1", label: "Nom de la voie 1", kind: "text", default: "Voie 1" },
    { key: "name2", label: "Nom de la voie 2", kind: "text", default: "Voie 2" },
  ],
  datasheet: {
    source: "Entrée d'oscilloscope standard : 1 MΩ en parallèle avec 15 pF, référencée à la masse du circuit (pince de masse).",
    notes: ["Le décodeur LTC lit chaque voie comme le firmware du boîtier : seuil au milieu de l'excursion, classement demi-bit / bit, mot de synchro."],
  },
  stamp(ctx, inst, [c1, c2], br, state) {
    ctx.conductance(c1, 0, 1e-6);
    ctx.conductance(c2, 0, 1e-6);
    ctx.capacitor(state, "c1", c1, 0, 15e-12);
    ctx.capacitor(state, "c2", c2, 0, 15e-12);
  },
  evaluate: (ctx, inst, [c1, c2]) => ({ V1: ctx.v(c1), V2: ctx.v(c2) }),
  describe: (inst, avg) => ({ readings: [[inst.params.name1, fmt(avg.V1, "V")], [inst.params.name2, fmt(avg.V2, "V")]], warnings: [] }),
  label: () => "Oscilloscope",
  symbol: () => `<rect x="6" y="-20" width="92" height="80" rx="6"/><rect x="16" y="-12" width="72" height="46" rx="2" style="fill:var(--screen, none)"/>`
    + `<polyline class="scope-trace" points="18,14 30,14 30,-2 46,-2 46,14 54,14 54,-2 62,-2 62,14 86,14"/>`
    + `<line x1="0" y1="0" x2="6" y2="0"/><line x1="0" y1="40" x2="6" y2="40"/>`
    + `<text class="pm" x="9" y="4">1</text><text class="pm" x="9" y="44">2</text>`,
};

// Briques physiques réutilisables par les composants.
import { thermalVoltage, pnjlim } from "./solver.js";

const GMIN_J = 1e-12;
const EXP_MAX = 80; // au-delà, prolongement linéaire de l'exponentielle

function expLin(u) {
  if (u <= EXP_MAX) { const e = Math.exp(u); return [e, e]; }
  const e = Math.exp(EXP_MAX);
  return [e * (1 + u - EXP_MAX), e];
}

/**
 * Jonction PN (modèle de Shockley + claquage inverse, comme le modèle D de SPICE).
 * p = { Is, n, BV?, Ibv?, nbv? }
 * Retourne { I, G } pour une tension v (anode - cathode).
 */
export function junctionIG(v, p, tempC = 25) {
  const vt = p.n * thermalVoltage(tempC);
  const [e, de] = expLin(v / vt);
  let I = p.Is * (e - 1) + GMIN_J * v;
  let G = (p.Is / vt) * de + GMIN_J;
  if (p.BV) {
    const vtb = (p.nbv ?? 1) * thermalVoltage(tempC);
    const [eb, deb] = expLin(-(v + p.BV) / vtb);
    I -= p.Ibv * eb;
    G += (p.Ibv / vtb) * deb;
  }
  return { I, G };
}

/** Estampille une jonction entre les noeuds a (anode) et k (cathode). */
export function stampJunction(ctx, state, key, a, k, p) {
  const vt = p.n * thermalVoltage(ctx.tempC);
  const vcrit = vt * Math.log(vt / (Math.SQRT2 * p.Is));
  const vd = ctx.v(a) - ctx.v(k);
  const vold = state[key] ?? 0;
  let vl = pnjlim(vd, vold, vt, vcrit);
  if (p.BV && vd < 0) {
    const vtb = (p.nbv ?? 1) * thermalVoltage(ctx.tempC);
    const vcritb = vtb * Math.log(vtb / (Math.SQRT2 * p.Ibv));
    const u = -(vd + p.BV);
    const ul = pnjlim(u, -(vold + p.BV), vtb, vcritb);
    if (ul !== u) vl = -(ul + p.BV);
  }
  if (vl !== vd) ctx.markLimited();
  state[key] = vl;
  const { I, G } = junctionIG(vl, p, ctx.tempC);
  ctx.conductance(a, k, G);
  ctx.current(a, k, I - G * vl);
}

/** Diode reliée à une tension fixe : courant de `a` vers un rail à Vrail (par rapport à ref). */
export function stampJunctionToRail(ctx, state, key, a, ref, vrail, p, reverse = false) {
  // reverse=false : anode = a, cathode = rail ; reverse=true : anode = rail, cathode = a
  const sgn = reverse ? -1 : 1;
  const vt = p.n * thermalVoltage(ctx.tempC);
  const vcrit = vt * Math.log(vt / (Math.SQRT2 * p.Is));
  const vd = sgn * (ctx.v(a) - ctx.v(ref) - vrail);
  const vold = state[key] ?? 0;
  const vl = pnjlim(vd, vold, vt, vcrit);
  if (vl !== vd) ctx.markLimited();
  state[key] = vl;
  const { I, G } = junctionIG(vl, p, ctx.tempC);
  // Courant sortant de a (vers ref) : sgn * I(vd), vd = sgn*(va - vref - vrail)
  ctx.conductance(a, ref, G);
  ctx.current(a, ref, sgn * (I - G * vl) - G * vrail);
}

/** Paramètres de Shockley déduits d'un point de fiche technique (VF à IF). */
export function fitIsFromVf(vf, iF, n, rs, tempC = 25) {
  const vj = vf - iF * rs;
  return iF / (Math.exp(vj / (n * thermalVoltage(tempC))) - 1);
}

/** Norton : source de tension V derrière une résistance R, entre a et ref. */
export function stampThevenin(ctx, a, ref, V, R) {
  const g = 1 / R;
  ctx.conductance(a, ref, g);
  ctx.current(ref, a, V * g * ctx.srcFactor);
}

export const OPEN_G = 1e-12;

/**
 * Transistor bipolaire, modèle d'Ebers-Moll (forme « transport » de SPICE, sans effets de forte injection).
 * m = { Is, BF, BR } ; pol = +1 (NPN) ou −1 (PNP).
 */
export function bjtCurrents(vbe, vbc, m, tempC = 25) {
  const vt = thermalVoltage(tempC);
  const [ef, def] = expLin(vbe / vt), [er, der] = expLin(vbc / vt);
  const If = m.Is * (ef - 1), Ir = m.Is * (er - 1);
  return { If, Ir, gf: (m.Is / vt) * def, gr: (m.Is / vt) * der, Ic: If - Ir * (1 + 1 / m.BR), Ib: If / m.BF + Ir / m.BR };
}

export function stampBJT(ctx, state, b, c, e, m, pol) {
  const vt = thermalVoltage(ctx.tempC);
  const vcrit = vt * Math.log(vt / (Math.SQRT2 * m.Is));
  const vbe = pol * (ctx.v(b) - ctx.v(e)), vbc = pol * (ctx.v(b) - ctx.v(c));
  const vbeL = pnjlim(vbe, state.vbe ?? 0, vt, vcrit), vbcL = pnjlim(vbc, state.vbc ?? 0, vt, vcrit);
  if (vbeL !== vbe || vbcL !== vbc) ctx.markLimited();
  state.vbe = vbeL; state.vbc = vbcL;
  const { If, Ir, gf, gr } = bjtCurrents(vbeL, vbcL, m, ctx.tempC);
  // Courant de transport collecteur → émetteur.
  ctx.vccs(c, e, b, e, gf);
  ctx.vccs(c, e, b, c, -gr);
  ctx.current(c, e, pol * (If - Ir - gf * vbeL + gr * vbcL));
  // Diodes base-émetteur et base-collecteur.
  const gbe = gf / m.BF + GMIN_J, gbc = gr / m.BR + GMIN_J;
  ctx.conductance(b, e, gbe);
  ctx.current(b, e, pol * (If / m.BF - (gf / m.BF) * vbeL));
  ctx.conductance(b, c, gbc);
  ctx.current(b, c, pol * (Ir / m.BR - (gr / m.BR) * vbcL));
}

/**
 * MOSFET, modèle quadratique de Shichman-Hodges (SPICE niveau 1, λ = 0).
 * Retourne le courant drain → source et ses dérivées pour (vgs, vds) quelconques.
 */
export function mosCurrents(vgs, vds, m) {
  const fwd = (g, d) => {
    const vov = g - m.Vt;
    if (vov <= 0) return [0, 0, 0];
    if (d < vov) return [m.Kp * (vov * d - d * d / 2), m.Kp * d, m.Kp * (vov - d)];
    return [m.Kp / 2 * vov * vov, m.Kp * vov, 0];
  };
  if (vds >= 0) { const [Id, gm, gds] = fwd(vgs, vds); return { Id, gm, gds }; }
  const [I, g1, g2] = fwd(vgs - vds, -vds); // rôles drain/source échangés
  return { Id: -I, gm: -g1, gds: g1 + g2 };
}

export function stampMOS(ctx, g, d, s, m, pol) {
  const vgs = pol * (ctx.v(g) - ctx.v(s)), vds = pol * (ctx.v(d) - ctx.v(s));
  const { Id, gm, gds } = mosCurrents(vgs, vds, m);
  ctx.vccs(d, s, g, s, gm);
  ctx.conductance(d, s, gds + 1e-9);
  ctx.current(d, s, pol * (Id - gm * vgs - gds * vds));
}

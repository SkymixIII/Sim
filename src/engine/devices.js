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

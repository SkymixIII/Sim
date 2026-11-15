// Dessins partagés : boîtiers DIP, boîtes à broches, fils d'amenée.
export const G = 20; // pixels par pas de grille

export const lead = (x1, x2, y = 0) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>`;

// Nom de broche : un "~" initial signifie « actif à l'état bas » (barre au-dessus).
const pinText = (name) => (name.startsWith("~") ? `<tspan text-decoration="overline">${name.slice(1)}</tspan>` : name);
export const plainName = (name) => (name.startsWith("~") ? `${name.slice(1)} (actif bas)` : name);

/**
 * Boîtier DIP vu de dessus, brochage réel : broche 1 en haut à gauche, numérotation en U.
 * names : nom de chaque broche (index = numéro − 1). Largeur : 6 pas de grille.
 */
export function dipPins(names) {
  const half = names.length / 2;
  return names.map((name, i) => ({
    id: String(i + 1), name, label: `${i + 1} · ${plainName(name)}`,
    x: i < half ? 0 : 6, y: i < half ? i : names.length - 1 - i,
  }));
}
export const dipBounds = (names) => ({ x: 1, y: -0.7, w: 4, h: names.length / 2 - 1 + 1.4 });

/** cls(i) : classes CSS supplémentaires de la pastille de la broche i (niveau logique…). */
export function dipSymbol(names, title, cls = () => "") {
  const half = names.length / 2;
  const h = (half - 1) * G;
  let s = `<rect class="ic" x="20" y="-14" width="80" height="${h + 28}" rx="4"/><path class="ic-notch" d="M52,-14 a8,8 0 0 0 16,0"/>`;
  if (title) s += `<text class="chip small" x="60" y="${h / 2 + 3}" transform="rotate(-90 60 ${h / 2})">${title}</text>`;
  names.forEach((name, i) => {
    const left = i < half;
    const y = (left ? i : names.length - 1 - i) * G;
    s += `<line x1="${left ? 0 : 120}" y1="${y}" x2="${left ? 20 : 100}" y2="${y}"/>`
      + `<circle class="pin ${cls(i)}" cx="${left ? 25 : 95}" cy="${y}" r="2.6"/>`
      + `<text class="pinlabel" x="${left ? 30 : 90}" y="${y + 3}" text-anchor="${left ? "start" : "end"}">${pinText(name)}</text>`;
  });
  return s;
}

/** Boîte rectangulaire à broches libres : pins [{ x, y, name }] sur le pourtour, coordonnées de grille. */
export function boxSymbol({ x, y, w, h }, pins, title, sub = "") {
  let s = `<rect class="ic" x="${x * G}" y="${y * G}" width="${w * G}" height="${h * G}" rx="4"/>`;
  s += `<text class="chip" x="${(x + w / 2) * G}" y="${(y + h / 2) * G + (sub ? -1 : 5)}">${title}</text>`;
  if (sub) s += `<text class="chip small" x="${(x + w / 2) * G}" y="${(y + h / 2) * G + 13}">${sub}</text>`;
  for (const p of pins) {
    const px = p.x * G, py = p.y * G;
    if (p.x <= x) s += `<line x1="${px}" y1="${py}" x2="${x * G}" y2="${py}"/><text class="pinlabel" x="${x * G + 5}" y="${py + 3}">${p.name ?? ""}</text>`;
    else if (p.x >= x + w) s += `<line x1="${px}" y1="${py}" x2="${(x + w) * G}" y2="${py}"/><text class="pinlabel" x="${(x + w) * G - 5}" y="${py + 3}" text-anchor="end">${p.name ?? ""}</text>`;
    else if (p.y >= y + h) s += `<line x1="${px}" y1="${py}" x2="${px}" y2="${(y + h) * G}"/><text class="pinlabel" x="${px}" y="${(y + h) * G - 5}" text-anchor="middle">${p.name ?? ""}</text>`;
    else s += `<line x1="${px}" y1="${py}" x2="${px}" y2="${y * G}"/><text class="pinlabel" x="${px}" y="${y * G + 11}" text-anchor="middle">${p.name ?? ""}</text>`;
  }
  return s;
}

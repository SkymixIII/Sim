// Mélangeur Blackmagic ATEM 2 M/E Constellation HD, vu du réseau.
// Ce n'est pas un composant électrique : il n'a pas de broches, seulement un port RJ45.
// Il se comporte comme le vrai côté Ethernet (protocole ATEM, UDP 9910) :
//   - poignée de main (hello 0x10 / 0x01 -> 0x02, ou 0x03 si plus de place) ;
//   - nouvelle session (bit de poids fort à 1) et état initial en plusieurs paquets
//     (_ver, _pin, PrgI/PrvI des deux M/E, TlIn, InCm) ;
//   - chaque paquet demande un accusé (0x08) : sans accusé il est renvoyé (0x20) ;
//   - paquet vide « ping » toutes les 500 ms si rien d'autre n'est parti ;
//   - un client muet depuis 2,5 s est oublié ;
//   - à chaque changement : PrgI, PrvI, TlIn ; pendant un AUTO, TrPs à chaque image.
// Le tally (TlIn) suit le M/E 1 : bit 0 = programme (et source entrante pendant un mix),
// bit 1 = preview. C'est ce que lisent les systèmes de tally du commerce.

const F_ACKREQ = 0x08, F_HELLO = 0x10, F_RESEND = 0x20, F_ACK = 0x80;
const NB_BOUTONS = 8;
const MAX_SESSIONS = 8;
const RENVOI_MS = 250, PING_MS = 500, TIMEOUT_MS = 2500, MAX_RENVOIS = 10;
const IMAGE_MS = 40; // 25 images/s
export const ATEM_IP = "192.168.10.240";

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];

/** Commande ATEM : longueur (2), 2 octets nuls, nom (4), données, complétée à un multiple de 4. */
export function atemCommand(name, data) {
  const len = 8 + data.length + ((4 - (data.length % 4)) % 4);
  const out = [...u16(len), 0, 0, ...ascii(name), ...data];
  while (out.length < len) out.push(0);
  return out;
}

export function atemHeader(flags, len, session, ackId, id) {
  const h = new Array(12).fill(0);
  h[0] = flags | ((len >> 8) & 0x07); h[1] = len & 0xff;
  [h[2], h[3]] = u16(session); [h[4], h[5]] = u16(ackId); [h[10], h[11]] = u16(id);
  return h;
}

export function initialAtemState() {
  return { pgm: 1, pvw: 2, trans: null };
}

/** Octets de tally par entrée pour l'état courant. */
export function tallyFlags(s, inputs) {
  const flags = [];
  for (let i = 1; i <= inputs; i++) {
    let f = 0;
    if (i === s.pgm || (s.trans && i === s.trans.to)) f |= 1;
    if (i === s.pvw) f |= 2;
    flags.push(f);
  }
  return flags;
}

export class AtemServer {
  constructor(inst, port, { now = () => performance.now(), onChange = () => {}, log = () => {} } = {}) {
    this.inst = inst; this.port = port; this.now = now; this.onChange = onChange; this.log = log;
    inst.rt = { ...inst.rt, atem: inst.rt?.atem ?? initialAtemState(), clients: 0 };
    this.sessions = new Map();   // session -> { sid, state, lastRx, lastTx, nextId, unacked }
    this.nextSession = 1;
    this.lastSent = null;
  }

  get s() { return this.inst.rt.atem; }
  get inputs() { return Number(this.inst.params.inputs) || 20; }

  sendRaw(bytes) { this.port.rj45Send(bytes); }

  send(sess, commands, t) {
    sess.nextId = (sess.nextId + 1) & 0x7fff;
    const body = commands.flat();
    const pkt = [...atemHeader(F_ACKREQ, 12 + body.length, sess.sid, 0, sess.nextId), ...body];
    sess.unacked.set(sess.nextId, { pkt, at: t, tries: 0 });
    sess.lastTx = t;
    this.sendRaw(pkt);
  }

  stateCommands() {
    const s = this.s;
    return [
      atemCommand("PrgI", [0, 0, ...u16(s.pgm)]),
      atemCommand("PrvI", [0, 0, ...u16(s.pvw), 0, 0, 0, 0]),
      atemCommand("TlIn", [...u16(this.inputs), ...tallyFlags(s, this.inputs)]),
    ];
  }

  transitionCommand(t) {
    const tr = this.s.trans;
    if (!tr) return atemCommand("TrPs", [0, 0, 0, 0, 0, 0, 0, 0]);
    const pos = Math.min(1, (t - tr.start) / tr.dur);
    const remaining = Math.max(0, Math.round(((1 - pos) * tr.dur) / IMAGE_MS));
    return atemCommand("TrPs", [0, 1, remaining, 0, ...u16(Math.round(pos * 10000)), 0, 0]);
  }

  openSession(helloSid, t) {
    const sid = 0x8000 | (this.nextSession++ & 0x7fff);
    const sess = { sid, state: "open", lastRx: t, lastTx: t, nextId: 0, unacked: new Map() };
    this.sessions.set(sid, sess);
    this.sessions.delete(helloSid);
    const name = ascii("ATEM 2 M/E Constellation HD");
    while (name.length < 44) name.push(0);
    // État initial en plusieurs paquets, comme le vrai mélangeur.
    this.send(sess, [atemCommand("_ver", [0, 2, 0, 30]), atemCommand("_pin", name)], t);
    this.send(sess, [
      atemCommand("PrgI", [0, 0, ...u16(this.s.pgm)]), atemCommand("PrvI", [0, 0, ...u16(this.s.pvw), 0, 0, 0, 0]),
      atemCommand("PrgI", [1, 0, 0, 1]), atemCommand("PrvI", [1, 0, 0, 2, 0, 0, 0, 0]),
    ], t);
    this.send(sess, [atemCommand("TlIn", [...u16(this.inputs), ...tallyFlags(this.s, this.inputs)])], t);
    this.send(sess, [atemCommand("InCm", [1, 0, 0, 0])], t);
    this.log(`Client connecté (session 0x${sid.toString(16).toUpperCase()})`);
    this.updateClients();
  }

  updateClients() {
    const n = [...this.sessions.values()].filter((x) => x.state === "open").length;
    if (n !== this.inst.rt.clients) { this.inst.rt.clients = n; this.onChange(); }
  }

  onPacket(p, t) {
    if (p.length < 12) return;
    const flags = p[0] & 0xf8;
    const sid = (p[2] << 8) | p[3];
    if (flags & F_HELLO) {
      if (p[12] !== 0x01) return;
      const open = [...this.sessions.values()].filter((x) => x.state === "open").length;
      const reply = [...atemHeader(F_HELLO, 20, sid, 0, 0), open >= MAX_SESSIONS ? 0x03 : 0x02, 0, 0, 0, 0, 0, 0, 0];
      this.sendRaw(reply);
      if (open < MAX_SESSIONS) this.sessions.set(sid, { sid, state: "hello", lastRx: t, lastTx: t, nextId: 0, unacked: new Map() });
      return;
    }
    const sess = this.sessions.get(sid);
    if (!sess) return;
    sess.lastRx = t;
    if (sess.state === "hello") {
      if (flags & F_ACK) this.openSession(sid, t);
      return;
    }
    if (flags & F_ACK) {
      const acked = (p[4] << 8) | p[5];
      for (const id of sess.unacked.keys()) if (((acked - id) & 0x7fff) < 0x4000) sess.unacked.delete(id);
    }
    if (flags & F_ACKREQ) this.sendRaw(atemHeader(F_ACK, 12, sid, (p[10] << 8) | p[11], 0)); // commande d'un client : acquittée, ignorée
  }

  tick() {
    const t = this.now();
    let m;
    while ((m = this.port.rj45Receive())) this.onPacket(m, t);

    // Fin d'un AUTO
    const s = this.s;
    let transitioning = false;
    if (s.trans) {
      transitioning = true;
      if (t - s.trans.start >= s.trans.dur) { s.pgm = s.trans.to; s.pvw = s.trans.from; s.trans = null; }
      this.onChange();
    }

    const key = `${s.pgm}/${s.pvw}/${s.trans ? s.trans.to : 0}/${this.inputs}`;
    const changed = key !== this.lastSent;
    const frame = transitioning && t - (this.lastFrame ?? 0) >= IMAGE_MS;
    if (changed || frame) {
      if (changed) this.lastSent = key;
      if (frame) this.lastFrame = t;
      for (const sess of this.sessions.values()) {
        if (sess.state !== "open") continue;
        const cmds = changed ? this.stateCommands() : [];
        if (transitioning) cmds.push(this.transitionCommand(t));
        this.send(sess, cmds, t);
      }
    }

    for (const sess of [...this.sessions.values()]) {
      if (t - sess.lastRx > TIMEOUT_MS) {
        this.sessions.delete(sess.sid);
        if (sess.state === "open") this.log(`Client perdu (session 0x${sess.sid.toString(16).toUpperCase()})`);
        continue;
      }
      if (sess.state !== "open") continue;
      for (const u of sess.unacked.values()) {
        if (t - u.at < RENVOI_MS) continue;
        if (++u.tries > MAX_RENVOIS) { this.sessions.delete(sess.sid); break; }
        u.at = t;
        const again = u.pkt.slice();
        again[0] |= F_RESEND;
        this.sendRaw(again);
        sess.lastTx = t;
      }
      if (this.sessions.has(sess.sid) && t - sess.lastTx >= PING_MS) this.send(sess, [], t);
    }
    this.updateClients();
  }
}

// ---------- Composant ----------
const BX = 120, BW = 44, BG = 8, ROW_PGM = 58, ROW_PVW = 112, BH = 34;
const keyX = (i) => BX + i * (BW + BG);
const CUT_X = keyX(NB_BOUTONS) + 20;

export const atem = {
  type: "atem",
  name: "ATEM 2 M/E Constellation HD",
  category: "Vidéo et réseau",
  summary: "Mélangeur vidéo Blackmagic, modélisé côté réseau : pupitre PGM/PVW, CUT, AUTO, et protocole ATEM (UDP 9910) sur son port RJ45.",
  pins: [],
  bounds: { x: 0, y: 0, w: 32, h: 9 },
  rotatable: false,
  interactive: true,
  device: AtemServer,
  params: [
    { key: "inputs", label: "Entrées annoncées dans le tally (TlIn)", kind: "select", default: 20, options: [{ value: 20, label: "20 (Constellation HD 2 M/E)" }, { value: 40, label: "40 (Constellation 4 M/E)" }] },
    { key: "rate", label: "Durée de la transition AUTO", kind: "select", default: 1, options: [{ value: 0.5, label: "0,5 s" }, { value: 1, label: "1 s (25 images)" }, { value: 2, label: "2 s" }] },
  ],
  datasheet: {
    source: "Blackmagic ATEM Constellation : port Ethernet 1 Gb/s, IP par défaut 192.168.10.240. Protocole décrit par la communauté (SKAARHOJ libATEM, Sofie atem-connection).",
    notes: [
      "Seul le comportement réseau est simulé : pas de vidéo, pas d'alimentation électrique.",
      "Tally (TlIn) : un octet par entrée, bit 0 programme, bit 1 preview, d'après le M/E 1. Pendant un AUTO, la source entrante est aussi au programme.",
      "Chaque paquet doit être acquitté par le client, sinon il est renvoyé toutes les 250 ms. Un client muet 2,5 s est déconnecté.",
      "Le pupitre montre les 8 premières entrées (caméras 1 à 8).",
    ],
  },
  stamp() {}, evaluate: () => ({}), describe: () => ({ readings: [], warnings: [] }),
  liveInfo(inst) {
    const s = inst.rt?.atem;
    return {
      readings: [
        ["Adresse IP", ATEM_IP],
        ["Clients connectés", String(inst.rt?.clients ?? 0)],
        ["Programme (M/E 1)", s ? `CAM ${s.pgm}` : "—"],
        ["Preview (M/E 1)", s ? `CAM ${s.pvw}` : "—"],
        ["Transition", s?.trans ? `AUTO CAM ${s.trans.from} → CAM ${s.trans.to}` : "aucune"],
      ],
      warnings: inst.rt?.atem && !inst.rt?.clients ? [{ level: "warn", text: "Aucun client connecté sur le port RJ45." }] : [],
    };
  },
  press(inst, down, key) {
    const s = inst.rt?.atem;
    if (!down || !key || !s) return false;
    const n = Number(key.slice(3));
    if (key.startsWith("pgm")) { if (!s.trans) s.pgm = n; }
    else if (key.startsWith("pvw")) { if (!s.trans) s.pvw = n; }
    else if (key === "cut") { if (!s.trans) [s.pgm, s.pvw] = [s.pvw, s.pgm]; }
    else if (key === "auto") {
      if (!s.trans && s.pgm !== s.pvw) s.trans = { from: s.pgm, to: s.pvw, start: performance.now(), dur: (Number(inst.params.rate) || 1) * 1000 };
    } else return false;
    return true;
  },
  label: () => "",
  symbol(inst) {
    const s = inst.rt?.atem;
    const on = !!s;
    let out = `<rect class="atem-body" x="0" y="0" width="640" height="180" rx="8"/>`
      + `<text class="atem-title" x="16" y="24">ATEM 2 M/E Constellation HD</text>`
      + `<text class="atem-sub" x="16" y="40">${ATEM_IP} · ${on ? `${inst.rt.clients} client${inst.rt.clients > 1 ? "s" : ""}` : "éteint"}</text>`
      + `<text class="atem-row" x="16" y="${ROW_PGM + 22}">PROGRAM</text><text class="atem-row" x="16" y="${ROW_PVW + 22}">PREVIEW</text>`;
    for (let i = 0; i < NB_BOUTONS; i++) {
      const n = i + 1, x = keyX(i);
      const pg = on && (s.pgm === n || s.trans?.to === n), pv = on && s.pvw === n;
      out += `<g data-key="pgm${n}"><rect class="atem-key${pg ? " pgm" : ""}" x="${x}" y="${ROW_PGM}" width="${BW}" height="${BH}" rx="4"/><text class="atem-num" x="${x + BW / 2}" y="${ROW_PGM + 22}">${n}</text></g>`
        + `<g data-key="pvw${n}"><rect class="atem-key${pv ? " pvw" : ""}" x="${x}" y="${ROW_PVW}" width="${BW}" height="${BH}" rx="4"/><text class="atem-num" x="${x + BW / 2}" y="${ROW_PVW + 22}">${n}</text></g>`;
    }
    const pos = on && s.trans ? Math.min(1, (performance.now() - s.trans.start) / s.trans.dur) : 0;
    out += `<g data-key="cut"><rect class="atem-key" x="${CUT_X}" y="${ROW_PGM}" width="56" height="${BH}" rx="4"/><text class="atem-num" x="${CUT_X + 28}" y="${ROW_PGM + 22}">CUT</text></g>`
      + `<g data-key="auto"><rect class="atem-key${on && s.trans ? " auto" : ""}" x="${CUT_X}" y="${ROW_PVW}" width="56" height="${BH}" rx="4"/><text class="atem-num" x="${CUT_X + 28}" y="${ROW_PVW + 22}">AUTO</text></g>`
      + `<rect class="atem-bar" x="${CUT_X + 66}" y="${ROW_PGM}" width="10" height="${ROW_PVW + BH - ROW_PGM}" rx="3"/>`
      + `<rect class="atem-bar-fill" x="${CUT_X + 66}" y="${ROW_PGM}" width="10" height="${((ROW_PVW + BH - ROW_PGM) * pos).toFixed(1)}" rx="3"/>`
      + `<rect class="atem-rj45" x="586" y="10" width="34" height="26" rx="2"/><circle class="atem-led${on && inst.rt.clients ? " up" : ""}" cx="592" cy="14" r="2.6"/>`
      + `<text class="atem-sub" x="603" y="50" text-anchor="middle">RJ45</text>`;
    return out;
  },
};

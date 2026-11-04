// Liens virtuels entre cartes : ce qui n'est pas un fil de cuivre.
// Un lien relie deux composants programmables et transporte des octets, jamais du courant.
//   rj45   : câble Ethernet direct (point à point, bidirectionnel). Les sketches y échangent
//            des datagrammes UDP complets (ex. protocole ATEM sur le port 9910).
//   espnow : radio ESP-NOW 2,4 GHz. Une diffusion (broadcast) atteint toutes les cartes reliées
//            à l'émetteur par un lien espnow, à condition d'être sur le même canal Wi-Fi.
// Chaque lien peut être coupé (câble débranché, lampe hors de portée) et, pour la radio,
// perdre une fraction des messages.

export const LINK_KINDS = {
  rj45: {
    label: "RJ45 (Ethernet direct)",
    short: "RJ45",
    summary: "Câble Ethernet direct entre deux cartes, sans switch ni routeur. Transporte des datagrammes UDP.",
    notes: [
      "Le lien est « monté » quand il est branché et que les deux cartes tournent (comme la LED LINK du port).",
      "Les datagrammes sont livrés dans l'ordre, sans perte : un câble court direct ne perd rien en pratique.",
    ],
  },
  espnow: {
    label: "Radio ESP-NOW 2,4 GHz",
    short: "ESP-NOW",
    summary: "Radio ESP-NOW sans routeur. Une diffusion atteint toutes les cartes à portée réglées sur le même canal.",
    notes: [
      "Message de 250 octets au plus, sans accusé de réception en diffusion : un message perdu n'est pas renvoyé.",
      "Émetteur et récepteur doivent être sur le même canal Wi-Fi (1 à 13), sinon rien ne passe.",
      "Le réglage « perte » simule une lampe en limite de portée ou un environnement 2,4 GHz chargé.",
    ],
  },
};

const INBOX_MAX = 32;     // file de réception d'une carte, comme le tampon de lwIP / ESP-NOW
const ESPNOW_MAX = 250;   // ESP_NOW_MAX_DATA_LEN

export class VirtualNetwork {
  /**
   * getLinks : () => liste des liens { id, kind, a, b, cut, loss }
   * isOnline : (compId) => la carte exécute-t-elle un programme ?
   * onTraffic : (link, bytes) => appelé à chaque message transmis
   */
  constructor({ getLinks, isOnline, onTraffic = () => {}, random = Math.random }) {
    this.getLinks = getLinks; this.isOnline = isOnline; this.onTraffic = onTraffic; this.random = random;
    this.boards = new Map();
    this.stats = new Map();   // link.id -> { count, lost, last, at }
  }

  state(id) {
    if (!this.boards.has(id)) this.boards.set(id, { rj45: [], espnow: [], channel: null });
    return this.boards.get(id);
  }

  /** Carte redémarrée ou arrêtée : files vidées, radio éteinte. */
  reset(id) { this.boards.delete(id); }

  linksOf(id, kind) {
    return this.getLinks().filter((l) => l.kind === kind && (l.a === id || l.b === id));
  }

  stat(link) {
    if (!this.stats.has(link.id)) this.stats.set(link.id, { count: 0, lost: 0, last: null, at: 0 });
    return this.stats.get(link.id);
  }

  /** Lien utilisable : branché et les deux cartes sous tension avec un programme. */
  up(link) { return !link.cut && this.isOnline(link.a) && this.isOnline(link.b); }

  deliver(link, to, kind, bytes) {
    const box = this.state(to)[kind];
    if (box.length >= INBOX_MAX) box.shift();
    box.push(bytes.slice());
    const s = this.stat(link);
    s.count++; s.last = bytes.slice(); s.at = Date.now();
    this.onTraffic(link, bytes);
  }

  port(id) {
    const net = this;
    return {
      rj45Linked: () => net.linksOf(id, "rj45").some((l) => net.up(l)),
      rj45Send(bytes) {
        let sent = false;
        for (const l of net.linksOf(id, "rj45")) {
          if (!net.up(l)) continue;
          net.deliver(l, l.a === id ? l.b : l.a, "rj45", bytes);
          sent = true;
        }
        return sent;
      },
      rj45Receive: () => net.state(id).rj45.shift() ?? null,
      espnowBegin(channel) {
        const ch = Math.round(Number(channel));
        if (!(ch >= 1 && ch <= 14)) return false;
        net.state(id).channel = ch;
        return true;
      },
      espnowSend(bytes) {
        const me = net.state(id);
        if (me.channel === null || bytes.length > ESPNOW_MAX) return false;
        for (const l of net.linksOf(id, "espnow")) {
          const to = l.a === id ? l.b : l.a;
          if (!net.up(l) || net.state(to).channel !== me.channel) continue;
          if (net.random() * 100 < (l.loss ?? 0)) { net.stat(l).lost++; continue; }
          net.deliver(l, to, "espnow", bytes);
        }
        return true; // en diffusion, esp_now_send réussit même si personne n'écoute
      },
      espnowReceive: () => net.state(id).espnow.shift() ?? null,
    };
  }
}

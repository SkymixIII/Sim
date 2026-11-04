// Montage « Tally ATEM 8 caméras » : un ATEM 2 M/E Constellation HD (modélisé côté réseau),
// relié en RJ45 à l'émetteur WT32-ETH01, qui diffuse en ESP-NOW à 8 lampes ESP32-C3 (une par caméra).
// Dérivé de tally_atem_4_lampes.csv, dont il garde les identifiants.
//
// Les sketches ci-dessous sont la version « établi » des firmwares de firmware/ :
// même logique, mêmes octets échangés (protocole ATEM UDP, trame tally ESP-NOW),
// seules les entrées/sorties réseau changent (Rj45.* et EspNow.* au lieu de WiFiUDP et esp_now_*).

export const SKETCH_EMETTEUR = `// Émetteur tally (WT32-ETH01) : client ATEM sur le RJ45, rediffusion ESP-NOW 10 fois/s.
// Version établi de firmware/emetteur_wt32eth01/emetteur_wt32eth01.ino

const int LED_STATUT = 2;
const int CANAL_ESPNOW = 1;
const int PERIODE_RADIO_MS = 100;     // 10 Hz
const int TIMEOUT_ATEM_MS = 2000;
const int RELANCE_HELLO_MS = 1000;
const int MAX_CAMS = 8;
const int TTL_MAX = 4;                // nombre maximal de relais (sauts) dans le maillage

const int F_ACK_DEMANDE = 0x08;
const int F_HELLO = 0x10;
const int F_ACK = 0x80;

int etat = 0;                 // 0 : déconnecté, 1 : hello envoyé, 2 : connecté
unsigned int sessionId = 0x53AB;
unsigned long dernierRecu = 0;
unsigned long dernierHello = 0;
unsigned long dernierRadio = 0;
int seq = 0;
int nbEntrees = 0;
int ledAllumee = -1;

uint8_t tally[8];
uint8_t rx[1500];
uint8_t tx[64];

void envoyerHello() {
  for (int i = 0; i < 20; i++) tx[i] = 0;
  sessionId = 0x5300 | random(0, 256);
  tx[0] = F_HELLO; tx[1] = 20;
  tx[2] = (sessionId >> 8) & 0xFF; tx[3] = sessionId & 0xFF;
  tx[9] = 0x3A;
  tx[12] = 0x01;                      // demande de connexion
  Rj45.send(tx, 20);
  etat = 1;
  dernierHello = millis();
}

void envoyerAck(int session, int id) {
  for (int i = 0; i < 12; i++) tx[i] = 0;
  tx[0] = F_ACK; tx[1] = 12;
  tx[2] = (session >> 8) & 0xFF; tx[3] = session & 0xFF;
  tx[4] = (id >> 8) & 0xFF; tx[5] = id & 0xFF;
  Rj45.send(tx, 12);
}

void lireTally(int p) {
  int nb = (rx[p] << 8) | rx[p + 1];
  bool change = (nb != nbEntrees);
  nbEntrees = nb;
  for (int k = 0; k < MAX_CAMS; k++) {
    int f = 0;
    if (k < nb) f = rx[p + 2 + k] & 0x03;
    if (f != tally[k]) change = true;
    tally[k] = f;
  }
  if (change) {
    String s = "Tally ATEM :";
    for (int k = 0; k < MAX_CAMS && k < nb; k++) {
      s = s + " " + String(k + 1) + ":";
      if (tally[k] & 1) s = s + "PGM";
      else if (tally[k] & 2) s = s + "PVW";
      else s = s + "-";
    }
    Serial.println(s);
  }
}

void traiterPaquet(int n) {
  int drapeaux = rx[0] & 0xF8;
  int longueur = ((rx[0] & 0x07) << 8) | rx[1];
  if (longueur < 12 || longueur > n) return;
  int session = (rx[2] << 8) | rx[3];
  int idDistant = (rx[10] << 8) | rx[11];
  if ((drapeaux & F_HELLO) != 0) {
    if (longueur >= 13 && rx[12] == 0x02) {
      envoyerAck(session, 0);
      etat = 2;
      dernierRecu = millis();
      Serial.println("Connecté à l'ATEM");
    }
    return;
  }
  if (etat != 2) return;
  dernierRecu = millis();
  sessionId = session;                // l'ATEM attribue sa propre session après le hello
  if ((drapeaux & F_ACK_DEMANDE) != 0) envoyerAck(session, idDistant);
  int i = 12;
  while (i + 8 <= longueur) {
    int l = (rx[i] << 8) | rx[i + 1];
    if (l < 8 || i + l > longueur) break;
    if (rx[i + 4] == 0x54 && rx[i + 5] == 0x6C && rx[i + 6] == 0x49 && rx[i + 7] == 0x6E) lireTally(i + 8);
    i = i + l;
  }
}

void diffuser() {
  // Trame tally v2 (16 octets) : 'T' 'L', version 2, numéro, ATEM ok, nb caméras,
  // TTL (relais encore permis), sauts déjà faits, puis 1 octet par caméra (bit 0 programme, bit 1 preview).
  tx[0] = 0x54; tx[1] = 0x4C; tx[2] = 2;
  tx[3] = seq;
  tx[4] = (etat == 2) ? 1 : 0;
  tx[5] = MAX_CAMS;
  tx[6] = TTL_MAX;
  tx[7] = 0;
  for (int k = 0; k < MAX_CAMS; k++) tx[8 + k] = (etat == 2) ? tally[k] : 0;
  EspNow.broadcast(tx, 8 + MAX_CAMS);
  seq = (seq + 1) & 0xFF;
  dernierRadio = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUT, OUTPUT);
  Rj45.begin();
  if (!EspNow.begin(CANAL_ESPNOW)) Serial.println("Erreur ESP-NOW");
  Serial.println("Émetteur prêt, IP 192.168.10.50 -> ATEM 192.168.10.240");
}

void loop() {
  if (etat != 2 && millis() - dernierHello >= RELANCE_HELLO_MS) envoyerHello();
  int n = Rj45.receive(rx);
  while (n > 0) {
    traiterPaquet(n);
    n = Rj45.receive(rx);
  }
  if (etat == 2 && millis() - dernierRecu > TIMEOUT_ATEM_MS) {
    etat = 0;
    for (int k = 0; k < MAX_CAMS; k++) tally[k] = 0;
    Serial.println("ATEM perdu, nouvelle tentative...");
  }
  int led = (etat == 2) ? LOW : HIGH;   // allumée = pas connecté à l'ATEM
  if (led != ledAllumee) { digitalWrite(LED_STATUT, led); ledAllumee = led; }
  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
  delay(2);
}
`;

export const sketchLampe = (cam) => `// Lampe tally (ESP32-C3 Super Mini) de la caméra ${cam}, et relais du maillage ESP-NOW.
// Une seule couleur à la fois, par priorité : BLEU > ROUGE > VERT.
//   bleu fixe        : plus de trame tally reçue (ni de l'émetteur, ni d'une autre lampe)
//   bleu clignotant  : l'émetteur répond mais n'a plus l'ATEM
//   rouge            : caméra au programme
//   vert             : caméra en preview
// Maillage : chaque trame nouvelle (numéro jamais vu) est rediffusée une fois, après un délai
// aléatoire, avec TTL - 1. Les doublons sont ignorés : pas de boucle, pas de tempête.
// Version établi de firmware/lampe_esp32c3/lampe_esp32c3.ino (réel : une WS2812B sur GPIO4).

const int CAM = ${cam};               // caméra suivie : changer ce numéro pour réaffecter la lampe
const bool RELAIS = true;             // false : la lampe écoute sans relayer
const int LED_ROUGE = 18;
const int LED_VERTE = 19;
const int LED_BLEUE = 21;
const int CANAL_ESPNOW = 1;
const int TIMEOUT_MS = 2000;

uint8_t rx[64];
uint8_t relais[16];
bool relaisEnAttente = false;
unsigned long relaisA = 0;
unsigned long dernierMessage = 0;
bool dejaRecu = false;
int dernierSeq = 0;
int sauts = -1;
int atemOk = 0;
int etatCam = 0;
int actuel[3] = {-1, -1, -1};
int etatAvant = -1;

void ecrire(int r, int v, int b) {
  if (r != actuel[0]) { digitalWrite(LED_ROUGE, r); actuel[0] = r; }
  if (v != actuel[1]) { digitalWrite(LED_VERTE, v); actuel[1] = v; }
  if (b != actuel[2]) { digitalWrite(LED_BLEUE, b); actuel[2] = b; }
}

// Trame nouvelle : numéro plus récent que le dernier accepté (sur 8 bits),
// ou rien d'accepté depuis 1 s (émetteur redémarré).
bool estNouvelle(int seq) {
  if (!dejaRecu || millis() - dernierMessage > 1000) return true;
  int d = (seq - dernierSeq) & 0xFF;
  return d > 0 && d < 128;
}

void traiter(int n) {
  if (n < 16 || rx[0] != 0x54 || rx[1] != 0x4C || rx[2] != 2) return;
  if (!estNouvelle(rx[3])) return;          // doublon déjà reçu par un autre chemin
  dernierSeq = rx[3];
  dernierMessage = millis();
  dejaRecu = true;
  atemOk = rx[4];
  etatCam = (CAM <= rx[5]) ? rx[7 + CAM] : 0;
  if (rx[7] + 1 != sauts) {
    sauts = rx[7] + 1;
    Serial.println("Trame reçue en " + String(sauts) + " saut(s)");
  }
  if (RELAIS && rx[6] > 1) {
    for (int i = 0; i < 16; i++) relais[i] = rx[i];
    relais[6] = rx[6] - 1;                 // TTL
    relais[7] = rx[7] + 1;                 // sauts
    relaisEnAttente = true;
    relaisA = millis() + random(2, 15);    // délai aléatoire : évite que toutes les lampes émettent ensemble
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_ROUGE, OUTPUT);
  pinMode(LED_VERTE, OUTPUT);
  pinMode(LED_BLEUE, OUTPUT);
  EspNow.begin(CANAL_ESPNOW);
  Serial.println("Lampe prête, caméra " + String(CAM) + ", canal " + String(CANAL_ESPNOW) + (RELAIS ? ", relais actif" : ""));
}

void loop() {
  int n = EspNow.receive(rx);
  while (n > 0) {
    traiter(n);
    n = EspNow.receive(rx);
  }
  if (relaisEnAttente && millis() >= relaisA) {
    EspNow.broadcast(relais, 16);
    relaisEnAttente = false;
  }
  // 0 : plus de trame, 1 : ATEM perdu, 2 : programme, 3 : preview, 4 : rien
  int etat = 4;
  if (!dejaRecu || millis() - dernierMessage > TIMEOUT_MS) etat = 0;
  else if (atemOk == 0) etat = 1;
  else if (etatCam & 1) etat = 2;
  else if (etatCam & 2) etat = 3;
  if (etat != etatAvant) {
    if (etat == 0) { Serial.println("Plus de trame tally : bleu"); sauts = -1; }
    if (etat == 1) Serial.println("Émetteur sans ATEM : bleu clignotant");
    if (etat == 2) Serial.println("Programme : rouge");
    if (etat == 3) Serial.println("Preview : vert");
    if (etat == 4) Serial.println("Hors antenne : éteinte");
    etatAvant = etat;
  }
  if (etat == 0) ecrire(LOW, LOW, HIGH);
  else if (etat == 1) ecrire(LOW, LOW, (millis() % 1000) < 500 ? HIGH : LOW);
  else if (etat == 2) ecrire(HIGH, LOW, LOW);
  else if (etat == 3) ecrire(LOW, HIGH, LOW);
  else ecrire(LOW, LOW, LOW);
  delay(2);
}
`;

export const NB_CAMS = 8;
const LAMPE_X = [2, 26, 50, 74];
const LAMPE_Y = [18, 35];

// Carte radio par défaut (mètres) : les lampes 1 à 4 sont près de l'émetteur, les lampes 5 à 8
// au fond du plateau, hors de sa portée directe. Elles ne reçoivent que grâce au maillage.
export const RADIO_POSITIONS = {
  emetteur: [15, 80],
  lampe1: [50, 45], lampe2: [55, 115], lampe3: [60, 80], lampe4: [35, 60],
  lampe5: [95, 50], lampe6: [100, 110], lampe7: [135, 70], lampe8: [150, 115],
};
export function defaultRadio() {
  return {
    nodes: Object.fromEntries(Object.entries(RADIO_POSITIONS).map(([id, [x, y]]) => [id, { x, y, range: 60 }])),
    obstacles: {},
  };
}

export function tallyCircuit() {
  const components = [];
  const wires = [];
  const comp = (id, type, x, y, params = {}, extra = {}) => components.push({ id, type, x, y, rot: 0, params, ...extra });
  // Polyligne de fils : [[x, y], [x, y], ...]
  const path = (...pts) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      wires.push({ id: `w${wires.length}`, x1, y1, x2, y2 });
    }
  };

  // --- ATEM 2 M/E Constellation HD (appareil réseau, sans broche) ---
  comp("atem", "atem", 2, 3, { inputs: 20, rate: 1 }, { name: "ATEM Constellation" });

  // --- Émetteur WT32-ETH01 ---
  const ex = 44, ey = 3;
  comp("emetteur", "esp32", ex, ey, { drive: 2 }, { name: "Émetteur", realBoard: "WT32-ETH01", code: SKETCH_EMETTEUR });
  comp("em_r_statut", "resistor", ex + 12, ey + 4, { R: 220, Pmax: 0.25 });
  comp("em_led_statut", "led", ex + 16, ey + 4, { color: "red" }, { name: "Statut ATEM" });
  comp("em_gnd", "ground", ex + 21, ey + 9);
  path([ex + 10, ey + 4], [ex + 12, ey + 4]);
  path([ex + 20, ey + 4], [ex + 21, ey + 4], [ex + 21, ey + 9]);
  path([ex + 10, ey + 9], [ex + 21, ey + 9]);

  // --- 8 lampes ESP32-C3, une par caméra ---
  for (let cam = 1; cam <= NB_CAMS; cam++) {
    const lx = LAMPE_X[(cam - 1) % 4], ly = LAMPE_Y[Math.floor((cam - 1) / 4)];
    const id = `lampe${cam}`;
    comp(id, "esp32", lx, ly, { drive: 3 }, { name: `Lampe CAM ${cam}`, realBoard: "ESP32-C3 Super Mini", code: sketchLampe(cam) });
    comp(`${id}_r_rouge`, "resistor", lx + 12, ly + 2, { R: 120, Pmax: 0.25 });
    comp(`${id}_led_rouge`, "led", lx + 16, ly + 2, { color: "red" }, { name: "Programme" });
    comp(`${id}_r_vert`, "resistor", lx + 12, ly + 6, { R: 47, Pmax: 0.25 });
    comp(`${id}_led_vert`, "led", lx + 16, ly + 6, { color: "green" }, { name: "Preview" });
    comp(`${id}_r_bleu`, "resistor", lx + 12, ly + 10, { R: 33, Pmax: 0.25 });
    comp(`${id}_led_bleu`, "led", lx + 16, ly + 10, { color: "blue" }, { name: "Liaison perdue" });
    comp(`${id}_gnd`, "ground", lx + 21, ly + 12);
    path([lx + 10, ly + 5], [lx + 11, ly + 5], [lx + 11, ly + 2], [lx + 12, ly + 2]);  // GPIO18 -> rouge
    path([lx + 10, ly + 6], [lx + 12, ly + 6]);                                      // GPIO19 -> vert
    path([lx + 10, ly + 7], [lx + 11, ly + 7], [lx + 11, ly + 10], [lx + 12, ly + 10]); // GPIO21 -> bleu
    path([lx + 20, ly + 2], [lx + 21, ly + 2], [lx + 21, ly + 12]);                  // cathodes
    path([lx + 20, ly + 6], [lx + 21, ly + 6]);
    path([lx + 20, ly + 10], [lx + 21, ly + 10]);
    path([lx + 10, ly + 9], [lx + 10, ly + 12], [lx + 21, ly + 12]);                 // GND -> masse
  }

  const links = [
    { id: "l_eth", kind: "rj45", a: "atem", b: "emetteur", cut: false, note: "Câble RJ45 direct, protocole ATEM UDP 9910 (ATEM 192.168.10.240, émetteur 192.168.10.50)" },
  ];
  return { components, wires, links, radio: defaultRadio() };
}

// Montage « Tally ATEM 4 lampes », construit d'après tally_atem_4_lampes.csv.
// Les identifiants des composants et des liens sont ceux du CSV.
//
// Les sketches ci-dessous sont la version « établi » des firmwares de firmware/ :
// même logique, mêmes octets échangés (protocole ATEM UDP, trame tally ESP-NOW),
// seules les entrées/sorties réseau changent (Rj45.* et EspNow.* au lieu de WiFiUDP et esp_now_*).

export const SKETCH_ATEM = `// Émulateur ATEM (côté mélangeur) : 4 boutons, programme / preview des caméras 1 et 2.
// Parle le protocole ATEM (UDP 9910) sur le lien RJ45, comme un vrai mélangeur.
// Version établi de firmware/atem_emulateur/atem_emulateur.ino

const int BTN_C1_PVW = 32;
const int BTN_C1_CUT = 4;
const int BTN_C2_PVW = 5;
const int BTN_C2_CUT = 18;
const int NB_ENTREES = 2;
const int ANTI_REBOND_MS = 30;
const int PERIODE_ETAT_MS = 500;
const int TIMEOUT_CLIENT_MS = 3000;

// Drapeaux de l'en-tête ATEM (5 bits de poids fort de l'octet 0)
const int F_ACK_DEMANDE = 0x08;
const int F_HELLO = 0x10;
const int F_ACK = 0x80;

int boutons[4] = {BTN_C1_PVW, BTN_C1_CUT, BTN_C2_PVW, BTN_C2_CUT};
int stable[4] = {1, 1, 1, 1};
int dernierLu[4] = {1, 1, 1, 1};
unsigned long changeA[4] = {0, 0, 0, 0};

int programme = 1;
int preview = 2;
bool aEnvoyer = true;

int etatSession = 0;          // 0 : aucun client, 1 : hello reçu, 2 : client connecté
unsigned int sessionHello = 0;
unsigned int sessionId = 0;
unsigned int idLocal = 0;
unsigned long dernierClient = 0;
unsigned long dernierEnvoi = 0;

uint8_t rx[256];
uint8_t tx[256];

void afficherEtat() {
  Serial.println("Programme : CAM " + String(programme) + " · Preview : CAM " + String(preview));
}

void actionBouton(int b) {
  int cam = (b < 2) ? 1 : 2;
  bool cut = (b == 1 || b == 3);
  if (!cut) {
    if (cam != programme && cam != preview) { preview = cam; aEnvoyer = true; }
  } else if (cam != programme) {
    if (cam == preview) preview = programme;   // l'ancienne caméra programme passe en preview
    programme = cam;
    aEnvoyer = true;
  }
  if (aEnvoyer) afficherEtat();
}

void lireBoutons() {
  for (int b = 0; b < 4; b++) {
    int lu = digitalRead(boutons[b]);
    if (lu != dernierLu[b]) { dernierLu[b] = lu; changeA[b] = millis(); }
    if (millis() - changeA[b] >= ANTI_REBOND_MS && lu != stable[b]) {
      stable[b] = lu;
      if (lu == LOW) actionBouton(b);   // action au front descendant (LOW = appuyé)
    }
  }
}

void effacer(int n) {
  for (int i = 0; i < n; i++) tx[i] = 0;
}

void entete(int drapeaux, int longueur, int session, int ackId, int id) {
  tx[0] = drapeaux | ((longueur >> 8) & 0x07);
  tx[1] = longueur & 0xFF;
  tx[2] = (session >> 8) & 0xFF;
  tx[3] = session & 0xFF;
  tx[4] = (ackId >> 8) & 0xFF;
  tx[5] = ackId & 0xFF;
  tx[10] = (id >> 8) & 0xFF;
  tx[11] = id & 0xFF;
}

// Écrit l'en-tête d'une commande (longueur, 2 octets nuls, nom ASCII) et renvoie la position des données.
int commande(int pos, int longueur, int c1, int c2, int c3, int c4) {
  tx[pos] = (longueur >> 8) & 0xFF;
  tx[pos + 1] = longueur & 0xFF;
  tx[pos + 2] = 0;
  tx[pos + 3] = 0;
  tx[pos + 4] = c1;
  tx[pos + 5] = c2;
  tx[pos + 6] = c3;
  tx[pos + 7] = c4;
  return pos + 8;
}

void envoyerEtat(bool initial) {
  effacer(256);
  int pos = 12;
  int d = 0;
  if (initial) {
    d = commande(pos, 12, 0x5F, 0x76, 0x65, 0x72);          // _ver : protocole 2.30
    tx[d + 1] = 2; tx[d + 3] = 30;
    pos = pos + 12;
  }
  d = commande(pos, 12, 0x50, 0x72, 0x67, 0x49);            // PrgI : programme du M/E 1
  tx[d + 3] = programme;
  pos = pos + 12;
  d = commande(pos, 12, 0x50, 0x72, 0x76, 0x49);            // PrvI : preview du M/E 1
  tx[d + 3] = preview;
  pos = pos + 12;
  int lTally = 10 + NB_ENTREES;
  while (lTally % 4 != 0) lTally++;
  d = commande(pos, lTally, 0x54, 0x6C, 0x49, 0x6E);        // TlIn : tally par entrée
  tx[d + 1] = NB_ENTREES;
  for (int i = 1; i <= NB_ENTREES; i++) {
    int f = 0;
    if (i == programme) f = f | 1;
    if (i == preview) f = f | 2;
    tx[d + 1 + i] = f;
  }
  pos = pos + lTally;
  if (initial) {
    commande(pos, 12, 0x49, 0x6E, 0x43, 0x6D);              // InCm : fin de l'état initial
    pos = pos + 12;
  }
  idLocal = (idLocal + 1) & 0x7FFF;
  entete(F_ACK_DEMANDE, pos, sessionId, 0, idLocal);
  Rj45.send(tx, pos);
  dernierEnvoi = millis();
  aEnvoyer = false;
}

void traiterPaquet(int n) {
  int drapeaux = rx[0] & 0xF8;
  int session = (rx[2] << 8) | rx[3];
  if ((drapeaux & F_HELLO) != 0) {
    if (n >= 13 && rx[12] == 0x01) {
      effacer(20);
      entete(F_HELLO, 20, session, 0, 0);
      tx[12] = 0x02;                                          // connexion acceptée
      Rj45.send(tx, 20);
      sessionHello = session;
      etatSession = 1;
      dernierClient = millis();
    }
    return;
  }
  if ((drapeaux & F_ACK) != 0) {
    dernierClient = millis();
    if (etatSession == 1) {
      etatSession = 2;
      sessionId = 0x8000 | (sessionHello & 0x7FFF);
      idLocal = 0;
      Serial.println("Client connecté sur le RJ45 (session 0x" + String(sessionId, HEX) + ")");
      envoyerEtat(true);
    }
  }
}

void setup() {
  Serial.begin(115200);
  for (int b = 0; b < 4; b++) pinMode(boutons[b], INPUT_PULLUP);
  Rj45.begin();
  Serial.println("Émulateur ATEM prêt, IP 192.168.10.240, port UDP 9910");
  afficherEtat();
}

void loop() {
  lireBoutons();
  int n = Rj45.receive(rx);
  while (n > 0) {
    if (n >= 12) traiterPaquet(n);
    n = Rj45.receive(rx);
  }
  if (etatSession == 2) {
    if (aEnvoyer || millis() - dernierEnvoi >= PERIODE_ETAT_MS) envoyerEtat(false);
    if (millis() - dernierClient > TIMEOUT_CLIENT_MS) {
      etatSession = 0;
      Serial.println("Client perdu (plus d'accusé de réception)");
    }
  }
  delay(2);
}
`;

export const SKETCH_EMETTEUR = `// Émetteur tally (WT32-ETH01) : client ATEM sur le RJ45, rediffusion ESP-NOW 10 fois/s.
// Version établi de firmware/emetteur_wt32eth01/emetteur_wt32eth01.ino

const int LED_STATUT = 2;
const int CANAL_ESPNOW = 1;
const int PERIODE_RADIO_MS = 100;     // 10 Hz
const int TIMEOUT_ATEM_MS = 2000;
const int RELANCE_HELLO_MS = 1000;
const int MAX_CAMS = 8;

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
    for (int k = 0; k < 4 && k < nb; k++) {
      s = s + " CAM" + String(k + 1) + "=";
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
  // Trame tally : 'T' 'L', version, numéro, ATEM ok, nb caméras, puis 1 octet par caméra
  // (bit 0 = programme, bit 1 = preview).
  tx[0] = 0x54; tx[1] = 0x4C; tx[2] = 1;
  tx[3] = seq;
  tx[4] = (etat == 2) ? 1 : 0;
  tx[5] = MAX_CAMS;
  for (int k = 0; k < MAX_CAMS; k++) tx[6 + k] = (etat == 2) ? tally[k] : 0;
  EspNow.broadcast(tx, 6 + MAX_CAMS);
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

export const sketchLampe = (cam) => `// Lampe tally (ESP32-C3 Super Mini) qui suit la caméra ${cam}.
// Rouge = programme, vert = preview, rouge + vert clignotant à 2 Hz = liaison perdue.
// Version établi de firmware/lampe_esp32c3/lampe_esp32c3.ino (réel : une WS2812B sur GPIO4).

const int CAM = ${cam};               // caméra suivie : changer ce numéro pour réaffecter la lampe
const int LED_ROUGE = 18;
const int LED_VERTE = 19;
const int CANAL_ESPNOW = 1;
const int TIMEOUT_MS = 2000;

uint8_t rx[64];
unsigned long dernierMessage = 0;
bool dejaRecu = false;
int atemOk = 0;
int etatCam = 0;
int rougeActuel = -1;
int verteActuel = -1;
bool perduAvant = true;

void ecrire(int r, int v) {
  if (r != rougeActuel) { digitalWrite(LED_ROUGE, r); rougeActuel = r; }
  if (v != verteActuel) { digitalWrite(LED_VERTE, v); verteActuel = v; }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_ROUGE, OUTPUT);
  pinMode(LED_VERTE, OUTPUT);
  EspNow.begin(CANAL_ESPNOW);
  Serial.println("Lampe prête, caméra " + String(CAM) + ", canal " + String(CANAL_ESPNOW));
}

void loop() {
  int n = EspNow.receive(rx);
  while (n > 0) {
    if (n >= 6 && rx[0] == 0x54 && rx[1] == 0x4C && rx[2] == 1) {
      dernierMessage = millis();
      dejaRecu = true;
      atemOk = rx[4];
      etatCam = (CAM <= rx[5]) ? rx[5 + CAM] : 0;
    }
    n = EspNow.receive(rx);
  }
  bool perdu = !dejaRecu || millis() - dernierMessage > TIMEOUT_MS || atemOk == 0;
  if (perdu != perduAvant) {
    Serial.println(perdu ? "Liaison perdue : clignotement" : "Liaison OK");
    perduAvant = perdu;
  }
  if (perdu) {
    int phase = (millis() % 500) < 250 ? HIGH : LOW;   // 2 Hz
    ecrire(phase, phase);
  } else if (etatCam & 1) {
    ecrire(HIGH, LOW);      // programme : prioritaire
  } else if (etatCam & 2) {
    ecrire(LOW, HIGH);      // preview
  } else {
    ecrire(LOW, LOW);
  }
  delay(5);
}
`;

const LAMPES = [
  { n: 1, cam: 1, x: 2 },
  { n: 2, cam: 2, x: 26 },
  { n: 3, cam: 1, x: 50 },
  { n: 4, cam: 2, x: 74 },
];

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

  // --- ATEM (émulé par un ESP32) ---
  const ax = 24, ay = 4;
  comp("atem", "esp32", ax, ay, { drive: 2 }, { name: "ATEM (émulateur)", realBoard: "ATEM 2 M/E", code: SKETCH_ATEM });
  comp("atem_btn_c1_pvw", "button", 14, ay + 4, {}, { name: "CAM 1 PREV" });
  comp("atem_btn_c1_cut", "button", 14, ay + 8, {}, { name: "CAM 1 CUT" });
  comp("atem_btn_c2_pvw", "button", 14, ay + 12, {}, { name: "CAM 2 PREV" });
  comp("atem_btn_c2_cut", "button", ax + 12, ay + 5, {}, { name: "CAM 2 CUT" });
  comp("atem_gnd", "ground", 12, ay + 14);
  path([ax, ay + 7], [ax - 2, ay + 7], [ax - 2, ay + 4], [18, ay + 4]);    // GPIO32 -> CAM 1 PREV
  path([ax, ay + 8], [18, ay + 8]);                                        // GPIO4  -> CAM 1 CUT
  path([ax, ay + 9], [ax - 2, ay + 9], [ax - 2, ay + 12], [18, ay + 12]);  // GPIO5  -> CAM 2 PREV
  path([ax + 10, ay + 5], [ax + 12, ay + 5]);                              // GPIO18 -> CAM 2 CUT
  path([ax + 16, ay + 5], [ax + 17, ay + 5], [ax + 17, ay + 9], [ax + 10, ay + 9]); // CAM 2 CUT -> GND
  path([ax, ay + 5], [ax - 1, ay + 5], [ax - 1, ay + 2], [12, ay + 2], [12, ay + 14]); // GND -> masse
  for (const y of [ay + 4, ay + 8, ay + 12]) path([14, y], [12, y]);

  // --- Émetteur WT32-ETH01 ---
  const ex = 56, ey = ay;
  comp("emetteur", "esp32", ex, ey, { drive: 2 }, { name: "Émetteur", realBoard: "WT32-ETH01", code: SKETCH_EMETTEUR });
  comp("em_r_statut", "resistor", ex + 12, ey + 4, { R: 220, Pmax: 0.25 });
  comp("em_led_statut", "led", ex + 16, ey + 4, { color: "red" }, { name: "Statut ATEM" });
  comp("em_gnd", "ground", ex + 21, ey + 9);
  path([ex + 10, ey + 4], [ex + 12, ey + 4]);
  path([ex + 20, ey + 4], [ex + 21, ey + 4], [ex + 21, ey + 9]);
  path([ex + 10, ey + 9], [ex + 21, ey + 9]);

  // --- 4 lampes ESP32-C3 ---
  const ly = 25;
  for (const { n, cam, x: lx } of LAMPES) {
    const id = `lampe${n}`;
    comp(id, "esp32", lx, ly, { drive: 3 }, { name: `Lampe ${n} · CAM ${cam}`, realBoard: "ESP32-C3 Super Mini", code: sketchLampe(cam) });
    comp(`${id}_r_rouge`, "resistor", lx + 12, ly + 3, { R: 120, Pmax: 0.25 });
    comp(`${id}_led_rouge`, "led", lx + 16, ly + 3, { color: "red" }, { name: "Programme" });
    comp(`${id}_r_vert`, "resistor", lx + 12, ly + 8, { R: 47, Pmax: 0.25 });
    comp(`${id}_led_vert`, "led", lx + 16, ly + 8, { color: "green" }, { name: "Preview" });
    comp(`${id}_gnd`, "ground", lx + 21, ly + 11);
    path([lx + 10, ly + 5], [lx + 11, ly + 5], [lx + 11, ly + 3], [lx + 12, ly + 3]); // GPIO18 -> rouge
    path([lx + 10, ly + 6], [lx + 12, ly + 6], [lx + 12, ly + 8]);                   // GPIO19 -> vert
    path([lx + 20, ly + 3], [lx + 21, ly + 3], [lx + 21, ly + 11]);
    path([lx + 20, ly + 8], [lx + 21, ly + 8]);
    path([lx + 10, ly + 9], [lx + 11, ly + 9], [lx + 11, ly + 11], [lx + 21, ly + 11]);
  }

  const links = [
    { id: "l_eth", kind: "rj45", a: "atem", b: "emetteur", cut: false, note: "Câble RJ45 direct, protocole ATEM UDP 9910" },
    ...LAMPES.map(({ n }) => ({ id: `l_radio_${n}`, kind: "espnow", a: "emetteur", b: `lampe${n}`, cut: false, loss: 0 })),
  ];
  return { components, wires, links };
}

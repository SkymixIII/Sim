// ============================================================================
//  Émulateur de mélangeur ATEM (pour tester l'émetteur sans le vrai ATEM)
//  Carte : WT32-ETH01 (ESP32 + Ethernet LAN8720), comme l'émetteur
// ----------------------------------------------------------------------------
//  - Répond sur UDP 9910 comme un ATEM : poignée de main, état initial,
//    puis PrgI / PrvI / TlIn à chaque changement et toutes les 500 ms.
//  - 4 boutons (vers GND, INPUT_PULLUP) :
//      CAM 1 PREV, CAM 1 CUT, CAM 2 PREV, CAM 2 CUT
//    PREV X : preview = X (rien si X est déjà au programme)
//    CUT X  : programme = X ; si X était en preview, l'ancien programme passe en preview.
//    Anti-rebond 30 ms, action à l'appui (front descendant).
//  - État initial : programme = CAM 1, preview = CAM 2.
//
//  Seul un client à la fois (l'émetteur). Aucune bibliothèque externe.
//
//  Broches : sur l'établi, CAM 2 CUT est sur GPIO18. Sur une WT32-ETH01, GPIO18 est
//  le MDIO du PHY Ethernet : le bouton CAM 2 CUT passe donc sur GPIO14.
//  Simulation : même logique que le sketch « ATEM (émulateur) » du montage Tally de l'Établi.
// ============================================================================
#include <ETH.h>
#include <WiFiUdp.h>

// ---------- Réglages (repris du CSV) ----------
static const IPAddress IP_ATEM(192, 168, 10, 240);
static const IPAddress PASSERELLE(192, 168, 10, 1);
static const IPAddress MASQUE(255, 255, 255, 0);
static const uint16_t PORT_ATEM = 9910;

static const uint8_t BTN_C1_PVW = 32;
static const uint8_t BTN_C1_CUT = 4;
static const uint8_t BTN_C2_PVW = 5;
static const uint8_t BTN_C2_CUT = 14;      // GPIO18 sur l'établi, pris par l'Ethernet ici
static const uint8_t NB_ENTREES = 2;
static const uint32_t ANTI_REBOND_MS = 30;
static const uint32_t PERIODE_ETAT_MS = 500;
static const uint32_t TIMEOUT_CLIENT_MS = 3000;

// ---------- WT32-ETH01 : PHY LAN8720 ----------
static const int ETH_ADDR = 1;
static const int ETH_POWER = 16;
static const int ETH_MDC = 23;
static const int ETH_MDIO = 18;

// ---------- Protocole ATEM ----------
static const uint8_t F_ACK_DEMANDE = 0x08;
static const uint8_t F_HELLO = 0x10;
static const uint8_t F_ACK = 0x80;

WiFiUDP udp;
IPAddress ipClient;
uint16_t portClient = 0;

const uint8_t boutons[4] = {BTN_C1_PVW, BTN_C1_CUT, BTN_C2_PVW, BTN_C2_CUT};
uint8_t stable[4] = {HIGH, HIGH, HIGH, HIGH};
uint8_t dernierLu[4] = {HIGH, HIGH, HIGH, HIGH};
uint32_t changeA[4] = {0, 0, 0, 0};

uint8_t programme = 1;
uint8_t preview = 2;
bool aEnvoyer = true;

enum EtatSession { LIBRE, HELLO_RECU, CONNECTE };
EtatSession etatSession = LIBRE;
uint16_t sessionHello = 0, sessionId = 0, idLocal = 0;
uint32_t dernierClient = 0, dernierEnvoi = 0;

uint8_t rx[256];
uint8_t tx[256];

// ---------------------------------------------------------------------------
void afficherEtat() {
  Serial.printf("Programme : CAM %d · Preview : CAM %d\n", programme, preview);
}

void actionBouton(int b) {
  uint8_t cam = (b < 2) ? 1 : 2;
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
    uint8_t lu = digitalRead(boutons[b]);
    if (lu != dernierLu[b]) { dernierLu[b] = lu; changeA[b] = millis(); }
    if (millis() - changeA[b] >= ANTI_REBOND_MS && lu != stable[b]) {
      stable[b] = lu;
      if (lu == LOW) actionBouton(b);
    }
  }
}

void envoyer(int len) {
  udp.beginPacket(ipClient, portClient);
  udp.write(tx, len);
  udp.endPacket();
}

void entete(uint8_t drapeaux, int longueur, uint16_t session, uint16_t ackId, uint16_t id) {
  tx[0] = drapeaux | ((longueur >> 8) & 0x07);
  tx[1] = longueur & 0xFF;
  tx[2] = session >> 8; tx[3] = session & 0xFF;
  tx[4] = ackId >> 8;   tx[5] = ackId & 0xFF;
  tx[10] = id >> 8;     tx[11] = id & 0xFF;
}

// En-tête d'une commande : longueur (2), 2 octets nuls, nom ASCII (4). Renvoie la position des données.
int commande(int pos, int longueur, const char *nom) {
  tx[pos] = longueur >> 8; tx[pos + 1] = longueur & 0xFF;
  tx[pos + 2] = 0; tx[pos + 3] = 0;
  memcpy(&tx[pos + 4], nom, 4);
  return pos + 8;
}

void envoyerEtat(bool initial) {
  memset(tx, 0, sizeof(tx));
  int pos = 12, d;
  if (initial) {
    d = commande(pos, 12, "_ver");             // version de protocole 2.30
    tx[d + 1] = 2; tx[d + 3] = 30;
    pos += 12;
  }
  d = commande(pos, 12, "PrgI");               // programme du M/E 1
  tx[d + 3] = programme;
  pos += 12;
  d = commande(pos, 12, "PrvI");               // preview du M/E 1
  tx[d + 3] = preview;
  pos += 12;
  int lTally = 10 + NB_ENTREES;
  while (lTally % 4) lTally++;
  d = commande(pos, lTally, "TlIn");           // tally par entrée : bit 0 programme, bit 1 preview
  tx[d + 1] = NB_ENTREES;
  for (int i = 1; i <= NB_ENTREES; i++) {
    tx[d + 1 + i] = (i == programme ? 1 : 0) | (i == preview ? 2 : 0);
  }
  pos += lTally;
  if (initial) {
    commande(pos, 12, "InCm");                 // fin de l'état initial
    tx[pos + 8] = 1;
    pos += 12;
  }
  idLocal = (idLocal + 1) & 0x7FFF;
  entete(F_ACK_DEMANDE, pos, sessionId, 0, idLocal);
  envoyer(pos);
  dernierEnvoi = millis();
  aEnvoyer = false;
}

void traiterPaquet(int n) {
  uint8_t drapeaux = rx[0] & 0xF8;
  uint16_t session = (rx[2] << 8) | rx[3];
  if (drapeaux & F_HELLO) {
    if (n >= 13 && rx[12] == 0x01) {
      memset(tx, 0, 20);
      entete(F_HELLO, 20, session, 0, 0);
      tx[12] = 0x02;                           // connexion acceptée
      envoyer(20);
      sessionHello = session;
      etatSession = HELLO_RECU;
      dernierClient = millis();
    }
    return;
  }
  if (drapeaux & F_ACK) {
    dernierClient = millis();
    if (etatSession == HELLO_RECU) {
      etatSession = CONNECTE;
      sessionId = 0x8000 | (sessionHello & 0x7FFF);
      idLocal = 0;
      Serial.printf("Client %s connecté (session 0x%04X)\n", ipClient.toString().c_str(), sessionId);
      envoyerEtat(true);
    }
  }
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  for (int b = 0; b < 4; b++) pinMode(boutons[b], INPUT_PULLUP);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ETH.begin(ETH_PHY_LAN8720, ETH_ADDR, ETH_MDC, ETH_MDIO, ETH_POWER, ETH_CLOCK_GPIO0_IN);
#else
  ETH.begin(ETH_ADDR, ETH_POWER, ETH_MDC, ETH_MDIO, ETH_PHY_LAN8720, ETH_CLOCK_GPIO0_IN);
#endif
  ETH.config(IP_ATEM, PASSERELLE, MASQUE);
  udp.begin(PORT_ATEM);
  Serial.printf("Émulateur ATEM prêt, IP %s, port UDP %d\n", IP_ATEM.toString().c_str(), PORT_ATEM);
  afficherEtat();
}

void loop() {
  lireBoutons();

  int n = udp.parsePacket();
  while (n > 0) {
    int lu = udp.read(rx, sizeof(rx));
    if (lu >= 12) {
      ipClient = udp.remoteIP();
      portClient = udp.remotePort();
      traiterPaquet(lu);
    }
    n = udp.parsePacket();
  }

  if (etatSession == CONNECTE) {
    if (aEnvoyer || millis() - dernierEnvoi >= PERIODE_ETAT_MS) envoyerEtat(false);
    if (millis() - dernierClient > TIMEOUT_CLIENT_MS) {
      etatSession = LIBRE;
      Serial.println("Client perdu (plus d'accusé de réception)");
    }
  }
  delay(1);
}

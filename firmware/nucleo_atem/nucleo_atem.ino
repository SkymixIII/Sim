// ============================================================================
//  Lecteur de tally ATEM  ·  carte NUCLEO-H753ZI (RJ45 intégré)
// ----------------------------------------------------------------------------
//  - Se connecte à l'ATEM par le port RJ45 du Nucleo, en parlant le protocole
//    ATEM (UDP 9910) comme ATEM Software Control.
//  - Lit la commande TlIn (tally de toutes les M/E : bit 0 programme, bit 1 preview).
//  - Envoie le tally des caméras 1 à 8 à l'ESP32 émetteur par liaison série
//    (D1/PB6 = TX vers l'ESP32, D0/PB7 = RX), 10 fois par seconde.
//  - LED verte LD1 : connecté à l'ATEM. LED rouge LD3 : pas d'ATEM.
//  - Journal sur le port USB du ST-Link (moniteur série 115200 bauds).
//
//  Arduino IDE : gestionnaire de cartes « STM32 MCU based boards » (STMicroelectronics),
//  carte « Nucleo-144 », numéro de carte « Nucleo H753ZI » (ou « Nucleo H743ZI2 », même brochage),
//  méthode de téléversement « STM32CubeProgrammer (SWD) » ou « Mass Storage ».
//  Bibliothèques : « STM32duino LwIP » et « STM32duino STM32Ethernet ».
//
//  Liaison série vers l'ESP32 (trame de 12 octets) :
//    0xA5 0x5A | ATEM ok (0/1) | caméras 1 à 8 (bit 0 PGM, bit 1 PVW) | XOR des octets 2 à 10
// ============================================================================
#include <LwIP.h>
#include <STM32Ethernet.h>
#include <EthernetUdp.h>

// ---------- Réglages ----------
IPAddress IP_NUCLEO(192, 168, 2, 51);   // libre, dans le même réseau que l'ATEM
IPAddress IP_ATEM(192, 168, 2, 20);
static const uint16_t PORT_ATEM = 9910;
static const uint16_t PORT_LOCAL = 50910;
static const uint32_t PERIODE_ENVOI_MS = 100;
static const uint32_t TIMEOUT_ATEM_MS = 2000;
static const uint32_t RELANCE_HELLO_MS = 1000;
static const uint8_t  MAX_CAMS = 8;

Uart VersEsp32(PB7, PB6);               // RX = D0 (PB7), TX = D1 (PB6), comme le brochage Arduino du Nucleo


// ---------- Protocole ATEM ----------
static const uint8_t F_ACK_DEMANDE = 0x08;
static const uint8_t F_HELLO = 0x10;
static const uint8_t F_ACK = 0x80;

enum EtatAtem { DECONNECTE, HELLO_ENVOYE, CONNECTE };

EthernetUDP udp;
EtatAtem etat = DECONNECTE;
uint16_t sessionId = 0x53AB;
uint32_t dernierRecu = 0, dernierHello = 0, dernierEnvoi = 0;
uint16_t nbEntrees = 0;
uint8_t tally[MAX_CAMS] = {0};
uint8_t rx[1500];
uint8_t tx[64];
void envoyerEsp32();

void envoyerUdp(const uint8_t *buf, size_t len) {
  udp.beginPacket(IP_ATEM, PORT_ATEM);
  udp.write(buf, len);
  udp.endPacket();
}

void envoyerHello() {
  memset(tx, 0, 20);
  sessionId = 0x5300 | (random(256) & 0xFF);
  tx[0] = F_HELLO; tx[1] = 20;
  tx[2] = sessionId >> 8; tx[3] = sessionId & 0xFF;
  tx[9] = 0x3A;
  tx[12] = 0x01;
  envoyerUdp(tx, 20);
  etat = HELLO_ENVOYE;
  dernierHello = millis();
}

void envoyerAck(uint16_t session, uint16_t id) {
  memset(tx, 0, 12);
  tx[0] = F_ACK; tx[1] = 12;
  tx[2] = session >> 8; tx[3] = session & 0xFF;
  tx[4] = id >> 8; tx[5] = id & 0xFF;
  envoyerUdp(tx, 12);
}

void lireTally(int p, int fin) {
  if (p + 2 > fin) return;
  uint16_t nb = (rx[p] << 8) | rx[p + 1];
  bool change = (nb != nbEntrees);
  nbEntrees = nb;
  for (int k = 0; k < MAX_CAMS; k++) {
    uint8_t f = (k < nb && p + 2 + k < fin) ? (rx[p + 2 + k] & 0x03) : 0;
    if (f != tally[k]) change = true;
    tally[k] = f;
  }
  if (change) {
    Serial.print("Tally ATEM :");
    for (int k = 0; k < MAX_CAMS && k < nb; k++) {
      Serial.print(' ');
      Serial.print(k + 1);
      Serial.print((tally[k] & 1) ? ":PGM" : (tally[k] & 2) ? ":PVW" : ":-");
    }
    Serial.println();
    envoyerEsp32();   // tout de suite, sans attendre les 100 ms
  }
}

void traiterPaquet(int n) {
  if (n < 12) return;
  uint8_t drapeaux = rx[0] & 0xF8;
  int longueur = ((rx[0] & 0x07) << 8) | rx[1];
  if (longueur < 12 || longueur > n) return;
  uint16_t session = (rx[2] << 8) | rx[3];
  uint16_t idDistant = (rx[10] << 8) | rx[11];

  if (drapeaux & F_HELLO) {
    if (longueur >= 13 && rx[12] == 0x02) {
      envoyerAck(session, 0);
      etat = CONNECTE;
      dernierRecu = millis();
      Serial.println("Connecté à l'ATEM");
    } else if (longueur >= 13 && rx[12] == 0x03) {
      Serial.println("L'ATEM refuse la connexion (trop de clients ?)");
    }
    return;
  }
  if (etat != CONNECTE) return;
  dernierRecu = millis();
  sessionId = session;
  if (drapeaux & F_ACK_DEMANDE) envoyerAck(session, idDistant);

  int i = 12;
  while (i + 8 <= longueur) {
    int l = (rx[i] << 8) | rx[i + 1];
    if (l < 8 || i + l > longueur) break;
    if (memcmp(&rx[i + 4], "TlIn", 4) == 0) lireTally(i + 8, i + l);
    i += l;
  }
}

void envoyerEsp32() {
  uint8_t m[12];
  m[0] = 0xA5; m[1] = 0x5A;
  m[2] = (etat == CONNECTE) ? 1 : 0;
  for (int k = 0; k < MAX_CAMS; k++) m[3 + k] = (etat == CONNECTE) ? tally[k] : 0;
  uint8_t x = 0;
  for (int k = 2; k <= 10; k++) x ^= m[k];
  m[11] = x;
  VersEsp32.write(m, sizeof(m));
  dernierEnvoi = millis();
}

void setup() {
  Serial.begin(115200);
  VersEsp32.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  digitalWrite(LED_RED, HIGH);
  randomSeed(micros());
  Ethernet.begin(IP_NUCLEO);
  udp.begin(PORT_LOCAL);
  Serial.print("Nucleo prêt, IP ");
  Serial.print(Ethernet.localIP());
  Serial.print(" -> ATEM ");
  Serial.println(IP_ATEM);
}

void loop() {
  Ethernet.schedule();   // fait tourner la pile réseau LwIP

  if (etat != CONNECTE && millis() - dernierHello >= RELANCE_HELLO_MS) envoyerHello();

  int n = udp.parsePacket();
  while (n > 0) {
    int lu = udp.read(rx, sizeof(rx));
    if (udp.remoteIP() == IP_ATEM) traiterPaquet(lu);
    n = udp.parsePacket();
  }

  if (etat == CONNECTE && millis() - dernierRecu > TIMEOUT_ATEM_MS) {
    etat = DECONNECTE;
    memset(tally, 0, sizeof(tally));
    Serial.println("ATEM perdu, nouvelle tentative...");
  }

  digitalWrite(LED_BUILTIN, etat == CONNECTE ? HIGH : LOW);
  digitalWrite(LED_RED, etat == CONNECTE ? LOW : HIGH);

  if (millis() - dernierEnvoi >= PERIODE_ENVOI_MS) envoyerEsp32();
}

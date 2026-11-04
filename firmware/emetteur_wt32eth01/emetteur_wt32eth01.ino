// ============================================================================
//  Émetteur tally ATEM -> ESP-NOW  ·  carte WT32-ETH01 (ESP32 + LAN8720)
// ----------------------------------------------------------------------------
//  - Se connecte au mélangeur ATEM par le port RJ45 (câble direct, IP fixes),
//    en parlant le protocole ATEM (UDP 9910) comme ATEM Software Control.
//  - Lit la commande TlIn (tally par entrée : bit 0 = programme, bit 1 = preview).
//  - Rediffuse l'état des 8 caméras en ESP-NOW, 10 fois par seconde.
//  - Acquitte chaque paquet de l'ATEM (sinon il les renvoie puis coupe la session)
//    et se reconnecte seul si l'ATEM ne dit plus rien pendant 2 s.
//  - LED statut sur GPIO2 : allumée = pas connecté à l'ATEM, éteinte = connecté.
//
//  Aucune bibliothèque externe : uniquement le core Arduino ESP32 (2.x ou 3.x).
//  Carte à choisir dans l'IDE : « ESP32 Dev Module » (ou « WT32-ETH01 Ethernet Module »).
//  Simulation : même logique que le sketch « Émetteur » du montage Tally de l'Établi.
// ============================================================================
#include <ETH.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ---------- Réglages (repris du CSV) ----------
static const IPAddress IP_EMETTEUR(192, 168, 10, 50);
static const IPAddress IP_ATEM(192, 168, 10, 240);
static const IPAddress PASSERELLE(192, 168, 10, 1);   // inutilisée en câble direct, mais requise
static const IPAddress MASQUE(255, 255, 255, 0);
static const uint16_t PORT_ATEM = 9910;
static const uint16_t PORT_LOCAL = 50910;              // port source quelconque

static const uint8_t  CANAL_ESPNOW = 1;                // identique sur les lampes
static const uint32_t PERIODE_RADIO_MS = 100;          // 10 Hz
static const uint32_t TIMEOUT_ATEM_MS = 2000;
static const uint32_t RELANCE_HELLO_MS = 1000;
static const uint8_t  LED_STATUT = 2;
static const uint8_t  MAX_CAMS = 8;                    // caméras transmises (entrées 1 à 8 de l'ATEM)
static const uint8_t  TTL_MAX = 6;                     // relais maximum dans le maillage (lampes et antennes)

// ---------- WT32-ETH01 : PHY LAN8720 ----------
static const int ETH_ADDR = 1;
static const int ETH_POWER = 16;   // active l'oscillateur 50 MHz du PHY
static const int ETH_MDC = 23;
static const int ETH_MDIO = 18;

// ---------- Protocole ATEM ----------
// En-tête de 12 octets : [0] drapeaux(5 bits) | longueur(11 bits) [2-3] session
// [4-5] id acquitté  [10-11] id du paquet de l'expéditeur.
static const uint8_t F_ACK_DEMANDE = 0x08;
static const uint8_t F_HELLO = 0x10;
static const uint8_t F_ACK = 0x80;

enum EtatAtem { DECONNECTE, HELLO_ENVOYE, CONNECTE };

WiFiUDP udp;
EtatAtem etat = DECONNECTE;
uint16_t sessionId = 0x53AB;
uint32_t dernierRecu = 0, dernierHello = 0, dernierRadio = 0;
uint8_t seq = 0;
uint16_t nbEntrees = 0;
uint8_t tally[MAX_CAMS] = {0};
uint8_t rx[1500];
uint8_t tx[64];
int ledActuelle = -1;

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------------------------------------------------------------------------
void envoyerUdp(const uint8_t *buf, size_t len) {
  udp.beginPacket(IP_ATEM, PORT_ATEM);
  udp.write(buf, len);
  udp.endPacket();
}

void envoyerHello() {
  memset(tx, 0, 20);
  sessionId = 0x5300 | (esp_random() & 0xFF);
  tx[0] = F_HELLO; tx[1] = 20;
  tx[2] = sessionId >> 8; tx[3] = sessionId & 0xFF;
  tx[9] = 0x3A;
  tx[12] = 0x01;                       // demande de connexion
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
      Serial.printf(" %d:%s", k + 1, (tally[k] & 1) ? "PGM" : (tally[k] & 2) ? "PVW" : "-");
    }
    Serial.println();
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
    if (longueur >= 13 && rx[12] == 0x02) {        // connexion acceptée
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
  sessionId = session;                              // l'ATEM attribue sa session après le hello
  if (drapeaux & F_ACK_DEMANDE) envoyerAck(session, idDistant);

  int i = 12;
  while (i + 8 <= longueur) {
    int l = (rx[i] << 8) | rx[i + 1];
    if (l < 8 || i + l > longueur) break;
    if (memcmp(&rx[i + 4], "TlIn", 4) == 0) lireTally(i + 8, i + l);
    i += l;
  }
}

// Trame tally ESP-NOW v2 (8 + MAX_CAMS = 16 octets) :
//   'T' 'L' | version=2 | numéro | ATEM ok (0/1) | nb caméras | TTL | sauts | 1 octet par caméra
//   (bit 0 = programme, bit 1 = preview). Les lampes relaient la trame tant que TTL > 1.
void diffuser() {
  uint8_t m[8 + MAX_CAMS];
  m[0] = 'T'; m[1] = 'L'; m[2] = 2;
  m[3] = seq++;
  m[4] = (etat == CONNECTE) ? 1 : 0;
  m[5] = MAX_CAMS;
  m[6] = TTL_MAX;
  m[7] = 0;
  for (int k = 0; k < MAX_CAMS; k++) m[8 + k] = (etat == CONNECTE) ? tally[k] : 0;
  esp_now_send(BROADCAST, m, sizeof(m));
  dernierRadio = millis();
}

void demarrerEspNow() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(CANAL_ESPNOW, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  if (esp_now_init() != ESP_OK) {
    Serial.println("Erreur esp_now_init");
    return;
  }
  esp_now_peer_info_t pair = {};
  memcpy(pair.peer_addr, BROADCAST, 6);
  pair.channel = CANAL_ESPNOW;
  pair.ifidx = WIFI_IF_STA;
  pair.encrypt = false;
  if (esp_now_add_peer(&pair) != ESP_OK) Serial.println("Erreur esp_now_add_peer");
}

void demarrerEthernet() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ETH.begin(ETH_PHY_LAN8720, ETH_ADDR, ETH_MDC, ETH_MDIO, ETH_POWER, ETH_CLOCK_GPIO0_IN);
#else
  ETH.begin(ETH_ADDR, ETH_POWER, ETH_MDC, ETH_MDIO, ETH_PHY_LAN8720, ETH_CLOCK_GPIO0_IN);
#endif
  ETH.config(IP_EMETTEUR, PASSERELLE, MASQUE);
  udp.begin(PORT_LOCAL);
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUT, OUTPUT);
  digitalWrite(LED_STATUT, HIGH);
  demarrerEthernet();
  demarrerEspNow();
  Serial.printf("Émetteur prêt, IP %s -> ATEM %s, ESP-NOW canal %d\n",
                IP_EMETTEUR.toString().c_str(), IP_ATEM.toString().c_str(), CANAL_ESPNOW);
}

void loop() {
  if (etat != CONNECTE && ETH.linkUp() && millis() - dernierHello >= RELANCE_HELLO_MS) envoyerHello();

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

  int led = (etat == CONNECTE) ? LOW : HIGH;   // allumée = pas connecté à l'ATEM
  if (led != ledActuelle) { digitalWrite(LED_STATUT, led); ledActuelle = led; }

  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
  delay(1);
}

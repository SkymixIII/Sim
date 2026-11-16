// ============================================================================
//  Émetteur tally ATEM -> ESP-NOW  ·  ESP32 DevKit V1 + module Ethernet W5500
// ----------------------------------------------------------------------------
//  Version RJ45 seulement : l'ESP32 parle lui-même à l'ATEM (UDP 9910) par le
//  câble réseau, lit le tally et le diffuse en ESP-NOW (trame v2) aux tallys
//  et aux antennes, 10 fois par seconde et aussitôt qu'il change.
//  LED bleue de la carte (D2) : allumée = pas connecté à l'ATEM.
//
//  Câblage W5500 -> ESP32 DevKit V1 :
//     SCK  -> D18      MISO -> D19      MOSI -> D23      CS (SCS) -> D5
//     RST  -> EN (ou non branché)       VCC  -> 3V3      GND -> GND
//  (Module W5500 « Lite » ou « mini » : alimenté en 3,3 V, pas en 5 V.)
//
//  Bibliothèque : « Ethernet » (Arduino), à installer dans le gestionnaire.
//  Carte dans l'IDE : « ESP32 Dev Module ».  Moniteur série : 115200 bauds.
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>

// ---------- Réglages ----------
static const uint8_t  IP_ATEM[4] = {192, 168, 2, 20};
static const uint8_t  IP_EMETTEUR[4] = {192, 168, 2, 52};  // adresse de l'ESP32 : doit être libre sur le réseau
static const uint8_t  MASQUE[4] = {255, 255, 255, 0};
static const uint16_t PORT_ATEM = 9910;
static const uint16_t PORT_LOCAL = 50910;
static const uint8_t  SUIVRE_ME = 0;        // 0 : tally général de l'ATEM ; 1 ou 2 : suit cette M/E
static const uint8_t  CANAL_ESPNOW = 1;
static const uint32_t PERIODE_RADIO_MS = 100;
static const uint32_t TIMEOUT_ATEM_MS = 2500;
static const uint32_t RELANCE_HELLO_MS = 1000;
static const uint8_t  MAX_CAMS = 8;
static const uint8_t  TTL_MAX = 6;
static const int      LED_STATUT = 2;
static const int      CS_W5500 = 5;

// ---------- Protocole ATEM ----------
static const uint8_t F_ACK_DEMANDE = 0x08;
static const uint8_t F_HELLO = 0x10;
static const uint8_t F_ACK = 0x80;
enum EtatAtem { DECONNECTE, HELLO_ENVOYE, CONNECTE };

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

EtatAtem etat = DECONNECTE;
uint16_t sessionId = 0x53AB;
uint32_t dernierRecu = 0, dernierHello = 0, dernierRadio = 0, dernierLien = 0;
uint8_t seq = 0;
uint16_t nbEntrees = 0;
uint8_t tally[MAX_CAMS] = {0};
uint16_t prg[2] = {0, 0}, prv[2] = {0, 0};
uint8_t rx[1600];
uint8_t tx[32];
int ledActuelle = -1;

EthernetUDP udp;
bool cableBranche = false;

// ---------------------------------------------------------------------------
//  Envoi d'un paquet UDP vers l'ATEM
// ---------------------------------------------------------------------------
void envoyerUdp(const uint8_t *buf, uint16_t len) {
  udp.beginPacket(IPAddress(IP_ATEM[0], IP_ATEM[1], IP_ATEM[2], IP_ATEM[3]), PORT_ATEM);
  udp.write(buf, len);
  udp.endPacket();
}

void diffuser();

// ---------------------------------------------------------------------------
//  Client ATEM
// ---------------------------------------------------------------------------
void envoyerHello() {
  memset(tx, 0, 20);
  sessionId = 0x5300 | (esp_random() & 0xFF);
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

void afficherTally() {
  Serial.print("Tally :");
  for (int k = 0; k < MAX_CAMS; k++) Serial.printf(" %d:%s", k + 1, (tally[k] & 1) ? "PGM" : (tally[k] & 2) ? "PVW" : "-");
  Serial.println();
}

void changerTally(const uint8_t *nouveau) {
  if (memcmp(nouveau, tally, MAX_CAMS) == 0) return;
  memcpy(tally, nouveau, MAX_CAMS);
  afficherTally();
  diffuser();                                  // tout de suite, sans attendre
}

void lireTally(int p, int fin) {
  if (SUIVRE_ME != 0 || p + 2 > fin) return;
  uint16_t nb = (rx[p] << 8) | rx[p + 1];
  nbEntrees = nb;
  uint8_t n[MAX_CAMS];
  for (int k = 0; k < MAX_CAMS; k++) n[k] = (k < nb && p + 2 + k < fin) ? (rx[p + 2 + k] & 0x03) : 0;
  changerTally(n);
}

void lireSource(bool programme, int p, int fin) {
  if (p + 4 > fin) return;
  uint8_t me = rx[p];
  uint16_t src = (rx[p + 2] << 8) | rx[p + 3];
  if (me > 1) return;
  if (programme) prg[me] = src; else prv[me] = src;
  Serial.printf("M/E %d : PGM %d / PVW %d\n", me + 1, prg[me], prv[me]);
  if (SUIVRE_ME == me + 1) {
    uint8_t n[MAX_CAMS];
    for (int k = 0; k < MAX_CAMS; k++) n[k] = (prg[me] == k + 1 ? 1 : 0) | (prv[me] == k + 1 ? 2 : 0);
    changerTally(n);
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
    else if (memcmp(&rx[i + 4], "PrgI", 4) == 0) lireSource(true, i + 8, i + l);
    else if (memcmp(&rx[i + 4], "PrvI", 4) == 0) lireSource(false, i + 8, i + l);
    i += l;
  }
}

// ---------------------------------------------------------------------------
//  Câble réseau
// ---------------------------------------------------------------------------
void surveillerCable() {
  bool b = Ethernet.linkStatus() != LinkOFF;   // « inconnu » compte comme branché
  if (b == cableBranche) return;
  cableBranche = b;
  etat = DECONNECTE;
  dernierHello = 0;
  memset(tally, 0, sizeof(tally));
  Serial.println(b ? "Câble réseau branché" : "Câble réseau débranché !");
}

// ---------------------------------------------------------------------------
//  ESP-NOW : trame v2 de 16 octets
// ---------------------------------------------------------------------------
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
  if (esp_now_init() != ESP_OK) { Serial.println("Erreur esp_now_init"); return; }
  esp_now_peer_info_t pair = {};
  memcpy(pair.peer_addr, BROADCAST, 6);
  pair.channel = CANAL_ESPNOW;
  pair.ifidx = WIFI_IF_STA;
  pair.encrypt = false;
  if (esp_now_add_peer(&pair) != ESP_OK) Serial.println("Erreur esp_now_add_peer");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUT, OUTPUT);
  digitalWrite(LED_STATUT, HIGH);
  demarrerEspNow();

  Ethernet.init(CS_W5500);
  uint8_t mac[6];
  WiFi.macAddress(mac);
  mac[0] = 0x02;                               // adresse MAC locale, dérivée de celle de l'ESP32
  IPAddress ip(IP_EMETTEUR[0], IP_EMETTEUR[1], IP_EMETTEUR[2], IP_EMETTEUR[3]);
  IPAddress masque(MASQUE[0], MASQUE[1], MASQUE[2], MASQUE[3]);
  IPAddress routeur(IP_EMETTEUR[0], IP_EMETTEUR[1], IP_EMETTEUR[2], 1);
  Ethernet.begin(mac, ip, routeur, routeur, masque);   // IP fixe (pas de DHCP)
  while (Ethernet.hardwareStatus() == EthernetNoHardware) {
    Serial.println("Module W5500 introuvable : vérifiez SCK D18, MISO D19, MOSI D23, CS D5, 3V3, GND");
    for (int i = 0; i < 10; i++) { digitalWrite(LED_STATUT, i & 1); delay(100); }
  }
  udp.begin(PORT_LOCAL);
  Serial.printf("W5500 OK, ESP32 en %d.%d.%d.%d\n", IP_EMETTEUR[0], IP_EMETTEUR[1], IP_EMETTEUR[2], IP_EMETTEUR[3]);
  surveillerCable();
  Serial.printf("Émetteur prêt, ATEM %d.%d.%d.%d, ESP-NOW canal %d, %s\n", IP_ATEM[0], IP_ATEM[1], IP_ATEM[2], IP_ATEM[3],
                CANAL_ESPNOW, SUIVRE_ME ? "suit une M/E" : "tally général");
}

void loop() {
  if (millis() - dernierLien >= 1000) { surveillerCable(); dernierLien = millis(); }

  // Paquets de l'ATEM (au plus 20 par tour pour garder la radio régulière)
  for (int k = 0; k < 20; k++) {
    int n = udp.parsePacket();
    if (n <= 0) break;
    int lu = udp.read(rx, sizeof(rx));
    IPAddress ip = udp.remoteIP();
    if (ip[0] == IP_ATEM[0] && ip[1] == IP_ATEM[1] && ip[2] == IP_ATEM[2] && ip[3] == IP_ATEM[3]) traiterPaquet(lu);
  }

  if (cableBranche && etat != CONNECTE && millis() - dernierHello >= RELANCE_HELLO_MS) envoyerHello();
  if (etat == CONNECTE && millis() - dernierRecu > TIMEOUT_ATEM_MS) {
    etat = DECONNECTE;
    memset(tally, 0, sizeof(tally));
    Serial.println("ATEM perdu, nouvelle tentative...");
  }

  int led = (etat == CONNECTE) ? LOW : HIGH;
  if (led != ledActuelle) { digitalWrite(LED_STATUT, led); ledActuelle = led; }
  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
}

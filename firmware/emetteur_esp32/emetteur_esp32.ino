// ============================================================================
//  Émetteur tally ATEM -> ESP-NOW  ·  ESP32 DevKit V1
// ----------------------------------------------------------------------------
//  L'ESP32 parle lui-même le protocole ATEM (UDP 9910) et lit le tally.
//  Deux chemins réseau, choisis automatiquement :
//    1. RJ45 : module W5500 sur le bus SPI (si présent et câble branché).
//    2. USB  : le PC relaie simplement les paquets UDP entre l'ATEM et l'ESP32
//              (script pont_usb_atem.py, qui ne connaît pas le protocole ATEM).
//  Le tally est diffusé en ESP-NOW (trame v2) aux tallys et antennes, 10 fois/s.
//  LED bleue de la carte (D2) : allumée = pas connecté à l'ATEM.
//
//  Câblage W5500 (facultatif) : SCK -> D18, MISO -> D19, MOSI -> D23, CS -> D5,
//                               3V3 -> 3V3, GND -> GND.
//  Bibliothèque : « Ethernet » (Arduino), seulement si UTILISER_W5500 vaut 1.
//  Carte dans l'IDE : « ESP32 Dev Module ».
//
//  Trame USB (dans les deux sens) :
//    0xA5 0x5A | IP (4) | port (2) | longueur (2) | paquet UDP | XOR des octets 2 à la fin
//  ESP32 -> PC : paquet à envoyer à IP:port.  PC -> ESP32 : paquet reçu de IP:port.
//  Le Moniteur série doit être fermé quand le script tourne (vitesse 460800 bauds).
// ============================================================================
#define UTILISER_W5500 1        // 0 si vous n'avez pas de module W5500

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#if UTILISER_W5500
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#endif

// ---------- Réglages ----------
static const uint8_t  IP_ATEM[4] = {192, 168, 2, 20};
static const uint8_t  IP_EMETTEUR[4] = {192, 168, 2, 52};  // adresse du W5500 (libre sur le réseau)
static const uint16_t PORT_ATEM = 9910;
static const uint16_t PORT_LOCAL = 50910;
static const uint8_t  SUIVRE_ME = 0;        // 0 : tally général de l'ATEM ; 1 ou 2 : suit cette M/E
static const uint8_t  CANAL_ESPNOW = 1;
static const uint32_t VITESSE_USB = 460800;    // identique dans pont_usb_atem.py
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
enum Chemin { AUCUN, RJ45, USB };

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

EtatAtem etat = DECONNECTE;
Chemin chemin = AUCUN;
uint16_t sessionId = 0x53AB;
uint32_t dernierRecu = 0, dernierHello = 0, dernierRadio = 0, dernierLien = 0;
uint8_t seq = 0;
uint16_t nbEntrees = 0;
uint8_t tally[MAX_CAMS] = {0};
uint16_t prg[2] = {0, 0}, prv[2] = {0, 0};
uint8_t rx[1600];
uint8_t tx[32];
int ledActuelle = -1;

#if UTILISER_W5500
EthernetUDP udp;
bool w5500Present = false;
#endif

// Réception USB : automate de lecture des trames A5 5A ...
uint8_t usbBuf[1700];
int usbPos = 0;
uint16_t usbLen = 0;
uint32_t dernierUsb = 0;
volatile uint32_t usbTramesOk = 0, usbTramesAbimees = 0, usbDebordements = 0, usbErreursLigne = 0;
uint32_t dernierBilanUsb = 0;

void traiterPaquet(int n);
void diffuser();

// ---------------------------------------------------------------------------
//  Envoi d'un paquet UDP vers l'ATEM, par le chemin actif
// ---------------------------------------------------------------------------
void envoyerUdp(const uint8_t *buf, uint16_t len) {
#if UTILISER_W5500
  if (chemin == RJ45) {
    udp.beginPacket(IPAddress(IP_ATEM[0], IP_ATEM[1], IP_ATEM[2], IP_ATEM[3]), PORT_ATEM);
    udp.write(buf, len);
    udp.endPacket();
    return;
  }
#endif
  // USB : trame vers le PC, qui l'envoie à IP_ATEM:PORT_ATEM
  uint8_t h[10] = {0xA5, 0x5A, IP_ATEM[0], IP_ATEM[1], IP_ATEM[2], IP_ATEM[3],
                   (uint8_t)(PORT_ATEM >> 8), (uint8_t)(PORT_ATEM & 0xFF),
                   (uint8_t)(len >> 8), (uint8_t)(len & 0xFF)};
  uint8_t x = 0;
  for (int i = 2; i < 10; i++) x ^= h[i];
  for (int i = 0; i < len; i++) x ^= buf[i];
  Serial.write(h, 10);
  Serial.write(buf, len);
  Serial.write(&x, 1);
}

void lireUsb() {
  // Au plus 2 Ko par tour de loop() : la radio et les délais continuent de tourner
  // même quand l'USB est saturé.
  int budget = 2048;
  while (budget-- > 0 && Serial.available()) {
    uint8_t c = Serial.read();
    if (usbPos == 0) { if (c == 0xA5) usbBuf[usbPos++] = c; continue; }
    if (usbPos == 1) { if (c == 0x5A) usbBuf[usbPos++] = c; else usbPos = (c == 0xA5) ? 1 : 0; continue; }
    usbBuf[usbPos++] = c;
    if (usbPos == 10) {
      usbLen = (usbBuf[8] << 8) | usbBuf[9];
      if (usbLen > sizeof(rx)) { usbPos = 0; continue; }   // trame impossible
    }
    if (usbPos >= 10 && usbPos == 10 + usbLen + 1) {
      uint8_t x = 0;
      for (int i = 2; i < usbPos - 1; i++) x ^= usbBuf[i];
      bool okIp = memcmp(&usbBuf[2], IP_ATEM, 4) == 0;
      usbPos = 0;
      if (x != usbBuf[10 + usbLen]) { usbTramesAbimees++; continue; }   // trame abîmée
      usbTramesOk++;
      dernierUsb = millis();
      if (chemin == USB && okIp) {
        memcpy(rx, &usbBuf[10], usbLen);
        traiterPaquet(usbLen);
      }
    }
  }
}

#if defined(ESP_ARDUINO_VERSION_VAL)
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(2, 0, 6)
void surErreurUsb(hardwareSerial_error_t e) {
  if (e == UART_BUFFER_FULL_ERROR || e == UART_FIFO_OVF_ERROR) usbDebordements++;
  else usbErreursLigne++;
}
#define AVEC_ERREURS_USB 1
#endif
#endif

void bilanUsb() {
  if (millis() - dernierBilanUsb < 5000) return;
  dernierBilanUsb = millis();
  if (chemin != USB || (usbTramesOk == 0 && usbTramesAbimees == 0)) return;
  Serial.printf("USB : %lu trames OK, %lu abîmées, %lu débordements, %lu erreurs de ligne (5 s)\n",
                (unsigned long)usbTramesOk, (unsigned long)usbTramesAbimees,
                (unsigned long)usbDebordements, (unsigned long)usbErreursLigne);
  usbTramesOk = usbTramesAbimees = usbDebordements = usbErreursLigne = 0;
}

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
      Serial.printf("Connecté à l'ATEM par %s\n", chemin == RJ45 ? "le RJ45" : "l'USB");
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
//  Choix du chemin : RJ45 si le W5500 est là et le câble branché, sinon USB
// ---------------------------------------------------------------------------
void choisirChemin() {
  Chemin c = USB;
#if UTILISER_W5500
  if (w5500Present && Ethernet.linkStatus() == LinkON) c = RJ45;
#endif
  if (c != chemin) {
    chemin = c;
    etat = DECONNECTE;                         // nouvelle poignée de main sur le nouveau chemin
    dernierHello = 0;
    Serial.println(c == RJ45 ? "Chemin : RJ45 (W5500)" : "Chemin : USB (script pont_usb_atem.py sur le PC)");
  }
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
  Serial.setRxBufferSize(8192);                // les paquets ATEM arrivent vite par l'USB
  Serial.begin(VITESSE_USB);
#ifdef AVEC_ERREURS_USB
  Serial.onReceiveError(surErreurUsb);
#endif
  pinMode(LED_STATUT, OUTPUT);
  digitalWrite(LED_STATUT, HIGH);
  demarrerEspNow();
#if UTILISER_W5500
  Ethernet.init(CS_W5500);
  uint8_t mac[6];
  WiFi.macAddress(mac);
  mac[0] = 0x02;                               // adresse MAC locale, dérivée de celle de l'ESP32
  Ethernet.begin(mac, IPAddress(IP_EMETTEUR[0], IP_EMETTEUR[1], IP_EMETTEUR[2], IP_EMETTEUR[3]));
  w5500Present = Ethernet.hardwareStatus() != EthernetNoHardware;
  if (w5500Present) udp.begin(PORT_LOCAL);
  Serial.println(w5500Present ? "Module W5500 détecté" : "Pas de module W5500 : USB seulement");
#endif
  choisirChemin();
  Serial.printf("Émetteur prêt, ATEM %d.%d.%d.%d, ESP-NOW canal %d, %s\n", IP_ATEM[0], IP_ATEM[1], IP_ATEM[2], IP_ATEM[3],
                CANAL_ESPNOW, SUIVRE_ME ? "suit une M/E" : "tally général");
}

void loop() {
  if (millis() - dernierLien >= 1000) { choisirChemin(); dernierLien = millis(); }

  lireUsb();
  bilanUsb();
#if UTILISER_W5500
  if (chemin == RJ45) {
    int n = udp.parsePacket();
    while (n > 0) {
      int lu = udp.read(rx, sizeof(rx));
      IPAddress ip = udp.remoteIP();
      if (ip[0] == IP_ATEM[0] && ip[1] == IP_ATEM[1] && ip[2] == IP_ATEM[2] && ip[3] == IP_ATEM[3]) traiterPaquet(lu);
      n = udp.parsePacket();
    }
  }
#endif

  if (etat != CONNECTE && millis() - dernierHello >= RELANCE_HELLO_MS) envoyerHello();
  if (etat == CONNECTE && millis() - dernierRecu > TIMEOUT_ATEM_MS) {
    etat = DECONNECTE;
    memset(tally, 0, sizeof(tally));
    Serial.println("ATEM perdu, nouvelle tentative...");
  }

  int led = (etat == CONNECTE) ? LOW : HIGH;
  if (led != ledActuelle) { digitalWrite(LED_STATUT, led); ledActuelle = led; }
  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
}

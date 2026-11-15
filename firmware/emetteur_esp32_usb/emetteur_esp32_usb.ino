// ============================================================================
//  Émetteur tally ESP-NOW  ·  ESP32 DevKit V1 branché en USB sur le Mac
// ----------------------------------------------------------------------------
//  - Le Mac lit l'ATEM par son RJ45 (script atem_vers_esp32.py) et envoie le
//    tally à l'ESP32 par le câble USB (port série, 115200 bauds).
//  - L'ESP32 le diffuse en ESP-NOW (trame v2 de 16 octets), 10 fois par seconde,
//    aux tallys et aux antennes : leur code ne change pas.
//  - Si le Mac ne dit plus rien pendant 1 s, ou s'il a perdu l'ATEM, la trame
//    part avec « ATEM ok = 0 » : les tallys passent en bleu clignotant.
//  - LED bleue de la carte (D2) : allumée = pas d'ATEM (ou script arrêté).
//
//  Trame reçue du Mac (12 octets) :
//    0xA5 0x5A | ATEM ok | caméras 1 à 8 (bit 0 PGM, bit 1 PVW) | XOR des octets 2 à 10
//  Le Moniteur série d'Arduino IDE doit être FERMÉ : c'est le script qui utilise le port.
//  Aucune bibliothèque externe. Carte dans l'IDE : « ESP32 Dev Module ».
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

static const uint8_t  CANAL_ESPNOW = 1;      // identique sur toutes les lampes et antennes
static const uint32_t PERIODE_RADIO_MS = 100;
static const uint32_t TIMEOUT_MAC_MS = 1000;
static const uint8_t  MAX_CAMS = 8;
static const uint8_t  TTL_MAX = 6;
static const int      LED_STATUT = 2;

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

uint8_t tally[MAX_CAMS] = {0};
uint8_t atemOk = 0;
uint32_t dernierMac = 0, dernierRadio = 0;
uint8_t seq = 0;
uint8_t buf[12];
void diffuser();
int pos = 0;
bool macVu = false;
int etatAvant = -1;

// Lit les octets envoyés par le Mac et reconnaît les trames complètes
void lireMac() {
  while (Serial.available()) {
    uint8_t c = Serial.read();
    if (pos == 0 && c != 0xA5) continue;
    if (pos == 1 && c != 0x5A) { pos = (c == 0xA5) ? 1 : 0; continue; }
    buf[pos++] = c;
    if (pos < 12) continue;
    pos = 0;
    uint8_t x = 0;
    for (int k = 2; k <= 10; k++) x ^= buf[k];
    if (x != buf[11]) continue;                   // trame abîmée
    atemOk = buf[2];
    bool change = false;
    for (int k = 0; k < MAX_CAMS; k++) {
      if (tally[k] != buf[3 + k]) change = true;
      tally[k] = buf[3 + k];
    }
    dernierMac = millis();
    macVu = true;
    if (change) {
      Serial.print("Tally :");
      for (int k = 0; k < MAX_CAMS; k++) Serial.printf(" %d:%s", k + 1, (tally[k] & 1) ? "PGM" : (tally[k] & 2) ? "PVW" : "-");
      Serial.println();
      diffuser();                                 // tout de suite, sans attendre
    }
  }
}

bool atemDisponible() {
  return macVu && millis() - dernierMac < TIMEOUT_MAC_MS && atemOk;
}

void diffuser() {
  bool ok = atemDisponible();
  uint8_t m[8 + MAX_CAMS];
  m[0] = 'T'; m[1] = 'L'; m[2] = 2;
  m[3] = seq++;
  m[4] = ok ? 1 : 0;
  m[5] = MAX_CAMS;
  m[6] = TTL_MAX;
  m[7] = 0;
  for (int k = 0; k < MAX_CAMS; k++) m[8 + k] = ok ? tally[k] : 0;
  esp_now_send(BROADCAST, m, sizeof(m));
  dernierRadio = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUT, OUTPUT);
  digitalWrite(LED_STATUT, HIGH);

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
  Serial.printf("Émetteur prêt, ESP-NOW canal %d, attend le Mac sur l'USB\n", CANAL_ESPNOW);
}

void loop() {
  lireMac();

  // 0 : pas de Mac, 1 : Mac sans ATEM, 2 : OK
  int etat = 2;
  if (!macVu || millis() - dernierMac >= TIMEOUT_MAC_MS) etat = 0;
  else if (!atemOk) etat = 1;
  if (etat != etatAvant) {
    static const char *noms[] = {"Pas de données du Mac (lancer atem_vers_esp32.py)",
                                 "Le Mac n'est pas connecté à l'ATEM", "ATEM OK"};
    Serial.println(noms[etat]);
    etatAvant = etat;
  }
  digitalWrite(LED_STATUT, etat == 2 ? LOW : HIGH);

  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
  delay(1);
}

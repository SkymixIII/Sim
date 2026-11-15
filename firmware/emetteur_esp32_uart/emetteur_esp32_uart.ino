// ============================================================================
//  Émetteur tally ESP-NOW  ·  ESP32 DevKit V1, alimenté par le Nucleo
// ----------------------------------------------------------------------------
//  - Reçoit le tally du NUCLEO-H753ZI par liaison série (RX2 = GPIO16).
//  - Le diffuse en ESP-NOW (trame v2 de 16 octets), 10 fois par seconde, aux
//    lampes tally et aux antennes relais. Format identique à l'émetteur WT32-ETH01 :
//    les lampes et antennes existantes n'ont rien à changer.
//  - Si le Nucleo ne dit plus rien pendant 1 s, ou s'il a perdu l'ATEM, la trame
//    part avec « ATEM ok = 0 » : les lampes passent en bleu clignotant.
//  - LED bleue de la carte (D2) : allumée = pas d'ATEM (ou pas de Nucleo).
//
//  Liaison série depuis le Nucleo (12 octets) :
//    0xA5 0x5A | ATEM ok | caméras 1 à 8 | XOR des octets 2 à 10
//  Aucune bibliothèque externe. Carte dans l'IDE : « ESP32 Dev Module ».
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

static const uint8_t  CANAL_ESPNOW = 1;      // identique sur toutes les lampes et antennes
static const uint32_t PERIODE_RADIO_MS = 100;
static const uint32_t TIMEOUT_NUCLEO_MS = 1000;
static const uint8_t  MAX_CAMS = 8;
static const uint8_t  TTL_MAX = 6;
static const int      RX_NUCLEO = 16;       // RX2 <- D1 (PG14) du Nucleo
static const int      TX_NUCLEO = 17;       // TX2 -> D0 (PG9) du Nucleo (inutilisé, mais câblé)
static const int      LED_STATUT = 2;

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

uint8_t tally[MAX_CAMS] = {0};
uint8_t atemOk = 0;
uint32_t dernierNucleo = 0, dernierRadio = 0;
uint8_t seq = 0;
uint8_t buf[12];
void diffuser();
int pos = 0;
bool nucleoVu = false;
int etatAvant = -1;

// Lit les octets du Nucleo et reconnaît les trames complètes
void lireNucleo() {
  while (Serial2.available()) {
    uint8_t c = Serial2.read();
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
    dernierNucleo = millis();
    nucleoVu = true;
    if (change) {
      Serial.print("Tally :");
      for (int k = 0; k < MAX_CAMS; k++) Serial.printf(" %d:%s", k + 1, (tally[k] & 1) ? "PGM" : (tally[k] & 2) ? "PVW" : "-");
      Serial.println();
      diffuser();                                 // tout de suite, sans attendre
    }
  }
}

bool atemDisponible() {
  return nucleoVu && millis() - dernierNucleo < TIMEOUT_NUCLEO_MS && atemOk;
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
  Serial2.begin(115200, SERIAL_8N1, RX_NUCLEO, TX_NUCLEO);
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
  Serial.printf("Émetteur prêt, ESP-NOW canal %d, attend le Nucleo sur RX2 (GPIO%d)\n", CANAL_ESPNOW, RX_NUCLEO);
}

void loop() {
  lireNucleo();

  // 0 : pas de Nucleo, 1 : Nucleo sans ATEM, 2 : OK
  int etat = 2;
  if (!nucleoVu || millis() - dernierNucleo >= TIMEOUT_NUCLEO_MS) etat = 0;
  else if (!atemOk) etat = 1;
  if (etat != etatAvant) {
    static const char *noms[] = {"Pas de données du Nucleo (vérifier le fil D1 -> RX2 et la masse)",
                                 "Le Nucleo n'est pas connecté à l'ATEM", "ATEM OK"};
    Serial.println(noms[etat]);
    etatAvant = etat;
  }
  digitalWrite(LED_STATUT, etat == 2 ? LOW : HIGH);

  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
  delay(1);
}

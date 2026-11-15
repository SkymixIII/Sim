// ============================================================================
//  Émetteur de TEST  ·  ESP32 DevKit V1, sans ATEM ni Nucleo
// ----------------------------------------------------------------------------
//  Fait comme si l'ATEM envoyait le tally, et le diffuse en ESP-NOW aux tallys
//  (même trame v2 que le vrai émetteur), en alternant toutes les 10 s :
//    phase A : caméra 1 au PROGRAMME (rouge), les autres éteintes
//    phase B : caméra 2 au PROGRAMME (rouge), caméra 1 en PREVIEW (vert)
//  LED bleue de la carte (D2) : allumée en phase A, éteinte en phase B.
//  Moniteur série 115200 : affiche chaque changement.
//  Aucune bibliothèque externe. Carte dans l'IDE : « ESP32 Dev Module ».
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

static const uint8_t  CANAL_ESPNOW = 1;      // identique sur les tallys
static const uint32_t PERIODE_RADIO_MS = 100;
static const uint32_t DUREE_PHASE_MS = 10000;
static const uint8_t  MAX_CAMS = 8;
static const uint8_t  TTL_MAX = 6;
static const int      LED_CARTE = 2;
static const uint8_t  PGM = 0x01, PVW = 0x02;

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

uint8_t tally[MAX_CAMS];
uint8_t seq = 0;
uint32_t dernierRadio = 0, debutPhase = 0;
bool phaseB = false;

void appliquerPhase() {
  memset(tally, 0, sizeof(tally));
  if (!phaseB) {
    tally[0] = PGM;                       // caméra 1 au programme
    Serial.println("Phase A : CAM 1 PGM (rouge)");
  } else {
    tally[1] = PGM;                       // caméra 2 au programme
    tally[0] = PVW;                       // caméra 1 en preview
    Serial.println("Phase B : CAM 2 PGM (rouge), CAM 1 PVW (vert)");
  }
  digitalWrite(LED_CARTE, phaseB ? LOW : HIGH);
}

void diffuser() {
  uint8_t m[8 + MAX_CAMS];
  m[0] = 'T'; m[1] = 'L'; m[2] = 2;
  m[3] = seq++;
  m[4] = 1;                               // « ATEM connecté »
  m[5] = MAX_CAMS;
  m[6] = TTL_MAX;
  m[7] = 0;
  for (int k = 0; k < MAX_CAMS; k++) m[8 + k] = tally[k];
  esp_now_send(BROADCAST, m, sizeof(m));
  dernierRadio = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_CARTE, OUTPUT);

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
  Serial.println("Émetteur de test prêt (ATEM simulé)");

  debutPhase = millis();
  appliquerPhase();
  diffuser();
}

void loop() {
  if (millis() - debutPhase >= DUREE_PHASE_MS) {
    phaseB = !phaseB;
    debutPhase = millis();
    appliquerPhase();
    diffuser();                           // tout de suite, sans attendre
  }
  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
  delay(1);
}

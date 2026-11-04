// ============================================================================
//  Antenne relais du maillage tally ESP-NOW  ·  carte ESP32-WROOM-32U (antenne externe)
// ----------------------------------------------------------------------------
//  - Ne suit aucune caméra : elle sert uniquement à étendre la portée.
//  - Rediffuse une fois chaque trame tally nouvelle (même règle que les lampes :
//    doublons ignorés, TTL - 1, délai de 2 à 14 ms au hasard).
//  - LED bleue (GPIO19) : comme sur les lampes
//      fixe        -> plus aucune trame reçue depuis TIMEOUT_MS
//      clignotante -> l'émetteur répond mais n'a plus l'ATEM
//      éteinte     -> liaison OK
//  - LED orange (GPIO18) : flash de FLASH_MS à chaque trame retransmise.
//    À 10 trames/s, elle clignote donc rapidement tant que l'antenne relaie.
//
//  Câblage : GPIO18 -> 150 Ω -> LED orange -> GND, GPIO19 -> 33 Ω -> LED bleue -> GND
//  (ou les LED intégrées d'un boîtier, avec des résistances adaptées).
//  Aucune bibliothèque externe. Carte dans l'IDE : « ESP32 Dev Module ».
//  Pour une portée maximale : antenne 2,4 GHz externe (IPEX/SMA), placée en hauteur et dégagée.
//  Simulation : même logique que les sketches « Antenne » du montage Tally de l'Établi.
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ---------- Réglages ----------
static const uint8_t  CANAL_ESPNOW = 1;     // identique sur l'émetteur, les lampes et les antennes
static const uint32_t TIMEOUT_MS = 2000;
static const uint32_t FLASH_MS = 40;
static const uint8_t  LED_ORANGE = 18;
static const uint8_t  LED_BLEUE = 19;
static const int8_t   PUISSANCE_TX = 78;    // en quarts de dBm : 78 = 19,5 dBm, le maximum

static const uint8_t  TRAME_LEN = 16;
static const uint8_t  BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// Écrits dans le callback ESP-NOW (tâche Wi-Fi), lus dans loop().
portMUX_TYPE verrou = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t dernierMessage = 0;
volatile bool dejaRecu = false;
volatile uint8_t dernierSeq = 0;
volatile uint8_t atemOk = 0;
volatile uint8_t sauts = 0;
uint8_t relais[TRAME_LEN];
volatile bool relaisEnAttente = false;
volatile uint32_t relaisA = 0;

uint32_t flashJusqua = 0;
uint32_t relayees = 0, dernierBilan = 0;
int etatAvant = -1;
uint8_t sautsAffiches = 0xFF;
int ledO = -1, ledB = -1;

static bool estNouvelle(uint8_t seq, uint32_t maintenant) {
  if (!dejaRecu || maintenant - dernierMessage > 1000) return true;
  uint8_t d = seq - dernierSeq;
  return d > 0 && d < 128;
}

static void traiterTrame(const uint8_t *data, int len) {
  if (len < TRAME_LEN || data[0] != 'T' || data[1] != 'L' || data[2] != 2) return;
  uint32_t maintenant = millis();
  portENTER_CRITICAL(&verrou);
  if (!estNouvelle(data[3], maintenant)) { portEXIT_CRITICAL(&verrou); return; }
  dernierSeq = data[3];
  dernierMessage = maintenant;
  dejaRecu = true;
  atemOk = data[4];
  sauts = data[7] + 1;
  if (data[6] > 1) {
    memcpy(relais, data, TRAME_LEN);
    relais[6] = data[6] - 1;
    relais[7] = data[7] + 1;
    relaisA = maintenant + 2 + (esp_random() % 13);
    relaisEnAttente = true;
  }
  portEXIT_CRITICAL(&verrou);
}

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void surReception(const esp_now_recv_info_t *info, const uint8_t *data, int len) { traiterTrame(data, len); }
#else
void surReception(const uint8_t *mac, const uint8_t *data, int len) { traiterTrame(data, len); }
#endif

void ecrire(int o, int b) {
  if (o != ledO) { digitalWrite(LED_ORANGE, o); ledO = o; }
  if (b != ledB) { digitalWrite(LED_BLEUE, b); ledB = b; }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_ORANGE, OUTPUT);
  pinMode(LED_BLEUE, OUTPUT);
  ecrire(LOW, HIGH);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(CANAL_ESPNOW, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  esp_wifi_set_max_tx_power(PUISSANCE_TX);
  if (esp_now_init() != ESP_OK) {
    Serial.println("Erreur esp_now_init");
    return;
  }
  esp_now_register_recv_cb(surReception);
  esp_now_peer_info_t pair = {};
  memcpy(pair.peer_addr, BROADCAST, 6);
  pair.channel = CANAL_ESPNOW;
  pair.ifidx = WIFI_IF_STA;
  pair.encrypt = false;
  if (esp_now_add_peer(&pair) != ESP_OK) Serial.println("Erreur esp_now_add_peer");
  Serial.printf("Antenne prête, canal %d, MAC %s\n", CANAL_ESPNOW, WiFi.macAddress().c_str());
}

void loop() {
  uint8_t aEnvoyer[TRAME_LEN];
  bool envoyer = false;
  portENTER_CRITICAL(&verrou);
  if (relaisEnAttente && (int32_t)(millis() - relaisA) >= 0) {
    memcpy(aEnvoyer, relais, TRAME_LEN);
    relaisEnAttente = false;
    envoyer = true;
  }
  uint32_t dernier = dernierMessage;
  bool recu = dejaRecu;
  uint8_t ok = atemOk, s = sauts;
  portEXIT_CRITICAL(&verrou);

  uint32_t maintenant = millis();
  if (envoyer && esp_now_send(BROADCAST, aEnvoyer, TRAME_LEN) == ESP_OK) {
    flashJusqua = maintenant + FLASH_MS;   // la LED orange signale l'émission
    relayees++;
  }
  if (maintenant - dernierBilan >= 5000) {
    if (relayees > 0) Serial.printf("%lu trames relayées en 5 s\n", (unsigned long)relayees);
    relayees = 0;
    dernierBilan = maintenant;
  }

  // 0 : plus de trame, 1 : ATEM perdu, 2 : liaison OK
  int etat = 2;
  if (!recu || maintenant - dernier > TIMEOUT_MS) etat = 0;
  else if (ok == 0) etat = 1;
  if (etat != etatAvant) {
    static const char *noms[] = {"plus de trame tally : bleu", "émetteur sans ATEM : bleu clignotant", "liaison OK"};
    Serial.printf("Antenne : %s\n", noms[etat]);
    etatAvant = etat;
  }
  if (etat != 0 && s != sautsAffiches) {
    Serial.printf("Trame reçue en %d saut(s)\n", s);
    sautsAffiches = s;
  }

  int bleu = LOW;
  if (etat == 0) bleu = HIGH;
  if (etat == 1 && (maintenant % 1000) < 500) bleu = HIGH;
  ecrire((int32_t)(flashJusqua - maintenant) > 0 ? HIGH : LOW, bleu);
  delay(1);
}

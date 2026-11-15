// ============================================================================
//  Tally caméra 4  ·  ESP32 DevKit V1 + 3 LED (rouge, verte, bleue)
// ----------------------------------------------------------------------------
//  Même câblage que les lampes de l'établi :
//    D18 -> 120 Ω -> LED rouge -> GND   (programme)
//    D19 ->  47 Ω -> LED verte -> GND   (preview)
//    D21 ->  33 Ω -> LED bleue -> GND   (liaison perdue)
//  (patte longue de la LED côté résistance, patte courte côté GND)
//
//  Une seule LED à la fois, priorité BLEU > ROUGE > VERT :
//    bleue fixe        -> plus aucune trame reçue depuis 2 s
//    bleue clignotante -> l'émetteur répond mais n'a plus l'ATEM
//    rouge             -> caméra 4 au programme
//    verte             -> caméra 4 en preview
//    tout éteint       -> caméra hors antenne
//
//  Maillage : chaque trame nouvelle est rediffusée une fois (TTL - 1), pour
//  porter le tally aux lampes plus éloignées. Mettre RELAIS à false pour l'éviter.
//  Aucune bibliothèque externe. Carte dans l'IDE : « ESP32 Dev Module ».
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

static const uint8_t  CAM = 4;               // caméra suivie par ce tally
static const bool     RELAIS = true;
static const uint8_t  CANAL_ESPNOW = 1;
static const uint32_t TIMEOUT_MS = 2000;
static const int      LED_ROUGE = 18;              // D18
static const int      LED_VERTE = 19;              // D19
static const int      LED_BLEUE = 21;              // D21

static const uint8_t  TRAME_LEN = 16;
static const uint8_t  BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

portMUX_TYPE verrou = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t dernierMessage = 0;
volatile bool dejaRecu = false;
volatile uint8_t dernierSeq = 0;
volatile uint8_t atemOk = 0;
volatile uint8_t etatCam = 0;
volatile uint8_t sauts = 0;
uint8_t relais[TRAME_LEN];
volatile bool relaisEnAttente = false;
volatile uint32_t relaisA = 0;

int etatAvant = -1;
uint8_t sautsAffiches = 0xFF;
int actuel[3] = {-1, -1, -1};

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
  etatCam = (CAM <= data[5]) ? data[7 + CAM] : 0;
  sauts = data[7] + 1;
  if (RELAIS && data[6] > 1) {
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

void ecrire(int r, int v, int b) {
  if (r != actuel[0]) { digitalWrite(LED_ROUGE, r); actuel[0] = r; }
  if (v != actuel[1]) { digitalWrite(LED_VERTE, v); actuel[1] = v; }
  if (b != actuel[2]) { digitalWrite(LED_BLEUE, b); actuel[2] = b; }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_ROUGE, OUTPUT);
  pinMode(LED_VERTE, OUTPUT);
  pinMode(LED_BLEUE, OUTPUT);
  // Petit test au démarrage : rouge, vert, bleu, 300 ms chacun
  ecrire(HIGH, LOW, LOW); delay(300);
  ecrire(LOW, HIGH, LOW); delay(300);
  ecrire(LOW, LOW, HIGH); delay(300);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(CANAL_ESPNOW, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  if (esp_now_init() != ESP_OK) { Serial.println("Erreur esp_now_init"); return; }
  esp_now_register_recv_cb(surReception);
  esp_now_peer_info_t pair = {};
  memcpy(pair.peer_addr, BROADCAST, 6);
  pair.channel = CANAL_ESPNOW;
  pair.ifidx = WIFI_IF_STA;
  pair.encrypt = false;
  if (esp_now_add_peer(&pair) != ESP_OK) Serial.println("Erreur esp_now_add_peer");
  Serial.printf("Tally caméra %d prêt, canal %d, relais %s\n", CAM, CANAL_ESPNOW, RELAIS ? "actif" : "inactif");
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
  uint8_t ok = atemOk, e = etatCam, s = sauts;
  portEXIT_CRITICAL(&verrou);
  if (envoyer) esp_now_send(BROADCAST, aEnvoyer, TRAME_LEN);

  uint32_t maintenant = millis();
  // 0 : plus de trame, 1 : ATEM perdu, 2 : programme, 3 : preview, 4 : rien
  int etat = 4;
  if (!recu || maintenant - dernier > TIMEOUT_MS) etat = 0;
  else if (ok == 0) etat = 1;
  else if (e & 0x01) etat = 2;
  else if (e & 0x02) etat = 3;

  if (etat != etatAvant) {
    static const char *noms[] = {"plus de trame tally : bleu", "émetteur sans ATEM : bleu clignotant",
                                 "programme : rouge", "preview : vert", "hors antenne : éteint"};
    Serial.printf("CAM %d %s\n", CAM, noms[etat]);
    etatAvant = etat;
  }
  if (etat != 0 && s != sautsAffiches) {
    Serial.printf("Trame reçue en %d saut(s)\n", s);
    sautsAffiches = s;
  }

  switch (etat) {
    case 0: ecrire(LOW, LOW, HIGH); break;
    case 1: ecrire(LOW, LOW, (maintenant % 1000) < 500 ? HIGH : LOW); break;
    case 2: ecrire(HIGH, LOW, LOW); break;
    case 3: ecrire(LOW, HIGH, LOW); break;
    default: ecrire(LOW, LOW, LOW);
  }
  delay(1);
}

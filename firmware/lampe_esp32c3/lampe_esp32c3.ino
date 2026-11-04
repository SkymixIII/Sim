// ============================================================================
//  Lampe tally ESP-NOW maillée  ·  carte ESP32-C3 Super Mini + LED WS2812B
// ----------------------------------------------------------------------------
//  - Écoute les trames tally diffusées par l'émetteur (ESP-NOW, canal 1)
//    ou relayées par les autres lampes.
//  - Maillage : chaque trame nouvelle (numéro jamais vu) est rediffusée une fois,
//    après 2 à 14 ms au hasard, avec TTL - 1. Les doublons sont ignorés : pas de
//    boucle ni de tempête. Une lampe hors de portée de l'émetteur reçoit donc le
//    tally par ses voisines (jusqu'à TTL_MAX sauts, quelques ms par saut).
//  - Une seule couleur à la fois, par priorité BLEU > ROUGE > VERT :
//      bleu fixe        -> plus aucune trame reçue depuis TIMEOUT_MS
//      bleu clignotant  -> l'émetteur répond mais n'a plus l'ATEM
//      rouge            -> SA caméra (CAM ci-dessous) au programme
//      vert             -> SA caméra en preview
//      éteinte          -> caméra hors antenne
//
//  Câblage réel : WS2812B DIN <- 330 Ω <- GPIO4, 5 V et GND de la carte.
//  Bibliothèque : « Adafruit NeoPixel » (gestionnaire de bibliothèques de l'IDE).
//  Carte dans l'IDE : « ESP32C3 Dev Module », USB CDC On Boot : Enabled (pour le moniteur série).
//  Simulation : même logique que les sketches « Lampe » du montage Tally de l'Établi
//  (où la WS2812B est remplacée par 3 LED : rouge GPIO18, verte GPIO19, bleue GPIO21).
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Adafruit_NeoPixel.h>

// ---------- Réglages ----------
static const uint8_t  CAM = 1;              // caméra suivie, de 1 à 8 : une lampe par caméra
static const bool     RELAIS = true;        // false : la lampe écoute sans relayer
static const uint8_t  CANAL_ESPNOW = 1;     // identique sur l'émetteur et toutes les lampes
static const uint32_t TIMEOUT_MS = 2000;

static const uint8_t  PIN_WS2812 = 4;
static const uint16_t NB_LEDS = 1;          // mettre le nombre de LED si c'est un anneau ou un ruban
static const uint8_t  LUMINOSITE = 160;     // 0 à 255 : une WS2812B à fond tire ~60 mA par LED

static const uint8_t  TRAME_LEN = 16;
static const uint8_t  BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

Adafruit_NeoPixel leds(NB_LEDS, PIN_WS2812, NEO_GRB + NEO_KHZ800);

// Écrits dans le callback ESP-NOW (tâche Wi-Fi), lus dans loop().
// On ne réémet jamais depuis le callback : la trame à relayer est confiée à loop().
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

uint32_t couleurActuelle = 0xFFFFFFFF;
int etatAvant = -1;
uint8_t sautsAffiches = 0xFF;

// Trame v2 : 'T' 'L' | version=2 | numéro | ATEM ok | nb caméras | TTL | sauts | 1 octet par caméra
static bool estNouvelle(uint8_t seq, uint32_t maintenant) {
  if (!dejaRecu || maintenant - dernierMessage > 1000) return true;   // 1re trame, ou émetteur redémarré
  uint8_t d = seq - dernierSeq;                                        // comparaison sur 8 bits
  return d > 0 && d < 128;
}

static void traiterTrame(const uint8_t *data, int len) {
  if (len < TRAME_LEN || data[0] != 'T' || data[1] != 'L' || data[2] != 2) return;
  uint32_t maintenant = millis();
  portENTER_CRITICAL(&verrou);
  if (!estNouvelle(data[3], maintenant)) { portEXIT_CRITICAL(&verrou); return; }   // doublon
  dernierSeq = data[3];
  dernierMessage = maintenant;
  dejaRecu = true;
  atemOk = data[4];
  etatCam = (CAM <= data[5]) ? data[7 + CAM] : 0;
  sauts = data[7] + 1;
  if (RELAIS && data[6] > 1) {
    memcpy(relais, data, TRAME_LEN);
    relais[6] = data[6] - 1;                          // TTL
    relais[7] = data[7] + 1;                          // sauts
    relaisA = maintenant + 2 + (esp_random() % 13);   // 2 à 14 ms : les voisines n'émettent pas ensemble
    relaisEnAttente = true;
  }
  portEXIT_CRITICAL(&verrou);
}

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void surReception(const esp_now_recv_info_t *info, const uint8_t *data, int len) { traiterTrame(data, len); }
#else
void surReception(const uint8_t *mac, const uint8_t *data, int len) { traiterTrame(data, len); }
#endif

void afficher(uint32_t couleur) {
  if (couleur == couleurActuelle) return;   // la WS2812B garde sa couleur, inutile de la renvoyer
  for (uint16_t i = 0; i < NB_LEDS; i++) leds.setPixelColor(i, couleur);
  leds.show();
  couleurActuelle = couleur;
}

void setup() {
  Serial.begin(115200);
  leds.begin();
  leds.setBrightness(LUMINOSITE);
  afficher(0);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(CANAL_ESPNOW, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  if (esp_now_init() != ESP_OK) {
    Serial.println("Erreur esp_now_init");
    return;
  }
  esp_now_register_recv_cb(surReception);
  // Pair de diffusion, pour relayer
  esp_now_peer_info_t pair = {};
  memcpy(pair.peer_addr, BROADCAST, 6);
  pair.channel = CANAL_ESPNOW;
  pair.ifidx = WIFI_IF_STA;
  pair.encrypt = false;
  if (esp_now_add_peer(&pair) != ESP_OK) Serial.println("Erreur esp_now_add_peer");
  Serial.printf("Lampe prête, caméra %d, canal %d, relais %s, MAC %s\n",
                CAM, CANAL_ESPNOW, RELAIS ? "actif" : "inactif", WiFi.macAddress().c_str());
}

void loop() {
  // Relais en attente
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
                                 "programme : rouge", "preview : vert", "hors antenne : éteinte"};
    Serial.printf("CAM %d %s\n", CAM, noms[etat]);
    etatAvant = etat;
  }
  if (etat != 0 && s != sautsAffiches) {
    Serial.printf("Trame reçue en %d saut(s)\n", s);
    sautsAffiches = s;
  }

  const uint32_t BLEU = leds.Color(0, 0, 255), ROUGE = leds.Color(255, 0, 0), VERT = leds.Color(0, 255, 0);
  switch (etat) {
    case 0: afficher(BLEU); break;
    case 1: afficher((maintenant % 1000) < 500 ? BLEU : 0); break;
    case 2: afficher(ROUGE); break;
    case 3: afficher(VERT); break;
    default: afficher(0);
  }
  delay(1);
}

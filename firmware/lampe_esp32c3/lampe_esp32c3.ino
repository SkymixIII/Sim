// ============================================================================
//  Lampe tally ESP-NOW  ·  carte ESP32-C3 Super Mini + LED WS2812B
// ----------------------------------------------------------------------------
//  - Écoute les trames tally diffusées par l'émetteur (ESP-NOW, canal 1).
//  - Une seule couleur à la fois, par priorité BLEU > ROUGE > VERT :
//      bleu fixe        -> plus de liaison radio avec l'émetteur (rien depuis TIMEOUT_MS)
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

// ---------- Réglages (repris du CSV) ----------
static const uint8_t  CAM = 1;              // caméra suivie, de 1 à 8 : une lampe par caméra
static const uint8_t  CANAL_ESPNOW = 1;     // identique sur l'émetteur
static const uint32_t TIMEOUT_MS = 2000;

static const uint8_t  PIN_WS2812 = 4;
static const uint16_t NB_LEDS = 1;          // mettre le nombre de LED si c'est un anneau ou un ruban
static const uint8_t  LUMINOSITE = 160;     // 0 à 255 : une WS2812B à fond tire ~60 mA par LED

Adafruit_NeoPixel leds(NB_LEDS, PIN_WS2812, NEO_GRB + NEO_KHZ800);

// Écrits dans le callback ESP-NOW (tâche Wi-Fi), lus dans loop()
volatile uint32_t dernierMessage = 0;
volatile bool dejaRecu = false;
volatile uint8_t atemOk = 0;
volatile uint8_t etatCam = 0;

uint32_t couleurActuelle = 0xFFFFFFFF;
int etatAvant = -1;

// Trame tally : 'T' 'L' | version=1 | numéro | ATEM ok | nb caméras | 1 octet par caméra
static void traiterTrame(const uint8_t *data, int len) {
  if (len < 6 || data[0] != 'T' || data[1] != 'L' || data[2] != 1) return;
  uint8_t nb = data[5];
  etatCam = (CAM <= nb && 5 + CAM < len) ? data[5 + CAM] : 0;
  atemOk = data[4];
  dernierMessage = millis();
  dejaRecu = true;
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
  Serial.printf("Lampe prête, caméra %d, canal %d, MAC %s\n", CAM, CANAL_ESPNOW, WiFi.macAddress().c_str());
}

void loop() {
  uint32_t dernier = dernierMessage;        // lu avant millis() : pas de soustraction négative
  uint32_t maintenant = millis();

  // 0 : liaison émetteur perdue, 1 : ATEM perdu, 2 : programme, 3 : preview, 4 : rien
  int etat = 4;
  uint8_t e = etatCam;
  if (!dejaRecu || maintenant - dernier > TIMEOUT_MS) etat = 0;
  else if (atemOk == 0) etat = 1;
  else if (e & 0x01) etat = 2;
  else if (e & 0x02) etat = 3;

  if (etat != etatAvant) {
    static const char *noms[] = {"plus de liaison avec l'émetteur : bleu", "émetteur sans ATEM : bleu clignotant",
                                 "programme : rouge", "preview : vert", "hors antenne : éteinte"};
    Serial.printf("CAM %d %s\n", CAM, noms[etat]);
    etatAvant = etat;
  }

  const uint32_t BLEU = leds.Color(0, 0, 255), ROUGE = leds.Color(255, 0, 0), VERT = leds.Color(0, 255, 0);
  switch (etat) {
    case 0: afficher(BLEU); break;
    case 1: afficher((maintenant % 1000) < 500 ? BLEU : 0); break;
    case 2: afficher(ROUGE); break;
    case 3: afficher(VERT); break;
    default: afficher(0);
  }
  delay(5);
}

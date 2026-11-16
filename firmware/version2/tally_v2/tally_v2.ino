// ============================================================================
//  VERSION 2 · Tally  ·  ESP32-C3 Super Mini + LED WS2812B + afficheur TM1637
// ----------------------------------------------------------------------------
//  Le même code sur tous les tallys : l'entrée SDI lue se règle avec les
//  boutons + et −, et s'affiche sur l'afficheur 7 segments (« 7 », « 12 »),
//  sur les deux chiffres de droite du module 4 chiffres.
//
//  Câblage (ESP32-C3 Super Mini) :
//    GPIO4  -> 330 Ω -> DIN de la WS2812B      5V  -> VDD,  GND -> GND
//    GPIO5  -> CLK du TM1637                   GPIO6 -> DIO du TM1637
//    3V3    -> VCC du TM1637                   GND -> GND du TM1637
//    GPIO7  -> bouton « + » -> GND             GPIO10 -> bouton « − » -> GND
//
//  Boutons :
//    appui court     -> entrée suivante (+) ou précédente (−), de 1 à 20
//    appui maintenu  -> défile tout seul
//    L'afficheur clignote tant que le choix n'est pas enregistré ; il est gardé
//    en mémoire 3 s après le dernier appui, même après une coupure.
//
//  LED, une seule couleur à la fois, priorité BLEU > ROUGE > VERT :
//    bleu fixe        -> plus aucune trame reçue depuis 2 s
//    bleu clignotant  -> l'émetteur répond mais n'a plus l'ATEM
//    rouge            -> entrée au programme
//    vert             -> entrée en preview
//    éteinte          -> hors antenne
//
//  Maillage : chaque trame nouvelle est rediffusée une fois (TTL - 1).
//  Bibliothèque : « Adafruit NeoPixel ».
//  Carte : « ESP32C3 Dev Module », USB CDC On Boot : Enabled.
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Preferences.h>
#include <Adafruit_NeoPixel.h>

static const uint8_t  ENTREE_DEPART = 1;     // entrée utilisée la toute première fois
static const uint8_t  MAX_ENTREES = 20;     // entrées envoyées par l'émetteur
static const bool     RELAIS = true;
static const uint8_t  CANAL_ESPNOW = 1;
static const uint32_t TIMEOUT_MS = 2000;
static const int      PIN_WS2812 = 4;        // GPIO4
static const uint8_t  LUMINOSITE_LED = 160;  // 0 à 255
static const int      TM_CLK = 5;            // GPIO5
static const int      TM_DIO = 6;            // GPIO6
static const int      BOUTON_PLUS = 7;       // GPIO7
static const int      BOUTON_MOINS = 10;     // GPIO10
static const uint8_t  LUMINOSITE = 4;        // afficheur, de 0 à 7

static const uint8_t  TRAME_MIN = 16;
static const uint8_t  TRAME_MAX = 8 + 40;
static const uint8_t  BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

portMUX_TYPE verrou = portMUX_INITIALIZER_UNLOCKED;
volatile uint8_t entree = ENTREE_DEPART;     // lue aussi dans le callback radio
volatile uint32_t dernierMessage = 0;
volatile bool dejaRecu = false;
volatile uint8_t dernierSeq = 0;
volatile uint8_t atemOk = 0;
volatile uint8_t etatCam = 0;
volatile uint8_t sauts = 0;
uint8_t relais[TRAME_MAX];
volatile uint8_t relaisLen = 0;
volatile bool relaisEnAttente = false;
volatile uint32_t relaisA = 0;

Preferences memoire;
Adafruit_NeoPixel led(1, PIN_WS2812, NEO_GRB + NEO_KHZ800);
uint32_t couleurActuelle = 0xFFFFFFFF;
int etatAvant = -1;
uint8_t sautsAffiches = 0xFF;

// ---------------------------------------------------------------------------
//  Afficheur TM1637 (sans bibliothèque)
// ---------------------------------------------------------------------------
static const uint8_t CHIFFRES[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};

void tmPause() { delayMicroseconds(5); }
void tmDebut() {
  pinMode(TM_DIO, OUTPUT);
  digitalWrite(TM_CLK, HIGH); digitalWrite(TM_DIO, HIGH); tmPause();
  digitalWrite(TM_DIO, LOW); tmPause();
}
void tmFin() {
  digitalWrite(TM_CLK, LOW); tmPause();
  digitalWrite(TM_DIO, LOW); tmPause();
  digitalWrite(TM_CLK, HIGH); tmPause();
  digitalWrite(TM_DIO, HIGH); tmPause();
}
void tmOctet(uint8_t b) {
  for (int i = 0; i < 8; i++) {
    digitalWrite(TM_CLK, LOW); tmPause();
    digitalWrite(TM_DIO, (b >> i) & 1); tmPause();
    digitalWrite(TM_CLK, HIGH); tmPause();
  }
  digitalWrite(TM_CLK, LOW);                 // accusé de réception du TM1637
  pinMode(TM_DIO, INPUT_PULLUP); tmPause();
  digitalWrite(TM_CLK, HIGH); tmPause();
  digitalWrite(TM_CLK, LOW); tmPause();
  pinMode(TM_DIO, OUTPUT);
}
void tmAfficher(const uint8_t seg[4], bool allume) {
  tmDebut(); tmOctet(0x40); tmFin();         // écriture, adresse automatique
  tmDebut(); tmOctet(0xC0);
  for (int i = 0; i < 4; i++) tmOctet(seg[i]);
  tmFin();
  tmDebut(); tmOctet(allume ? (0x88 | LUMINOSITE) : 0x80); tmFin();
}

int segAffiche = -1;
void afficherEntree(uint8_t n, bool allume) {
  int code = n | (allume ? 0x100 : 0);
  if (code == segAffiche) return;
  segAffiche = code;
  uint8_t seg[4] = {0, 0, (uint8_t)(n >= 10 ? CHIFFRES[(n / 10) % 10] : 0), CHIFFRES[n % 10]};
  tmAfficher(seg, allume);
}

// ---------------------------------------------------------------------------
//  Radio
// ---------------------------------------------------------------------------
static bool estNouvelle(uint8_t seq, uint32_t maintenant) {
  if (!dejaRecu || maintenant - dernierMessage > 1000) return true;
  uint8_t d = seq - dernierSeq;
  return d > 0 && d < 128;
}

static void traiterTrame(const uint8_t *data, int len) {
  if (len < TRAME_MIN || data[0] != 'T' || data[1] != 'L' || data[2] != 2) return;
  uint32_t maintenant = millis();
  portENTER_CRITICAL(&verrou);
  if (!estNouvelle(data[3], maintenant)) { portEXIT_CRITICAL(&verrou); return; }
  dernierSeq = data[3];
  dernierMessage = maintenant;
  dejaRecu = true;
  atemOk = data[4];
  uint8_t e = entree;
  etatCam = (e <= data[5] && 7 + e < len) ? data[7 + e] : 0;
  sauts = data[7] + 1;
  if (RELAIS && data[6] > 1) {
    relaisLen = len < TRAME_MAX ? len : TRAME_MAX;
    memcpy(relais, data, relaisLen);
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

void afficherCouleur(uint32_t c) {
  if (c == couleurActuelle) return;           // la WS2812B garde sa couleur
  led.setPixelColor(0, c);
  led.show();
  couleurActuelle = c;
}

// ---------------------------------------------------------------------------
//  Boutons + et − : appui court = un pas, maintenu = défilement ; enregistré 3 s après
// ---------------------------------------------------------------------------
struct Bouton { int broche; int sens; bool avant; uint32_t debut, dernierPas; };
Bouton boutons[2] = {{BOUTON_PLUS, +1, false, 0, 0}, {BOUTON_MOINS, -1, false, 0, 0}};
uint32_t dernierChangement = 0;
bool aEnregistrer = false;

void changerEntree(int sens) {
  int n = entree + sens;
  if (n > MAX_ENTREES) n = 1;
  if (n < 1) n = MAX_ENTREES;
  portENTER_CRITICAL(&verrou);
  entree = n;
  etatCam = 0;                               // attendre la prochaine trame pour la nouvelle entrée
  portEXIT_CRITICAL(&verrou);
  dernierChangement = millis();
  aEnregistrer = true;
  Serial.printf("Entrée SDI : %d\n", n);
}

void gererBoutons() {
  uint32_t t = millis();
  bool unAppui = false;
  for (auto &b : boutons) {
    bool appui = digitalRead(b.broche) == LOW;
    if (appui && !b.avant && t - b.debut > 30) { b.debut = t; b.dernierPas = t; changerEntree(b.sens); }
    if (appui && b.avant && t - b.debut > 700 && t - b.dernierPas > 200) { b.dernierPas = t; changerEntree(b.sens); }
    b.avant = appui;
    unAppui |= appui;
  }
  if (aEnregistrer && !unAppui && t - dernierChangement > 3000) {
    memoire.putUChar("entree", entree);
    aEnregistrer = false;
    Serial.printf("Entrée %d enregistrée\n", entree);
  }
}

void setup() {
  Serial.begin(115200);
  led.begin();
  led.setBrightness(LUMINOSITE_LED);
  pinMode(BOUTON_PLUS, INPUT_PULLUP);
  pinMode(BOUTON_MOINS, INPUT_PULLUP);
  pinMode(TM_CLK, OUTPUT);
  pinMode(TM_DIO, OUTPUT);

  memoire.begin("tally", false);
  uint8_t e = memoire.getUChar("entree", ENTREE_DEPART);
  entree = (e >= 1 && e <= MAX_ENTREES) ? e : ENTREE_DEPART;
  afficherEntree(entree, true);

  // Petit test au démarrage : rouge, vert, bleu, 300 ms chacun
  afficherCouleur(led.Color(255, 0, 0)); delay(300);
  afficherCouleur(led.Color(0, 255, 0)); delay(300);
  afficherCouleur(led.Color(0, 0, 255)); delay(300);
  afficherCouleur(0);

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
  Serial.printf("Tally prêt sur l'entrée SDI %d, canal %d, relais %s\n", entree, CANAL_ESPNOW, RELAIS ? "actif" : "inactif");
}

void loop() {
  uint8_t aEnvoyer[TRAME_MAX];
  uint8_t nEnvoi = 0;
  portENTER_CRITICAL(&verrou);
  if (relaisEnAttente && (int32_t)(millis() - relaisA) >= 0) {
    nEnvoi = relaisLen;
    memcpy(aEnvoyer, relais, nEnvoi);
    relaisEnAttente = false;
  }
  uint32_t dernier = dernierMessage;
  bool recu = dejaRecu;
  uint8_t ok = atemOk, e = etatCam, s = sauts;
  portEXIT_CRITICAL(&verrou);
  if (nEnvoi) esp_now_send(BROADCAST, aEnvoyer, nEnvoi);

  gererBoutons();
  uint32_t maintenant = millis();
  afficherEntree(entree, !aEnregistrer || (maintenant % 400) < 250);

  // 0 : plus de trame, 1 : ATEM perdu, 2 : programme, 3 : preview, 4 : rien
  int etat = 4;
  if (!recu || maintenant - dernier > TIMEOUT_MS) etat = 0;
  else if (ok == 0) etat = 1;
  else if (e & 0x01) etat = 2;
  else if (e & 0x02) etat = 3;

  if (etat != etatAvant) {
    static const char *noms[] = {"plus de trame tally : bleu", "émetteur sans ATEM : bleu clignotant",
                                 "programme : rouge", "preview : vert", "hors antenne : éteint"};
    Serial.printf("Entrée %d : %s\n", entree, noms[etat]);
    etatAvant = etat;
  }
  if (etat != 0 && s != sautsAffiches) {
    Serial.printf("Trame reçue en %d saut(s)\n", s);
    sautsAffiches = s;
  }

  const uint32_t BLEU = led.Color(0, 0, 255), ROUGE = led.Color(255, 0, 0), VERT = led.Color(0, 255, 0);
  switch (etat) {
    case 0: afficherCouleur(BLEU); break;
    case 1: afficherCouleur((maintenant % 1000) < 500 ? BLEU : 0); break;
    case 2: afficherCouleur(ROUGE); break;
    case 3: afficherCouleur(VERT); break;
    default: afficherCouleur(0);
  }
  delay(1);
}

// ============================================================================
//  Tally récepteur universel  ·  ESP32 DevKit V1 + 3 LED + afficheur TM1637
// ----------------------------------------------------------------------------
//  Le même code sur tous les tallys : l'entrée SDI suivie se règle au bouton
//  et s'affiche sur l'afficheur 7 segments (« In 7 », « In12 »…).
//
//  Câblage :
//    D18 -> 120 Ω -> LED rouge -> GND   (programme)
//    D19 ->  47 Ω -> LED verte -> GND   (preview)
//    D21 ->  33 Ω -> LED bleue -> GND   (liaison perdue)
//    Afficheur TM1637 4 chiffres : CLK -> D22, DIO -> D23, VCC -> 3V3, GND -> GND
//    Bouton (facultatif) : D4 -> bouton -> GND.  Le bouton BOOT de la carte marche aussi.
//
//  Réglage de l'entrée :
//    appui court      -> entrée suivante (1, 2, … 40, puis 1)
//    appui maintenu   -> défile tout seul
//    L'afficheur clignote tant que le choix n'est pas enregistré ; il est gardé
//    en mémoire 3 s après le dernier appui, même après une coupure de courant.
//
//  LED, une seule à la fois, priorité BLEU > ROUGE > VERT :
//    bleue fixe        -> plus aucune trame reçue depuis 2 s
//    bleue clignotante -> l'émetteur répond mais n'a plus l'ATEM
//    rouge             -> entrée au programme
//    verte             -> entrée en preview
//    tout éteint       -> hors antenne
//
//  Maillage : chaque trame nouvelle est rediffusée une fois (TTL - 1).
//  Aucune bibliothèque externe. Carte dans l'IDE : « ESP32 Dev Module ».
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Preferences.h>

static const uint8_t  ENTREE_DEPART = 1;     // entrée utilisée la toute première fois
static const uint8_t  MAX_ENTREES = 40;
static const bool     RELAIS = true;
static const uint8_t  CANAL_ESPNOW = 1;
static const uint32_t TIMEOUT_MS = 2000;
static const int      LED_ROUGE = 18;        // D18
static const int      LED_VERTE = 19;        // D19
static const int      LED_BLEUE = 21;        // D21
static const int      TM_CLK = 22;           // D22
static const int      TM_DIO = 23;           // D23
static const int      BOUTON = 4;            // D4
static const int      BOUTON_BOOT = 0;       // bouton BOOT de la carte
static const uint8_t  LUMINOSITE = 4;        // afficheur, de 0 à 7

static const uint8_t  TRAME_MIN = 16;
static const uint8_t  TRAME_MAX = 8 + MAX_ENTREES;
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
int etatAvant = -1;
uint8_t sautsAffiches = 0xFF;
int actuel[3] = {-1, -1, -1};

// ---------------------------------------------------------------------------
//  Afficheur TM1637 (sans bibliothèque)
// ---------------------------------------------------------------------------
static const uint8_t CHIFFRES[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
static const uint8_t SEG_I = 0x30, SEG_N = 0x54;

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
  uint8_t seg[4] = {SEG_I, SEG_N, (uint8_t)(n >= 10 ? CHIFFRES[(n / 10) % 10] : 0), CHIFFRES[n % 10]};
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

void ecrire(int r, int v, int b) {
  if (r != actuel[0]) { digitalWrite(LED_ROUGE, r); actuel[0] = r; }
  if (v != actuel[1]) { digitalWrite(LED_VERTE, v); actuel[1] = v; }
  if (b != actuel[2]) { digitalWrite(LED_BLEUE, b); actuel[2] = b; }
}

// ---------------------------------------------------------------------------
//  Bouton : appui court = +1, maintenu = défilement ; enregistré 3 s après
// ---------------------------------------------------------------------------
bool appuiAvant = false;
uint32_t debutAppui = 0, dernierPas = 0, dernierChangement = 0;
bool aEnregistrer = false;

void changerEntree() {
  uint8_t n = entree >= MAX_ENTREES ? 1 : entree + 1;
  portENTER_CRITICAL(&verrou);
  entree = n;
  etatCam = 0;                               // attendre la prochaine trame pour la nouvelle entrée
  portEXIT_CRITICAL(&verrou);
  dernierChangement = millis();
  aEnregistrer = true;
  Serial.printf("Entrée SDI : %d\n", n);
}

void gererBouton() {
  bool appui = digitalRead(BOUTON) == LOW || digitalRead(BOUTON_BOOT) == LOW;
  uint32_t t = millis();
  if (appui && !appuiAvant) { debutAppui = t; dernierPas = t; changerEntree(); }
  if (appui && t - debutAppui > 700 && t - dernierPas > 200) { dernierPas = t; changerEntree(); }
  appuiAvant = appui;
  if (aEnregistrer && !appui && t - dernierChangement > 3000) {
    memoire.putUChar("entree", entree);
    aEnregistrer = false;
    Serial.printf("Entrée %d enregistrée\n", entree);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_ROUGE, OUTPUT);
  pinMode(LED_VERTE, OUTPUT);
  pinMode(LED_BLEUE, OUTPUT);
  pinMode(BOUTON, INPUT_PULLUP);
  pinMode(BOUTON_BOOT, INPUT_PULLUP);
  pinMode(TM_CLK, OUTPUT);
  pinMode(TM_DIO, OUTPUT);

  memoire.begin("tally", false);
  uint8_t e = memoire.getUChar("entree", ENTREE_DEPART);
  entree = (e >= 1 && e <= MAX_ENTREES) ? e : ENTREE_DEPART;
  afficherEntree(entree, true);

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

  gererBouton();
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

  switch (etat) {
    case 0: ecrire(LOW, LOW, HIGH); break;
    case 1: ecrire(LOW, LOW, (maintenant % 1000) < 500 ? HIGH : LOW); break;
    case 2: ecrire(HIGH, LOW, LOW); break;
    case 3: ecrire(LOW, HIGH, LOW); break;
    default: ecrire(LOW, LOW, LOW);
  }
  delay(1);
}

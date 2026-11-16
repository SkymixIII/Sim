// ============================================================================
//  Émetteur tally ESP-NOW  ·  ESP32 DevKit V1 branché en USB sur le Mac
// ----------------------------------------------------------------------------
//  - Le Mac lit l'ATEM par son RJ45 (script atem_vers_esp32.py) et envoie à
//    l'ESP32, par le câble USB (115200 bauds), le tally de CHAQUE M/E.
//  - 4 interrupteurs (DIP) choisissent les M/E prises en compte :
//      ME1 -> D32   ME2 -> D33   ME3 -> D25   ME4 -> D26   (l'autre côté à GND)
//    Interrupteur sur ON = M/E suivie. Toutes sur OFF = toutes les M/E.
//    Une entrée est ROUGE si elle est au programme de l'une des M/E suivies,
//    sinon VERTE si elle est en preview sur l'une d'elles.
//  - Le tally est diffusé en ESP-NOW (trame v2, une case par entrée SDI),
//    10 fois par seconde et tout de suite à chaque changement.
//  - Si le Mac ne dit plus rien pendant 1 s, ou s'il a perdu l'ATEM, la trame
//    part avec « ATEM ok = 0 » : les tallys passent en bleu clignotant.
//  - LED bleue de la carte (D2) : allumée = pas d'ATEM (ou script arrêté).
//
//  Trame reçue du Mac :
//    0xA5 0x5A | ATEM ok | nb M/E | nb entrées | état[M/E][entrée] | XOR des octets 2 à la fin
//    (état : bit 0 programme, bit 1 preview)
//  Le Moniteur série d'Arduino IDE doit être FERMÉ : c'est le script qui utilise le port.
//  Ses messages s'affichent dans le terminal du script, précédés de [ESP32].
//  Aucune bibliothèque externe. Carte dans l'IDE : « ESP32 Dev Module ».
// ============================================================================
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

static const uint8_t  CANAL_ESPNOW = 1;      // identique sur toutes les lampes et antennes
static const uint32_t PERIODE_RADIO_MS = 100;
static const uint32_t TIMEOUT_MAC_MS = 1000;
static const uint8_t  MAX_ME = 8;
static const uint8_t  MAX_ENTREES = 40;
static const uint8_t  TTL_MAX = 6;
static const int      LED_STATUT = 2;
static const uint8_t  NB_INTER = 4;
static const int      INTER_ME[NB_INTER] = {32, 33, 25, 26};   // D32, D33, D25, D26

static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

uint8_t parMe[MAX_ME][MAX_ENTREES];   // dernier état reçu du Mac
uint8_t nbMe = 0, nbEntrees = 0;
uint8_t tally[MAX_ENTREES] = {0};     // résultat combiné, envoyé par radio
uint8_t atemOk = 0;
uint8_t masqueMe = 0xFF;              // M/E suivies (bit 0 = M/E 1)
uint32_t dernierMac = 0, dernierRadio = 0, dernierInter = 0;
uint8_t seq = 0;
bool macVu = false;
int etatAvant = -1;

// Réception des trames du Mac
uint8_t buf[5 + MAX_ME * MAX_ENTREES + 1];
int pos = 0, attendu = 0;

void diffuser();

bool atemDisponible() {
  return macVu && millis() - dernierMac < TIMEOUT_MAC_MS && atemOk;
}

// ---------------------------------------------------------------------------
//  Interrupteurs de choix des M/E
// ---------------------------------------------------------------------------
uint8_t lireInterrupteurs() {
  uint8_t m = 0;
  for (int i = 0; i < NB_INTER; i++)
    if (digitalRead(INTER_ME[i]) == LOW) m |= 1 << i;   // ON = relié à GND
  return m ? m : 0xFF;                                  // aucun : toutes les M/E
}

void afficherChoix() {
  if (masqueMe == 0xFF) { Serial.println("M/E suivies : toutes (aucun interrupteur sur ON)"); return; }
  Serial.print("M/E suivies :");
  for (int i = 0; i < NB_INTER; i++) if (masqueMe & (1 << i)) Serial.printf(" %d", i + 1);
  Serial.println();
}

// ---------------------------------------------------------------------------
//  Combine les M/E choisies : rouge si au programme de l'une, sinon vert si en preview
// ---------------------------------------------------------------------------
bool combiner() {
  uint8_t n[MAX_ENTREES] = {0};
  for (int k = 0; k < nbEntrees; k++) {
    uint8_t pgm = 0, pvw = 0;
    for (int m = 0; m < nbMe; m++) {
      if (!(masqueMe & (1 << m))) continue;
      pgm |= parMe[m][k] & 1;
      pvw |= parMe[m][k] & 2;
    }
    n[k] = pgm ? 1 : (pvw ? 2 : 0);
  }
  if (memcmp(n, tally, sizeof(tally)) == 0) return false;
  memcpy(tally, n, sizeof(tally));
  Serial.print("Tally :");
  bool rien = true;
  for (int k = 0; k < nbEntrees; k++) {
    if (!tally[k]) continue;
    Serial.printf(" %d:%s", k + 1, (tally[k] & 1) ? "PGM" : "PVW");
    rien = false;
  }
  Serial.println(rien ? " aucune entrée" : "");
  return true;
}

// ---------------------------------------------------------------------------
//  Lecture des trames du Mac
// ---------------------------------------------------------------------------
void lireMac() {
  while (Serial.available()) {
    uint8_t c = Serial.read();
    if (pos == 0) { if (c == 0xA5) buf[pos++] = c; continue; }
    if (pos == 1) { if (c == 0x5A) buf[pos++] = c; else pos = (c == 0xA5) ? 1 : 0; continue; }
    buf[pos++] = c;
    if (pos == 5) {
      if (buf[3] > MAX_ME || buf[4] > MAX_ENTREES) { pos = 0; continue; }   // trame impossible
      attendu = 5 + buf[3] * buf[4] + 1;
    }
    if (pos < 5 || pos < attendu) continue;
    pos = 0;
    uint8_t x = 0;
    for (int k = 2; k < attendu - 1; k++) x ^= buf[k];
    if (x != buf[attendu - 1]) continue;              // trame abîmée
    atemOk = buf[2];
    nbMe = buf[3];
    nbEntrees = buf[4];
    for (int m = 0; m < nbMe; m++) memcpy(parMe[m], &buf[5 + m * nbEntrees], nbEntrees);
    dernierMac = millis();
    macVu = true;
    if (combiner()) diffuser();                       // tout de suite, sans attendre
  }
}

// ---------------------------------------------------------------------------
//  ESP-NOW : trame v2, 8 octets d'en-tête + une case par entrée
// ---------------------------------------------------------------------------
void diffuser() {
  bool ok = atemDisponible();
  uint8_t nb = nbEntrees < 8 ? 8 : nbEntrees;         // au moins 8 cases pour les anciennes lampes
  uint8_t m[8 + MAX_ENTREES];
  m[0] = 'T'; m[1] = 'L'; m[2] = 2;
  m[3] = seq++;
  m[4] = ok ? 1 : 0;
  m[5] = nb;
  m[6] = TTL_MAX;
  m[7] = 0;
  for (int k = 0; k < nb; k++) m[8 + k] = ok ? tally[k] : 0;
  esp_now_send(BROADCAST, m, 8 + nb);
  dernierRadio = millis();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUT, OUTPUT);
  digitalWrite(LED_STATUT, HIGH);
  for (int i = 0; i < NB_INTER; i++) pinMode(INTER_ME[i], INPUT_PULLUP);
  delay(5);
  masqueMe = lireInterrupteurs();

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
  afficherChoix();
}

void loop() {
  lireMac();

  // Interrupteurs : relus toutes les 50 ms, pris en compte tout de suite
  if (millis() - dernierInter >= 50) {
    dernierInter = millis();
    uint8_t m = lireInterrupteurs();
    if (m != masqueMe) {
      masqueMe = m;
      afficherChoix();
      combiner();
      diffuser();
    }
  }

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

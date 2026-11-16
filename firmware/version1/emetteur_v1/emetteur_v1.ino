// ============================================================================
//  VERSION 1 · Émetteur tally ATEM -> ESP-NOW  ·  carte WT32-ETH01 (ESP32 + LAN8720)
// ----------------------------------------------------------------------------
//  Le WT32-ETH01 est branché à l'ATEM par son RJ45. Il parle lui-même
//  le protocole ATEM (UDP 9910) et calcule ce qui est à l'antenne sur chaque M/E :
//    - source de programme et de preview ;
//    - clés en incrustation (DVE, luma, chroma, motif) : leur source de remplissage ;
//    - SuperSource : sources des boîtes actives et le fond ;
//    - multiview envoyé comme source : les sources de ses fenêtres ;
//    - sortie d'une M/E utilisée dans une autre, DSK (sur la M/E 1), transitions.
//  Le tally est diffusé en ESP-NOW (trame v2, une case par entrée SDI),
//  10 fois par seconde et tout de suite à chaque changement.
//
//  Tout est réglé en dur ci-dessous (aucun bouton sur le boîtier) :
//    IP de l'ATEM, IP du WT32, M/E prises en compte (MES_SUIVIES).
//    Une entrée est ROUGE si elle est au programme de l'une des M/E suivies,
//    sinon VERTE si elle est en preview sur l'une d'elles.
//
//  Alimentation : 5V et GND du WT32-ETH01 (ou 3V3 et GND).
//  Téléversement : adaptateur USB-série 3,3 V : TX -> RX0, RX -> TX0, GND -> GND,
//  et IO0 relié à GND pendant la mise sous tension (à retirer ensuite).
//  LED sur IO2 : allumée = pas connecté à l'ATEM.
//
//  Aucune bibliothèque externe.  Carte : « ESP32 Dev Module » (ou « WT32-ETH01 Ethernet Module »).
//  Moniteur série : 115200 bauds.
// ============================================================================
#include <ETH.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ---------- Réglages ----------
static const uint8_t  IP_ATEM[4] = {192, 168, 2, 20};
static const uint8_t  IP_EMETTEUR[4] = {192, 168, 2, 52};  // adresse du WT32 : doit être libre sur le réseau
static const uint8_t  MASQUE[4] = {255, 255, 255, 0};
static const uint8_t  NB_ENTREES = 20;      // entrées SDI transmises (40 au plus)
// M/E prises en compte : bit 0 = M/E 1, bit 1 = M/E 2...  0xFF = toutes.
// Exemples : 0b0001 = M/E 1 seule, 0b0011 = M/E 1 et 2.
static const uint8_t  MES_SUIVIES = 0xFF;
static const uint8_t  CANAL_ESPNOW = 1;
static const uint16_t PORT_ATEM = 9910;
static const uint16_t PORT_LOCAL = 50910;
static const uint32_t PERIODE_RADIO_MS = 100;
static const uint32_t TIMEOUT_ATEM_MS = 2500;
static const uint32_t RELANCE_HELLO_MS = 1000;
static const uint8_t  TTL_MAX = 6;
static const int      LED_STATUT = 2;

// ---------- WT32-ETH01 : PHY LAN8720 ----------
static const int ETH_ADRESSE = 1;
static const int ETH_ALIM = 16;      // active l'oscillateur 50 MHz du PHY
static const int ETH_MDC_BROCHE = 23;
static const int ETH_MDIO_BROCHE = 18;

// ---------- Protocole ATEM ----------
static const uint8_t F_ACK_DEMANDE = 0x08;
static const uint8_t F_HELLO = 0x10;
static const uint8_t F_ACK = 0x80;
enum EtatLien { DECONNECTE, HELLO_ENVOYE, CONNECTE };
static const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ---------- État de l'ATEM ----------
static const uint8_t MAX_ME = 4, MAX_CLES = 4, MAX_DSK = 4, MAX_SS = 2, MAX_BOITES = 4, MAX_MV = 4, MAX_FEN = 16;
struct Atem {
  uint16_t verMaj, verMin;
  uint8_t nbMe;
  uint16_t prg[MAX_ME], prv[MAX_ME];
  bool enTransition[MAX_ME];
  uint8_t selection[MAX_ME];                 // bit 0 fond, bits 1.. clés de la prochaine transition
  bool cleAir[MAX_ME][MAX_CLES];
  uint8_t cleType[MAX_ME][MAX_CLES];         // 3 = DVE
  uint16_t cleFill[MAX_ME][MAX_CLES];
  bool dskAir[MAX_DSK], dskTr[MAX_DSK], dskLie[MAX_DSK];
  uint16_t dskFill[MAX_DSK];
  bool ssActive[MAX_SS][MAX_BOITES];
  uint16_t ssSource[MAX_SS][MAX_BOITES], ssFond[MAX_SS];
  uint16_t mv[MAX_MV][MAX_FEN];
} atem;

EtatLien etat = DECONNECTE;
uint16_t sessionId = 0x53AB;
uint32_t dernierRecu = 0, dernierHello = 0, dernierRadio = 0, dernierLien = 0;
uint8_t seq = 0;
uint8_t tally[40] = {0};
uint64_t pgmMe[MAX_ME], pvwMe[MAX_ME];       // bit k = entrée k+1
uint8_t masqueMe = 0xFF;
bool aRecalculer = false;
uint8_t rx[1600];
uint8_t tx[32];
int ledActuelle = -1;
WiFiUDP udp;
bool cableBranche = false;

void diffuser();

// ---------------------------------------------------------------------------
//  Calcul : quelles entrées sont visibles dans une source
// ---------------------------------------------------------------------------
uint64_t programme(int me, int prof, bool avecDsk = true);
uint64_t preview(int me, int prof);

uint64_t visible(uint16_t src, int prof) {
  if (prof > 6 || src == 0) return 0;                    // garde-fou contre les boucles
  if (src <= 40) return 1ULL << (src - 1);               // entrée physique
  if (src < 1000) return 0;
  if (src >= 6000 && src < 6000 + MAX_SS) {              // SuperSource
    int n = src - 6000;
    uint64_t m = visible(atem.ssFond[n], prof + 1);
    for (int b = 0; b < MAX_BOITES; b++) if (atem.ssActive[n][b]) m |= visible(atem.ssSource[n][b], prof + 1);
    return m;
  }
  if (src >= 7001 && src <= 7009) return programme(0, prof + 1, false);   // clean feed
  if (src >= 9001 && src < 9001 + MAX_MV) {              // multiview
    int n = src - 9001;
    uint64_t m = 0;
    for (int f = 0; f < MAX_FEN; f++) m |= visible(atem.mv[n][f], prof + 1);
    return m;
  }
  if (src >= 10010 && src <= 10999) {                    // sortie de M/E : 10010 prog M/E 1, 10011 prev
    int me = (src - 10000) / 10 - 1, quoi = src % 10;
    if (me < 0 || me >= MAX_ME) return 0;
    if (quoi == 0) return programme(me, prof + 1);
    if (quoi == 1) return preview(me, prof + 1);
  }
  return 0;
}

uint64_t programme(int me, int prof, bool avecDsk) {
  bool tr = atem.enTransition[me];
  uint8_t sel = atem.selection[me];
  uint64_t m = visible(atem.prg[me], prof);
  if (tr && (sel & 1)) m |= visible(atem.prv[me], prof);          // mix en cours
  for (int k = 0; k < MAX_CLES; k++)
    if (atem.cleAir[me][k] || (tr && (sel & (2 << k)))) m |= visible(atem.cleFill[me][k], prof);
  if (me == 0 && avecDsk)
    for (int d = 0; d < MAX_DSK; d++)
      if (atem.dskAir[d] || atem.dskTr[d]) m |= visible(atem.dskFill[d], prof);
  return m;
}

uint64_t preview(int me, int prof) {
  uint8_t sel = atem.selection[me];
  uint64_t m = visible((sel & 1) ? atem.prv[me] : atem.prg[me], prof);
  for (int k = 0; k < MAX_CLES; k++)
    if (atem.cleAir[me][k] != (bool)(sel & (2 << k))) m |= visible(atem.cleFill[me][k], prof);
  if (me == 0)
    for (int d = 0; d < MAX_DSK; d++)
      if (atem.dskAir[d] != atem.dskLie[d]) m |= visible(atem.dskFill[d], prof);
  return m;
}

int nbMeConnues() {
  int n = atem.nbMe;
  for (int m = 0; m < MAX_ME; m++) if (atem.prg[m] && n < m + 1) n = m + 1;
  return n < MAX_ME ? n : MAX_ME;
}

void listerEntrees(uint64_t m) {
  bool rien = true;
  for (int k = 0; k < NB_ENTREES; k++) if (m & (1ULL << k)) { Serial.printf("%s%d", rien ? "" : ",", k + 1); rien = false; }
  if (rien) Serial.print("-");
}

// Recalcule chaque M/E, puis combine les M/E choisies par les interrupteurs
void recalculer(bool forcer) {
  int nb = nbMeConnues();
  bool meChange = false;
  for (int m = 0; m < MAX_ME; m++) {
    uint64_t pg = m < nb ? programme(m, 0) : 0, pv = m < nb ? preview(m, 0) : 0;
    if (pg != pgmMe[m] || pv != pvwMe[m]) meChange = true;
    pgmMe[m] = pg; pvwMe[m] = pv;
  }
  if (meChange) {
    for (int m = 0; m < nb; m++) {
      Serial.printf("%sM/E %d PGM ", m ? " | " : "", m + 1); listerEntrees(pgmMe[m]);
      Serial.print(" PVW "); listerEntrees(pvwMe[m]);
    }
    Serial.println();
  }
  uint64_t pg = 0, pv = 0;
  for (int m = 0; m < nb; m++) if (masqueMe & (1 << m)) { pg |= pgmMe[m]; pv |= pvwMe[m]; }
  uint8_t n[40] = {0};
  for (int k = 0; k < NB_ENTREES; k++) n[k] = (pg & (1ULL << k)) ? 1 : (pv & (1ULL << k)) ? 2 : 0;
  if (!forcer && memcmp(n, tally, sizeof(tally)) == 0) return;
  memcpy(tally, n, sizeof(tally));
  Serial.print("Tally :");
  bool rien = true;
  for (int k = 0; k < NB_ENTREES; k++) if (tally[k]) { Serial.printf(" %d:%s", k + 1, tally[k] == 1 ? "PGM" : "PVW"); rien = false; }
  Serial.println(rien ? " aucune entrée" : "");
  diffuser();                                              // tout de suite, sans attendre
}

// ---------------------------------------------------------------------------
//  Lecture des commandes de l'ATEM
// ---------------------------------------------------------------------------
static inline uint16_t u16(const uint8_t *p) { return (p[0] << 8) | p[1]; }

void lireCommande(const char *nom, const uint8_t *c, int l) {
  bool v8 = atem.verMaj > 2 || (atem.verMaj == 2 && atem.verMin >= 28);
  if (!memcmp(nom, "_ver", 4) && l >= 4) { atem.verMaj = u16(c); atem.verMin = u16(c + 2); return; }
  if (!memcmp(nom, "_top", 4) && l >= 1) { atem.nbMe = c[0]; }
  else if (!memcmp(nom, "PrgI", 4) && l >= 4 && c[0] < MAX_ME) atem.prg[c[0]] = u16(c + 2);
  else if (!memcmp(nom, "PrvI", 4) && l >= 4 && c[0] < MAX_ME) atem.prv[c[0]] = u16(c + 2);
  else if (!memcmp(nom, "KeOn", 4) && l >= 3 && c[0] < MAX_ME && c[1] < MAX_CLES) atem.cleAir[c[0]][c[1]] = c[2];
  else if (!memcmp(nom, "KeBS", 4) && l >= 10 && c[0] < MAX_ME && c[1] < MAX_CLES) {
    atem.cleType[c[0]][c[1]] = c[2];
    atem.cleFill[c[0]][c[1]] = u16(c + 8);
  }
  else if (!memcmp(nom, "TrPs", 4) && l >= 2 && c[0] < MAX_ME) atem.enTransition[c[0]] = c[1] & 1;
  else if (!memcmp(nom, "TrSS", 4) && l >= 3 && c[0] < MAX_ME) atem.selection[c[0]] = c[2];
  else if (!memcmp(nom, "DskB", 4) && l >= 4 && c[0] < MAX_DSK) atem.dskFill[c[0]] = u16(c + 2);
  else if (!memcmp(nom, "DskS", 4) && l >= 3 && c[0] < MAX_DSK) { atem.dskAir[c[0]] = c[1]; atem.dskTr[c[0]] = c[2]; }
  else if (!memcmp(nom, "DskP", 4) && l >= 2 && c[0] < MAX_DSK) atem.dskLie[c[0]] = c[1];
  else if (!memcmp(nom, "SSBP", 4)) {
    if (v8 && l >= 6 && c[0] < MAX_SS && c[1] < MAX_BOITES) { atem.ssActive[c[0]][c[1]] = c[2]; atem.ssSource[c[0]][c[1]] = u16(c + 4); }
    else if (!v8 && l >= 4 && c[0] < MAX_BOITES) { atem.ssActive[0][c[0]] = c[1]; atem.ssSource[0][c[0]] = u16(c + 2); }
    else return;
  }
  else if (!memcmp(nom, "SSrc", 4)) {
    if (v8 && l >= 4 && c[0] < MAX_SS) atem.ssFond[c[0]] = u16(c + 2);
    else if (!v8 && l >= 2) atem.ssFond[0] = u16(c);
    else return;
  }
  else if (!memcmp(nom, "MvIn", 4) && l >= 4 && c[0] < MAX_MV && c[1] < MAX_FEN) atem.mv[c[0]][c[1]] = u16(c + 2);
  else if (!memcmp(nom, "InCm", 4)) { Serial.printf("État de l'ATEM reçu : %d M/E\n", atem.nbMe); }
  else return;
  aRecalculer = true;
}

// ---------------------------------------------------------------------------
//  Client ATEM
// ---------------------------------------------------------------------------
void envoyerUdp(const uint8_t *buf, uint16_t len) {
  udp.beginPacket(IPAddress(IP_ATEM[0], IP_ATEM[1], IP_ATEM[2], IP_ATEM[3]), PORT_ATEM);
  udp.write(buf, len);
  udp.endPacket();
}

void envoyerHello() {
  memset(tx, 0, 20);
  sessionId = 0x5300 | (esp_random() & 0xFF);
  tx[0] = F_HELLO; tx[1] = 20;
  tx[2] = sessionId >> 8; tx[3] = sessionId & 0xFF;
  tx[9] = 0x3A;
  tx[12] = 0x01;
  envoyerUdp(tx, 20);
  etat = HELLO_ENVOYE;
  dernierHello = millis();
}

void envoyerAck(uint16_t session, uint16_t id) {
  memset(tx, 0, 12);
  tx[0] = F_ACK; tx[1] = 12;
  tx[2] = session >> 8; tx[3] = session & 0xFF;
  tx[4] = id >> 8; tx[5] = id & 0xFF;
  envoyerUdp(tx, 12);
}

void oublierAtem() {
  memset(&atem, 0, sizeof(atem));
  for (int m = 0; m < MAX_ME; m++) atem.selection[m] = 1;   // par défaut : la transition prend le fond
  memset(pgmMe, 0, sizeof(pgmMe));
  memset(pvwMe, 0, sizeof(pvwMe));
  memset(tally, 0, sizeof(tally));
}

void traiterPaquet(int n) {
  if (n < 12) return;
  uint8_t drapeaux = rx[0] & 0xF8;
  int longueur = ((rx[0] & 0x07) << 8) | rx[1];
  if (longueur < 12 || longueur > n) return;
  uint16_t session = (rx[2] << 8) | rx[3];
  uint16_t idDistant = (rx[10] << 8) | rx[11];

  if (drapeaux & F_HELLO) {
    if (longueur >= 13 && rx[12] == 0x02) {
      envoyerAck(session, 0);
      oublierAtem();
      etat = CONNECTE;
      dernierRecu = millis();
      Serial.println("Connecté à l'ATEM, lecture de son état...");
    } else if (longueur >= 13 && rx[12] == 0x03) {
      Serial.println("L'ATEM refuse la connexion (trop de clients ?)");
    }
    return;
  }
  if (etat != CONNECTE) return;
  dernierRecu = millis();
  sessionId = session;
  if (drapeaux & F_ACK_DEMANDE) envoyerAck(session, idDistant);

  int i = 12;
  while (i + 8 <= longueur) {
    int l = (rx[i] << 8) | rx[i + 1];
    if (l < 8 || i + l > longueur) break;
    lireCommande((const char *)&rx[i + 4], &rx[i + 8], l - 8);
    i += l;
  }
}

// ---------------------------------------------------------------------------
//  Câble réseau
// ---------------------------------------------------------------------------
void afficherChoix() {
  if (masqueMe == 0xFF) { Serial.println("M/E suivies : toutes"); return; }
  Serial.print("M/E suivies :");
  for (int i = 0; i < MAX_ME; i++) if (masqueMe & (1 << i)) Serial.printf(" %d", i + 1);
  Serial.println();
}

void surveillerCable() {
  bool b = ETH.linkUp();
  if (b == cableBranche) return;
  cableBranche = b;
  etat = DECONNECTE;
  dernierHello = 0;
  oublierAtem();
  Serial.println(b ? "Câble réseau branché" : "Câble réseau débranché !");
}

// ---------------------------------------------------------------------------
//  ESP-NOW : trame v2, 8 octets d'en-tête + une case par entrée
// ---------------------------------------------------------------------------
void diffuser() {
  bool ok = etat == CONNECTE;
  uint8_t m[8 + 40];
  m[0] = 'T'; m[1] = 'L'; m[2] = 2;
  m[3] = seq++;
  m[4] = ok ? 1 : 0;
  m[5] = NB_ENTREES;
  m[6] = TTL_MAX;
  m[7] = 0;
  for (int k = 0; k < NB_ENTREES; k++) m[8 + k] = ok ? tally[k] : 0;
  esp_now_send(BROADCAST, m, 8 + NB_ENTREES);
  dernierRadio = millis();
}

void demarrerEspNow() {
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
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_STATUT, OUTPUT);
  digitalWrite(LED_STATUT, HIGH);
  masqueMe = MES_SUIVIES;
  oublierAtem();
  demarrerEspNow();

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ETH.begin(ETH_PHY_LAN8720, ETH_ADRESSE, ETH_MDC_BROCHE, ETH_MDIO_BROCHE, ETH_ALIM, ETH_CLOCK_GPIO0_IN);
#else
  ETH.begin(ETH_ADRESSE, ETH_ALIM, ETH_MDC_BROCHE, ETH_MDIO_BROCHE, ETH_PHY_LAN8720, ETH_CLOCK_GPIO0_IN);
#endif
  IPAddress ip(IP_EMETTEUR[0], IP_EMETTEUR[1], IP_EMETTEUR[2], IP_EMETTEUR[3]);
  IPAddress masque(MASQUE[0], MASQUE[1], MASQUE[2], MASQUE[3]);
  IPAddress routeur(IP_EMETTEUR[0], IP_EMETTEUR[1], IP_EMETTEUR[2], 1);
  ETH.config(ip, routeur, masque);               // IP fixe (pas de DHCP)
  udp.begin(PORT_LOCAL);
  Serial.printf("Ethernet prêt, WT32 en %d.%d.%d.%d\n", IP_EMETTEUR[0], IP_EMETTEUR[1], IP_EMETTEUR[2], IP_EMETTEUR[3]);
  surveillerCable();
  Serial.printf("Émetteur prêt, ATEM %d.%d.%d.%d, ESP-NOW canal %d, entrées 1 à %d\n",
                IP_ATEM[0], IP_ATEM[1], IP_ATEM[2], IP_ATEM[3], CANAL_ESPNOW, NB_ENTREES);
  afficherChoix();
}

void loop() {
  if (millis() - dernierLien >= 1000) { surveillerCable(); dernierLien = millis(); }

  // Paquets de l'ATEM (au plus 20 par tour pour garder la radio régulière)
  for (int k = 0; k < 20; k++) {
    int n = udp.parsePacket();
    if (n <= 0) break;
    int lu = udp.read(rx, sizeof(rx));
    IPAddress ip = udp.remoteIP();
    if (ip[0] == IP_ATEM[0] && ip[1] == IP_ATEM[1] && ip[2] == IP_ATEM[2] && ip[3] == IP_ATEM[3]) traiterPaquet(lu);
  }
  if (aRecalculer) { aRecalculer = false; recalculer(false); }

  if (cableBranche && etat != CONNECTE && millis() - dernierHello >= RELANCE_HELLO_MS) envoyerHello();
  if (etat == CONNECTE && millis() - dernierRecu > TIMEOUT_ATEM_MS) {
    etat = DECONNECTE;
    oublierAtem();
    Serial.println("ATEM perdu, nouvelle tentative...");
  }

  int led = (etat == CONNECTE) ? LOW : HIGH;
  if (led != ledActuelle) { digitalWrite(LED_STATUT, led); ledActuelle = led; }
  if (millis() - dernierRadio >= PERIODE_RADIO_MS) diffuser();
}

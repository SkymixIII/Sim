/* Client tally ATEM : voir atem_client.h */
#include "atem_client.h"
#include "lwip/udp.h"
#include "lwip/pbuf.h"
#include "lwip/netif.h"
#include "lwip/ip_addr.h"
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

#define PORT_ATEM          9910
#define PORT_LOCAL         50910
#define MAX_CAMS           8
#define PERIODE_ENVOI_MS   100
#define TIMEOUT_ATEM_MS    2000
#define RELANCE_HELLO_MS   1000

#define F_ACK_DEMANDE 0x08
#define F_HELLO       0x10
#define F_ACK         0x80

extern struct netif gnetif;   /* défini par CubeMX dans LWIP/App/lwip.c */

typedef enum { DECONNECTE, HELLO_ENVOYE, CONNECTE } EtatAtem;

static struct udp_pcb *pcb;
static ip_addr_t ip_atem;
static UART_HandleTypeDef *uart_esp;
static UART_HandleTypeDef *uart_log;
static EtatAtem etat = DECONNECTE;
static uint16_t session_id = 0x53AB;
static uint32_t dernier_recu, dernier_hello, dernier_envoi;
static uint16_t nb_entrees;
static uint8_t tally[MAX_CAMS];
static uint8_t rx[1500];
static uint8_t tx[32];

static void journal(const char *fmt, ...)
{
  if (uart_log == NULL) return;
  char b[160];
  va_list a;
  va_start(a, fmt);
  int n = vsnprintf(b, sizeof(b), fmt, a);
  va_end(a);
  if (n <= 0) return;
  if (n >= (int)sizeof(b)) n = sizeof(b) - 1;
  HAL_UART_Transmit(uart_log, (uint8_t *)b, (uint16_t)n, 50);
}

static void envoyer_udp(const uint8_t *buf, uint16_t len)
{
  struct pbuf *p = pbuf_alloc(PBUF_TRANSPORT, len, PBUF_RAM);
  if (p == NULL) return;
  memcpy(p->payload, buf, len);
  udp_sendto(pcb, p, &ip_atem, PORT_ATEM);
  pbuf_free(p);
}

static void envoyer_hello(void)
{
  memset(tx, 0, 20);
  session_id = 0x5300 | (HAL_GetTick() & 0xFF);
  tx[0] = F_HELLO; tx[1] = 20;
  tx[2] = session_id >> 8; tx[3] = session_id & 0xFF;
  tx[9] = 0x3A;
  tx[12] = 0x01;                        /* demande de connexion */
  envoyer_udp(tx, 20);
  etat = HELLO_ENVOYE;
  dernier_hello = HAL_GetTick();
}

static void envoyer_ack(uint16_t session, uint16_t id)
{
  memset(tx, 0, 12);
  tx[0] = F_ACK; tx[1] = 12;
  tx[2] = session >> 8; tx[3] = session & 0xFF;
  tx[4] = id >> 8; tx[5] = id & 0xFF;
  envoyer_udp(tx, 12);
}

static void envoyer_esp32(void)
{
  uint8_t m[12];
  m[0] = 0xA5; m[1] = 0x5A;
  m[2] = (etat == CONNECTE) ? 1 : 0;
  for (int k = 0; k < MAX_CAMS; k++) m[3 + k] = (etat == CONNECTE) ? tally[k] : 0;
  uint8_t x = 0;
  for (int k = 2; k <= 10; k++) x ^= m[k];
  m[11] = x;
  HAL_UART_Transmit(uart_esp, m, sizeof(m), 10);
  dernier_envoi = HAL_GetTick();
}

static void lire_tally(int p, int fin)
{
  if (p + 2 > fin) return;
  uint16_t nb = (rx[p] << 8) | rx[p + 1];
  int change = (nb != nb_entrees);
  nb_entrees = nb;
  for (int k = 0; k < MAX_CAMS; k++) {
    uint8_t f = (k < nb && p + 2 + k < fin) ? (rx[p + 2 + k] & 0x03) : 0;
    if (f != tally[k]) change = 1;
    tally[k] = f;
  }
  if (change) {
    char ligne[96];
    int n = snprintf(ligne, sizeof(ligne), "Tally ATEM :");
    for (int k = 0; k < MAX_CAMS && k < nb && n < (int)sizeof(ligne) - 8; k++)
      n += snprintf(ligne + n, sizeof(ligne) - n, " %d:%s", k + 1,
                    (tally[k] & 1) ? "PGM" : (tally[k] & 2) ? "PVW" : "-");
    journal("%s\r\n", ligne);
    envoyer_esp32();                    /* tout de suite, sans attendre les 100 ms */
  }
}

static void traiter_paquet(int n)
{
  if (n < 12) return;
  uint8_t drapeaux = rx[0] & 0xF8;
  int longueur = ((rx[0] & 0x07) << 8) | rx[1];
  if (longueur < 12 || longueur > n) return;
  uint16_t session = (rx[2] << 8) | rx[3];
  uint16_t id_distant = (rx[10] << 8) | rx[11];

  if (drapeaux & F_HELLO) {
    if (longueur >= 13 && rx[12] == 0x02) {
      envoyer_ack(session, 0);
      etat = CONNECTE;
      dernier_recu = HAL_GetTick();
      journal("Connecte a l'ATEM\r\n");
    } else if (longueur >= 13 && rx[12] == 0x03) {
      journal("L'ATEM refuse la connexion (trop de clients ?)\r\n");
    }
    return;
  }
  if (etat != CONNECTE) return;
  dernier_recu = HAL_GetTick();
  session_id = session;
  if (drapeaux & F_ACK_DEMANDE) envoyer_ack(session, id_distant);

  int i = 12;
  while (i + 8 <= longueur) {
    int l = (rx[i] << 8) | rx[i + 1];
    if (l < 8 || i + l > longueur) break;
    if (memcmp(&rx[i + 4], "TlIn", 4) == 0) lire_tally(i + 8, i + l);
    i += l;
  }
}

static void sur_reception(void *arg, struct udp_pcb *upcb, struct pbuf *p,
                          const ip_addr_t *addr, u16_t port)
{
  (void)arg; (void)upcb; (void)port;
  if (ip_addr_cmp(addr, &ip_atem)) {
    uint16_t n = pbuf_copy_partial(p, rx, sizeof(rx), 0);
    traiter_paquet(n);
  }
  pbuf_free(p);
}

static void leds(int connecte)
{
#ifdef LD1_Pin
  HAL_GPIO_WritePin(LD1_GPIO_Port, LD1_Pin, connecte ? GPIO_PIN_SET : GPIO_PIN_RESET);
#endif
#ifdef LD3_Pin
  HAL_GPIO_WritePin(LD3_GPIO_Port, LD3_Pin, connecte ? GPIO_PIN_RESET : GPIO_PIN_SET);
#endif
}

void atem_init(UART_HandleTypeDef *esp, UART_HandleTypeDef *log)
{
  uart_esp = esp;
  uart_log = log;
  IP_ADDR4(&ip_atem, ATEM_IP0, ATEM_IP1, ATEM_IP2, ATEM_IP3);
  pcb = udp_new();
  if (pcb == NULL || udp_bind(pcb, IP_ADDR_ANY, PORT_LOCAL) != ERR_OK) {
    journal("Erreur : socket UDP impossible\r\n");
    return;
  }
  udp_recv(pcb, sur_reception, NULL);
  journal("Nucleo pret, ATEM %d.%d.%d.%d\r\n", ATEM_IP0, ATEM_IP1, ATEM_IP2, ATEM_IP3);
}

void atem_tick(void)
{
  if (pcb == NULL) return;
  uint32_t maintenant = HAL_GetTick();
  static int lien_avant = -1;
  int lien = netif_is_link_up(&gnetif) ? 1 : 0;
  if (lien != lien_avant) {
    journal(lien ? "Cable RJ45 branche\r\n" : "Cable RJ45 debranche\r\n");
    lien_avant = lien;
  }

  if (etat != CONNECTE && lien && maintenant - dernier_hello >= RELANCE_HELLO_MS) envoyer_hello();

  if (etat == CONNECTE && maintenant - dernier_recu > TIMEOUT_ATEM_MS) {
    etat = DECONNECTE;
    memset(tally, 0, sizeof(tally));
    journal("ATEM perdu, nouvelle tentative...\r\n");
  }

  leds(etat == CONNECTE);
  if (maintenant - dernier_envoi >= PERIODE_ENVOI_MS) envoyer_esp32();
}

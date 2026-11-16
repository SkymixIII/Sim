/* ============================================================================
 *  Client tally ATEM pour NUCLEO-H753ZI (STM32CubeIDE + LwIP, sans RTOS)
 * ----------------------------------------------------------------------------
 *  Se connecte à l'ATEM en UDP 9910 par le RJ45 du Nucleo, lit le tally (TlIn)
 *  et l'envoie à l'ESP32 émetteur par liaison série, 10 fois par seconde :
 *    0xA5 0x5A | ATEM ok | caméras 1 à 8 (bit 0 PGM, bit 1 PVW) | XOR des octets 2 à 10
 *  Même protocole que nucleo_atem.ino : le code de l'ESP32 émetteur ne change pas.
 * ========================================================================== */
#ifndef ATEM_CLIENT_H
#define ATEM_CLIENT_H

#include "main.h"

/* Adresse de l'ATEM (celle du Nucleo se règle dans CubeMX, onglet LWIP). */
#define ATEM_IP0 192
#define ATEM_IP1 168
#define ATEM_IP2 2
#define ATEM_IP3 20

/* uart_esp : liaison vers l'ESP32 (USART1, D1 = PB6).
 * uart_log : port série du ST-Link (USART3) pour les messages, ou NULL. */
void atem_init(UART_HandleTypeDef *uart_esp, UART_HandleTypeDef *uart_log);

/* À appeler dans la boucle while(1) de main.c, juste après MX_LWIP_Process(). */
void atem_tick(void);

#endif

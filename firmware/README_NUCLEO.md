# Variante NUCLEO-H753ZI + ESP32 DevKit V1

```
ATEM 192.168.2.20 ── RJ45 ──> NUCLEO-H753ZI ── série 115200 ──> ESP32 DevKit V1 ── ESP-NOW ──> tally_cam1 … tally_cam8
                              192.168.2.51     D1 -> RX2 (GPIO16)  (émetteur)                   + antennes relais
                                               D0 <- TX2 (GPIO17)
                                               GND -- GND
```

| Dossier | Carte | Rôle |
|---|---|---|
| `nucleo_atem/` | NUCLEO-H753ZI | Client ATEM sur le RJ45 du Nucleo, envoie le tally à l'ESP32 par sa liaison série D1/D0. |
| `emetteur_esp32_uart/` | ESP32 DevKit V1 | Lit le tally sur RX2 et le diffuse en ESP-NOW (même trame v2 que l'émetteur WT32-ETH01). |
| `tally_devkit/tally_camN/` | ESP32 DevKit V1 | Tally de la caméra N : LED rouge D18 (120 Ω), verte D19 (47 Ω), bleue D21 (33 Ω). Relaie le maillage. |

Liaison série Nucleo → ESP32 (12 octets, 10 fois par seconde et à chaque changement) :
`0xA5 0x5A | ATEM ok | caméras 1 à 8 (bit 0 PGM, bit 1 PVW) | XOR des octets 2 à 10`.

Nucleo dans l'Arduino IDE : gestionnaire de cartes « STM32 MCU based boards », carte Nucleo-144 → Nucleo H753ZI,
bibliothèques « STM32duino LwIP » et « STM32duino STM32Ethernet ». Régler `IP_ATEM` / `IP_NUCLEO` en haut du code.

Ces codes ont été vérifiés en syntaxe C++ seulement : ils n'ont pas encore été compilés avec les cores STM32 et ESP32, ni essayés sur les cartes.

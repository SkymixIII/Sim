# Firmware du tally ATEM 4 lampes

Trois programmes Arduino pour le système décrit dans `tally_atem_4_lampes.csv` :

```
 ATEM 2 M/E Constellation          WT32-ETH01                      4 × ESP32-C3 Super Mini
 (ou émulateur ATEM)  ── RJ45 ──>  émetteur  ── ESP-NOW canal 1 ──> lampes (WS2812B)
 192.168.10.240                    192.168.10.50   (10 trames/s)    CAM 1, 2, 1, 2
```

| Dossier | Carte | Rôle |
|---|---|---|
| `emetteur_wt32eth01/` | WT32-ETH01 | Client ATEM sur le RJ45, rediffuse le tally en ESP-NOW. LED statut GPIO2 allumée = pas d'ATEM. |
| `lampe_esp32c3/` | ESP32-C3 Super Mini | Rouge = programme, vert = preview, orange clignotant = liaison perdue. |
| `atem_emulateur/` | WT32-ETH01 | Faux mélangeur ATEM à 4 boutons, pour tester sans le vrai. |

Le même comportement tourne dans l'Établi : menu **Charger un montage… → Tally ATEM 4 lampes**. Les sketches du simulateur suivent la même logique et échangent les mêmes octets ; seules les entrées/sorties réseau diffèrent (`Rj45.*` / `EspNow.*` au lieu de `WiFiUDP` / `esp_now_*`), parce que le simulateur n'exécute qu'un sous-ensemble d'Arduino.

## Installation

1. Arduino IDE 2, gestionnaire de cartes : **esp32 by Espressif** (2.x ou 3.x, les deux sont gérés).
2. Lampes uniquement : bibliothèque **Adafruit NeoPixel** (gestionnaire de bibliothèques).
3. Réglages de carte :
   - WT32-ETH01 : « ESP32 Dev Module ». Pour téléverser, il faut un adaptateur USB-série 3,3 V (TX0/RX0) et IO0 relié à GND au démarrage.
   - ESP32-C3 Super Mini : « ESP32C3 Dev Module », **USB CDC On Boot : Enabled** pour voir le moniteur série.

## Réglages à adapter

- **Lampe** : `CAM` en haut de `lampe_esp32c3.ino` (1 pour les lampes 1 et 3, 2 pour les lampes 2 et 4), `NB_LEDS` si c'est un anneau ou un ruban, `LUMINOSITE`.
- **Émetteur** : adresses IP et `CANAL_ESPNOW`. Le canal doit être le même sur les lampes.
- **Vrai ATEM** : régler son adresse sur 192.168.10.240 / 255.255.255.0 (ATEM Setup), ou changer `IP_ATEM` dans l'émetteur. Le câble RJ45 direct suffit, sans switch.

## Protocoles

**ATEM (UDP 9910)**, partie utilisée : poignée de main (paquet `0x10` avec `0x01` → réponse `0x02`), acquittement de chaque paquet marqué « ack demandé » (`0x08`), lecture de la commande `TlIn` (un octet par entrée : bit 0 programme, bit 1 preview). Sans paquet de l'ATEM pendant 2 s, l'émetteur se reconnecte tout seul.

**Trame ESP-NOW** (14 octets, diffusion à FF:FF:FF:FF:FF:FF) :

| Octet | Contenu |
|---|---|
| 0–1 | `'T' 'L'` |
| 2 | version = 1 |
| 3 | numéro de trame |
| 4 | 1 si l'émetteur est connecté à l'ATEM |
| 5 | nombre de caméras (8) |
| 6… | une case par caméra : bit 0 programme, bit 1 preview |

Si l'émetteur perd l'ATEM, il continue d'émettre avec l'octet 4 à 0 : les lampes clignotent en orange au lieu de garder un tally périmé.

## Écarts avec l'établi

- Sur l'établi, la WS2812B de chaque lampe est remplacée par deux LED (rouge GPIO18, verte GPIO19). Sur l'ESP32-C3 réel, GPIO18/19 sont l'USB : le firmware pilote la WS2812B sur GPIO4 (via 330 Ω).
- Sur l'émulateur ATEM réel (WT32-ETH01), GPIO18 sert à l'Ethernet : le bouton CAM 2 CUT passe sur **GPIO14**.
- Les trois sketches ont été vérifiés en syntaxe C++ et leur logique est testée de bout en bout dans le simulateur (`npm test`). Ils n'ont pas encore été compilés avec le core ESP32 ni essayés sur les vraies cartes.

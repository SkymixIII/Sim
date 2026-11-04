# Firmware du tally ATEM 8 caméras

```
 ATEM 2 M/E Constellation HD         WT32-ETH01                       8 × ESP32-C3 Super Mini
 192.168.10.240        ── RJ45 ──>   émetteur    ── ESP-NOW canal 1 ──>  une lampe par caméra
 (protocole ATEM, UDP 9910)          192.168.10.50   (10 trames/s)      (WS2812B)
```

| Dossier | Carte | Rôle |
|---|---|---|
| `emetteur_wt32eth01/` | WT32-ETH01 | Se connecte à l'ATEM par le RJ45, lit son tally et le rediffuse en ESP-NOW. LED statut GPIO2 allumée = pas d'ATEM. |
| `lampe_esp32c3/` | ESP32-C3 Super Mini | Une seule couleur à la fois, priorité **BLEU > ROUGE > VERT**. |

Couleurs de la lampe :

| Couleur | Signification |
|---|---|
| Bleu fixe | Plus de liaison radio avec l'émetteur (rien reçu depuis 2 s) |
| Bleu clignotant | L'émetteur répond, mais il n'a plus l'ATEM |
| Rouge | Caméra au programme (et pendant un AUTO, la caméra entrante) |
| Vert | Caméra en preview |
| Éteinte | Caméra hors antenne |

Le même système tourne dans l'Établi (montage **Tally ATEM 8 caméras**). L'ATEM y est modélisé côté réseau, avec son pupitre PGM / PVW / CUT / AUTO. Les sketches du simulateur suivent la même logique et échangent les mêmes octets. Seules les entrées/sorties réseau diffèrent (`Rj45.*` / `EspNow.*` au lieu de `WiFiUDP` / `esp_now_*`).

## Installation

1. Arduino IDE 2, gestionnaire de cartes : **esp32 by Espressif** (2.x ou 3.x, les deux sont gérés).
2. Lampes uniquement : bibliothèque **Adafruit NeoPixel**.
3. Réglages de carte :
   - WT32-ETH01 : « ESP32 Dev Module ». Pour téléverser, il faut un adaptateur USB-série 3,3 V (TX0/RX0), avec IO0 relié à GND au démarrage.
   - ESP32-C3 Super Mini : « ESP32C3 Dev Module », **USB CDC On Boot : Enabled**.

## Réglages

- **Lampe** : `CAM` (de 1 à 8) en haut de `lampe_esp32c3.ino`, une valeur différente par lampe. Il est aussi possible de régler `NB_LEDS` (anneau ou ruban) et `LUMINOSITE`.
- **Émetteur** : les adresses IP et `CANAL_ESPNOW`, qui doit être identique sur les lampes.
- **ATEM** : 192.168.10.240 / 255.255.255.0 est son adresse par défaut. Sinon, la régler dans ATEM Setup ou changer `IP_ATEM` dans l'émetteur. Le câble RJ45 se branche en direct, sans switch.

## Protocoles

**ATEM (UDP 9910)** : partie utilisée par l'émetteur.
- Poignée de main : paquet `0x10` avec `0x01`, réponse `0x02`.
- L'ATEM attribue ensuite une session et envoie son état initial (`_ver`, `_pin`, `PrgI`, `PrvI`, `TlIn`, `InCm`).
- L'émetteur acquitte chaque paquet marqué `0x08`. Sans acquittement, l'ATEM renvoie le paquet puis coupe la session.
- L'émetteur lit `TlIn` : un octet par entrée, bit 0 programme, bit 1 preview.
- Sans nouvelles de l'ATEM pendant 2 s, l'émetteur se reconnecte.

**Trame ESP-NOW** (14 octets, diffusée à FF:FF:FF:FF:FF:FF) :

| Octet | Contenu |
|---|---|
| 0–1 | `'T' 'L'` |
| 2 | version = 1 |
| 3 | numéro de trame |
| 4 | 1 si l'émetteur est connecté à l'ATEM |
| 5 | nombre de caméras (8) |
| 6–13 | caméras 1 à 8 : bit 0 programme, bit 1 preview |

## Écarts avec l'établi

- Sur l'établi, la WS2812B de chaque lampe est remplacée par 3 LED : rouge sur GPIO18, verte sur GPIO19, bleue sur GPIO21. Sur l'ESP32-C3 réel, GPIO18 et 19 sont l'USB : le firmware pilote donc la WS2812B sur GPIO4, via une résistance de 330 Ω.
- Le firmware a été vérifié en syntaxe C++, et sa logique est testée de bout en bout dans le simulateur (`npm test`). Il n'a pas encore été compilé avec le core ESP32, ni essayé sur les vraies cartes.

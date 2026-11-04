# Firmware du tally ATEM 8 caméras (radio maillée)

```
 ATEM 2 M/E Constellation HD         WT32-ETH01                       8 × ESP32-C3 Super Mini
 192.168.10.240        ── RJ45 ──>   émetteur    ── ESP-NOW canal 1 ──>  une lampe par caméra,
 (protocole ATEM, UDP 9910)          192.168.10.50   (10 trames/s)      chacune relaie la trame
                                                                        + antennes relais ESP32 (sans caméra)
```

| Dossier | Carte | Rôle |
|---|---|---|
| `emetteur_wt32eth01/` | WT32-ETH01 | Se connecte à l'ATEM par le RJ45, lit son tally et le rediffuse en ESP-NOW. LED statut GPIO2 allumée = pas d'ATEM. |
| `lampe_esp32c3/` | ESP32-C3 Super Mini | Une seule couleur à la fois, priorité **BLEU > ROUGE > VERT**. Relaie chaque trame nouvelle (maillage). |
| `antenne_esp32/` | ESP32-WROOM-32U + antenne externe | Antenne relais : ne suit aucune caméra, rediffuse les trames pour couvrir plus loin. LED bleue comme sur les lampes, LED orange qui flashe à chaque trame retransmise. |

LED de l'antenne :

| LED | Signification |
|---|---|
| Bleue fixe | Plus aucune trame reçue depuis 2 s |
| Bleue clignotante | L'émetteur répond, mais il n'a plus l'ATEM |
| Orange qui clignote | L'antenne retransmet des trames (un flash de 40 ms par trame, environ 10 par seconde) |
| Orange éteinte | Rien à relayer (aucune trame reçue, ou TTL épuisé) |

Couleurs de la lampe :

| Couleur | Signification |
|---|---|
| Bleu fixe | Plus aucune trame reçue depuis 2 s (ni de l'émetteur, ni d'une autre lampe) |
| Bleu clignotant | L'émetteur répond, mais il n'a plus l'ATEM |
| Rouge | Caméra au programme (et pendant un AUTO, la caméra entrante) |
| Vert | Caméra en preview |
| Éteinte | Caméra hors antenne |

Le même système tourne dans l'Établi (montage **Tally ATEM 8 caméras**). L'ATEM y est modélisé côté réseau, avec son pupitre PGM / PVW / CUT / AUTO. Les sketches du simulateur suivent la même logique et échangent les mêmes octets. Seules les entrées/sorties réseau diffèrent (`Rj45.*` / `EspNow.*` au lieu de `WiFiUDP` / `esp_now_*`).

## Maillage : comment la portée est étendue

ESP-NOW ne fait pas de maillage tout seul. Les lampes utilisent une **inondation contrôlée**, la méthode la plus simple et la plus rapide pour un message court envoyé à tout le monde :

1. L'émetteur diffuse la trame avec un **numéro** (0 à 255, puis on recommence) et un **TTL** de 6.
2. Une lampe qui reçoit une trame **nouvelle** (numéro plus récent que la dernière acceptée) l'applique, puis la **rediffuse une seule fois**, avec TTL − 1 et sauts + 1, après un délai au hasard de 2 à 14 ms. Le délai évite que toutes les voisines émettent au même instant.
3. Une trame déjà vue (même numéro, arrivée par un autre chemin) est ignorée. Une trame dont le TTL vaut 1 n'est plus relayée. Il n'y a donc ni boucle ni tempête.

Résultat : une lampe hors de portée de l'émetteur reçoit le tally par ses voisines, avec quelques millisecondes de retard par saut (au plus 6 sauts). Il n'y a pas de table de routage à configurer : on ajoute une lampe, elle relaie. Pour le voir, le moniteur série de chaque lampe affiche « Trame reçue en N saut(s) ».

À savoir :
- Toutes les lampes doivent être sur le **même canal**. Une lampe éteinte ne relaie plus : placez-les de façon à garder au moins deux chemins vers le fond du plateau.
- Le trafic reste léger : 10 trames/s × (1 + 8 lampes + 2 antennes) ≈ 110 petits paquets par seconde.
- On peut désactiver le relais d'une lampe avec `RELAIS = false`, par exemple pour une lampe sur batterie.
- Pour gagner encore en portée, on ajoute des **antennes relais** (`antenne_esp32/`) : un ESP32 à antenne externe, alimenté en USB, placé en hauteur entre l'émetteur et le fond du plateau. Il relaie comme une lampe, mais porte plus loin (90 m dans l'établi, contre 60 m pour une lampe) et ne dépend pas d'une caméra allumée. On peut en mettre autant qu'on veut sans rien régler. Le mode Wi-Fi « Long Range » (`WIFI_PROTOCOL_LR`) est une autre piste, mais toutes les cartes doivent alors l'activer.

Dans l'Établi, l'onglet **Radio** du montage permet de placer les appareils sur un plan en mètres, de régler la portée de chacun et d'ajouter un obstacle entre deux appareils. On y voit par quel chemin chaque lampe reçoit vraiment la trame.

## Installation

1. Arduino IDE 2, gestionnaire de cartes : **esp32 by Espressif** (2.x ou 3.x, les deux sont gérés).
2. Lampes uniquement (pas les antennes) : bibliothèque **Adafruit NeoPixel**.
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

**Trame ESP-NOW v2** (16 octets, diffusée à FF:FF:FF:FF:FF:FF) :

| Octet | Contenu |
|---|---|
| 0–1 | `'T' 'L'` |
| 2 | version = 2 |
| 3 | numéro de trame (sert à éliminer les doublons) |
| 4 | 1 si l'émetteur est connecté à l'ATEM |
| 5 | nombre de caméras (8) |
| 6 | TTL : relais encore permis (6 au départ de l'émetteur) |
| 7 | sauts déjà faits (0 au départ de l'émetteur) |
| 8–15 | caméras 1 à 8 : bit 0 programme, bit 1 preview |

L'émetteur et les lampes doivent être mis à jour ensemble : une lampe v2 ignore les trames v1.

## Écarts avec l'établi

- Sur l'établi, la WS2812B de chaque lampe est remplacée par 3 LED : rouge sur GPIO18, verte sur GPIO19, bleue sur GPIO21. Sur l'ESP32-C3 réel, GPIO18 et 19 sont l'USB : le firmware pilote donc la WS2812B sur GPIO4, via une résistance de 330 Ω.
- Les antennes de l'établi sont des ESP32 génériques avec deux LED discrètes (orange GPIO18 via 150 Ω, bleue GPIO19 via 33 Ω), câblées de la même façon que sur la vraie carte.
- Le firmware a été vérifié en syntaxe C++, et sa logique est testée de bout en bout dans le simulateur (`npm test`). Il n'a pas encore été compilé avec le core ESP32, ni essayé sur les vraies cartes.

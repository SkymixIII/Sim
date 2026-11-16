# Architecture d'Établi

Établi est un émulateur de circuits électroniques qui tourne entièrement dans le navigateur. Le principe directeur : **chaque composant se comporte comme le vrai**, avec des paramètres tirés de sa fiche technique et des tests qui le prouvent.

## Vue d'ensemble

```
index.html, style.css
src/
  engine/              Le simulateur (aucune dépendance au navigateur)
    solver.js          MNA + Newton-Raphson, limitation de jonction, source stepping
    devices.js         Briques physiques : jonction PN, Thévenin, ajustement Is depuis VF
    circuit.js         Schéma -> netlist, masse, PWM moyenné, détection de casse
    units.js           Formatage SI (4k7, 220 Ω, 5,84 mA)
    network.js         Liens virtuels entre cartes : RJ45 (UDP) et radio ESP-NOW
  components/          Un fichier par famille de composants (le "plugin")
    index.js           Registre : la liste des composants disponibles
    passives.js        Masse, résistance, potentiomètre, interrupteur, bouton
    sources.js         Alimentation DC, piles (Thévenin), source de courant
    semiconductors.js  Diodes (1N4148, 1N4007, 1N5819, Zener 1N4733A), LED
    esp32.js           Carte ESP32-DevKitC : GPIO, pull-ups, diodes de protection, ADC
    atem.js            Mélangeur ATEM Constellation, côté réseau (protocole UDP 9910)
  runtime/
    arduino.js         Exécute un sketch Arduino (sous-ensemble) sur l'ESP32 simulé
    bench.js           Banc d'essai : un sketch par carte, circuit commun, réseau virtuel
  ui/
    app.js             Plan de travail SVG, palette, mesures, éditeur de code, liens
    example.js         Montage et sketch de démonstration
    montages/tally.js  Tally ATEM 8 caméras : ATEM, émetteur, 8 lampes et 2 antennes relais, avec leurs sketches
firmware/              Firmware Arduino réel des montages (voir firmware/README.md)
tests/
  datasheet.test.mjs   Chaque modèle confronté aux points de sa fiche technique
  tally.test.mjs       Le tally complet tourne : pupitre ATEM, câble, radio, LED ; renvois du protocole ATEM
docs/
  AJOUTER-UN-COMPOSANT.md   Procédure suivie par Claude pour intégrer un nouveau composant
```

## Le moteur

On utilise la même méthode que SPICE pour le point de fonctionnement continu (`.op`) :

1. **Analyse nodale modifiée (MNA).** Chaque composant "estampille" sa contribution dans une matrice `A·x = b`. Les inconnues sont les tensions des nœuds et les courants des sources de tension.
2. **Newton-Raphson.** Les composants non linéaires (diodes, LED, diodes de protection de l'ESP32) sont linéarisés autour de la solution courante, puis on itère jusqu'à convergence.
3. **Robustesse.** Limitation de tension de jonction (`pnjlim` de SPICE), conductance minimale `GMIN` sur chaque nœud, redémarrage à froid puis *source stepping* si la convergence échoue.
4. **PWM.** Une sortie PWM n'est pas approximée par une tension moyenne (faux pour une LED, qui est non linéaire). On résout le circuit dans chaque phase (HIGH/LOW) et on moyenne les courants et puissances pondérés par le rapport cyclique. Les alertes utilisent les valeurs crêtes.
5. **Casse.** Après chaque résolution, chaque composant décrit son état. S'il est détruit (LED à plus de 100 mA, résistance à plus de 2× sa puissance nominale), il devient un circuit ouvert et on résout à nouveau, comme dans la réalité.

Limite actuelle : analyse **continue / quasi statique**. Les condensateurs, bobines et phénomènes rapides (rebonds, temps de montée) demandent une analyse transitoire, prévue à l'étape suivante (intégration trapézoïdale, même interface `stamp`).

## Le contrat d'un composant

Un composant est un objet JavaScript. Le moteur et l'interface ne connaissent que ce contrat, ce qui permet d'en ajouter sans toucher au reste.

| Champ | Rôle |
|---|---|
| `type`, `name`, `category`, `summary` | Identité et place dans la palette |
| `pins` | Broches en coordonnées de grille locales (`{ id, label, x, y }`) |
| `bounds`, `rotatable`, `interactive` | Zone cliquable, rotation, interaction (bouton, interrupteur) |
| `params` | Paramètres réglables (`number`, `select`, `range`, `bool`) avec valeur par défaut |
| `datasheet` | Source et notes : ce que le modèle reproduit et ses limites |
| `internalNodes(inst)`, `branches(inst)` | Nœuds internes (ex. résistance série d'une diode) et sources de tension |
| `stamp(ctx, inst, nodes, branches, state)` | Contribution linéarisée à la matrice |
| `evaluate(ctx, inst, nodes, branches)` | Grandeurs numériques après résolution (`V`, `I`, `P`…) |
| `describe(inst, avg, peak)` | Mesures lisibles, alertes, et éventuelle casse (`damage`) |
| `symbol(inst, avg)`, `label(inst)` | Dessin SVG (unité : 20 px par pas de grille) |

L'API `ctx` offerte à `stamp` : `v(n)`, `conductance(a, b, g)`, `current(a, b, I)`, `voltageSource(a, b, V, k)`, `branchI(k)`, `markLimited()`, `srcFactor`, `tempC`. Les briques de `devices.js` (`stampJunction`, `stampThevenin`, `fitIsFromVf`…) couvrent la plupart des besoins.

## L'ESP32

Le modèle électrique suit le tableau *DC Characteristics* de la fiche Espressif :

- sortie : Thévenin calé sur VOH = 0,8·VDD et VOL = 0,495 V au courant nominal de la *drive strength* (20 mA par défaut) ;
- entrée : seuils VIH = 0,75·VDD et VIL = 0,25·VDD, zone indéterminée entre les deux, fuite 50 nA ;
- pull-up / pull-down internes de 45 kΩ, absents sur GPIO34 à 39 (entrées seules) ;
- diodes de protection vers 3,3 V et GND : mettre 5 V sur une broche fait réellement circuler du courant, et l'interface alerte ;
- états après reset des broches de strapping (GPIO2 en pull-down, GPIO5 en pull-up).

Le code est un **sous-ensemble d'Arduino** converti en JavaScript asynchrone (`delay()` rend la main au navigateur). Ce n'est pas une émulation du processeur Xtensa : le timing est celui du navigateur, et les bibliothèques C++ ne sont pas disponibles. Une étape ultérieure pourra brancher un vrai émulateur de jeu d'instructions (QEMU-ESP32 compilé en WebAssembly) sur la même interface `setPin / read`.

## Plusieurs cartes et liens virtuels

Chaque composant programmable porte son propre code (`code`), un nom (`name`) et, s'il représente une autre carte réelle, `realBoard` (ex. WT32-ETH01) : le modèle électrique reste celui de la DevKitC, le nom réel est affiché sur la carte. `runtime/bench.js` lance un `SketchRunner` par carte ; toutes partagent la même simulation électrique.

Ce qui n'est pas un fil de cuivre passe par `circuit.links` : `{ id, kind: "rj45" | "espnow", a, b, cut, loss }`. `engine/network.js` livre les octets :

- **rj45** : point à point, sans perte, monté si le câble est branché et que les deux cartes tournent.
- **espnow** : diffusion vers toutes les cartes reliées, sur le même canal Wi-Fi, avec une perte réglable (portée).
- **carte radio** (`circuit.radio`, prioritaire sur les liens espnow) : chaque appareil a une position en mètres et une portée, chaque paire un obstacle éventuel. Une diffusion atteint tout appareil allumé sur le même canal avec une probabilité qui dépend de la distance (100 % jusqu'à 70 % de la portée de l'émetteur, puis décroissante). C'est ce qui permet de simuler le maillage des lampes.

Dans un sketch : `Rj45.send(buf, n)`, `n = Rj45.receive(buf)`, `Rj45.linkUp()`, `EspNow.begin(canal)`, `EspNow.broadcast(buf, n)`, `n = EspNow.receive(buf)`. Les tableaux sont passés par référence, comme un `uint8_t*`. Sur le plan, un clic sur un lien permet de le débrancher, de le mettre hors de portée ou d'en lire le trafic.

### Appareils réseau

Un composant sans broche qui déclare `device` (une classe avec `tick()`) est un appareil réseau : le banc l'exécute toutes les 5 ms avec son port du réseau virtuel, sans sketch. C'est le cas de l'ATEM (`components/atem.js`) : poignée de main, état initial en plusieurs paquets, renvoi des paquets non acquittés, ping toutes les 500 ms, client oublié après 2,5 s de silence, tally `TlIn` et position de transition `TrPs` pendant un AUTO. Son pupitre est cliquable (`press(inst, down, key)` reçoit la touche via `data-key`).

## Pile technique et suite

- Aujourd'hui : JavaScript moderne (modules ES), SVG, aucune dépendance, tests avec `node --test`.
- Dès que le dépôt existe : Vite pour le développement, TypeScript progressif sur `engine/` et `components/`, CI GitHub Actions qui lance les tests de fiches techniques sur chaque PR.
- Feuille de route : analyse transitoire (condensateurs, bobines, oscilloscope), transistors (2N2222, IRLZ44N), régulateurs (AMS1117), capteurs (DHT22, BME280) avec leurs protocoles, I²C/SPI simulés, export/import de montages.

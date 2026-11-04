# Architecture d'Établi

Établi est un émulateur de circuits électroniques qui tourne entièrement dans le navigateur. Le principe directeur : **chaque composant se comporte comme le vrai**, avec des paramètres tirés de sa fiche technique et des tests qui le prouvent.

## Vue d'ensemble

```
index.html, style.css
src/
  engine/              Le simulateur (aucune dépendance au navigateur)
    solver.js          MNA + Newton-Raphson, limitation de jonction, source stepping, analyse transitoire
    ltc.js             Codeur / décodeur de timecode LTC (SMPTE 12M)
    measure.js         Mesures d'oscilloscope : crête à crête, fronts 10-90 %, décodage LTC
    tran-worker.js     Analyse transitoire dans un Web Worker
    devices.js         Briques physiques : jonction PN, Thévenin, ajustement Is depuis VF
    circuit.js         Schéma -> netlist, masse, PWM moyenné, détection de casse
    units.js           Formatage SI (4k7, 220 Ω, 5,84 mA)
  components/          Un fichier par famille de composants (le "plugin")
    index.js           Registre : la liste des composants disponibles
    passives.js        Masse, résistance, potentiomètre, condensateur, interrupteur, bouton
    sources.js         Alimentation DC, piles (Thévenin), source de courant, générateur (sinus, carré, LTC)
    semiconductors.js  Diodes (1N4148, 1N4007, 1N5819, BAT54, Zener 1N4733A), LED
    analog.js          Comparateur TLV3201, ampli op TLV9061
    instruments.js     Oscilloscope deux voies
    esp32.js           Carte ESP32-DevKitC : GPIO, pull-ups, diodes de protection, ADC
  runtime/
    arduino.js         Exécute un sketch Arduino (sous-ensemble) sur l'ESP32 simulé
  ui/
    app.js             Plan de travail SVG, palette, mesures, éditeur de code
    example.js         Montage et sketch de démonstration
tests/
  datasheet.test.mjs   Chaque modèle confronté aux points de sa fiche technique
  transient.test.mjs   Analyse transitoire : RC analytique, LTC, boîtier timecode comparé à ngspice
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

## L'analyse transitoire

L'onglet **Oscilloscope** simule le circuit dans le temps, comme le `.tran` de SPICE (`solveTransient` dans `solver.js`) :

1. **Point de départ.** Le point de fonctionnement DC, où chaque générateur délivre sa valeur moyenne : c'est l'état établi d'un signal qui tourne depuis longtemps, et les condensateurs de liaison sont chargés en conséquence.
2. **Intégration.** Pas fixe, méthode des trapèzes (précise à l'ordre 2, sans amortissement artificiel). Le premier pas, et tout pas redécoupé, utilise Euler implicite pour amortir les discontinuités.
3. **Robustesse.** Si Newton ne converge pas sur un pas, celui-ci est découpé en 4, jusqu'à 3 fois.
4. **Condensateurs.** `ctx.capacitor(state, clé, a, b, C)` pose le modèle compagnon (conductance + source de courant) ; le moteur met à jour la tension et le courant mémorisés quand le pas est accepté. En DC, c'est un circuit ouvert.
5. **Mesures.** Pour chaque composant, moyenne temporelle et extrêmes des grandeurs d'`evaluate`, passés à `describe` comme pour le PWM : les alertes (courant crête dans une diode, slew rate dépassé, tension inverse) portent sur toute la durée simulée. Chaque voie d'oscilloscope est mesurée (`measure.js`) et décodée en LTC.
6. **Web Worker.** Le calcul tourne dans `tran-worker.js` pour ne pas figer l'interface (environ 50 000 pas par seconde sur les montages du boîtier timecode, 10 à 15 nœuds).

Validation (`tests/transient.test.mjs`) : charge RC comparée à l'exponentielle exacte (erreur < 0,1 %), et circuits d'entrée et de sortie du boîtier timecode comparés aux simulations ngspice de `projets/timecode-ltc` : amplitudes à 0,1 % près, fronts à 0,3 µs près, retard du comparateur à 1 µs près (le pas de calcul).

Pas encore couverts : bobines, pas de temps adaptatif, bruit, analyse fréquentielle (`.ac`).

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

L'API `ctx` offerte à `stamp` : `v(n)`, `conductance(a, b, g)`, `current(a, b, I)`, `transconductance(a, b, cp, cn, g)`, `voltageSource(a, b, V, k)`, `capacitor(state, clé, a, b, C)`, `branchI(k)`, `markLimited()`, `srcFactor`, `tempC`, et pour l'analyse transitoire `mode` (`"dc"` ou `"tran"`), `t`, `dt` et `vPrev(n)` (tension au pas précédent). Les briques de `devices.js` (`stampJunction`, `stampThevenin`, `fitIsFromVf`…) couvrent la plupart des besoins.

## L'ESP32

Le modèle électrique suit le tableau *DC Characteristics* de la fiche Espressif :

- sortie : Thévenin calé sur VOH = 0,8·VDD et VOL = 0,495 V au courant nominal de la *drive strength* (20 mA par défaut) ;
- entrée : seuils VIH = 0,75·VDD et VIL = 0,25·VDD, zone indéterminée entre les deux, fuite 50 nA ;
- pull-up / pull-down internes de 45 kΩ, absents sur GPIO34 à 39 (entrées seules) ;
- diodes de protection vers 3,3 V et GND : mettre 5 V sur une broche fait réellement circuler du courant, et l'interface alerte ;
- états après reset des broches de strapping (GPIO2 en pull-down, GPIO5 en pull-up).

Le code est un **sous-ensemble d'Arduino** converti en JavaScript asynchrone (`delay()` rend la main au navigateur). Ce n'est pas une émulation du processeur Xtensa : le timing est celui du navigateur, et les bibliothèques C++ ne sont pas disponibles. Une étape ultérieure pourra brancher un vrai émulateur de jeu d'instructions (QEMU-ESP32 compilé en WebAssembly) sur la même interface `setPin / read`.

## Pile technique et suite

- Aujourd'hui : JavaScript moderne (modules ES), SVG, aucune dépendance, tests avec `node --test`.
- Dès que le dépôt existe : Vite pour le développement, TypeScript progressif sur `engine/` et `components/`, CI GitHub Actions qui lance les tests de fiches techniques sur chaque PR.
- Feuille de route : bobines et pas adaptatif, transistors (2N2222, IRLZ44N), régulateurs (AMS1117), capteurs (DHT22, BME280) avec leurs protocoles, I²C/SPI simulés, export/import de montages.

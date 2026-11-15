# Architecture d'Établi

Établi est un émulateur de circuits électroniques qui tourne entièrement dans le navigateur. Le principe directeur : **chaque composant se comporte comme le vrai**, avec des paramètres tirés de sa fiche technique et des tests qui le prouvent.

## Vue d'ensemble

```
index.html, dev.html, style.css
src/
  engine/              Le simulateur (aucune dépendance au navigateur)
    solver.js          MNA + Newton-Raphson, limitation de jonction, source stepping, états discrets
    transient.js       Analyse temporelle : pas adaptatif, trapèzes, points d'arrêt, moyennes glissantes
    devices.js         Briques physiques : jonction PN, Thévenin, Ebers-Moll (bipolaire), MOSFET niveau 1
    circuit.js         Schéma -> netlist, masse, point de fonctionnement continu, détection de casse
    units.js           Formatage et lecture SI (4k7, 220 Ω, 5,84 mA)
  components/          Un fichier par famille de composants (le "plugin")
    index.js           Registre : la liste des composants disponibles
    shapes.js          Aides de dessin (boîtiers DIP, pattes)
    passives.js        Masse, résistance, potentiomètre, interrupteur, bouton
    reactive.js        Condensateur (polarisé ou non), bobine
    sources.js         Alimentation DC, piles (Thévenin), source de courant
    instruments.js     Sonde d'oscilloscope, voltmètre, ampèremètre, multimètre, générateur de fonctions
    semiconductors.js  Diodes (1N4148, 1N4007, 1N5819, Zener 1N4733A), LED
    transistors.js     Bipolaires (2N2222A, 2N3904, BC547B, 2N3906, BC557B), MOSFET (2N7000, IRLZ44N, IRF9540N)
    opamps.js          Amplis opérationnels (LM358, µA741, TL072, MCP6002), comparateur LM393
    analog-ics.js      NE555, régulateurs (L7805, L7812, AMS1117-3.3, LM317)
    logic.js           Famille 74HC : 00, 02, 04, 08, 14, 32, 86, 74, 595, 138, 161, 4017, 4511
    electromech.js     Relais SRD-05VDC / 12VDC
    display.js         Afficheur 7 segments
    sensors.js         Thermistance CTN, photorésistance, LM35 / TMP36
    esp32.js           Carte ESP32-DevKitC : GPIO, pull-ups, diodes de protection, ADC, PWM temporelle
  runtime/
    arduino.js         Exécute un sketch Arduino (sous-ensemble) sur l'ESP32 simulé, calé sur le temps simulé
  ui/
    app.js             Plan de travail SVG, palette, mesures, boucle de simulation, éditeur de code
    scope.js           Oscilloscope 4 voies : tampon circulaire, déclenchement, mesures, export CSV
    examples.js        Montages de démonstration
tests/
  datasheet.test.mjs   Modèles statiques confrontés aux points de leur fiche technique
  transient.test.mjs   Analyse temporelle, puces et instruments confrontés à la théorie et aux fiches
docs/
  AJOUTER-UN-COMPOSANT.md   Procédure suivie par Claude pour intégrer un nouveau composant
```

## Le moteur

### Résolution d'un instant

On utilise la même méthode que SPICE :

1. **Analyse nodale modifiée (MNA).** Chaque composant "estampille" sa contribution dans une matrice `A·x = b`. Les inconnues sont les tensions des nœuds et les courants des sources de tension.
2. **Newton-Raphson.** Les composants non linéaires (diodes, transistors, amplis) sont linéarisés autour de la solution courante, puis on itère jusqu'à convergence.
3. **Robustesse.** Limitation de tension de jonction (`pnjlim`), conductance minimale `GMIN` sur chaque nœud, redémarrage à froid puis *source stepping* si la convergence échoue.
4. **États discrets.** Une bascule, la mémoire d'un 555, le contact d'un relais ou la région d'un ampli (linéaire, saturé) ne sont pas des inconnues continues. Après chaque résolution, `update()` laisse le composant changer d'état ; on résout à nouveau jusqu'à ce que plus rien ne bouge (`solveSettled`).

### Évolution dans le temps (`transient.js`)

La classe `Simulation` fait avancer le circuit :

- **Intégration par trapèzes** (ordre 2), avec deux pas d'Euler implicite après chaque discontinuité pour éviter les oscillations numériques.
- **Pas adaptatif.** Chaque solution est comparée à son extrapolation linéaire : trop d'écart, le pas est refusé et réduit ; peu d'écart, il grandit (de 1 ns à 1 ms).
- **Points d'arrêt.** Les fronts connus à l'avance (PWM, générateur carré) sont déclarés par `nextBreak()` : un pas se termine exactement dessus.
- **Basculements imprévus** (comparateur, 555) : le pas est réduit jusqu'à localiser l'instant à la nanoseconde.
- **Circuits statiques.** Sans élément réactif ni source variable, on saute directement au prochain événement : un montage purement continu ne coûte presque rien.
- **Mesures.** Chaque grandeur est moyennée par un filtre exponentiel (50 ms simulées par défaut), avec suivi des crêtes : c'est ce que lit `describe()`, et ce qui fait qu'une LED en PWM affiche son courant moyen et alerte sur son courant crête.
- **Casse.** À chaque image, chaque composant décrit son état. S'il est détruit, il devient un circuit ouvert, comme dans la réalité.

`simulate()` (dans `circuit.js`) reste disponible pour un simple point de fonctionnement continu.

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
| `reactive: true` | Le composant a une mémoire continue (condensateur, bobine, pôle d'un ampli) : active le pas adaptatif |
| `update(ctx, inst, nodes, branches)` | Change un état discret d'après la solution ; renvoie `true` s'il a changé (on résout à nouveau) |
| `commit(ctx, inst, nodes, branches)` | Appelé une fois le pas accepté : mémorise l'état (tension d'un condensateur…) dans `inst.rt.s` |
| `nextBreak(inst, t)`, `maxStep(inst)` | Prochain front connu ; plus grand pas toléré (générateur sinus) |
| `instrument`, `reading(inst, avg)`, `scopeKey(inst)` | Pour un appareil de mesure : grandeur lue (`"V"` ou `"I"`), valeur affichée, grandeur tracée à l'oscilloscope |

L'API `ctx` offerte à `stamp` : `v(n)`, `conductance(a, b, g)`, `current(a, b, I)`, `voltageSource(a, b, V, k)`, `branchI(k)`, `markLimited()`, `srcFactor`, `tempC`, et pour l'analyse temporelle `t`, `dt`, `trap`, `vccs(…)`, `addA`, `addB`, `nodeRow`, `branchRow`. Les briques de `devices.js` (`stampJunction`, `stampThevenin`, `stampBJT`, `stampMOS`, `fitIsFromVf`…) couvrent la plupart des besoins. L'état mémorisé d'un composant vit dans `inst.rt.s`, un objet plat que le moteur sait sauvegarder et restaurer quand un pas est refusé.

## L'ESP32

Le modèle électrique suit le tableau *DC Characteristics* de la fiche Espressif :

- sortie : Thévenin calé sur VOH = 0,8·VDD et VOL = 0,495 V au courant nominal de la *drive strength* (20 mA par défaut) ;
- entrée : seuils VIH = 0,75·VDD et VIL = 0,25·VDD, zone indéterminée entre les deux, fuite 50 nA ;
- pull-up / pull-down internes de 45 kΩ, absents sur GPIO34 à 39 (entrées seules) ;
- diodes de protection vers 3,3 V et GND : mettre 5 V sur une broche fait réellement circuler du courant, et l'interface alerte ;
- états après reset des broches de strapping (GPIO2 en pull-down, GPIO5 en pull-up).

- PWM (`analogWrite`, `ledcWrite`) produite comme un vrai signal carré, 1 kHz par défaut (`analogWriteFrequency`), visible à l'oscilloscope.

Le code est un **sous-ensemble d'Arduino** converti en JavaScript asynchrone. `delay()` et `millis()` suivent le **temps simulé** : en ralentissant la simulation, le sketch ralentit avec elle. Ce n'est pas une émulation du processeur Xtensa : les bibliothèques C++ ne sont pas disponibles. Une étape ultérieure pourra brancher un vrai émulateur de jeu d'instructions (QEMU-ESP32 compilé en WebAssembly) sur la même interface `setPin / read`.

## Les instruments

- **Oscilloscope** 4 voies : on pose une sonde sur un fil, ou on affecte une voie à un voltmètre, un ampèremètre ou un multimètre. Base de temps de 1 µs à 5 s par division, déclenchement sur front (auto, normal, mono-coup), défilement au-delà de 50 ms/div, calibre vertical automatique, mesures (crête à crête, moyenne, efficace, fréquence, rapport cyclique), curseur, export CSV.
- **Voltmètre** (10 MΩ), **ampèremètre** (shunt 0,1 Ω, fusible 10 A) et **multimètre** (V et A en continu et alternatif, ohmmètre, test de diode) chargent le circuit comme les vrais.
- **Générateur de fonctions** : sinus, carré, triangle, dent de scie, horloge logique, sortie 50 Ω.

## Pile technique et suite

- JavaScript moderne (modules ES), SVG et canvas, aucune dépendance, tests avec `node --test`.
- Pistes : Vite et TypeScript progressif, CI GitHub Actions, analyseur logique, bus I²C/SPI simulés avec leurs capteurs (DHT22, BME280, SSD1306), analyse fréquentielle (Bode), export/import de montages.

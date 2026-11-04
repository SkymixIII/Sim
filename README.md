# Établi

Émulateur de circuits électroniques dans le navigateur, dont chaque composant est calé sur sa fiche technique : diodes et LED au modèle de Shockley, piles avec leur résistance interne, ESP32 avec ses vraies limites de GPIO et un sous-ensemble d'Arduino pour le programmer.

## Lancer

```sh
python3 -m http.server 8000   # puis ouvrir http://localhost:8000/dev.html
npm test                      # vérifie les modèles contre les fiches techniques
```

## Montages fournis

- **Tally ATEM 8 caméras** (par défaut, ou `dev.html#tally`) : un ATEM 2 M/E Constellation HD modélisé côté réseau, avec son pupitre PGM/PVW/CUT/AUTO, est relié en RJ45 à l'émetteur WT32-ETH01, qui diffuse en ESP-NOW à 8 lampes ESP32-C3 maillées, qui relaient toutes la trame (une par caméra, priorité bleu > rouge > vert). L'onglet Radio place les appareils sur un plan, règle leur portée et les obstacles. Cliquez sur le lien RJ45 pour débrancher le câble. Le firmware réel est dans [`firmware/`](firmware/README.md).
- **LED + bouton** (`dev.html#demo`) : la démo d'origine.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) : moteur MNA/Newton-Raphson, contrat d'un composant, modèle de l'ESP32.
- [Ajouter un composant réel](docs/AJOUTER-UN-COMPOSANT.md) : la procédure suivie quand on demande un nouveau composant.

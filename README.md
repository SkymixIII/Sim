# Établi

Émulateur de circuits électroniques dans le navigateur, dont chaque composant est calé sur sa fiche technique. Simulation temporelle (condensateurs, bobines, oscillateurs), transistors, amplis opérationnels, NE555, régulateurs, logique 74HC, capteurs, ESP32 programmable en Arduino, et les instruments d'un vrai établi : oscilloscope 4 voies, voltmètre, ampèremètre, multimètre, générateur de fonctions.

## Lancer

```sh
python3 -m http.server 8000   # puis ouvrir http://localhost:8000/dev.html
npm test                      # vérifie les modèles contre les fiches techniques
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) : moteur MNA/Newton-Raphson, analyse temporelle, instruments, contrat d'un composant, modèle de l'ESP32.
- [Ajouter un composant réel](docs/AJOUTER-UN-COMPOSANT.md) : la procédure suivie quand on demande un nouveau composant.

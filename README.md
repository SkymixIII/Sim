# Établi

Émulateur de circuits électroniques dans le navigateur, dont chaque composant est calé sur sa fiche technique : diodes et LED au modèle de Shockley, piles avec leur résistance interne, ESP32 avec ses vraies limites de GPIO et un sous-ensemble d'Arduino pour le programmer.

## Lancer

```sh
python3 -m http.server 8000   # puis ouvrir http://localhost:8000/dev.html
npm test                      # vérifie les modèles contre les fiches techniques
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) : moteur MNA/Newton-Raphson, contrat d'un composant, modèle de l'ESP32.
- [Ajouter un composant réel](docs/AJOUTER-UN-COMPOSANT.md) : la procédure suivie quand on demande un nouveau composant.

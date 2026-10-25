# Ajouter un composant réel

Cette procédure est celle que suit Claude quand quelqu'un demande un nouveau composant. Elle sert aussi à un humain qui voudrait le faire à la main.

## Comment le demander

Dans le chat du projet « Emulateur Puce elec », écrire par exemple :

> Ajoute un transistor 2N2222
> Ajoute un capteur de température DHT22
> Ajoute un écran OLED SSD1306 en I²C

Le coordinateur ouvre un fil dédié, nommé d'après le composant. Ce fil travaille sur une branche du dépôt et termine par une pull request que vous relisez. Le composant apparaît dans la palette une fois la PR fusionnée.

## Ce que fait le fil, étape par étape

1. **Identifier la référence exacte.** Fabricant, boîtier, variante. S'il y a ambiguïté (ex. « un MOSFET »), choisir la référence la plus courante chez les amateurs et le dire.
2. **Lire la fiche technique.** Relever, avec leurs conditions de test :
   - les caractéristiques électriques (tensions de seuil, courants, résistances, gains) ;
   - les valeurs maximales absolues (ce qui détruit le composant) ;
   - les courbes typiques utiles pour caler le modèle ;
   - un modèle SPICE publié par le fabricant s'il existe (préféré à un ajustement maison).
3. **Choisir le modèle physique.** Réutiliser les briques de `src/engine/devices.js` (jonction, Thévenin) ou en ajouter une si nécessaire (ex. Ebers-Moll pour un bipolaire, modèle quadratique ou EKV pour un MOSFET). Pour un composant numérique (capteur, écran), modéliser l'électrique de ses broches *et* son protocole.
4. **Écrire le composant** dans `src/components/<famille>.js` selon le contrat décrit dans `docs/ARCHITECTURE.md`, puis l'ajouter à `src/components/index.js`. La section `datasheet` cite la source et les limites du modèle.
5. **Écrire les tests** dans `tests/` : au moins trois points de la fiche technique (fonctionnement nominal, un autre point de la courbe, une limite qui déclenche une alerte ou la casse). Tolérance justifiée par la dispersion annoncée par le fabricant (typ/min/max).
6. **Vérifier dans l'application** : placer le composant, le câbler dans un montage typique de sa fiche (circuit d'application), comparer les mesures.
7. **Ouvrir la PR** avec : la fiche technique utilisée, les points testés, ce que le modèle ne reproduit pas encore.

## Critères d'acceptation

- `npm test` passe, y compris les nouveaux tests.
- Le composant alerte avant ses limites et casse au-delà de ses maximums absolus quand c'est physiquement le cas.
- Aucune valeur « inventée » : chaque paramètre vient de la fiche technique, d'un modèle SPICE publié, ou d'un ajustement documenté sur une courbe de la fiche.

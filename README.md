# RL Overlay (RLO)

Un overlay Rocket League permettant d'afficher en temps réel des informations avancées sur les joueurs et la partie en cours.

RLO récupère les données fournies par Rocket League via RLS et affiche directement en jeu des informations qui ne sont normalement pas visibles :

- MMR des joueurs
- Rang actuel
- Icône de rang personnalisée
- Plateforme utilisée
- Nombre de démolitions
- MMR moyen des équipes
- Probabilité de victoire estimée
- Informations détaillées sur la composition du match

L'objectif du projet est de fournir davantage de contexte compétitif pendant une partie et de permettre une meilleure analyse des matchs.

---

## Aperçu

*Ajouter ici des captures d'écran de l'overlay et du dashboard.*

---

## Fonctionnalités

### Informations des joueurs

- Affichage du MMR en temps réel
- Affichage du rang
- Affichage de la plateforme (Steam, Epic Games, PlayStation, Xbox, etc.)
- Icônes de rang personnalisées
- Détection automatique des joueurs présents dans la partie

### Informations de match

- Calcul du MMR moyen de chaque équipe
- Estimation du taux de victoire
- Support des parties :
  - 1v1
  - 2v2
  - 3v3
  - Mode automatique

### Overlay

- Fenêtre transparente affichée au-dessus du jeu
- Mise à jour automatique des données
- Dashboard de contrôle intégré

### Contrôles rapides

- Touche `1`
- Combinaison manette `LB + R3`

Permettent de changer rapidement le mode sélectionné.

---

## Prérequis

Avant d'utiliser RLO, vous devez disposer de :

- Rocket League
- Une clé API RLS valide
- Node.js
- npm

---

## Installation

Cloner le dépôt :

```bash
git clone https://github.com/VOTRE_PSEUDO/RL-Overlay.git
cd RL-Overlay
```

Installer les dépendances :

```bash
npm install
```

Créer un fichier `.env` à la racine du projet :

```env
RLS_KEY=votre_cle_api
```

Lancer l'application :

```bash
npm start
```

---

## Technologies utilisées

- Electron
- Node.js
- HTML
- CSS
- JavaScript

---

## Configuration

La clé API RLS est chargée depuis le fichier `.env`.

Exemple :

```env
RLS_KEY=xxxxxxxxxxxxxxxx
```

---

## Compatibilité

Le projet est principalement développé et testé sous Windows.

La compatibilité avec Linux et macOS n'est actuellement pas garantie.

---

## Roadmap

### Prévu

- Notifications lors des passages de rang
- Prise en compte optionnelle des buts dans le calcul du winrate
- Prise en compte optionnelle du temps restant dans le calcul du winrate
- Historique et statistiques de session
- Sessions séparées par mode de jeu
- Support de tous les modes Rocket League
- Récupération et statistiques du chat de partie
- Statistiques "Pote là !" / "Tope là !"
- Nouvelles analyses avancées de match

---

## Ressources graphiques

Toutes les icônes de rang incluses dans ce projet ont été réalisées manuellement par l'auteur.

Merci de ne pas les réutiliser ou les redistribuer sans autorisation.

---

## Contribution

Les suggestions, rapports de bugs et propositions d'amélioration sont les bienvenus.

Vous pouvez ouvrir une Issue ou soumettre une Pull Request.

---

## Licence

Ce projet est distribué sous licence MIT.

Voir le fichier `LICENSE` pour plus d'informations.

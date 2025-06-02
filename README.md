**`Mise à jour : version 1.1.4`**

# LFG Discord Bot

Le bot Discord "Looking For Group" (LFG) est conçu pour aider les joueurs à trouver des groupes pour jouer ensemble. Il permet de créer des sessions de jeu, de rejoindre des sessions existantes, et de gérer les participants.

## Description

Le bot LFG permet aux utilisateurs de créer des sessions de jeu pour divers jeux, de rejoindre des sessions existantes, et de gérer les participants. Il offre également des fonctionnalités pour modifier les sessions, lister les membres, et afficher les statistiques des sessions.

## Fonctionnalités

- **Création de sessions LFG** : Créez des sessions de jeu pour divers jeux.
- **Rejoindre des sessions** : Rejoignez des sessions de jeu existantes.
- **Modifier des sessions** : Modifiez les détails des sessions existantes.
- **Lister les membres** : Listez les membres d'une session.
- **Retirer des membres** : Retirez des membres d'une session.
- **Bannir des membres** : Bannissez des membres d'une session.
- **Afficher les statistiques** : Affichez les statistiques des sessions LFG.
- **Afficher l'historique** : Affichez l'historique des sessions LFG.
- **Définir le salon pour les annonces LFG** : Définissez le salon pour les annonces LFG.
- **Commandes Slash** : Utilisation de commandes slash pour interagir avec le bot.

## Prérequis

- Node.js (version 16 ou supérieure)
- Un bot Discord (créé via le [Portail Développeur Discord](https://discord.com/developers/applications))
- Les permissions nécessaires pour ajouter le bot à vos serveurs

## Installation

1. Clonez ce dépôt sur votre machine locale.
2. Installez les dépendances nécessaires en exécutant `npm install`.
3. Créez un fichier `.env` à la racine du projet et ajoutez vos variables d'environnement :

```plaintext
DISCORD_TOKEN=VOTRE_TOKEN_DE_BOT
CLIENT_ID=VOTRE_CLIENT_ID
```

4. Exécutez le bot avec la commande `node index.js`.

## Commandes

Le bot utilise des commandes slash pour interagir avec les utilisateurs. Voici les commandes disponibles :

- `/lfg` : Créez une session LFG.
  - Options : `jeux`, `plateforme`, `joueurs`, `gametag`, `activité`, `description`
- `/modify_lfg` : Modifiez une session LFG.
  - Options : `session_id`, `joueurs`, `description`
- `/list_members` : Listez les membres d'une session LFG.
  - Options : `session_id`, `page`
- `/kick_member` : Retirez un membre d'une session LFG.
  - Options : `session_id`, `member`
- `/ban_member` : Bannissez un membre d'une session LFG.
  - Options : `session_id`, `member`
- `/stats` : Affichez les statistiques des sessions LFG.
- `/history` : Affichez l'historique des sessions LFG.
  - Options : `page`
- `/set_lfg_channel` : Définissez le salon pour les annonces LFG.
  - Options : `channel`

## Utilisation

1. Invitez le bot sur votre serveur Discord en utilisant le lien OAuth2 généré dans le [Portail Développeur Discord](https://discord.com/developers/applications).
2. Utilisez la commande `/lfg` pour créer une session LFG.
3. Utilisez les autres commandes pour rejoindre des sessions, modifier des sessions, lister les membres, et plus encore.

## Contribution

Les contributions sont les bienvenues ! Pour contribuer à ce projet, veuillez suivre ces étapes :

1. Fork ce dépôt.
2. Créez une branche pour votre fonctionnalité (`git checkout -b feature/AmazingFeature`).
3. Commitez vos changements (`git commit -m 'Add some AmazingFeature'`).
4. Poussez vers la branche (`git push origin feature/AmazingFeature`).
5. Ouvrez une Pull Request.

## Licence

Ce projet est sous licence MIT. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

## Contact

Pour toute question ou suggestion, n'hésitez pas à ouvrir une issue ou à me contacter directement.

---

© 2025 Ludovic Rose. Tous droits réservés.

[![Donate](https://img.shields.io/badge/paypal-donate-yellow.svg?style=flat)](https://www.paypal.me/nuggan85) [![v1.1.4](http://img.shields.io/badge/zip-v1.1.4-blue.svg)](https://github.com/NuggaN85/Exolfg/archive/master.zip) [![GitHub license](https://img.shields.io/github/license/NuggaN85/Exolfg)](https://github.com/NuggaN85/Exolfg)

# 💌 Love Room

Deux personnes installent l'appli, se lient avec un **code**, puis s'envoient des **GIF qui apparaissent
dans un coin de l'écran** de l'autre (au-dessus des autres fenêtres, sans voler le focus, clics traversants).

Windows en priorité, mais aussi macOS et Linux (Electron).

## Comment ça marche

1. À la première ouverture, l'appli génère **ton code** (ex. `TT6KK-9GWY6`) et un secret local.
2. Chacun entre le code de l'autre → quand les **deux** se sont ajoutés, le statut passe à « Lié ✓ ».
3. Colle un lien **Giphy / Tenor / Imgur** ou glisse un fichier GIF (≤ 3 Mo) : il s'affiche chez l'autre
   pendant quelques secondes dans le coin choisi.

```
client (Electron) ──ws──► serveur relais (Node) ──ws──► client (Electron)
```

Le serveur ne stocke rien : il garde seulement les connexions en cours et relaie les messages entre
deux personnes qui se sont désignées mutuellement.

## Lancer en local

```bash
# 1. serveur relais
cd server && npm install && npm start          # écoute sur :8787

# 2. client (dans un autre terminal)
cd client && npm install && npm start
```

Pour tester seul, lance un 2ᵉ client avec un autre profil :
`npx electron . --user-data-dir=/tmp/love-b`

## Installer sur Windows / macOS / Linux

Le workflow GitHub Actions `.github/workflows/build.yml` construit les installeurs sur les 3 OS
(`.exe` NSIS + portable, `.dmg`, `.AppImage`) ; ils sont téléchargeables dans les *artifacts* du run.
En local : `cd client && npm run dist:win` (ou `dist:mac`, `dist:linux`) sur l'OS correspondant.

Les installeurs ne sont pas signés : Windows SmartScreen et macOS Gatekeeper afficheront un avertissement
(« Informations complémentaires → Exécuter quand même » / clic droit → Ouvrir).

## Mettre le serveur en ligne

Pour jouer à deux machines différentes, le serveur doit être joignable sur internet.
`server/Dockerfile` est prêt pour Fly.io, Render, Railway, etc. (variable `PORT`).
Mets-le derrière TLS pour utiliser `wss://`.

Ensuite, change l'adresse par défaut dans `client/src/store.js` (`DEFAULT_SERVER`) avant de construire
les installeurs — ou, plus simplement, chacun la modifie dans **Réglages → Serveur**.

## Sécurité

- Le code (≈ 49 bits) sert d'identifiant ; le secret local empêche quiconque d'usurper ton code pendant que tu es en ligne.
- Aucun GIF n'est relayé tant que **les deux** ne se sont pas ajoutés mutuellement : connaître ton code ne permet pas de t'envoyer des images.
- Les liens sont limités à Giphy / Tenor / Imgur en `https` (afficher une image distante révèle l'IP du destinataire à l'hébergeur). Les fichiers sont vérifiés par leurs octets (GIF/PNG/WebP/JPEG).
- Le client revalide tout ce qui vient du serveur ; fenêtres Electron en `contextIsolation` + `sandbox` + CSP stricte.
- Limites de débit côté serveur ; pas de stockage, pas de logs de contenu.

## Limites actuelles / idées

- Pas de recherche de GIF intégrée (Giphy/Tenor demandent une clé d'API) : il faut coller un lien ou un fichier.
- Les GIF sont perdus si l'autre est hors ligne (pas de file d'attente).
- L'overlay s'affiche sur l'écran principal uniquement.
- Lancement au démarrage : Windows et macOS seulement.
- Pistes : historique, favoris, réactions ❤️, son, recherche de GIF.

## Tests

```bash
cd server && npm test
```

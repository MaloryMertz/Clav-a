# Clav-a — Grand Piano Virtuel

Piano virtuel 61 touches (C2 → C7) dans le navigateur, avec le **mapping clavier de virtualpiano.net** et le son du **Salamander Grand Piano** (Yamaha C5 échantillonné, licence CC-BY).

## Fonctionnalités

- **Mapping virtualpiano.net** : rangée `1`–`0` puis `q`…`m`, `Maj` pour les dièses.
  Le mapping se fait par **caractère tapé** (comme sur virtualpiano.net) : la touche qui écrit `w` joue le `w`, sur QWERTY comme sur AZERTY. Le pavé numérique fonctionne aussi.
- **Son haute qualité** : 21 samples du Salamander Grand Piano (un tous les 3 demi-tons), interpolation de pitch inaudible, compresseur léger pour éviter la saturation en accords.
- **Pédale de sustain** : `Espace` (maintien) ou bouton Sustain (verrou). Compatible pédale MIDI (CC64).
- **Web MIDI** : branchez un clavier maître, il est détecté automatiquement (badge MIDI).
- **Souris / tactile** : clic ou toucher multi-doigts, glissando en glissant sur les touches, vélocité selon la hauteur du clic sur la touche.
- **Étiquettes** : affichage des touches clavier (mapping VP), des noms de notes (C4…), ou rien.
- **PWA hors-ligne** : après une première visite en ligne, tout (page + samples, ~1,3 Mo) est mis en cache par le service worker — l'app fonctionne ensuite sans réseau et est installable.

## Lancer en local

Le service worker exige HTTP (pas `file://`) :

```bash
cd Piano
python -m http.server 8000
# → http://localhost:8000
```

## Héberger en ligne

C'est un site 100 % statique, sans build ni dépendance : copiez le dossier tel quel sur n'importe quel hébergement (nginx, IIS, GitHub Pages, Netlify…). HTTPS requis pour le service worker et l'installation PWA.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page unique de l'app |
| `style.css` | Thème sombre « scène », rendu des touches |
| `app.js` | Moteur audio Web Audio, clavier, souris/tactile, MIDI, PWA |
| `sw.js` | Service worker cache-first (mode hors-ligne) |
| `manifest.webmanifest` | Manifeste PWA (installable) |
| `samples/*.mp3` | 29 samples Salamander Grand Piano (C1 → C8) |

## Licences

- **Code** : [MIT](LICENSE) — © 2026 Malory M.
- **Échantillons audio** (`samples/`) : [Salamander Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) par Alexander Holm, licence **CC-BY 3.0** (attribution obligatoire), via tonejs.github.io.

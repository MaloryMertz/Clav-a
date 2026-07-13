# Dossier partitions

Déposez ici vos partitions : elles apparaissent automatiquement dans la
bibliothèque de l'app (section « Dossier en ligne »), sans toucher au code.

## Formats acceptés

- **`Mon Morceau.txt`** — le contenu est la partition (notation Virtual Piano),
  le nom du fichier (sans extension) devient le nom du morceau.
- **`pack.json`** — plusieurs morceaux d'un coup :
  ```json
  { "Morceau 1": "8 t u [8t] o", "Morceau 2": "t y u" }
  ```

Les `README.md` et autres extensions sont ignorés. Après un `git push`,
l'app recharge la liste automatiquement (via l'API GitHub).

⚠️ Ce dossier est public : n'y mettez que des œuvres libres de droits ou vos
propres compositions. Pour les morceaux sous droits, gardez-les en local
(`partitions-perso.json`, jamais publié) et importez-les dans l'app.

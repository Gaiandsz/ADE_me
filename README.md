# Planning ME4

Emploi du temps ME4 (groupe G4.3) synchronisé avec ADE, en accès libre avec le lien.

- **Site** : `index.html`, servi par GitHub Pages.
- **Données** : Supabase (projet « Planning ME4 »), table `events`.
- **Synchro ADE** : fonction `supabase/functions/ade-sync`, lancée toutes les heures (pg_cron) et par le bouton « Synchroniser ».
  - Les cours ADE sont mis à jour via leur identifiant (UID) : horaires, salles et profs suivent ADE.
  - Un cours supprimé d'ADE disparaît du site ; un créneau « masqué » sur le site ne revient pas.
  - Les événements ajoutés à la main ne sont jamais touchés.

## Changer les cours filtrés

Les matières écartées sont dans la table `excluded_keywords` (un mot-clé par ligne, comparé au titre du cours, sans tenir compte des majuscules).
Ajouter ou retirer une ligne dans Supabase suffit ; la synchro suivante applique le changement.

## Changer le lien ADE

Modifier `ADE_URL` dans `supabase/functions/ade-sync/index.ts` (ou définir le secret `ADE_URL` dans Supabase) puis redéployer la fonction.

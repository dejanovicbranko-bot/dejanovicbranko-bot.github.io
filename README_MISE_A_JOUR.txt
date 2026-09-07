GridLedger v3 Cloud Bridge — mise à jour minimale

Fichiers à envoyer dans le dépôt GitHub Pages existant :
- cloud-sync.js  (nouveau)
- sw.js          (remplace l'ancien)

Cette mise à jour NE change PAS :
- la base IndexedDB locale ;
- le mot de passe du coffre ;
- les données déjà présentes sur le téléphone ;
- les captures/documents chiffrés locaux.

Le pont cloud synchronise uniquement les données comptables structurées après consentement explicite dans l'application.
La clé incluse dans cloud-sync.js est une clé PUBLIABLE Supabase conçue pour être utilisée côté navigateur. Les protections d'accès reposent sur Supabase Auth + RLS.

GRIDLEDGER v3.2 — BOTS ACTIFS / BOTS FERMÉS / PRÉVISIONS FISCALES

À mettre à la racine du dépôt GitHub :
- ui-v32.js : nouveau fichier
- sw.js : remplacer l'ancien

Ne supprime pas :
- app.js
- cloud-sync.js
- history-fix.js
- tes données locales

Après l'upload :
1. Ouvre GridLedger dans le navigateur.
2. Actualise une fois.
3. Ferme et rouvre l'application installée.
4. Dans Assistant GridLedger, touche « Récupérer les mises à jour ChatGPT ».

Ce correctif :
- montre d'abord uniquement les bots actifs ;
- range les bots fermés dans un onglet séparé ;
- ajoute des prévisions fiscales de 10 % et 30 % sur les gains nets réalisés connus ;
- précise que ces montants sont des provisions/scénarios et pas un calcul fiscal officiel ;
- marque les apports/performance comme partiels tant que l'historique complet des apports n'est pas réconcilié.

Aucune donnée financière personnelle n'est incluse dans les fichiers publics.

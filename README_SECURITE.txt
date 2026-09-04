GRIDLEDGER MOBILE v1.0 BETA SECURISEE

Cette version garde l'interface mobile validée et ajoute le coffre local chiffré.

SECURITE
- Mot de passe/code requis au démarrage.
- PBKDF2-SHA256 pour dériver une clé locale.
- AES-GCM 256 bits pour les données comptables.
- AES-GCM 256 bits pour chaque document.
- La clé de déchiffrement reste en mémoire seulement pendant la session.
- Verrouillage manuel + verrouillage automatique configurable.
- Aucune donnée comptable lisible n'est stockée dans localStorage.
- localStorage ne contient que les paramètres nécessaires à la dérivation/vérification du mot de passe.

SAUVEGARDE
- "Créer une sauvegarde" exporte les enregistrements sous leur forme chiffrée.
- La sauvegarde inclut les documents.
- La restauration remplace le coffre local et exige ensuite le mot de passe de la sauvegarde.
- Perdre le mot de passe signifie perdre l'accès au contenu chiffré.

LIMITES BETA IMPORTANTES
- Ne pas conserver GridLedger comme unique copie d'un justificatif important.
- Le système de sauvegarde/restauration doit encore être testé sur plusieurs téléphones/navigateurs.
- Pas de synchronisation cloud dans ce MVP.
- Pas de récupération de mot de passe centralisée.
- Pas d'audit de sécurité externe.
- La fiscalité reste une préparation de dossier, pas une déclaration officielle.
- Aucune connexion exchange, aucune transaction, aucun levier.

INSTALLATION PWA
Le dossier doit être servi en HTTPS.
Android/Chrome : Installer l'application / Ajouter à l'écran d'accueil.
iPhone/Safari : Partager -> Sur l'écran d'accueil.


CORRECTIF 1.1
- Capture mobile : choix séparé entre galerie/captures d'écran et appareil photo.


CORRECTIF / FONCTION 1.2
- OCR local réel : moteur natif TextDetector lorsqu'il existe, sinon Tesseract.js/WebAssembly.
- Au premier usage du fallback Tesseract, le navigateur télécharge le moteur OCR et les modèles français/anglais.
- L'image est traitée côté appareil ; GridLedger n'envoie pas la capture à une API d'analyse dans cette version.
- Détection de source : Pionex, Bybit, Bitstack, Binance, autre.
- Profil Bot : paire, investissement, bénéfice courant/Total P&L, Grid Profit, P&L latent/tendance, valeur actuelle, retrait.
- Si aucune valeur actuelle explicite n'est trouvée mais investissement + bénéfice courant existent, GridLedger propose une valeur CALCULÉE marquée « Estimé » ; l'utilisateur doit la vérifier.
- Snapshot créé uniquement après validation humaine.
- Option pour conserver la capture comme justificatif chiffré lié au bot.
- Ne pas utiliser comme unique archive de documents critiques tant que les tests multi-appareils ne sont pas terminés.


FONCTION 1.3 — FIABILISATION OCR / COMPTABILITE
- Reconnaissance Pionex par combinaison de libellés même si le logo/nom n'est pas lu par l'OCR.
- Deuxième passe OCR améliorée automatiquement lorsque la confiance est faible.
- Les champs OCR détectés ne sont plus marqués « Certain » automatiquement.
- Confiance < 80 % : champs proposés « À vérifier » ; sinon « Estimé ».
- Détection de l'unité native (USDT, USDC, EUR, etc.).
- Suppression de l'affichage trompeur en EUR pour les métriques natives.
- Suppression du calcul automatique « investissement + bénéfice = valeur actuelle ».
- Une capture en USDT peut créer un snapshot PARTIEL NATIF sans modifier la valorisation patrimoniale EUR.
- Seule une valeur explicitement validée en EUR peut modifier le patrimoine global.
- Le champ « Retiré » reste une métrique de capture ; il ne crée jamais automatiquement un transfert/distribution.


FONCTION 1.4 — PROFIL OCR PIONEX CIBLE
- Après la lecture globale, GridLedger lance des lectures OCR supplémentaires sur plusieurs zones du bot Pionex.
- Les textes des différentes passes sont fusionnés sans doublons.
- Contraste renforcé sur les zones ciblées pour améliorer les petits libellés sur fond sombre.
- Tolérance ajoutée pour quelques erreurs OCR fréquentes sur « PnL de tendance », « bénéfice courant » et « retiré ».
- Aucune valeur réelle de capture utilisateur n'est intégrée comme donnée de démonstration.


FONCTION 1.5 — VERIFICATION ASSISTEE
- Compteur des champs encore « À vérifier ».
- Bouton global « Relire les champs manquants ».
- Bouton « Relire ce champ » sur les métriques Pionex ciblables.
- Relecture ciblée avec OCR de zone et mode de segmentation adapté.
- Une valeur relue automatiquement passe au maximum en « Estimé », jamais en « Certain ».
- Zoom plein écran de la capture pour comparaison visuelle.
- Si une valeur est présente mais reste « À vérifier », l'enregistrement est bloqué jusqu'à validation humaine.
- Pas de chiffres utilisateur intégrés dans les données de démonstration.


CORRECTIF 1.5.1 — RELECTURE CIBLEE
- Après « Relire ce champ », le texte OCR brut de la zone est maintenant affiché.
- Si le libellé n'est pas reconnu mais qu'un nombre crédible est lu, GridLedger propose ce nombre comme « Estimé ».
- Le champ ne reste plus silencieusement vide sans explication.
- Les erreurs OCR de la relecture ciblée sont affichées pour faciliter le diagnostic.


CORRECTIF 1.5.2 — DIAGNOSTIC SOUS LE CHAMP
- Le texte brut OCR de « Relire ce champ » apparaît directement sous le champ concerné.
- Bouton « Voir la zone lue » : affiche le recadrage exact utilisé par l'OCR.
- Si aucun nombre n'est reconnu, l'utilisateur peut voir immédiatement si le problème vient du recadrage ou de l'OCR.
- Le diagnostic global éloigné a été supprimé au profit d'un diagnostic contextuel.


CORRECTIF 1.5.3 — OCR NUMERIQUE PIONEX
- Diagnostic confirmé : le recadrage pouvait contenir la bonne valeur mais l'OCR privilégiait un libellé voisin.
- Deuxième passe dédiée au nombre seul dans une zone plus étroite.
- OCR limité aux caractères 0-9 + - , . % pendant cette passe.
- Affichage séparé du texte de zone et de la lecture « nombre uniquement ».
- Le bouton « Voir la zone » montre la zone numérique lorsque cette seconde passe a été utilisée.
- Toute valeur ainsi trouvée reste « Estimé » jusqu'à validation humaine.


FONCTION 1.5.4 — OCR ASSISTE PAR POINTAGE
- Si la zone automatique échoue, bouton « Pointer le nombre » sous chaque métrique numérique.
- L'utilisateur touche directement le nombre sur la capture.
- GridLedger crée plusieurs petits recadrages autour du point touché.
- Plusieurs prétraitements locaux (contraste / seuil) sont testés.
- OCR limité aux caractères numériques et signes.
- La meilleure valeur candidate est proposée en « Estimé », jamais en « Certain ».
- Cette méthode s'adapte mieux aux tailles d'écran et variations d'interface que des coordonnées fixes.


CORRECTIF 1.5.5 — VALIDATION HUMAINE
- Une nouvelle tentative de pointage qui échoue n'efface plus ni ne rend ambiguë une estimation déjà présente.
- Le diagnostic indique explicitement que la valeur précédente est conservée.
- Bouton « J’ai vérifié » pour transformer volontairement un champ Estimé en Certain après comparaison visuelle.
- Le passage à Certain reste exclusivement une action humaine.


CORRECTIF 1.5.6 — GARDE-FOU OCR / SAISIE ASSISTEE
- Correction du cas dangereux où « +39,49 (+3,73%) » pouvait devenir un entier concaténé comme « 3949037 ».
- Les lectures OCR numériques ambiguës sont désormais rejetées au lieu d'être proposées.
- Un entier long sans séparateur décimal issu d'une petite zone monétaire Pionex est considéré comme suspect.
- Si le crop contient un pourcentage et que l'OCR aplatit les chiffres, la valeur est rejetée.
- Dans la fenêtre de pointage, l'utilisateur peut saisir manuellement la valeur visible.
- La saisie assistée est enregistrée comme « Estimé » puis peut être passée à « Certain » avec « J’ai vérifié ».
- L'OCR ne doit jamais avoir priorité sur une validation humaine explicite.


VERSION 1.6 — CAPTURE SIMPLIFIEE
- Les diagnostics OCR techniques sont cachés par défaut.
- Bouton « Afficher les outils avancés » pour accéder à Relire / Pointer / zones OCR.
- Le parcours normal devient : lire l'image -> vérifier/corriger -> J'ai vérifié -> enregistrer.
- Une saisie manuelle dans un champ « À vérifier » le fait passer à « Estimé ».
- Seule l'action « J'ai vérifié » passe un champ à « Certain ».
- Les garde-fous OCR de la 1.5.6 sont conservés.


CORRECTIF 1.6.1 — VALIDATION SIMPLE
- En mode normal, le sélecteur Certain / Estimé / À vérifier est caché.
- Un badge simple affiche l'état du champ.
- Dès qu'un champ contient une valeur, « J’ai vérifié » apparaît.
- L'utilisateur peut donc confirmer directement un chiffre OCR après comparaison visuelle.
- Si une valeur confirmée est modifiée, elle redescend automatiquement à Estimé.
- Les réglages détaillés restent accessibles via « Outils avancés ».


CORRECTIF 1.6.2 — SOURCE PLATEFORME
- Lorsqu'une capture reconnue provient d'une plateforme connue, GridLedger peut remplacer automatiquement une plateforme vide ou « Exemple ».
- Une plateforme réelle déjà renseignée n'est jamais écrasée automatiquement.
- La source de la dernière capture est affichée séparément dans la fiche du bot.
- Le statut « snapshot partiel » reste inchangé tant qu'aucune valorisation EUR fiable n'est fournie.


VERSION 1.7 — FICHE BOT & GRAPHIQUE
- Un bot peut être ouvert depuis l'écran Bots.
- Fiche détaillée : plateforme, paire, valeur patrimoniale EUR, dernières métriques natives et nombre de snapshots.
- Graphique local SVG : Grid Profit et P&L latent dans leur unité native.
- Plages : 7 jours, 30 jours, 3 mois, 1 an, tout.
- Les unités natives différentes ne sont jamais mélangées dans une même courbe.
- La valeur patrimoniale EUR reste séparée du graphique des métriques de plateforme.
- Les mouvements liés sont affichés comme repères/historique, jamais additionnés aux métriques.
- Historique des snapshots et justificatifs liés au bot.
- Aucun moteur de trading, aucune connexion exchange, aucun levier.


CORRECTIF 1.7.1 — HISTORIQUE / DOUBLONS
- Correction du message « Pas assez de snapshots » qui pouvait rester visible par-dessus le graphique.
- Les nouveaux snapshots enregistrent maintenant date + heure (capturedAt).
- Le graphique regroupe les snapshots strictement identiques d'une même date/unité/métriques.
- Si plusieurs snapshots identiques existent, une note l'indique au lieu de simuler une évolution.
- L'historique affiche l'heure pour les nouveaux relevés et indique combien de relevés existent le même jour.
- Détection de snapshot identique avant enregistrement, avec confirmation explicite.
- Détection d'un justificatif très similaire avant création d'une deuxième copie.
- Les anciens snapshots sans heure restent compatibles.


CORRECTIF 1.7.2 — LEGACY & DOUBLONS EXACTS
- Les anciens snapshots sans capturedAt n'affichent plus une fausse heure 12:00 : « heure inconnue ».
- Les calculs de période conservent une date de repli interne sans présenter cette heure comme réelle.
- Quand le graphique ne contient qu'un seul point unique, GridLedger l'explique explicitement.
- Les justificatifs liés au bot sont comparés par empreinte SHA-256 après déchiffrement local.
- Les copies strictement identiques sont signalées.
- Le nettoyage reste volontaire : bouton « Conserver une seule copie » + confirmation.
- Avant suppression d'une copie exacte, les snapshots qui la référencent sont repointés vers la copie conservée.
- Aucun document similaire mais non identique n'est supprimé.


CORRECTIF 1.7.3 — DOUBLONS DE SNAPSHOTS
- Détection des relevés strictement identiques dans l'historique d'un bot.
- Les doublons sont signalés visuellement.
- Bouton volontaire « Conserver un seul relevé » + confirmation.
- Le relevé conservé est choisi en priorité selon : confiance Certain > Estimé > À vérifier, puis présence d'un justificatif.
- Si le relevé conservé n'a pas de justificatif mais qu'un doublon en a un, le lien au justificatif est préservé.
- Aucun relevé différent n'est fusionné.


VERSION 1.7.4 — TEST GRAPHIQUE FICTIF TEMPORAIRE
- Bouton « Ajouter un relevé fictif de test » dans la fiche Bot.
- Le relevé est uniquement conservé en mémoire de la page : aucun saveState, aucun ajout IndexedDB/localStorage.
- Valeurs de test fixes et anonymisées, non dérivées des données utilisateur.
- Le snapshot est marqué « FICTIF · NON ENREGISTRÉ ».
- Le compteur distingue les relevés réels du point de test.
- Le point fictif disparaît en quittant la fiche, en rechargeant la page ou via « Retirer le relevé fictif ».
- Aucun impact sur la valeur patrimoniale, les mouvements, les justificatifs, les sauvegardes ou la fiscalité.


VERSION 1.8 — COMPTABILITE DETAILLEE DU BOT
- Carte « Comptabilité du bot » séparée des métriques Pionex.
- Formule : valeur actuelle EUR + sorties du bot − financement reçu − valeur d'ouverture.
- Les frais ne sont jamais ajoutés en retour dans la formule : s'ils sont déjà reflétés dans la valeur, ils restent une perte économique.
- Grid Profit et P&L latent restent explicatifs et ne sont jamais additionnés à la performance GridLedger.
- Affichage séparé des gains retirés qualifiés et réinvestissements qualifiés.
- La métrique « Retiré » issue d'une capture de plateforme reste une information native, pas un transfert comptable automatique.
- Ajout manuel d'un mouvement lié au bot : financement, réinvestissement, gain retiré, retour de capital, autre transfert interne.
- Un mouvement enregistré ne modifie pas automatiquement la valeur actuelle observée du bot.
- Les qualifications sont manuelles : GridLedger ne déduit pas automatiquement qu'un transfert est un gain retiré ou un réinvestissement.
- Le test graphique fictif de la 1.7.4 est masqué dans l'interface normale.


CORRECTIF 1.8.1 — RÉCONCILIATION APRÈS MOUVEMENT
- Un mouvement lié au bot ne modifie toujours pas automatiquement sa valeur observée.
- Si un mouvement est plus récent que la dernière valeur EUR confirmée, la performance devient « PROVISOIRE · À RÉCONCILIER ».
- La performance n'est plus présentée en vert comme définitive tant que la valeur actuelle n'a pas été réobservée.
- Ajout de « Mettre à jour la valeur EUR du bot » avec valeur réellement observée + date.
- Une observation manuelle met à jour bot.value et bot.valueObservedAt.
- GridLedger ne calcule jamais cette valeur à partir du Grid Profit ou du P&L latent.
- Audit event BOT_VALUE_OBSERVED ajouté à chaque confirmation.


CORRECTIF 1.8.2 — RÉINVESTISSEMENT & RÉCONCILIATION
- Correction de la détection du mouvement le plus récent.
- Un réinvestissement enregistré après la dernière valeur EUR confirmée déclenche désormais correctement « PROVISOIRE · À RÉCONCILIER ».
- Les réinvestissements sont explicitement inclus dans « financement reçu » pour le calcul de performance du bot.
- Cela empêche de traiter un capital réinjecté comme un gain.
- Après une nouvelle observation EUR postérieure au mouvement, la performance redevient réconciliée.


VERSION 1.9 — FRAIS & ANTI DOUBLE COMPTAGE
- Ajout manuel de frais liés au bot avec traitement explicite.
- Traitements : REFLECTED_IN_VALUE, EXTERNAL_ACCRUAL, TRANSFER_GAP, INCLUDED_IN_PLATFORM_METRIC, UNKNOWN.
- Seuls les frais EXTERNAL_ACCRUAL (payés hors valeur observée du bot) sont soustraits séparément de la performance.
- REFLECTED_IN_VALUE : le frais doit être capturé par une valeur observée postérieure ; GridLedger demande une réconciliation si nécessaire.
- TRANSFER_GAP : le coût est supposé déjà visible dans les montants réels du transfert ; pas de deuxième soustraction.
- INCLUDED_IN_PLATFORM_METRIC : information explicative uniquement ; aucune correction de performance.
- UNKNOWN : conservé « à vérifier », sans soustraction arbitraire.
- Affichage du total des frais, de la part hors valeur réellement soustraite et du montant encore à qualifier.
- L'historique affiche le traitement choisi pour chaque frais.


GRIDLEDGER v2.0 BÊTA CONSOLIDÉE
==============================
Cette version regroupe le MVP mobile dans une seule livraison :

- coffre local chiffré + verrouillage automatique ;
- sauvegarde/restauration chiffrée ;
- tableau de bord global ;
- patrimoine : actifs/emplacements, baseline et observations de valeur ;
- mouvements généraux : apports, distributions, transferts internes ;
- bots Spot Grid : métriques natives, performance GridLedger, réconciliation ;
- frais avec traitement anti double comptage ;
- gains retirés / réinvestissements qualifiés ;
- graphique Grid Profit / P&L latent séparé de l'EUR ;
- snapshots, historique, détection de doublons ;
- corrections de mouvements par contre-écriture ;
- capture intelligente OCR local + vérification humaine ;
- documents chiffrés et justificatifs liés ;
- dossier fiscal annuel + scénario manuel configurable ;
- objectifs de patrimoine / réserve / allocation bots ;
- qualité des données et provenance ;
- cycle de vie du bot : changements de stratégie et clôture avec transfert de récupération ;
- Assistant GridLedger : seulement prévu, non connecté dans cette bêta.

RÈGLES IMPORTANTES
- Aucun ordre de trading.
- Aucune connexion exchange en écriture.
- Aucun levier.
- Aucun rendement promis.
- Grid Profit et P&L latent ne sont jamais ajoutés à la performance économique GridLedger.
- Les transferts internes sont neutres globalement.
- Les baselines ne sont pas des contributions fictives.
- Une fermeture de bot crée un transfert de récupération ; elle ne double pas la valeur récupérée.
- Fiscalité : aucun taux légal n'est fourni automatiquement.
- IA : aucune donnée n'est envoyée à un service externe dans cette version.

LIMITES DE CETTE BÊTA
- L'OCR local reste dépendant de la qualité de la capture et du navigateur.
- Les montants utilisent encore le moteur numérique du prototype ; la version production devra migrer vers une arithmétique décimale stricte.
- IndexedDB reste un stockage navigateur : conserver des sauvegardes chiffrées hors du téléphone.
- Une vraie publication installable / stores demandera encore une phase de packaging, tests multi-appareils et durcissement.


GRIDLEDGER v2.1 PERSONNEL — IMPORT DU TABLEAU DE BASE
====================================================
- Base locale distincte des versions de test.
- Aucun chiffre personnel n'est écrit en clair dans le HTML.
- Après création du coffre : Plus > Importer mon tableau de base > choisir le .xlsx.
- Le fichier est lu localement dans le navigateur, sans envoi internet.
- Les valeurs actuelles deviennent des baselines / valeurs d'ouverture.
- Les versements futurs et hypothèses de rendement restent du planning.
- Le capital bots est importé de façon agrégée Bybit + Pionex car le tableau ne donne pas leur ventilation.
- L'immobilier est importé comme capital net récupérable personnel, pas comme valeur brute de la maison.

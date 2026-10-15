# Starlink

Votre antenne Starlink dans Gladys : son état, la latence, la perte de paquets, les débits, l'obstruction,
les alertes et le mode fonte de neige, lus sur votre réseau local comme le fait l'application Starlink. Des
déclencheurs de scène signalent la coupure et le retour de la connexion, et un widget montre l'antenne d'un
coup d'œil.

> **Développée sans le matériel : vos retours sont les bienvenus.** L'intégration a été écrite à partir du
> protocole publié par la communauté et testée sur des réponses d'antenne enregistrées, pas sur une vraie
> antenne. Dites ce qui marche et ce qui ne marche pas sur le forum Gladys ou dans les issues GitHub.
>
> Cette intégration n'est ni affiliée, ni approuvée, ni soutenue par SpaceX ou Starlink.

## Présentation

- **Un appareil par antenne**, nommé d'après son matériel (ex. « Starlink rev3 »), identifié par le numéro
  de série de l'antenne : il survit à un changement d'adresse.
- **En local uniquement** : l'antenne répond sur `192.168.100.1:9200` (gRPC, le protocole de l'application
  Starlink), sans compte, sans mot de passe, sans cloud.
- **Mesures moyennées sur l'intervalle de rafraîchissement** : latence, perte de paquets et débits viennent
  de l'historique seconde par seconde de l'antenne, pas d'un échantillon isolé.
- **Rafraîchissement autonome** : l'intégration lit l'antenne avec son propre minuteur ; elle ne dépend pas
  de l'interrogation de l'appareil par Gladys.
- **Sûre par défaut** : redémarrer ou ranger l'antenne coupe Internet, ces commandes restent donc refusées
  tant que vous ne les autorisez pas.

## Prérequis

- Gladys Assistant **5.1.0** ou plus récent (déclencheurs, actions de scène et widgets).
- Une antenne Starlink (standard, Gen 2 « rectangulaire », Gen 3, Mini…) sous tension.
- **Gladys doit joindre `192.168.100.1`**. L'intégration tourne dans son propre conteneur, sur un réseau
  Docker en pont : son trafic sort par la machine Gladys, elle joint donc l'antenne exactement quand la
  machine Gladys la joint.
  - Avec le **routeur Starlink**, rien à faire : le routeur transmet `192.168.100.1` à l'antenne.
  - Avec **votre propre routeur** et le routeur Starlink en **mode bypass** (ou un adaptateur Ethernet
    Starlink branché sur votre routeur), la plupart des routeurs joignent directement l'adresse de
    l'antenne. Sinon, ajoutez sur votre routeur une route statique vers `192.168.100.1/32` par son interface
    WAN (Internet).
  - Vérifiez depuis la machine Gladys : `ping 192.168.100.1` doit répondre. Le bouton **Tester la connexion
    à l'antenne** de la configuration confirme que l'intégration la voit.

## Configuration

Ouvrez **Intégrations → Starlink → Configuration** :

| Champ                                        | Défaut          | Rôle                                                                                                               |
| -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Adresse de l'antenne                         | `192.168.100.1` | Adresse IP de l'antenne, éventuellement suivie du port (`9200` par défaut).                                        |
| Intervalle de rafraîchissement               | 30 secondes     | 10, 15, 30 s ou 1 min. Les mesures sont moyennées sur cet intervalle.                                              |
| Langue des textes de l'appareil              | Français        | Noms des fonctionnalités (fixés à l'ajout de l'antenne) et texte de l'état.                                        |
| Autoriser les commandes qui coupent Internet | désactivé       | Redémarrer, ranger et déployer sont refusés tant qu'il n'est pas activé. Le mode fonte de neige n'en a pas besoin. |

Ouvrez ensuite **Intégrations → Starlink → Découverte** et ajoutez l'antenne à Gladys. Les boutons de
l'écran de configuration :

- `test_connection` — **Tester la connexion à l'antenne** : indique ce qui a répondu (matériel, logiciel,
  état).
- `reboot_dish` — **Redémarrer l'antenne** : Internet revient au bout de quelques minutes.
- `stow_dish` — **Ranger l'antenne** : elle se met à plat (avant une tempête, pour la déplacer). Pas
  d'Internet jusqu'au déploiement.
- `unstow_dish` — **Déployer l'antenne** : elle se retourne vers le ciel et se reconnecte.

## L'appareil antenne

| Fonctionnalité             | Type (Gladys)  | Signification                                                                                        |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Starlink en ligne          | binaire        | 1 quand l'antenne est connectée aux satellites, 0 sinon (et quand elle est injoignable).             |
| État                       | texte          | Connectée, Recherche de satellites, Obstruée, Rangée, En veille, Injoignable…                        |
| Latence                    | durée (ms)     | Temps de ping moyen vers le réseau Starlink sur l'intervalle (secondes entièrement perdues exclues). |
| Perte de paquets           | pourcentage    | Part des pings perdus sur l'intervalle.                                                              |
| Débit descendant / montant | débit (Mbit/s) | Trafic moyen passant par l'antenne sur l'intervalle — votre usage, pas un test de débit.             |
| Ciel obstrué               | pourcentage    | Part du ciel que l'antenne a trouvée obstruée (arbres, bâtiments).                                   |
| Obstruée en ce moment      | binaire        | 1 quand un obstacle masque l'antenne au moment de la lecture.                                        |
| Durée de fonctionnement    | durée (h)      | Temps depuis le dernier redémarrage de l'antenne.                                                    |
| Consommation               | puissance (W)  | Consommation moyenne sur l'intervalle (antennes qui la publient).                                    |
| Chauffe (fonte de neige)   | binaire        | 1 quand l'antenne chauffe pour faire fondre la neige.                                                |
| Limitation thermique       | binaire        | 1 quand l'antenne se bride parce qu'elle a trop chaud.                                               |
| Arrêt pour surchauffe      | binaire        | 1 quand l'antenne s'est arrêtée à cause d'une surchauffe.                                            |
| Mise à jour en attente     | binaire        | 1 quand une mise à jour du logiciel attend un redémarrage.                                           |
| Mode fonte de neige        | sélection      | Automatique, Toujours active, Désactivée — modifiable depuis Gladys.                                 |
| Version du logiciel        | texte          | Le micrologiciel de l'antenne.                                                                       |

Seules les valeurs qui changent sont envoyées à Gladys ; une valeur stable est renvoyée toutes les 6 heures
pour que le tableau de bord n'affiche jamais « Pas de valeur récente ».

### Mode fonte de neige

**Automatique** chauffe quand l'antenne détecte de la neige, **Toujours active** chauffe avant une chute de
neige (plus de consommation), **Désactivée** ne chauffe jamais (économise l'énergie, mais la neige peut
couper la connexion). Choisissez-le depuis l'appareil ou avec l'action de scène `set_snow_melt_mode`.

## Widget

Le widget `dish_status` (**Starlink**) montre la latence, les débits descendant et montant, le ciel
obstrué, puis l'état (vert quand connectée, orange pendant une coupure, rouge quand injoignable), les
alertes actives par leur nom, le mode fonte de neige et la durée de fonctionnement. Une fois l'antenne
ajoutée à Gladys, les tuiles suivent ses fonctionnalités en direct. Son réglage facultatif choisit
l'antenne.

## Déclencheurs de scène

- `connection_lost` — **Connexion Starlink coupée** : l'antenne est hors ligne depuis tout un intervalle de
  rafraîchissement (deux lectures de suite), ou ne répond plus du tout (cause `unreachable` : coupure de
  courant, câble). Les micro-coupures sont ignorées. Filtrez sur la **Cause** (obstruée, recherche de
  satellites, rangée, en veille, antenne muette…). Variables : le code de la cause et le texte de l'état.
- `connection_restored` — **Connexion Starlink rétablie** : l'antenne revient après une coupure signalée.
  Variables : la durée de la coupure en secondes et la cause.
- `obstruction_detected` — **Ciel de l'antenne Starlink obstrué** : un obstacle commence à masquer
  l'antenne, au plus une fois toutes les 10 minutes. Variable : la part du ciel obstruée (%).

Une coupure déjà en cours au démarrage de Gladys n'est pas signalée (Gladys ne peut pas savoir quand elle a
commencé).

## Actions de scène

- `reboot_dish` — **Redémarrer l'antenne Starlink**.
- `stow_dish` — **Ranger l'antenne Starlink**.
- `unstow_dish` — **Déployer l'antenne Starlink**.
- `set_snow_melt_mode` — **Régler la fonte de neige Starlink** (automatique, toujours active, désactivée).

Les trois premières coupent Internet : elles échouent (et la scène l'inscrit dans ses journaux) tant que
**Autoriser les commandes qui coupent Internet** n'est pas activé. Gardez en tête que Gladys Plus, l'accès à
distance et les notifications par le cloud passent par ce même accès à Internet.

## Exemples de scènes

- **Prévenir quand Starlink tombe** : déclencheur `connection_lost` avec la cause « Antenne muette
  (courant, câble) » → envoyer un message sur un canal local (ou une notification plus tard, au retour de
  la connexion).
- **Garder trace des coupures** : déclencheur `connection_restored` → envoyer le message « Starlink revenu
  après `outage_seconds` s ».
- **De la neige est annoncée** : condition météo « neige » le soir → `set_snow_melt_mode` « Toujours
  active » ; le lendemain matin → « Automatique ».
- **Chien de garde** : déclencheur `connection_lost`, cause « Pas de réponse du réseau » → attendre
  10 minutes → `reboot_dish` (avec les commandes autorisées).

## Dépannage

- **« L'antenne ne répond pas »** : depuis la machine Gladys, `ping 192.168.100.1`. Pas de réponse : voir
  les prérequis (mode bypass, route statique). Une réponse mais toujours en échec : vérifiez l'adresse et le
  port (`9200`) dans la configuration.
- **Aucun appareil dans Découverte** : l'antenne doit avoir répondu une fois ; utilisez **Tester la
  connexion à l'antenne**.
- **Les valeurs ne bougent jamais** : vérifiez que l'antenne a été ajoutée à Gladys ; puis regardez les
  journaux avec `LOG_LEVEL=debug` (chaque lecture y est écrite au niveau debug).
- **La consommation reste vide** : certaines antennes ou versions du logiciel ne la publient pas.
- **Noms des fonctionnalités dans la mauvaise langue** : ils sont fixés à l'ajout de l'antenne ; changez la
  langue, puis supprimez et ajoutez de nouveau l'appareil (son historique est perdu).

## Limites

- L'API de l'antenne n'est **pas officielle** : SpaceX peut la changer par une mise à jour. L'intégration
  ignore ce qu'elle ne connaît pas et continue avec ce qu'elle trouve encore.
- **Une antenne** par installation (l'adresse de la configuration). Le routeur Wi-Fi Starlink n'est pas lu.
- Les débits sont le **trafic** qui passe par l'antenne, pas la capacité du lien.
- Pas de carte des obstructions, pas de position GPS, pas de programmation de la veille (l'application
  Starlink s'en charge).
- L'intervalle de rafraîchissement le plus court est de 10 secondes : une coupure plus courte qu'un
  intervalle peut passer inaperçue.
- Deux petites requêtes par intervalle (état ≈ 1 Ko, historique ≈ 25 Ko), sur le réseau local uniquement :
  aucun quota, aucun trafic Internet.

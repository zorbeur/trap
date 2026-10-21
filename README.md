# TimeQuant Email Service ✉️

Ce dépôt contient le microservice de messagerie officiel de la plateforme **TimeQuant**. Il est conçu pour être une passerelle transactionnelle robuste, découplée et hautement disponible, capable d'encaisser des milliers de requêtes asynchrones sans jamais bloquer les threads de simulation HPC.

## 🌟 Fonctionnalités Clés

- **Architecture Asynchrone (BullMQ + Redis)** : L'API répond en moins de 100ms. Les e-mails sont mis en file d'attente et traités en tâche de fond avec une politique de réessai automatique (Exponential Backoff).
- **Idempotence Stricte** : Évite l'envoi d'e-mails en double en cas de coupure réseau ou de retry (rétention de 24h via `Idempotency-Key`).
- **Moteur de Templates Dynamique (Nunjucks)** : Rendu de variables dynamiques compatible avec la syntaxe Jinja2. Extraction automatique du sujet de l'e-mail depuis la balise `<title>`.
- **Éditeur de Templates Intégré (UI)** : Tableau de bord permettant aux administrateurs de modifier le design HTML des e-mails à chaud.
- **Résilience des Données (Fallback System)** : Les templates modifiés via l'UI survivent au redémarrage de Docker grâce à un volume dédié. Si un template personnalisé est supprimé, le système se rabat automatiquement sur le "réglage d'usine".
- **Tracking & Webhooks** : Écoute les retours des fournisseurs SaaS (ex: SendGrid) pour enregistrer les échecs définitifs (*Hard Bounces*).
- **Bouclier Anti-Spam (Rate Limiting)** : Bloque les abus (max 10 e-mails par heure par utilisateur) et ignore silencieusement les e-mails de "Calcul Terminé" si la durée est inférieure à 6 heures.
- **Observabilité MLOps** : Expose des compteurs Prometheus (`/metrics`) et intègre des logs structurés (Pino).

---

## 🛠️ Stack Technique

- **Backend** : Node.js (v20), Express.js
- **File d'attente & Cache** : Redis, BullMQ
- **Validation & Sécurité** : Zod, Helmet, Express Basic Auth
- **Mailing** : Nodemailer, html-to-text (génération automatique du *Plain Text Fallback*)
- **Déploiement** : Docker & Docker Compose (Conteneur Monolithique "Tout-en-un")

---

## 🚀 Démarrage Rapide (Déploiement & Développement)

Le service est conçu pour être déployé très simplement soit via Docker (recommandé en production, incluant l'API, le Worker et la base de données locale Redis), soit directement en Node.js pour le développement.

### Méthode 1 : Démarrage Production via Docker Compose (Recommandé)
```bash
# 1. Aller dans le dossier du microservice
cd /home/amos/stage/trap

# 2. Lancer le conteneur tout-en-un (API + Worker BullMQ + Redis interne)
docker compose up --build -d

# 3. Vérifier les logs et la santé du service :
docker compose logs -f
curl http://localhost:3000/health
```
L'API est désormais disponible sur `http://localhost:3000`.

### Méthode 2 : Démarrage Local Node.js (Développement)
```bash
cd /home/amos/stage/trap

# Installer les dépendances
npm install

# Assurez-vous qu'une instance Redis locale est active (ex: redis-server sur le port 6379)
# Lancer en mode développement avec rechargement automatique :
npm run dev

# Ou lancer en mode production standard :
npm start
```

### Exécution des Tests d'Intégration
```bash
cd /home/amos/stage/trap

# Exécuter le banc de test d'intégration complet (Validation API, File BullMQ et Envoi SMTP) :
./test_integration.sh
```

---

## 🔗 Intégration avec TimeQuant Platform

Le serveur principal TimeQuant Platform (`timequant-platform`) communique automatiquement avec ce microservice pour notifier les chercheurs.

### Variables à renseigner dans `timequant-platform/.env` :
```env
# URL du microservice de mailing TimeQuant
MAILER_URL="http://localhost:3000"

# Jeton d'authentification Bearer partagé
TQ_EMAIL_SERVICE_API_KEY="dev-secret-key"
```

### Événements Déclencheurs dans la Plateforme :
1. **Création de Compte Chercheur** : Envoi de l'e-mail de confirmation d'adresse et de bienvenue (`template_id: welcome_verification`).
2. **Réinitialisation de Mot de Passe** : Lien sécurisé à usage unique avec expiration 15 minutes (`template_id: password_reset`).
3. **Calcul Longue Durée Terminé** : Déclenché par les Celery Workers pour tout calcul dont le temps de simulation dépasse 6 heures (`wall_time_s >= 21600`), incluant le résumé des scalaires physiques calculés et le lien vers le studio (`template_id: simulation_completed`).

---

## ⚙️ Configuration (Variables d'Environnement)

Le service peut être configuré soit via des variables d'environnement, soit dynamiquement depuis l'interface d'administration.

| Variable | Description | Défaut |
|---|---|---|
| `PORT` | Port d'écoute de l'API | `3000` |
| `TQ_EMAIL_SERVICE_API_KEY` | Jeton d'authentification (Bearer Token) pour sécuriser l'API | `dev-secret-key` |
| `ADMIN_USER` | Identifiant du tableau de bord administrateur | `admin` |
| `ADMIN_PASSWORD` | Mot de passe du tableau de bord administrateur | `supersecret` |
| `SMTP_HOST` | Hôte SMTP par défaut (surchargé par l'UI si configuré) | `mailhog` |
| `SMTP_PORT` | Port SMTP par défaut | `1025` |

*(Note : Le changement de fournisseur d'e-mail (SendGrid, Mailjet, etc.) se fait de préférence en 1 clic depuis le Tableau de Bord sans redémarrer le serveur).*

---

## 🎛️ Interfaces d'Administration (UI)

Une fois le serveur démarré, vous avez accès à deux interfaces Web (protégées par le mot de passe `ADMIN_USER` / `ADMIN_PASSWORD`) :

1. **Tableau de Bord des Files d'Attente (Bull-Board)**
   👉 `http://localhost:3000/admin/queues`
   *Visualisez les e-mails en cours d'envoi, accédez à la Dead Letter Queue (DLQ) et relancez les tâches échouées.*

2. **Éditeur de Configuration & Templates**
   👉 `http://localhost:3000/admin/settings`
   *Changez votre fournisseur de messagerie à chaud ou éditez le code HTML des e-mails en direct.*

---

## 📡 Endpoints Principaux de l'API

Une collection **[Postman](postman_collection.json)** est disponible à la racine du projet pour tester facilement toutes ces routes.

### 1. Envoyer un E-mail (TimeQuant Platform -> Service)
`POST /v1/emails/send-templated`
* **Headers requis** : `Authorization: Bearer <API_KEY>`, `Idempotency-Key: <UUID>`
* **Corps (JSON)** :
  ```json
  {
    "to": { "email": "chercheur@labo.fr" },
    "template_id": "simulation_completed",
    "template_data": { "calc_id": "1234", "wall_time_s": 25000 }
  }
  ```

### 2. Consulter l'état d'un message
`GET /v1/emails/:message_id/status`
*Retourne l'état du message (`queued`, `sending`, `delivered`, `failed`, `bounced`).*

### 3. Métriques Prometheus (Grafana)
`GET /metrics`
*Scrappable publiquement par Prometheus.*

### 4. Réception des Webhooks (Bounce Tracking SaaS)
`POST /v1/webhooks/delivery`
*Endpoint générique destiné à être renseigné dans la configuration de votre fournisseur SaaS (SendGrid, Mailjet) pour recevoir les événements de livraison.*

---

## 📂 Architecture des Dossiers

```text
/
├── docker-compose.yml       # Orchestration
├── Dockerfile               # Construction de l'image Alpine (Node + Redis)
├── start.sh                 # Script de démarrage dual (Daemon Redis + Serveur Node)
├── postman_collection.json  # Requêtes de test prêtes à l'emploi
├── src/
│   ├── index.js             # Point d'entrée principal
│   ├── api.js               # Serveur Express, Routes, Webhooks et Limiteurs
│   ├── worker.js            # Consommateur BullMQ, Nodemailer, Générateur Plaintext
│   ├── queue.js             # Configuration BullMQ
│   ├── redis.js             # Client ioredis
│   ├── templates.js         # Moteur de rendu Nunjucks
│   ├── metrics.js           # Déclaration des compteurs Prometheus
│   ├── schemas.js           # Validation Zod
│   └── templates/           # ⚠️ Fichiers HTML des gabarits originaux ("Réglages d'usine")
```

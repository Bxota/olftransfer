# Brief projet — Service de partage de fichiers (type SwissTransfer)

## Contexte

Projet perso pour partager des fichiers avec des amis. Hébergé sur un VPS existant (`bxota.com`).
Objectif : coût quasi nul, pipeline GitOps simple, stack familière (Docker, Nginx, Ansible).

---

## Stack décidée

| Composant | Choix | Raison |
|---|---|---|
| Stockage fichiers | **Cloudflare R2** | 10 Go gratuits, egress gratuit, S3-compatible |
| Base de données | **PostgreSQL** (Docker) | Métadonnées + liens de partage |
| API | **FastAPI** | Léger, performant |
| Reverse proxy | **CaddyFile** (déjà en place) | Sous-domaine `share.bxota.com` |
| Secrets | **Doppler** | Déjà exploré, injection au runtime |
| CI/CD | **GitHub Actions + Ansible** | Push sur `main` = deploy automatique |
| Monitoring | **Uptime Kuma** (déjà en place) | Pas de changement |

---

## Architecture

```
Client (browser)
  └─► Nginx (share.bxota.com)
        └─► API Fastify (Docker)
              ├─► PostgreSQL (Docker) — métadonnées
              ├─► Cloudflare R2 — fichiers (via presigned URLs)
              └─► Worker cron — expiration des transferts
```

**Point clé** : le client uploade/télécharge directement vers R2 via **presigned URLs**.
L'API ne sert pas de proxy pour les fichiers — elle génère juste les URLs signées.
Cela évite de saturer le VPS sur les gros fichiers.

---

## Fonctionnement métier

1. L'utilisateur sélectionne un ou plusieurs fichiers dans le navigateur
2. L'API génère une presigned URL R2 pour chaque fichier + crée un enregistrement en base
3. Le client uploade directement vers R2 (chunked / multipart pour les gros fichiers)
4. L'API retourne un lien de partage unique (token opaque)
5. Le destinataire ouvre le lien → l'API génère une presigned URL de téléchargement
6. Un worker cron supprime les fichiers expirés de R2 et nettoie la base

---

## Schéma de base de données (à créer)

```sql
-- À implémenter
transfers (
  id UUID PRIMARY KEY,
  token VARCHAR UNIQUE,        -- token du lien de partage
  created_at TIMESTAMP,
  expires_at TIMESTAMP,        -- expiration configurable (ex. 7 jours)
  password_hash VARCHAR,       -- optionnel
  download_count INT DEFAULT 0,
  max_downloads INT            -- optionnel
)

files (
  id UUID PRIMARY KEY,
  transfer_id UUID REFERENCES transfers(id),
  filename VARCHAR,
  size_bytes BIGINT,
  mime_type VARCHAR,
  r2_key VARCHAR               -- clé dans le bucket R2
)
```

---

## Structure du repo Git (à créer)

```
file-sharing/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions : build image + run Ansible
├── app/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── src/                    # code Fastify
├── infra/
│   ├── inventory.yml           # IP du VPS
│   ├── playbook.yml            # playbook principal
│   └── roles/
│       ├── nginx/              # dépose la config share.bxota.com + reload
│       ├── app/                # docker compose up via Doppler
│       └── postgres/           # init DB + migrations
└── README.md
```

---

## Pipeline GitOps (à créer)

**Déclencheur** : push sur `main`

```
git push
  └─► GitHub Actions
        ├─► Build image Docker → push vers GHCR (ghcr.io/...)
        └─► ansible-playbook infra/playbook.yml
              ├─► Role nginx   → config Nginx + reload
              ├─► Role postgres → migrations si nécessaire
              └─► Role app     → doppler run -- docker compose up -d --pull always
```

**Secrets GitHub Actions nécessaires** :
- `VPS_SSH_KEY` — clé privée SSH pour se connecter au VPS
- `DOPPLER_TOKEN` — token Doppler injecté dans Ansible

**Secrets gérés par Doppler** (injectés au runtime) :
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_ENDPOINT`
- `DATABASE_URL`
- `APP_SECRET` (pour signer les tokens)

---

## Actions à implémenter (dans l'ordre suggéré)

### 1. Infra de base
- [ ] Créer `infra/inventory.yml` avec l'IP du VPS
- [ ] Créer `infra/roles/nginx/` — template de config Nginx pour `share.bxota.com`
- [ ] Créer `infra/roles/postgres/` — démarrage du conteneur + init schema
- [ ] Créer `infra/roles/app/` — déploiement via `doppler run -- docker compose up -d`
- [ ] Créer `infra/playbook.yml` qui orchestre les 3 roles

### 2. CI/CD
- [ ] Créer `.github/workflows/deploy.yml`
  - Step 1 : build + push image vers GHCR
  - Step 2 : install Ansible + run playbook avec la clé SSH et le token Doppler
- [ ] Ajouter les secrets `VPS_SSH_KEY` et `DOPPLER_TOKEN` dans GitHub Actions

### 3. Application
- [ ] Créer le `docker-compose.yml` (services : `app`, `postgres`)
- [ ] Implémenter l'API Fastify :
  - `POST /transfers` — créer un transfert, retourner presigned URLs d'upload
  - `GET /transfers/:token` — récupérer les infos d'un transfert
  - `GET /transfers/:token/download` — générer presigned URLs de téléchargement
- [ ] Implémenter le worker cron (expiration + nettoyage R2)
- [ ] Créer les migrations SQL

### 4. Frontend (optionnel dans un premier temps)
- [ ] Page d'upload simple (drag & drop, barre de progression)
- [ ] Page de téléchargement (liste des fichiers, bouton download)

---

## Contraintes techniques importantes

- **Upload multipart** : découper les fichiers > 5 Mo en chunks côté client, utiliser l'API multipart S3 de R2
- **Presigned URLs** : durée de validité courte (ex. 15 min pour l'upload, 1h pour le download)
- **Nginx** : ne pas router le trafic fichier par Nginx — uniquement l'API. Les transferts se font directement client ↔ R2
- **Expiration** : le cron doit supprimer les objets R2 ET les entrées en base. Indexer `expires_at` en base
- **CORS sur R2** : configurer le bucket pour autoriser les uploads depuis `share.bxota.com`
- **Doppler CLI** doit être installé sur le VPS (à gérer dans un role Ansible ou en prérequis)

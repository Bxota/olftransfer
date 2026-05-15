COMPOSE = docker compose

migrate:
	$(COMPOSE) exec -T postgres psql -U olftransfer -d olftransfer < infra/roles/postgres/files/schema.sql

.PHONY: migrate

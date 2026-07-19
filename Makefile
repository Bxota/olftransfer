COMPOSE = docker compose

migrate:
	$(COMPOSE) exec -T postgres psql -U olftransfer -d olftransfer < infra/roles/postgres/files/schema.sql

check:
	ruff check app/src
	npm --prefix frontend run typecheck

.PHONY: migrate check

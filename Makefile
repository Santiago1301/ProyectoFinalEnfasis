# AegisVolt - atajos de desarrollo local (Floci + minikube)
ENV ?= dev
TF_DIR := infra/terraform/live
export AWS_ACCESS_KEY_ID ?= test
export AWS_SECRET_ACCESS_KEY ?= test
export AWS_DEFAULT_REGION ?= us-east-1

.PHONY: cloud-up cluster-up bootstrap tf-init tf-plan tf-apply dev test typecheck prefect-install prefect-server prefect-run prefect-serve prefect-test

cloud-up:            ## Levanta Floci (AWS emulado en :4566)
	docker compose up -d floci

cluster-up:          ## Levanta minikube (perfil aegisvolt)
	minikube start -p aegisvolt --driver=docker --cpus=2 --memory=2800 --kubernetes-version=v1.33.1

bootstrap:           ## Crea el bucket S3 versionado para el tfstate (una sola vez)
	cd infra/terraform/bootstrap && terraform init -input=false && terraform apply -auto-approve

tf-init:
	cd $(TF_DIR) && terraform init -input=false -backend-config=backend-local.hcl

tf-plan:             ## make tf-plan ENV=test
	cd $(TF_DIR) && (terraform workspace select $(ENV) || terraform workspace new $(ENV)) && terraform plan -var-file=local.tfvars

tf-apply:            ## make tf-apply ENV=prod
	cd $(TF_DIR) && (terraform workspace select $(ENV) || terraform workspace new $(ENV)) && terraform apply -auto-approve -var-file=local.tfvars

dev:                 ## Corre los 4 servicios en local contra las tablas de $(ENV)
	./scripts/run-local.sh $(ENV)

test:
	npm test

typecheck:
	npm run typecheck

# --- Observabilidad con Prefect (UI en http://127.0.0.1:4200) -----------------
PREFECT_ENV := PREFECT_API_URL=http://127.0.0.1:4200/api PREFECT_SERVER_ANALYTICS_ENABLED=false DO_NOT_TRACK=1

prefect-install:     ## Crea el entorno de Python de los flujos
	python3 -m venv prefect/.venv && prefect/.venv/bin/pip install -q -r prefect/requirements.txt

prefect-server:      ## Levanta el servidor y dashboard de Prefect
	$(PREFECT_ENV) prefect/.venv/bin/prefect server start --host 127.0.0.1 --port 4200

prefect-run:         ## Ejecuta una vez el flujo de observabilidad
	cd prefect && $(PREFECT_ENV) .venv/bin/python -m aegis_flows.observability

prefect-serve:       ## Programa el flujo cada 5 minutos
	cd prefect && $(PREFECT_ENV) .venv/bin/python -m aegis_flows.observability --serve

prefect-test:        ## Pruebas de la auditoría SAGA
	cd prefect && .venv/bin/python -m pytest -q tests

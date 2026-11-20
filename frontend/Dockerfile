# docker build -f frontend/Dockerfile .   (contexto = raíz del monorepo)
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/station-reservation-service/package.json services/station-reservation-service/
COPY services/billing-wallet-service/package.json services/billing-wallet-service/
COPY services/energy-dispatch-service/package.json services/energy-dispatch-service/
COPY services/graphql-gateway/package.json services/graphql-gateway/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund -w frontend --include-workspace-root=false
COPY frontend frontend
RUN npm run build -w frontend

FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/nginx.conf
COPY frontend/docker-entrypoint.d/40-aegisvolt-upstream.sh /docker-entrypoint.d/
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
EXPOSE 8080

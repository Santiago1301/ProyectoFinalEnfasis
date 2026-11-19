# Imagen única para los 4 servicios: docker build --build-arg SERVICE=<servicio> .
# Imagen base configurable (CI usa node:22-alpine; en local sirve cualquier node >= 20).
ARG NODE_IMAGE=node:22-alpine
# Etapa 1: instala el monorepo y empaqueta el servicio en un solo archivo con esbuild.
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY services/station-reservation-service/package.json services/station-reservation-service/
COPY services/billing-wallet-service/package.json services/billing-wallet-service/
COPY services/energy-dispatch-service/package.json services/energy-dispatch-service/
COPY services/graphql-gateway/package.json services/graphql-gateway/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY services services
# ARG después de npm ci: las 4 imágenes reutilizan la misma capa de dependencias.
ARG SERVICE
RUN test -n "$SERVICE" && npm run build -w services/${SERVICE}

# Etapa 2: runtime mínimo, sin node_modules ni código fuente, usuario no root.
FROM ${NODE_IMAGE}
ARG SERVICE
ARG APP_VERSION=local
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    SERVICE_NAME=${SERVICE}
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/${SERVICE}/dist ./
USER node
EXPOSE 4000 4001 4002 4003
CMD ["node", "index.js"]

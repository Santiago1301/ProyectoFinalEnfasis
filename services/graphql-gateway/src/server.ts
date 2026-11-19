import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { expressMiddleware } from '@as-integrations/express5';
import { makeExecutableSchema } from '@graphql-tools/schema';
import cors from 'cors';
import express, { type RequestHandler } from 'express';
import { useServer } from 'graphql-ws/use/ws';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createServiceApp } from '@aegisvolt/shared';
import { buildResolvers, type GatewayDeps } from './resolvers.ts';
import { readFileSync } from 'node:fs';

// En dist/ el build copia schema.graphql junto a index.js.
const typeDefs = readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8');

export async function startGateway(deps: GatewayDeps, port: number) {
  const schema = makeExecutableSchema({ typeDefs, resolvers: buildResolvers(deps) as never });

  // El middleware de Apollo se asigna tras apollo.start(); se registra antes
  // del manejador de errores de createServiceApp.
  let graphqlHandler: RequestHandler = (_req, res) => void res.status(503).json({ error: 'STARTING' });
  const app = createServiceApp(deps.logger, (a) => {
    a.use('/graphql', cors(), express.json(), (req, res, next) => graphqlHandler(req, res, next));
  });
  const httpServer = createServer(app);

  // WSS: suscripciones GraphQL (protocolo graphql-ws) para el panel en tiempo real.
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
  const wsCleanup = useServer({ schema }, wsServer);

  const apollo = new ApolloServer({
    schema,
    introspection: true,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await wsCleanup.dispose();
            },
          };
        },
      },
      {
        async requestDidStart({ request }) {
          const started = Date.now();
          return {
            async willSendResponse({ errors }) {
              deps.logger.info('graphql_operation', {
                operation: request.operationName,
                duration_ms: Date.now() - started,
                errors: errors?.map((e) => e.message),
              });
            },
          };
        },
      },
    ],
  });
  await apollo.start();
  graphqlHandler = expressMiddleware(apollo);

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  deps.logger.info('service_started', { port, path: '/graphql', environment: deps.environment });

  const shutdown = async () => {
    deps.logger.info('service_stopping');
    await apollo.stop();
    await deps.logger.flush();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return httpServer;
}

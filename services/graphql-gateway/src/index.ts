import { FeatureFlagClient, Logger, getEnvironment } from '@aegisvolt/shared';
import { createServiceClients } from './clients.ts';
import { SagaOrchestrator } from './saga/orchestrator.ts';
import { httpParticipants } from './saga/participants.ts';
import { DynamoSagaStore } from './saga/store.ts';
import { startGateway } from './server.ts';

const environment = getEnvironment();
const logger = new Logger('graphql-gateway');
const clients = createServiceClients();
const flags = new FeatureFlagClient();
const store = new DynamoSagaStore();
const orchestrator = new SagaOrchestrator(store, httpParticipants(clients), flags, logger, environment);

await startGateway(
  {
    clients,
    orchestrator,
    store,
    flags,
    logger,
    environment,
    // Gobernanza: en prod las flags sólo se cambian por pipeline / IaC, no desde la UI.
    flagMutationsAllowed: (process.env.ALLOW_FLAG_MUTATIONS ?? (environment === 'prod' ? 'false' : 'true')) === 'true',
  },
  Number(process.env.PORT ?? 4000),
);

import { FeatureFlagClient, Logger, listen } from '@aegisvolt/shared';
import { buildApp } from './app.ts';
import { BillingRepository } from './repository.ts';

const logger = new Logger('billing-wallet-service');
const app = buildApp({ repo: new BillingRepository(), flags: new FeatureFlagClient(), logger });
listen(app, logger, 4002);

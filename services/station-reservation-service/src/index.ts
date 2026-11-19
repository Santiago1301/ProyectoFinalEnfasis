import { FeatureFlagClient, Logger, listen } from '@aegisvolt/shared';
import { buildApp } from './app.ts';
import { ReservationRepository } from './repository.ts';

const logger = new Logger('station-reservation-service');
const app = buildApp({ repo: new ReservationRepository(), flags: new FeatureFlagClient(), logger });
listen(app, logger, 4001);

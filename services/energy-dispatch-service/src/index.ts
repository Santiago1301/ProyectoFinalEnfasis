import { FeatureFlagClient, Logger, listen } from '@aegisvolt/shared';
import { buildApp } from './app.ts';
import { DispatchRepository } from './repository.ts';
import { startTelemetryLoop } from './telemetry-loop.ts';

const logger = new Logger('energy-dispatch-service');
const repo = new DispatchRepository();
const app = buildApp({ repo, flags: new FeatureFlagClient(), logger });
listen(app, logger, 4003);
startTelemetryLoop(repo, logger);

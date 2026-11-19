/**
 * Configuración común a todos los servicios. El ambiente (dev|test|prod) es
 * la única fuente de verdad para nombrar recursos: coincide con el workspace
 * de Terraform que los creó (aegisvolt-<recurso>-<ambiente>).
 */
export type Environment = 'dev' | 'test' | 'prod';

const ENVIRONMENTS: Environment[] = ['dev', 'test', 'prod'];

export function getEnvironment(): Environment {
  const env = (process.env.AEGIS_ENV ?? 'dev') as Environment;
  if (!ENVIRONMENTS.includes(env)) {
    throw new Error(`AEGIS_ENV inválido: ${env}. Valores permitidos: ${ENVIRONMENTS.join(', ')}`);
  }
  return env;
}

export function tableName(kind: 'reservations' | 'billing' | 'dispatch' | 'sagas' | 'feature-flags', env = getEnvironment()): string {
  const override = process.env[`TABLE_${kind.toUpperCase().replace('-', '_')}`];
  return override ?? `aegisvolt-${kind}-${env}`;
}

export function awsClientConfig() {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return {
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  };
}

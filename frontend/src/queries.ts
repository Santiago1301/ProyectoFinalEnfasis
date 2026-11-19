const STATION_FIELDS = `stationId name city address availableConnectors
  connectors { connectorId status powerKw plugType ultraFast reservationSagaId }`;
const FLAG_FIELDS = 'name enabled description environment updatedAt updatedBy';
const SAGA_FIELDS = `sagaId status fleetId stationId connectorId energyKwh fastChargeBoost amount currency
  surgeMultiplier failedStep failureReason createdAt steps { name status at detail }`;

export const Q_ENV = `{ environment { environment version flagMutationsAllowed services { name status version track latencyMs } } }`;
export const Q_STATIONS = `{ stations { ${STATION_FIELDS} } }`;
export const S_STATIONS = `subscription { stationsUpdated { ${STATION_FIELDS} } }`;
export const Q_FLAGS = `{ featureFlags { ${FLAG_FIELDS} } }`;
export const S_FLAGS = `subscription { featureFlagsUpdated { ${FLAG_FIELDS} } }`;
export const Q_WALLETS = `{ wallets { fleetId fleetName balance currency
  transactions(limit: 8) { txId sagaId type amount status reason createdAt } } }`;
export const Q_SAGAS = `query($limit: Int) { sagas(limit: $limit) { ${SAGA_FIELDS} } }`;
export const Q_SAGA = `query($id: ID!) { saga(sagaId: $id) { ${SAGA_FIELDS}
  session { status deliveredKwh energyKwhTarget powerKw faultCode telemetry(limit: 40) { timestamp powerKw deliveredKwh stateOfCharge } } } }`;
export const Q_QUOTE = `query($input: QuoteInput!) { quote(input: $input) { ratePerKwh surgeMultiplier surgeActive peakHour boostFee amount currency } }`;

export const M_RESERVE = `mutation($input: ReserveAndChargeInput!) { reserveAndCharge(input: $input) { ${SAGA_FIELDS} } }`;
export const M_STOP = `mutation($id: ID!) { stopCharging(sagaId: $id) { sagaId status } }`;
export const M_RETRY = `mutation($id: ID!) { retrySagaCompensation(sagaId: $id) { sagaId status } }`;
export const M_FLAG = `mutation($name: String!, $enabled: Boolean!) { setFeatureFlag(name: $name, enabled: $enabled) { ${FLAG_FIELDS} } }`;

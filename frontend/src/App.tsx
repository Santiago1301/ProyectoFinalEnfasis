import { useState } from 'react';
import { setEndpoint, useLiveQuery, useQuery } from './api';
import { FlagsPanel } from './components/FlagsPanel';
import { Header } from './components/Header';
import { ReservePanel } from './components/ReservePanel';
import { SagaHistory } from './components/SagaHistory';
import { StationsPanel } from './components/StationsPanel';
import { WalletsPanel } from './components/WalletsPanel';
import { Q_ENV, Q_FLAGS, Q_SAGAS, Q_STATIONS, Q_WALLETS, S_FLAGS, S_STATIONS } from './queries';
import type { EnvironmentInfo, FeatureFlag, Saga, Station, Wallet, WalletTx } from './types';

function Console() {
  const [selected, setSelected] = useState<{ stationId: string; connectorId: string }>();

  const env = useQuery<{ environment: EnvironmentInfo }>(Q_ENV, undefined, 10000);
  const stations = useLiveQuery<Station[]>(S_STATIONS, Q_STATIONS, (d) => d.stationsUpdated ?? d.stations);
  const flags = useLiveQuery<FeatureFlag[]>(S_FLAGS, Q_FLAGS, (d) => d.featureFlagsUpdated ?? d.featureFlags);
  const wallets = useQuery<{ wallets: (Wallet & { transactions: WalletTx[] })[] }>(Q_WALLETS, undefined, 5000);
  const sagas = useQuery<{ sagas: Saga[] }>(Q_SAGAS, { limit: 30 }, 4000);

  const environment = env.data?.environment;
  const refreshAll = () => {
    void wallets.refetch();
    void sagas.refetch();
  };

  return (
    <div className={`app env-${environment?.environment ?? 'unknown'}`}>
      <div className="env-strip" />
      <Header
        env={environment}
        error={env.error}
        onEndpoint={(url) => {
          setEndpoint(url);
          window.location.reload();
        }}
      />
      <main className="grid">
        <div className="col-main">
          <StationsPanel
            stations={stations.data}
            mode={stations.mode}
            selected={selected}
            onSelect={(stationId, connectorId) => setSelected({ stationId, connectorId })}
          />
          <SagaHistory sagas={sagas.data?.sagas} onChanged={refreshAll} />
        </div>
        <div className="col-side">
          <ReservePanel
            stations={stations.data}
            wallets={wallets.data?.wallets}
            flags={flags.data}
            selected={selected}
            onSelect={(stationId, connectorId) => setSelected({ stationId, connectorId })}
            onDone={refreshAll}
          />
          <FlagsPanel
            flags={flags.data}
            env={environment?.environment}
            mutationsAllowed={environment?.flagMutationsAllowed ?? false}
            onChanged={(f) => flags.setData((prev) => prev?.map((x) => (x.name === f.name ? f : x)))}
          />
          <WalletsPanel wallets={wallets.data?.wallets} />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return <Console />;
}

import { fmtMoney, fmtTime } from '../api';
import type { Wallet, WalletTx } from '../types';

export function WalletsPanel({ wallets }: { wallets?: (Wallet & { transactions: WalletTx[] })[] }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Billeteras de flotas</h2>
        <span className="muted small">billing-wallet-service</span>
      </div>
      <div className="wallets">
        {wallets?.map((w) => (
          <article key={w.fleetId} className="wallet">
            <header>
              <span>{w.fleetName}</span>
              <strong>{fmtMoney(w.balance, w.currency)}</strong>
            </header>
            <ul>
              {w.transactions.length === 0 && <li className="muted small">Sin movimientos</li>}
              {w.transactions.map((t) => (
                <li key={t.txId} className="small">
                  <span className={t.type === 'REFUND' ? 'tx-refund' : 'tx-charge'}>
                    {t.type === 'REFUND' ? '+' : '−'}
                    {fmtMoney(t.amount)}
                  </span>
                  <span className="muted">
                    {t.type === 'REFUND' ? 'Reembolso compensatorio' : 'Cobro'} · {fmtTime(t.createdAt)}
                    {t.status === 'REFUNDED' ? ' · revertido' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

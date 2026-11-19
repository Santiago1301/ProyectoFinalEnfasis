import { createClient, type Client } from 'graphql-ws';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Endpoint GraphQL activo (configurable en runtime desde /config.json). */
let endpoint = (() => {
  try {
    return localStorage.getItem('aegisvolt.endpoint') ?? '/graphql';
  } catch {
    return '/graphql';
  }
})();

export function getEndpoint() {
  return endpoint;
}

export function setEndpoint(url: string) {
  endpoint = url;
  try {
    localStorage.setItem('aegisvolt.endpoint', url);
  } catch {
    /* almacenamiento no disponible */
  }
  wsClient?.dispose();
  wsClient = undefined;
}

function wsUrl(http: string) {
  const abs = new URL(http, window.location.href);
  abs.protocol = abs.protocol === 'https:' ? 'wss:' : 'ws:';
  return abs.toString();
}

export class GraphQLRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}` }] }));
  if (body.errors?.length) {
    throw new GraphQLRequestError(body.errors[0].message, body.errors[0].extensions?.code);
  }
  return body.data as T;
}

let wsClient: Client | undefined;
function ws() {
  wsClient ??= createClient({ url: wsUrl(endpoint), retryAttempts: Infinity, lazy: true });
  return wsClient;
}

/** Consulta con refresco opcional cada `intervalMs`. */
export function useQuery<T>(query: string, variables?: Record<string, unknown>, intervalMs?: number, deps: unknown[] = [], skip = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const vars = JSON.stringify(variables ?? {});
  const refetch = useCallback(async () => {
    try {
      setData(await gql<T>(query, JSON.parse(vars)));
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, vars, ...deps]);

  useEffect(() => {
    if (skip) return;
    void refetch();
    if (!intervalMs) return;
    const id = setInterval(() => void refetch(), intervalMs);
    return () => clearInterval(id);
  }, [refetch, intervalMs, skip]);

  return { data, error, refetch, setData };
}

/**
 * Suscripción GraphQL por WSS (graphql-ws). Si el WebSocket no está disponible
 * (p. ej. detrás de un API Gateway REST), cae a polling HTTP del `fallbackQuery`.
 */
export function useLiveQuery<T>(subscription: string, fallbackQuery: string, pick: (d: any) => T, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [mode, setMode] = useState<'wss' | 'polling' | 'connecting'>('connecting');
  const pickRef = useRef(pick);
  pickRef.current = pick;

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => {
      if (pollTimer || cancelled) return;
      setMode('polling');
      const tick = () =>
        gql(fallbackQuery)
          .then((d) => !cancelled && setData(pickRef.current(d)))
          .catch(() => undefined);
      void tick();
      pollTimer = setInterval(tick, 2500);
    };
    // Si en 4 s no llegó nada por WSS, se usa polling.
    const watchdog = setTimeout(startPolling, 4000);
    const dispose = ws().subscribe(
      { query: subscription },
      {
        next: (msg) => {
          if (cancelled || !msg.data) return;
          clearTimeout(watchdog);
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = undefined;
          }
          setMode('wss');
          setData(pickRef.current(msg.data));
        },
        error: () => startPolling(),
        complete: () => undefined,
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      if (pollTimer) clearInterval(pollTimer);
      dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription, fallbackQuery, ...deps]);

  return { data, mode, setData };
}

export const fmtMoney = (n?: number | null, currency = 'COP') =>
  n == null ? '—' : new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

export const fmtTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

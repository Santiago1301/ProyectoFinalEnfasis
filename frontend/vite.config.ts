import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo /graphql (HTTP y WSS) se reenvía al gateway.
// GATEWAY_URL=http://localhost:8080 npm run dev  -> gateway en minikube (port-forward)
const target = process.env.GATEWAY_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/graphql': { target, ws: true, changeOrigin: true } },
  },
});

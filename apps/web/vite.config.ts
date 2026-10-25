import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const config = { plugins: [react()], server: { host: '127.0.0.1', proxy: { '/api': { target: process.env.WALLET_API_PROXY_TARGET ?? 'http://127.0.0.1:3001', changeOrigin: false } } }, test: { environment: 'node' } };
export default defineConfig(config);


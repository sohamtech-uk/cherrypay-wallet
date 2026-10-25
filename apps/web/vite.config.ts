import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const config = { plugins: [react()], server: { host: '127.0.0.1' }, test: { environment: 'node' } };
export default defineConfig(config);

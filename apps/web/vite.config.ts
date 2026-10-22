import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3005,
    strictPort: true,
    host: '127.0.0.1',
    fs: { allow: ['.', '../../design', '../../node_modules'] },
    proxy: {
      '/api': 'http://127.0.0.1:3006',
      '/ws': { target: 'http://127.0.0.1:3006', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] },
});

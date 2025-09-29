import { defineConfig } from 'vite';

// Ensure dependencies (like capnweb) using top-level await
// are transformed for modern environments.
export default defineConfig({
  esbuild: {
    target: 'es2022',
  },
  build: {
    target: 'es2022',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
  },
});


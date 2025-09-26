import { defineConfig } from 'vite';

// Ensure dependencies (like capnweb) using top-level await
// are transformed for modern environments.
export default defineConfig({
  esbuild: {
    target: 'esnext',
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
});


import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Three pages: model list (/), 3D viewer (/viewer.html?model=<id>), admin (/admin.html).
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        viewer: resolve(import.meta.dirname, 'viewer.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
});

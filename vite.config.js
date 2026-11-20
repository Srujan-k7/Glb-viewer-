import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Two pages: the public viewer (/) and the admin page (/admin.html).
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
});

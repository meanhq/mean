import { fileURLToPath } from 'node:url';
import { mean } from '@meanhq/mean/vite';
import { defineConfig, type UserConfig } from 'vite';

const config: UserConfig = defineConfig({
  plugins: [mean()],
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        other: fileURLToPath(new URL('./other.html', import.meta.url)),
      },
    },
  },
});

export default config;

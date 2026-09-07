import { mean } from '@meanhq/mean/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type UserConfig } from 'vite';

const config: UserConfig = defineConfig({ plugins: [vue(), mean()] });
export default config;

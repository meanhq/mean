import { mean } from '@meanhq/mean/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type UserConfig } from 'vite';

const config: UserConfig = defineConfig({ plugins: [svelte(), mean()] });
export default config;

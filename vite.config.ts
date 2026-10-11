import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
	resolve: {
		alias: {
			// Rare UI 组件内部用的是 `@/lib/utils` 这种导入形态，这里补别名，组件本身一行不改
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	envPrefix: ['VITE_', 'PARENT_ORIGIN'],
	plugins: [react(), cloudflare(), tailwindcss()],
})

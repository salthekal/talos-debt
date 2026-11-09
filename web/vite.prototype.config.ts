/**
 * Builds the clickable prototype: one self-contained HTML file with sample
 * data, for design review. `npm run build:prototype`
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  define: { 'import.meta.env.VITE_PROTOTYPE': JSON.stringify('1') },
  build: { outDir: 'dist-prototype', assetsInlineLimit: 100_000_000 },
});

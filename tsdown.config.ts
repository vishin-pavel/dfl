import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: false,
});

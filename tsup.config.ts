import { defineConfig } from 'tsup';

export default defineConfig({
  // `core` ne dépend ni de React ni de React Native : client HTTP et logique de la fenêtre,
  // utilisables (et testés) sous Node.js.
  entry: { index: 'src/index.ts', core: 'src/core.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  target: 'es2020',
  sourcemap: true,
  external: ['react', 'react-native'],
});

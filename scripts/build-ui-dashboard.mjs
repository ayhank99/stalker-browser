import { build } from 'esbuild';

await build({
  entryPoints: ['src/ui/dashboard.tsx'],
  bundle: true,
  outfile: 'public/tsx/dashboard.js',
  format: 'iife',
  globalName: 'DashboardApp',
  sourcemap: false,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

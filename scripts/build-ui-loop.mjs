import { build } from 'esbuild';

await build({
  entryPoints: ['src/ui/loop-channels.tsx'],
  bundle: true,
  outfile: 'public/tsx/loop-channels.js',
  format: 'iife',
  globalName: 'LoopChannelsApp',
  sourcemap: false,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

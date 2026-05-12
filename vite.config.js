import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig( {
  build: {
    lib: {
      entry: resolve( __dirname, 'index.js' ),
      name: 'BrowserDB',
      fileName: ( format ) => `browserdb.${ format === 'es' ? 'mjs' : format === 'umd' ? 'umd.js' : 'js' }`
    },
    rollupOptions: {
      // Externalize dependencies to avoid bundling them
      external: [ 'dexie' ],
      output: [
        {
          format: 'es',
          entryFileNames: 'browserdb.es.mjs',
          dir: 'dist'
        },
        {
          format: 'cjs',
          entryFileNames: 'browserdb.cjs.js',
          dir: 'dist',
          exports: 'default'
        },
        {
          format: 'umd',
          name: 'BrowserDB',
          entryFileNames: 'browserdb.umd.js',
          dir: 'dist',
          exports: 'default',
          globals: {
            dexie: 'Dexie'
          }
        }
      ]
    },
    target: 'esnext',
    minify: 'terser',
    sourcemap: true
  },
  resolve: {
    alias: {
      '@': resolve( __dirname, './src' )
    }
  }
} );

import "fake-indexeddb/auto";

// Reset Jest module cache and clear IndexedDB between test suites
beforeAll( async () => {
  // Clear all Jest module caches to reset dbCache in factory.js
  jest.resetModules();

  // Clear all fake-indexeddb databases
  if ( typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function" ) {
    try {
      const dbs = await indexedDB.databases();
      for ( const db of dbs ) {
        await new Promise( ( resolve ) => {
          const req = indexedDB.deleteDatabase( db.name );
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        } );
      }
    } catch ( err ) {
      // Silently ignore errors
    }
  }
} );

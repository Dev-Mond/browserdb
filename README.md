## Progressive `indexdb` Module — Custom Sync System

The `BrowserDB(userId)` helper for working with IndexedDB via Dexie wrapper with **automatic change tracking and bidirectional sync** capabilities

### Core Features

**Local CRUD & Queries:**
- `open(schemaSource)` — initialize DB
- `from(storeName)` — select store
- `where()`, `index()`, `between()`, `startsWith()`, `endsWith()`, `contains()` — filters
- `orderBy()`, `limit()`, `offset()` — sorting & paging
- `get()`, `first()`, `count()` — read
- `put()`, `update()`, `delete()` — write (auto-tracked)

**Custom Sync (Like Dexie Cloud Sync):**
- **Automatic change tracking**: All writes logged to `__sync__` metadata store (operation, timestamp, status)
- **`syncUp(endpoint, options)`**: Push pending changes with chunking & progress
- **`syncDown(endpoint, options)`**: Pull & merge remote changes with conflict detection
- **`fullSync(pushUrl, pullUrl, options)`**: Bidirectional sync
- **Conflict resolution**: Last-write-wins (default) or server-wins strategy
- **Sync metadata**: `getSyncMetadata()`, `getSyncStatus()`, `clearSyncMetadata()`
- **Control tracking**: `enableChangeTracking()` / `disableChangeTracking()`

### Sync Options

```javascript
{
  chunkSize: 500,                    // Records per batch (default: 500)
  onProgress: (p) => {},             // Progress callback
  headers: {},                       // Custom auth headers
  continueOnError: true,             // Skip failed chunks
  conflictStrategy: 'last-write-wins' // or 'server-wins'
}
```

### Quick Example

```javascript
const db = new BrowserDB(userId);
await db.open([{ name: 'users', options: { keyPath: 'id' } }]);

// Local changes auto-tracked
await db.from('users').put({ id: 1, name: 'Alice' });
await db.from('users').update({ id: 1, name: 'Bob' });

// Push pending changes
const result = await db.from('users').syncUp('/api/users/sync', {
  chunkSize: 1000,
  onProgress: (p) => console.log(`${p.synced}/${p.total}`)
});

// Pull remote changes
const data = await db.from('users').syncDown('/api/users/fetch', {
  conflictStrategy: 'last-write-wins'
});

// Or sync both ways
await db.from('users').fullSync('/api/sync-up', '/api/sync-down');
```

### Key Behaviors

- Changes tracked automatically in `__sync__` store (INSERT/UPDATE/DELETE)
- Large datasets handled via chunking (prevents 10MB+ memory issues)
- Pagination on `syncDown()` with auto page/limit params
- Offline-ready: changes queue until sync succeeds
- Conflict detection: compares local vs remote timestamps
- Bulk operations optimized via `bulkPut()`
### Build with Vite

BrowserDB uses **Vite** to generate optimized distribution bundles for different module systems:

```bash
# Build for production
npm run build

# Build for development (without minification)
npm run build:dev

# Preview the build
npm run preview
```

Generated bundles in `dist/`:
- **`browserdb.es.mjs`** — ES Module (for modern bundlers)
- **`browserdb.cjs.js`** — CommonJS (for Node.js)
- **`browserdb.umd.js`** — Universal Module Definition (browser & Node.js)

All bundles include source maps for debugging.

### Use Compiled Version

**In your project:**

```javascript
// ES Module
import BrowserDB from 'browserdb';

// CommonJS
const BrowserDB = require('browserdb');

// Browser UMD
<script src="dist/browserdb.umd.js"></script>
<script>
  const db = BrowserDB.default(userId);
</script>
```

### Testing

```bash
npm test
```

Runs Jest tests with Babel transpilation support for ES6 syntax.

import { getUserDexie, clearUserDexie } from "./factory";
import { DB_VERSION } from "./schema";

function buildQueryString ( params ) {
  if ( !params || typeof params !== "object" ) return "";
  const query = Object.keys( params )
    .filter( key => params[ key ] !== null && params[ key ] !== undefined )
    .map( key => `${ encodeURIComponent( key ) }=${ encodeURIComponent( params[ key ] ) }` )
    .join( "&" );
  return query ? `?${ query }` : "";
}

async function requestJson ( url, options = {} ) {
  const { method = "GET", headers = {}, body } = options;
  const config = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  };

  if ( body && ( method === "POST" || method === "PUT" || method === "PATCH" ) ) {
    config.body = JSON.stringify( body );
  }

  const response = await fetch( url, config );

  if ( !response.ok ) {
    throw new Error( `HTTP error! status: ${ response.status }` );
  }

  return await response.json();
}

function buildStoreSchema ( storeConfig ) {
  const options = storeConfig.options || {};
  const indexes = storeConfig.indexes || [];
  const parts = [];

  if ( options.keyPath ) {
    parts.push( options.autoIncrement ? "++" + options.keyPath : "" + options.keyPath );
  } else if ( options.autoIncrement ) {
    parts.push( "++id" );
  }

  indexes.forEach( index => {
    let path = index.keyPath || index.name;
    if ( !path ) {
      return;
    }

    if ( Array.isArray( path ) ) {
      path = `[${ path.join( "+" ) }]`;
    }

    if ( index.unique ) {
      parts.push( "&" + path );
    } else if ( index.multiEntry ) {
      parts.push( "*" + path );
    } else {
      parts.push( "" + path );
    }
  } );

  return parts.join( ", " );
}

function normalizeSchema ( source ) {
  const stores = {};
  const metadata = {};

  if ( Array.isArray( source ) ) {
    source.forEach( store => {
      if ( !store || !store.name ) {
        throw new Error( "Store config must be an object with a name property" );
      }

      stores[ store.name ] = buildStoreSchema( store );
      metadata[ store.name ] = {
        keyPath: store.options?.keyPath || null,
        autoIncrement: !!store.options?.autoIncrement,
        indexes: ( store.indexes || [] ).reduce( ( map, index ) => {
          const alias = index.name || index.keyPath;
          const keyPath = index.keyPath || index.name;
          if ( alias && keyPath ) {
            map[ alias ] = keyPath;
          }
          return map;
        }, {} )
      };
    } );
  } else if ( source && typeof source === "object" && source.name ) {
    return normalizeSchema( [ source ] );
  } else if ( source && typeof source === "object" ) {
    Object.keys( source ).forEach( storeName => {
      stores[ storeName ] = source[ storeName ];
      metadata[ storeName ] = { keyPath: null, autoIncrement: false, indexes: {} };
    } );
  } else {
    throw new Error( "Invalid schema configuration" );
  }

  return { stores, metadata };
}

// Sync metadata store schema - automatically added to track changes
const SYNC_METADATA_STORE = {
  name: "__sync__",
  options: { keyPath: "id", autoIncrement: true },
  indexes: [
    { name: "store_and_record_id", keyPath: [ "store", "record_id" ], unique: true },
    { name: "store_and_status", keyPath: [ "store", "status" ] },
    { name: "store", keyPath: "store" },
    { name: "status", keyPath: "status" },
    { name: "timestamp", keyPath: "timestamp" }
  ]
};

export default function BrowserDB ( userId ) {
  const db = getUserDexie( userId );
  let currentSchema = null;
  let currentMetadata = {};
  let currentVersion = DB_VERSION;
  let activeStore = null;
  let conditions = [];
  let indexQuery = null;
  let rangeQuery = null;
  let sortConfig = null;
  let limitCount = null;
  let offsetCount = null;
  let trackingEnabled = true;
  let originalPut = null;
  let originalUpdate = null;
  let originalDelete = null;

  function resetQuery () {
    activeStore = null;
    conditions = [];
    indexQuery = null;
    rangeQuery = null;
    sortConfig = null;
    limitCount = null;
    offsetCount = null;
  }

  function ensureStoreSelected () {
    if ( !activeStore ) {
      throw new Error( "Call from(storeName) before query or write operations" );
    }
  }

  function ensureStoreRegistered ( storeName ) {
    if ( !currentSchema || !currentSchema[ storeName ] ) {
      throw new Error( `Store "${ storeName }" is not registered. Call open() first.` );
    }
  }

  function getStoreMeta ( storeName ) {
    return currentMetadata[ storeName ] || { keyPath: null, autoIncrement: false, indexes: {} };
  }

  function getPrimaryKey ( storeName ) {
    return getStoreMeta( storeName ).keyPath || "id";
  }

  function getTable () {
    ensureStoreSelected();
    return db.table( activeStore );
  }

  async function trackChange ( store, recordId, operation, remoteTimestamp = null ) {
    if ( !trackingEnabled || store === "__sync__" ) return;

    try {
      const syncTable = db.table( "__sync__" );
      const now = Date.now();

      const existing = await syncTable
        .where( [ "store", "record_id" ] )
        .equals( [ store, String( recordId ) ] )
        .first();

      if ( existing ) {
        await syncTable.update( existing.id, {
          operation,
          local_timestamp: now,
          remote_timestamp: remoteTimestamp || null,
          status: "PENDING",
          attempts: 0
        } );
      } else {
        await syncTable.put( {
          store,
          record_id: String( recordId ),
          operation,
          local_timestamp: now,
          remote_timestamp: remoteTimestamp || null,
          status: "PENDING",
          attempts: 0
        } );
      }
    } catch ( err ) {
      console.warn( "Failed to track change:", err );
    }
  }

  async function markSynced ( store, recordId, remoteTimestamp = null ) {
    try {
      const syncTable = db.table( "__sync__" );
      const existing = await syncTable.where( [ "store", "record_id" ] ).equals( [ store, String( recordId ) ] ).first();
      if ( existing ) {
        await syncTable.update( existing.id, {
          status: "SYNCED",
          remote_timestamp: remoteTimestamp || Date.now()
        } );
      }
    } catch ( err ) {
      console.warn( "Failed to mark synced:", err );
    }
  }

  async function detectConflict ( store, recordId, remoteTimestamp ) {
    try {
      const syncTable = db.table( "__sync__" );
      const sync = await syncTable.where( [ "store", "record_id" ] ).equals( [ store, String( recordId ) ] ).first();
      if ( sync && sync.status === "PENDING" && sync.local_timestamp > remoteTimestamp ) {
        return true;
      }
    } catch ( err ) {
      console.warn( "Failed to detect conflict:", err );
    }
    return false;
  }

  async function applySchema ( schemaSource, version = DB_VERSION ) {
    const normalized = normalizeSchema( schemaSource );

    if ( !normalized.stores[ "__sync__" ] ) {
      normalized.stores[ "__sync__" ] = buildStoreSchema( SYNC_METADATA_STORE );
      normalized.metadata[ "__sync__" ] = {
        keyPath: "__sync__.id",
        autoIncrement: true,
        indexes: { store_and_record_id: [ "store", "record_id" ], store: "store", status: "status", timestamp: "timestamp" }
      };
    }

    currentSchema = { ...currentSchema, ...normalized.stores };
    currentMetadata = { ...currentMetadata, ...normalized.metadata };
    currentVersion = Math.max( currentVersion, version );
    db.close();
    db.version( currentVersion ).stores( currentSchema );
    await db.open();
  }

  async function runQuery () {
    ensureStoreSelected();
    const table = getTable();
    let results;

    if ( rangeQuery ) {
      results = await table.where( rangeQuery.field ).between( rangeQuery.lower, rangeQuery.upper ).toArray();
    } else if ( indexQuery ) {
      results = await table.where( indexQuery.keyPath ).equals( indexQuery.value ).toArray();
    } else {
      results = await table.toArray();
    }

    if ( conditions.length ) {
      results = results.filter( item => conditions.every( fn => fn( item ) ) );
    }

    if ( sortConfig ) {
      results.sort( ( a, b ) => {
        const aValue = a[ sortConfig.field ];
        const bValue = b[ sortConfig.field ];
        if ( aValue === bValue ) {
          return 0;
        }
        const compare = aValue > bValue ? 1 : -1;
        return sortConfig.direction === "desc" ? -compare : compare;
      } );
    }

    if ( offsetCount != null ) {
      results = results.slice( offsetCount );
    }
    if ( limitCount != null ) {
      results = results.slice( 0, limitCount );
    }

    return results;
  }

  return {
    async open ( schemaSource, version = DB_VERSION ) {
      await applySchema( schemaSource, version );
      return this;
    },

    async addStore ( storeConfig, version = currentVersion + 1 ) {
      if ( !storeConfig || !storeConfig.name ) {
        throw new Error( "addStore requires a store config with name" );
      }
      await applySchema( storeConfig, version );
      return this;
    },

    from ( storeName ) {
      ensureStoreRegistered( storeName );
      activeStore = storeName;
      conditions = [];
      indexQuery = null;
      sortConfig = null;
      limitCount = null;
      offsetCount = null;
      return this;
    },

    where ( predicate ) {
      if ( typeof predicate === "function" ) {
        conditions.push( predicate );
      } else if ( predicate && typeof predicate === "object" ) {
        conditions.push( item => Object.entries( predicate ).every( ( [ key, value ] ) => item[ key ] === value ) );
      } else {
        throw new Error( "where() expects a function or an object" );
      }
      return this;
    },

    index ( indexName, value ) {
      ensureStoreSelected();
      const indexMap = getStoreMeta( activeStore ).indexes;
      const keyPath = indexMap[ indexName ] || indexName;
      if ( !keyPath ) {
        throw new Error( `Index "${ indexName }" is not defined for "${ activeStore }"` );
      }
      indexQuery = { keyPath, value };
      return this;
    },

    between ( field, lower, upper ) {
      ensureStoreSelected();
      if ( lower > upper ) {
        throw new Error( "Lower bound cannot be greater than upper bound" );
      }
      rangeQuery = { field, lower, upper };
      return this;
    },

    startsWith ( field, prefix ) {
      ensureStoreSelected();
      if ( typeof prefix !== "string" ) {
        throw new Error( "Prefix must be a string" );
      }
      const nextChar = String.fromCharCode( prefix.charCodeAt( prefix.length - 1 ) + 1 );
      const upperBound = prefix.slice( 0, -1 ) + nextChar;
      rangeQuery = { field, lower: prefix, upper: upperBound };
      return this;
    },

    endsWith ( field, suffix ) {
      ensureStoreSelected();
      if ( typeof suffix !== "string" ) {
        throw new Error( "Suffix must be a string" );
      }
      conditions.push( item => {
        const value = item[ field ];
        return typeof value === "string" && value.endsWith( suffix );
      } );
      return this;
    },

    contains ( field, substring ) {
      ensureStoreSelected();
      if ( typeof substring !== "string" ) {
        throw new Error( "Substring must be a string" );
      }
      conditions.push( item => {
        const value = item[ field ];
        return typeof value === "string" && value.includes( substring );
      } );
      return this;
    },

    orderBy ( field, direction = "asc" ) {
      ensureStoreSelected();
      sortConfig = { field, direction: direction.toLowerCase() === "desc" ? "desc" : "asc" };
      return this;
    },

    limit ( count ) {
      ensureStoreSelected();
      limitCount = Number( count );
      return this;
    },

    offset ( count ) {
      ensureStoreSelected();
      offsetCount = Number( count );
      return this;
    },

    async get () {
      return runQuery();
    },

    async first () {
      const results = await runQuery();
      return results[ 0 ] || null;
    },

    async count () {
      return ( await runQuery() ).length;
    },

    async put ( data ) {
      ensureStoreSelected();
      const table = getTable();
      const primaryKey = getPrimaryKey( activeStore );

      if ( Array.isArray( data ) ) {
        const result = await table.bulkPut( data );
        for ( const record of data ) {
          const recordId = record[ primaryKey ];
          if ( recordId !== undefined ) {
            await trackChange( activeStore, recordId, "INSERT" );
          }
        }
        return result;
      }

      const result = await table.put( data );
      const recordId = data[ primaryKey ];
      if ( recordId !== undefined ) {
        await trackChange( activeStore, recordId, "INSERT" );
      }
      return result;
    },

    async update ( changes ) {
      ensureStoreSelected();
      const table = getTable();
      const primaryKey = getPrimaryKey( activeStore );

      if ( conditions.length || indexQuery ) {
        const rows = await runQuery();
        await Promise.all( rows.map( item => {
          const keyValue = item[ primaryKey ];
          if ( keyValue === undefined ) {
            throw new Error( `Cannot update row without primary key "${ primaryKey }"` );
          }
          return Promise.all( [
            table.update( keyValue, changes ),
            trackChange( activeStore, keyValue, "UPDATE" )
          ] );
        } ) );
        return rows.length;
      }

      if ( changes && typeof changes === "object" && changes[ primaryKey ] !== undefined ) {
        const keyValue = changes[ primaryKey ];
        await trackChange( activeStore, keyValue, "UPDATE" );
        return table.update( keyValue, changes );
      }

      throw new Error( "update() requires a primary key or query state" );
    },

    async delete ( keyOrPredicate ) {
      ensureStoreSelected();
      const table = getTable();
      const primaryKey = getPrimaryKey( activeStore );

      if ( keyOrPredicate !== undefined ) {
        if ( typeof keyOrPredicate === "function" ) {
          const rows = ( await table.toArray() ).filter( keyOrPredicate );
          await Promise.all( rows.map( item => Promise.all( [
            table.delete( item[ primaryKey ] ),
            trackChange( activeStore, item[ primaryKey ], "DELETE" )
          ] ) ) );
          return rows.length;
        }

        if ( keyOrPredicate && typeof keyOrPredicate === "object" && !Array.isArray( keyOrPredicate ) ) {
          const rows = ( await table.toArray() ).filter( item => Object.entries( keyOrPredicate ).every( ( [ key, value ] ) => item[ key ] === value ) );
          await Promise.all( rows.map( item => Promise.all( [
            table.delete( item[ primaryKey ] ),
            trackChange( activeStore, item[ primaryKey ], "DELETE" )
          ] ) ) );
          return rows.length;
        }

        await trackChange( activeStore, keyOrPredicate, "DELETE" );
        return table.delete( keyOrPredicate );
      }

      if ( conditions.length || indexQuery ) {
        const rows = await runQuery();
        await Promise.all( rows.map( item => Promise.all( [
          table.delete( item[ primaryKey ] ),
          trackChange( activeStore, item[ primaryKey ], "DELETE" )
        ] ) ) );
        return rows.length;
      }

      throw new Error( "delete() requires a key, predicate, or query state" );
    },

    async truncate () {
      ensureStoreSelected();
      return getTable().clear();
    },

    async syncUp ( endpoint, options = {} ) {
      const storeName = activeStore;
      ensureStoreSelected();
      if ( !endpoint || typeof endpoint !== "string" ) {
        throw new Error( "syncUp() requires a valid endpoint URL" );
      }

      const syncTable = db.table( "__sync__" );
      const onProgress = options.onProgress || ( () => { } );
      const chunkSize = options.chunkSize || 500;

      // Get all pending changes for this store
      const pending = await syncTable.where( "store" ).equals( storeName ).toArray();
      const grouped = {};

      pending.forEach( item => {
        if ( !grouped[ item.operation ] ) {
          grouped[ item.operation ] = [];
        }
        grouped[ item.operation ].push( item );
      } );

      let synced = 0;
      const failures = [];
      const url = endpoint + buildQueryString( options.params );

      // Send each operation type (INSERT, UPDATE, DELETE)
      for ( const [ operation, records ] of Object.entries( grouped ) ) {
        for ( let i = 0; i < records.length; i += chunkSize ) {
          const chunk = records.slice( i, Math.min( i + chunkSize, records.length ) );
          const recordIds = chunk.map( r => r.record_id );

          try {
            await requestJson( url, {
              method: options.method || "POST",
              headers: options.headers,
              body: {
                operation,
                recordIds,
                store: storeName,
                timestamp: Date.now()
              }
            } );

            // Mark as synced
            await Promise.all( chunk.map( r => syncTable.update( r.id, { status: "SYNCED" } ) ) );
            synced += chunk.length;
            onProgress( { synced, total: pending.length, operation } );
          } catch ( err ) {
            failures.push( { operation, chunk, error: err.message } );
            if ( !options.continueOnError ) {
              throw err;
            }
          }
        }
      }

      return {
        success: true,
        store: storeName,
        totalPending: pending.length,
        syncedRecords: synced,
        failedChunks: failures.length,
        failures
      };
    },

    async syncDown ( endpoint, options = {} ) {
      ensureStoreSelected();
      if ( !endpoint || typeof endpoint !== "string" ) {
        throw new Error( "syncDown() requires a valid endpoint URL" );
      }

      const storeName = activeStore;
      const chunkSize = options.chunkSize || 500;
      const onProgress = options.onProgress || ( () => { } );
      const url = endpoint + buildQueryString( options.params );

      let allData = [];
      let pageNum = 0;
      let hasMore = true;
      const conflicts = [];

      while ( hasMore ) {
        const paginatedUrl = url + ( url.includes( "?" ) ? "&" : "?" ) + `page=${ pageNum }&limit=${ chunkSize }`;

        try {
          const json = await requestJson( paginatedUrl, {
            method: options.method || "GET",
            headers: options.headers,
            body: options.body
          } );

          const data = Array.isArray( json ) ? json : ( json && Array.isArray( json.data ) ? json.data : [] );
          if ( !Array.isArray( data ) ) {
            throw new Error( "syncDown() expected an array of records from endpoint" );
          }

          if ( data.length === 0 ) {
            hasMore = false;
          } else {
            // Check for conflicts and apply last-write-wins
            const table = getTable();
            const primaryKey = getPrimaryKey( storeName );

            for ( const record of data ) {
              const recordId = record[ primaryKey ];
              const hasConflict = await detectConflict( storeName, recordId, record.remote_timestamp || Date.now() );

              if ( hasConflict ) {
                conflicts.push( { recordId, operation: "CONFLICT_MERGE" } );
                if ( options.conflictStrategy === "server-wins" ) {
                  await table.put( record );
                } else {
                  // last-write-wins (default): keep local if local is newer
                  const local = await table.get( recordId );
                  if ( !local || ( local.local_timestamp || 0 ) < ( record.remote_timestamp || 0 ) ) {
                    await table.put( record );
                  }
                }
              } else {
                await table.put( record );
              }

              await markSynced( storeName, recordId, record.remote_timestamp || Date.now() );
            }

            allData = allData.concat( data );
            pageNum++;
            onProgress( { loaded: allData.length, pageNum, conflicts: conflicts.length } );
          }
        } catch ( err ) {
          if ( !options.continueOnError ) {
            throw err;
          }
          hasMore = false;
        }
      }

      return {
        success: true,
        store: storeName,
        loadedRecords: allData.length,
        conflicts: conflicts.length,
        conflictRecords: conflicts
      };
    },

    async fullSync ( pushEndpoint, pullEndpoint, options = {} ) {
      try {
        const pushResult = await this.syncUp( pushEndpoint, options );
        const pullResult = await this.syncDown( pullEndpoint, options );

        return {
          success: true,
          push: pushResult,
          pull: pullResult,
          timestamp: Date.now()
        };
      } catch ( err ) {
        throw new Error( `fullSync() failed: ${ err.message }` );
      }
    },

    getSyncMetadata () {
      ensureStoreSelected();
      return db.table( "__sync__" )
        .where( "store" )
        .equals( activeStore )
        .toArray();
    },

    getSyncStatus () {
      ensureStoreSelected();
      return db.table( "__sync__" )
        .where( [ "store", "status" ] )
        .equals( [ activeStore, "PENDING" ] )
        .count();
    },

    clearSyncMetadata () {
      ensureStoreSelected();
      return db.table( "__sync__" )
        .where( "store" )
        .equals( activeStore )
        .delete();
    },

    enableChangeTracking () {
      trackingEnabled = true;
      return this;
    },

    disableChangeTracking () {
      trackingEnabled = false;
      return this;
    },

    async destroy () {
      await clearUserDexie( userId );
      resetQuery();
    }
  };
}

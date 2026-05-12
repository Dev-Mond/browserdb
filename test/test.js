import "fake-indexeddb/auto";
import BrowserDB from "../index.js";
import { clearUserDexie } from "../src/factory.js";

describe( "BrowserDB - ES6 Syntax Tests", () => {
  const USER_ID = "browserdb-test";

  beforeEach( async () => {
    // Ensure clean slate
    try {
      await clearUserDexie( USER_ID );
    } catch ( err ) {
      // Ignore if doesn't exist
    }
  } );

  afterEach( async () => {
    try {
      await clearUserDexie( USER_ID );
    } catch ( err ) {
      // Ignore cleanup errors
    }
  } );

  test( "BrowserDB is imported correctly with ES6 syntax", () => {
    expect( BrowserDB ).toBeDefined();
    expect( typeof BrowserDB ).toBe( "function" );
  } );

  test( "can create a BrowserDB instance", () => {
    const db = BrowserDB( USER_ID );
    expect( db ).toBeDefined();
    expect( typeof db.open ).toBe( "function" );
    expect( typeof db.from ).toBe( "function" );
    expect( typeof db.put ).toBe( "function" );
  } );

  test( "can open database with schema", async () => {
    const db = BrowserDB( USER_ID );

    const result = await db.open( [
      {
        name: "items",
        options: { keyPath: "id" },
        indexes: []
      }
    ] );

    expect( result ).toBe( db );

    await db.destroy();
  } );

  test( "supports ES6 import/export syntax throughout", async () => {
    const db = BrowserDB( USER_ID );
    await db.open( [
      {
        name: "test-store",
        options: { keyPath: "id" },
        indexes: []
      }
    ] );

    // Test basic operations work
    const result = await db.from( "test-store" ).put( { id: 1, data: "hello" } );
    expect( result ).toBeDefined();

    const items = await db.from( "test-store" ).get();
    expect( items ).toHaveLength( 1 );
    expect( items[ 0 ].data ).toBe( "hello" );

    await db.destroy();
  } );
} );

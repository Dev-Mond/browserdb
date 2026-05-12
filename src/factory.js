import Dexie from "dexie";
import { DB_NAME_PREFIX } from "./schema";

const dbCache = new Map();

export function getUserDexie ( userId ) {
  if ( dbCache.has( userId ) ) {
    return dbCache.get( userId );
  }

  const db = new Dexie( `${ DB_NAME_PREFIX }${ userId }` );

  dbCache.set( userId, db );
  return db;
}

export async function clearUserDexie ( userId ) {
  const db = dbCache.get( userId );
  if ( db ) {
    db.close();
    await Dexie.delete( `${ DB_NAME_PREFIX }${ userId }` );
    dbCache.delete( userId );
  }
}

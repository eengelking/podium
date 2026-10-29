// The synchronous stores the storage contract compares the SQLite adapter with (#313): the classes themselves, each over a fresh
// in-memory database.
import type { ContractReference } from '../contract.js';
import { FleetDb, openDb } from './db.js';
import { PeopleStore } from './people.js';
import { ReporterStore } from './reporters.js';

export function sqliteReference(): ContractReference {
  return {
    people: new PeopleStore(openDb(':memory:')),
    fleet: new FleetDb(openDb(':memory:')),
    reporters: new ReporterStore(openDb(':memory:'), 0),
  };
}

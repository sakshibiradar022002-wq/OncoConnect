// Run once to create the database file & tables: `npm run init-db`
import { initSchema, db } from './index.js';

await initSchema();
console.log('[db] initialized at', db.name);
process.exit(0);

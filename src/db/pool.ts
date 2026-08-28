import pg from 'pg';
import type { Config } from '../config.js';

export function createPool(config: Config): pg.Pool {
  return new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
}

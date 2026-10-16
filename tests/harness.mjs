// A stand-in for the Supabase project: PGlite (real Postgres, in-process)
// with Supabase's roles and extensions schema, plus a small imitation of
// PostgREST's RPC endpoint (anon role, request.headers, PTxyz status codes,
// response.status, 404 for a missing function).
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const SUPABASE = new URL('../supabase/', import.meta.url);

export async function createProject({ seed = true, startingStock = true } = {}) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema extensions;
    create extension pgcrypto schema extensions;
    grant usage on schema extensions to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    -- what Supabase's default privileges do for objects the postgres role makes in public
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  const migrations = readdirSync(new URL('migrations/', SUPABASE)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of [
    ...migrations.map((f) => `migrations/${f}`),
    ...(seed ? ['seed.sql'] : []),
    ...(startingStock ? ['starting-stock.sql'] : []),
  ]) {
    await db.exec(readFileSync(new URL(file, SUPABASE), 'utf8'));
  }
  return db;
}

const STATUS_FOR = { '23505': 409, '23503': 409, '42501': 401, '42883': 404, 'P0001': 400, '22P02': 400 };

// POST /rest/v1/rpc/<fn> with a JSON body, as the anon role.
export async function rpc(db, fn, body = {}, headers = { 'x-forwarded-for': '203.0.113.7' }) {
  const exists = await db.query(
    `select coalesce(p.proargnames, '{}') as names from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = $1`, [fn]);
  if (!exists.rows.length) {
    return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
  }
  const { names } = exists.rows[0];
  const keys = Object.keys(body);
  if (keys.some((k) => !names.includes(k))) {
    return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn}(${keys.sort().join(', ')}) in the schema cache` } };
  }
  const call = `select public.${fn}(${keys.map((k) => `${k} := ($1::jsonb -> '${k}')`).join(', ')}) as result`;

  try {
    return await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify(headers)]);
      await tx.query('set local role anon');
      const { rows } = await tx.query(call, keys.length ? [JSON.stringify(body)] : []);
      const status = (await tx.query(`select current_setting('response.status', true) as s`)).rows[0].s;
      return { status: status ? Number(status) : 200, body: rows[0].result };
    });
  } catch (err) {
    const code = err.code ?? 'XX000';
    const status = /^PT\d{3}$/.test(code) ? Number(code.slice(2)) : STATUS_FOR[code] ?? 500;
    return { status, body: { code, message: err.message, details: err.detail ?? null, hint: err.hint ?? null } };
  }
}

// What the frontend's fetch sees: a Response for a POST to the RPC URL.
export function fakeFetch(db, baseUrl, { onRequest } = {}) {
  return async (url, init = {}) => {
    const match = String(url).replace(baseUrl, '').match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (!match || init.method !== 'POST') return new Response('not found', { status: 404 });
    if (!init.headers?.apikey) return new Response(JSON.stringify({ message: 'No API key found in request' }), { status: 401 });
    const body = init.body ? JSON.parse(init.body) : {};
    onRequest?.(match[1], body, init.headers);
    const result = await rpc(db, match[1], body);
    return new Response(result.body === null ? '' : JSON.stringify(result.body), {
      status: result.status, headers: { 'Content-Type': 'application/json' },
    });
  };
}

// A tiny test runner: counts checks, lists what failed, and sets the exit code.
export function checker() {
  let passed = 0;
  const failures = [];
  const check = (label, condition, detail) => {
    if (condition) passed++;
    else failures.push(`${label}${detail === undefined ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  };
  const finish = (name) => {
    console.log(`${name}: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log('  FAIL', f);
    if (failures.length) process.exitCode = 1;
  };
  return { check, finish };
}

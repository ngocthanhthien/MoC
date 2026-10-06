/*
 * MoC Management App — Cloudflare Worker API.
 *
 * Three responsibilities, all backed by the same KV namespace (MOC_KV):
 *
 *  1. Auth — POST /auth/login, GET /auth/me, POST /auth/logout, GET /auth/names
 *     Sessions are opaque tokens stored at  session:<token>  with a TTL (auto-expire).
 *     Admin has exactly one account, defined by the ADMIN_USER / ADMIN_PASS secrets
 *     (never shipped to the frontend). Leader/User accounts live in the User Directory.
 *
 *  2. User Directory — GET/POST /users, PUT /users/:id  (admin only)
 *     Stored at KV key `moc_users`. Employee Code is never stored in plaintext —
 *     only its SHA-256 hash. Create/reset return the plaintext code ONCE so the
 *     admin can relay it to the person.
 *
 *  3. App data — GET/PUT /data  (any authenticated, enabled user)
 *     Stored at KV key `moc_data` (mocList/actionPlan/agenda/attendant/people — no more
 *     `users` field, that moved to the User Directory above). PUT now diffs the
 *     incoming payload against what's stored and enforces permissions server-side
 *     before accepting anything, then merges by `updatedAt` same as before so
 *     concurrent edits from different browsers don't clobber each other:
 *       - creating a new record            -> any enabled user
 *       - editing an existing MoC record   -> admin, or the record's Change Owner /
 *                                             Relevant people (matched against what's
 *                                             already stored, not the client's payload)
 *       - editing action/agenda/attendant  -> any enabled user (matches prior app behavior)
 *       - deleting anything                -> admin only
 *       - `people` (Change Owner/PIC lists) -> admin only to add/edit/delete
 *
 * Bindings expected (see wrangler.toml):
 *   KV namespace  MOC_KV
 *   secrets       ADMIN_USER, ADMIN_PASS
 *   var           ALLOWED_ORIGIN   (the GitHub Pages origin, e.g. https://user.github.io)
 */

const DATA_KEY = 'moc_data';
const USERS_KEY = 'moc_users';
const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h shift-length session

function emptyData(){
  return { schemaVersion: 1, mocList: [], actionPlan: [], agenda: [], attendant: [], people: [] };
}

function corsHeaders(env){
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400'
  };
}
function json(body, status, env){
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(env))
  });
}

/* -------------------------------------------------------------------------- */
/* name matching — mirrors normalizeNameForMatch()/isPersonInMoc() in index.html */
/* -------------------------------------------------------------------------- */
function normalizeName(str){
  return (str || '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function isPersonInRecord(nameKey, rec){
  if(!nameKey || !rec) return false;
  const owner = normalizeName(rec.changeOwner);
  if(owner && (owner.includes(nameKey) || nameKey.includes(owner))) return true;
  const relevant = (rec.relevantPeople || '').split(/[,/\n]/).map(normalizeName).filter(Boolean);
  return relevant.some(p => p.includes(nameKey) || nameKey.includes(p));
}

/* -------------------------------------------------------------------------- */
/* crypto helpers */
/* -------------------------------------------------------------------------- */
async function sha256Hex(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken(){
  return Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomEmployeeCode(){
  // 6-digit numeric — easy to read aloud / type on a shared floor PC
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}
function safeEqual(a, b){
  a = String(a || ''); b = String(b || '');
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* users directory */
/* -------------------------------------------------------------------------- */
async function loadUsers(env){
  return (await env.MOC_KV.get(USERS_KEY, 'json')) || {};
}
async function saveUsers(env, users){
  await env.MOC_KV.put(USERS_KEY, JSON.stringify(users));
}
function publicUser(u){
  return { id: u.id, name: u.name, function: u.function || '', role: u.role, enabled: !!u.enabled, createdAt: u.createdAt, updatedAt: u.updatedAt };
}

/* -------------------------------------------------------------------------- */
/* sessions */
/* -------------------------------------------------------------------------- */
async function createSession(env, user){
  const token = randomToken();
  await env.MOC_KV.put(SESSION_PREFIX + token, JSON.stringify(user), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}
function bearerToken(request){
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}
// Resolves the current session, re-checking the live User Directory each time so a
// leader disabled mid-session is cut off immediately rather than at next login.
async function resolveSession(request, env){
  const token = bearerToken(request);
  if(!token) return null;
  const session = await env.MOC_KV.get(SESSION_PREFIX + token, 'json');
  if(!session) return null;
  if(session.role === 'leader'){
    const users = await loadUsers(env);
    const rec = users[session.userId];
    if(!rec || !rec.enabled) { await env.MOC_KV.delete(SESSION_PREFIX + token); return null; }
    // keep name/function in sync with the directory in case admin edited them
    session.name = rec.name; session.function = rec.function || '';
  }
  return { token, ...session };
}
async function requireAuth(request, env){
  const session = await resolveSession(request, env);
  if(!session) return { error: json({ error: 'unauthorized' }, 401, env) };
  return { session };
}
async function requireAdmin(request, env){
  const { session, error } = await requireAuth(request, env);
  if(error) return { error };
  if(session.role !== 'admin') return { error: json({ error: 'forbidden' }, 403, env) };
  return { session };
}

/* -------------------------------------------------------------------------- */
/* app data merge (unchanged algorithm — union by id, freshest updatedAt wins) */
/* -------------------------------------------------------------------------- */
function mergeCollections(a, b){
  const map = new Map();
  (b || []).forEach(item => { if (item && item.id) map.set(item.id, item); });
  (a || []).forEach(item => {
    if (!item || !item.id) return;
    const existing = map.get(item.id);
    if (!existing || String(item.updatedAt || '') >= String(existing.updatedAt || '')) map.set(item.id, item);
  });
  return Array.from(map.values());
}
function mergeData(incoming, stored){
  if (!stored) return incoming;
  return {
    schemaVersion: incoming.schemaVersion || stored.schemaVersion || 1,
    mocList: mergeCollections(incoming.mocList, stored.mocList),
    actionPlan: mergeCollections(incoming.actionPlan, stored.actionPlan),
    agenda: mergeCollections(incoming.agenda, stored.agenda),
    attendant: mergeCollections(incoming.attendant, stored.attendant),
    people: mergeCollections(incoming.people, stored.people)
  };
}

// Server-side permission gate for a PUT /data payload. Throws {status, body} on
// the first disallowed change it finds — never trusts the frontend's own checks.
//
// Deletes are soft: the client never just omits a record's id (a union-merge would
// silently resurrect it on the next sync from any client that still has the old
// copy). Instead a delete replaces the record with a tombstone {id, deleted:true,
// updatedAt} — that's what this function treats as "deleting" below. Omitting an id
// entirely is still only tolerated from an admin, as a safety net against a stale
// client silently wiping records it never even fetched.
function assertWriteAllowed(collectionName, incomingArr, storedArr, session){
  const storedMap = new Map((storedArr || []).filter(r => r && r.id).map(r => [r.id, r]));
  const incomingMap = new Map((incomingArr || []).filter(r => r && r.id).map(r => [r.id, r]));
  const isAdmin = session.role === 'admin';
  const nameKey = normalizeName(session.name);

  // ids silently dropped from the payload (stale client, not an explicit tombstone)
  for(const id of storedMap.keys()){
    if(!incomingMap.has(id) && !isAdmin){
      throw { status: 403, body: { error: 'forbidden', reason: 'delete_requires_admin', collection: collectionName, id } };
    }
  }
  // edits (only records that actually changed content)
  for(const [id, incomingRec] of incomingMap){
    const storedRec = storedMap.get(id);
    // `people` = the Change Owner / PIC pick-lists edited in Settings — admin only, even to add
    if(collectionName === 'people' && !isAdmin){
      if(!storedRec || JSON.stringify(incomingRec) !== JSON.stringify(storedRec)){
        throw { status: 403, body: { error: 'forbidden', reason: 'people_admin_only', collection: collectionName, id } };
      }
      continue;
    }
    if(!storedRec) continue; // brand-new record — anyone enabled may create
    if(JSON.stringify(incomingRec) === JSON.stringify(storedRec)) continue; // unchanged passthrough

    const isDeleteTransition = !storedRec.deleted && !!incomingRec.deleted;
    if(isDeleteTransition){
      if(!isAdmin) throw { status: 403, body: { error: 'forbidden', reason: 'delete_requires_admin', collection: collectionName, id } };
      continue;
    }
    if(isAdmin) continue;
    if(collectionName === 'mocList'){
      if(!isPersonInRecord(nameKey, storedRec)){
        throw { status: 403, body: { error: 'forbidden', reason: 'not_owner', collection: collectionName, id } };
      }
    }
    // actionPlan / agenda / attendant: any enabled logged-in user may edit — matches
    // the app's existing canEdit() behavior (only delete + MoC-ownership are gated).
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP handlers */
/* -------------------------------------------------------------------------- */
async function handleLogin(request, env){
  let body;
  try{ body = await request.json(); }catch(e){ return json({ error: 'invalid_json' }, 400, env); }

  if(body.role === 'admin'){
    const okUser = safeEqual((body.username || '').trim().toLowerCase(), (env.ADMIN_USER || '').trim().toLowerCase());
    const okPass = safeEqual(body.password || '', env.ADMIN_PASS || '');
    if(!okUser || !okPass || !env.ADMIN_USER || !env.ADMIN_PASS){
      return json({ error: 'invalid_credentials' }, 401, env);
    }
    const user = { userId: 'admin', name: 'Admin', role: 'admin', function: 'Administrator' };
    const token = await createSession(env, user);
    return json({ token, user: { name: user.name, role: user.role, function: user.function } }, 200, env);
  }

  if(body.role === 'leader'){
    const nameKey = normalizeName(body.name);
    const code = String(body.employeeCode || '').trim();
    if(!nameKey || !code) return json({ error: 'invalid_credentials' }, 401, env);
    const users = await loadUsers(env);
    const rec = Object.values(users).find(u => normalizeName(u.name) === nameKey);
    if(!rec || !rec.enabled) return json({ error: 'invalid_credentials' }, 401, env);
    const codeHash = await sha256Hex(code);
    if(!safeEqual(codeHash, rec.employeeCodeHash)) return json({ error: 'invalid_credentials' }, 401, env);
    const user = { userId: rec.id, name: rec.name, role: 'leader', function: rec.function || '' };
    const token = await createSession(env, user);
    return json({ token, user: { name: user.name, role: user.role, function: user.function } }, 200, env);
  }

  return json({ error: 'invalid_role' }, 400, env);
}

async function handleMe(request, env){
  const { session, error } = await requireAuth(request, env);
  if(error) return error;
  return json({ user: { name: session.name, role: session.role, function: session.function } }, 200, env);
}

async function handleLogout(request, env){
  const token = bearerToken(request);
  if(token) await env.MOC_KV.delete(SESSION_PREFIX + token);
  return json({ ok: true }, 200, env);
}

// Public-ish: only the display names + function of *enabled* leader accounts, so the
// login screen can offer a "chọn tên" picker without exposing anything sensitive
// (no employee codes, no disabled accounts). Strictly less exposed than the old app,
// which showed the full Attendant list to anyone before logging in at all.
async function handleAuthNames(request, env){
  const users = await loadUsers(env);
  const list = Object.values(users)
    .filter(u => u.enabled)
    .map(u => ({ id: u.id, name: u.name, function: u.function || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return json({ users: list }, 200, env);
}

async function handleUsersList(request, env){
  const { error } = await requireAdmin(request, env);
  if(error) return error;
  const users = await loadUsers(env);
  return json({ users: Object.values(users).map(publicUser) }, 200, env);
}

async function handleUsersCreate(request, env){
  const { error } = await requireAdmin(request, env);
  if(error) return error;
  let body;
  try{ body = await request.json(); }catch(e){ return json({ error: 'invalid_json' }, 400, env); }
  const name = (body.name || '').trim();
  if(!name) return json({ error: 'name_required' }, 400, env);
  const users = await loadUsers(env);
  if(Object.values(users).some(u => normalizeName(u.name) === normalizeName(name))){
    return json({ error: 'name_taken' }, 409, env);
  }
  const id = crypto.randomUUID();
  const code = randomEmployeeCode();
  const now = new Date().toISOString();
  users[id] = {
    id, name, function: (body.function || '').trim(), role: 'leader',
    enabled: true, employeeCodeHash: await sha256Hex(code), createdAt: now, updatedAt: now
  };
  await saveUsers(env, users);
  return json({ user: publicUser(users[id]), employeeCode: code }, 201, env);
}

async function handleUserUpdate(request, env, id){
  const { error } = await requireAdmin(request, env);
  if(error) return error;
  let body;
  try{ body = await request.json(); }catch(e){ return json({ error: 'invalid_json' }, 400, env); }
  const users = await loadUsers(env);
  const rec = users[id];
  if(!rec) return json({ error: 'not_found' }, 404, env);
  if(typeof body.name === 'string' && body.name.trim()) rec.name = body.name.trim();
  if(typeof body.function === 'string') rec.function = body.function.trim();
  if(typeof body.enabled === 'boolean') rec.enabled = body.enabled;
  rec.updatedAt = new Date().toISOString();
  let employeeCode;
  if(body.resetCode){
    employeeCode = randomEmployeeCode();
    rec.employeeCodeHash = await sha256Hex(employeeCode);
  }
  await saveUsers(env, users);
  const resp = { user: publicUser(rec) };
  if(employeeCode) resp.employeeCode = employeeCode;
  return json(resp, 200, env);
}

async function handleDataGet(request, env){
  const { error } = await requireAuth(request, env);
  if(error) return error;
  const stored = await env.MOC_KV.get(DATA_KEY, 'json');
  return json(stored || emptyData(), 200, env);
}

async function handleDataPut(request, env){
  const { session, error } = await requireAuth(request, env);
  if(error) return error;
  let incoming;
  try{ incoming = await request.json(); }catch(e){ return json({ error: 'invalid_json' }, 400, env); }
  const stored = (await env.MOC_KV.get(DATA_KEY, 'json')) || emptyData();

  // Only an admin can change the Change Owner/PIC lists. For everyone else the payload's
  // copy is ignored (not rejected) — a leader whose tab is a few seconds stale must still
  // be able to save their own MoC edit without tripping over lists they can't touch.
  if(session.role !== 'admin') incoming.people = stored.people || [];

  try{
    ['mocList', 'actionPlan', 'agenda', 'attendant', 'people'].forEach(col => {
      // an older frontend that predates `people` simply omits it — not a delete
      if(col === 'people' && incoming[col] === undefined) return;
      assertWriteAllowed(col, incoming[col], stored[col], session);
    });
  }catch(e){
    if(e && e.status) return json(e.body, e.status, env);
    throw e;
  }

  const merged = mergeData(incoming, stored);
  await env.MOC_KV.put(DATA_KEY, JSON.stringify(merged));
  return json(merged, 200, env);
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if(request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if(path === '/auth/login' && request.method === 'POST') return handleLogin(request, env);
    if(path === '/auth/me' && request.method === 'GET') return handleMe(request, env);
    if(path === '/auth/logout' && request.method === 'POST') return handleLogout(request, env);
    if(path === '/auth/names' && request.method === 'GET') return handleAuthNames(request, env);

    if(path === '/users' && request.method === 'GET') return handleUsersList(request, env);
    if(path === '/users' && request.method === 'POST') return handleUsersCreate(request, env);
    const userMatch = /^\/users\/([^/]+)$/.exec(path);
    if(userMatch && request.method === 'PUT') return handleUserUpdate(request, env, userMatch[1]);

    if(path === '/data' && request.method === 'GET') return handleDataGet(request, env);
    if(path === '/data' && request.method === 'PUT') return handleDataPut(request, env);

    return json({ error: 'not_found' }, 404, env);
  }
};

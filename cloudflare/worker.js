/*
 * MoC Management App — Cloudflare Worker API.
 *
 * Three responsibilities, all backed by the same KV namespace (MOC_KV):
 *
 *  1. Auth — POST /auth/login, GET /auth/me, POST /auth/logout
 *     One login form for everyone: Tên đăng nhập (username or email) + Mật khẩu.
 *     Sessions are opaque tokens stored at  session:<token>  with a TTL (auto-expire).
 *     Accounts (role admin|user) live in the User Directory. The ADMIN_USER /
 *     ADMIN_PASS secrets define one extra "bootstrap" Admin that always works — it
 *     creates the first real accounts and is the recovery path if every directory
 *     Admin is lost. It is never shipped to the frontend and never stored in KV.
 *
 *  2. User Directory — GET/POST /users, PUT/DELETE /users/:id  (admin only)
 *     Stored at KV key `moc_users`. Passwords are chosen by the Admin and stored only
 *     as a salted PBKDF2-SHA256 hash — they cannot be read back, only replaced.
 *     Accounts created before this scheme (name + 6-digit Mã NV) are migrated on
 *     first read: they get a username derived from their name and keep the old Mã NV
 *     as password until it is changed (see migrateLegacyUsers / checkPassword).
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
 *       - `people` (Change Owner/PIC lists) -> read-only: derived on every response
 *                                             from the User Directory (accounts ticked
 *                                             Change Owner / PIC), never written via /data
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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
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
function b64(bytes){
  let s = '';
  new Uint8Array(bytes).forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}
function b64ToBytes(str){
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// 100,000 is the most Workers' Web Crypto accepts for PBKDF2. Stored per account so
// it can be raised later without invalidating existing hashes.
const PBKDF2_ITERATIONS = 100000;
async function pbkdf2(password, saltBytes, iterations){
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return b64(bits);
}
async function setPassword(rec, password){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  rec.passwordHash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  rec.passwordSalt = b64(salt);
  rec.passwordIterations = PBKDF2_ITERATIONS;
  delete rec.employeeCodeHash;
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
const BOOTSTRAP_ADMIN_ID = 'admin';
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

async function loadUsers(env){
  const users = (await env.MOC_KV.get(USERS_KEY, 'json')) || {};
  if(migrateLegacyUsers(users)) await saveUsers(env, users);
  return users;
}
// Accounts from the old "pick your name + Mã NV" login have no loginId. Give each one
// a username built from its name (no diacritics/spaces, numbered if it collides) so
// it can sign in through the single login form; its old Mã NV keeps working as the
// password until someone replaces it (see checkPassword).
function migrateLegacyUsers(users){
  const legacy = Object.values(users).filter(u => !u.loginId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  if(!legacy.length) return false;
  const taken = new Set(Object.values(users).filter(u => u.loginId).map(u => u.loginId.toLowerCase()));
  legacy.forEach(u => {
    const base = normalizeName(u.name).replace(/ /g, '').slice(0, 28) || 'user';
    let login = base, n = 2;
    while(taken.has(login)) login = base + (n++);
    taken.add(login);
    u.loginId = login;
    u.role = u.role === 'admin' ? 'admin' : 'user';
  });
  return true;
}
function bootstrapAdminLogin(env){
  return env.ADMIN_USER && env.ADMIN_PASS ? env.ADMIN_USER.trim().toLowerCase() : '';
}
function findUserByLogin(users, loginId){
  const lower = String(loginId || '').toLowerCase();
  return Object.values(users).find(u => (u.loginId || '').toLowerCase() === lower) || null;
}
function hasOtherActiveAdmin(env, users, exceptId){
  if(bootstrapAdminLogin(env)) return true;
  return Object.values(users).some(u => u.id !== exceptId && u.role === 'admin' && u.enabled);
}
async function checkPassword(env, users, rec, password){
  if(rec.passwordHash){
    const computed = await pbkdf2(password, b64ToBytes(rec.passwordSalt), rec.passwordIterations);
    return safeEqual(computed, rec.passwordHash);
  }
  if(!rec.employeeCodeHash) return false;
  if(!safeEqual(await sha256Hex(password), rec.employeeCodeHash)) return false;
  // legacy Mã NV accepted — re-store it under the current hashing scheme
  await setPassword(rec, password);
  await saveUsers(env, users);
  return true;
}
async function saveUsers(env, users){
  await env.MOC_KV.put(USERS_KEY, JSON.stringify(users));
}
function publicUser(u){
  return {
    id: u.id, name: u.name, loginId: u.loginId || '', function: u.function || '', role: u.role, enabled: !!u.enabled,
    isOwner: !!u.isOwner, isPic: !!u.isPic,
    // still signing in with the pre-migration Mã NV as password
    legacyCode: !u.passwordHash && !!u.employeeCodeHash,
    createdAt: u.createdAt, updatedAt: u.updatedAt
  };
}

/* -------------------------------------------------------------------------- */
/* sessions */
/* -------------------------------------------------------------------------- */
async function createSession(env, user){
  const token = randomToken();
  await env.MOC_KV.put(SESSION_PREFIX + token, JSON.stringify(user), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}
function sessionUser(s){
  return { id: s.userId, name: s.name, role: s.role, function: s.function || '', loginId: s.loginId || '' };
}
function bearerToken(request){
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}
// Resolves the current session, re-checking the live User Directory each time so a
// user disabled mid-session is cut off immediately rather than at next login, and a
// role change takes effect on the very next request.
async function resolveSession(request, env){
  const token = bearerToken(request);
  if(!token) return null;
  const session = await env.MOC_KV.get(SESSION_PREFIX + token, 'json');
  if(!session) return null;
  if(session.userId !== BOOTSTRAP_ADMIN_ID){
    const users = await loadUsers(env);
    const rec = users[session.userId];
    if(!rec || !rec.enabled) { await env.MOC_KV.delete(SESSION_PREFIX + token); return null; }
    // keep name/function/role in sync with the directory in case admin edited them
    session.name = rec.name; session.function = rec.function || '';
    session.role = rec.role === 'admin' ? 'admin' : 'user';
    session.loginId = rec.loginId;
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
    // pre-User-Directory pick-lists, kept frozen for reference only — the lists the
    // client sees are derived from user accounts (see clientData)
    people: stored.people || [],
    peopleMigrated: stored.peopleMigrated
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
  // A stored tombstone is never sent back: the client strips deleted:true records in
  // normalizeData(), so its absence from the payload is expected, not a delete.
  for(const [id, storedRec] of storedMap){
    if(storedRec.deleted) continue;
    if(!incomingMap.has(id) && !isAdmin){
      throw { status: 403, body: { error: 'forbidden', reason: 'delete_requires_admin', collection: collectionName, id } };
    }
  }
  // edits (only records that actually changed content)
  for(const [id, incomingRec] of incomingMap){
    const storedRec = storedMap.get(id);
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
  const loginId = String(body.loginId || '').trim();
  const password = String(body.password || '');
  // same error for "no such account" and "wrong password" — don't reveal which
  if(!loginId || !password) return json({ error: 'invalid_credentials' }, 401, env);

  let user;
  if(bootstrapAdminLogin(env) && safeEqual(loginId.toLowerCase(), bootstrapAdminLogin(env))){
    if(!safeEqual(password, env.ADMIN_PASS)) return json({ error: 'invalid_credentials' }, 401, env);
    user = { userId: BOOTSTRAP_ADMIN_ID, name: 'Admin', role: 'admin', function: 'Administrator', loginId: env.ADMIN_USER.trim() };
  } else {
    const users = await loadUsers(env);
    const rec = findUserByLogin(users, loginId);
    if(!rec || !(await checkPassword(env, users, rec, password))) return json({ error: 'invalid_credentials' }, 401, env);
    if(!rec.enabled) return json({ error: 'account_disabled' }, 403, env);
    user = { userId: rec.id, name: rec.name, role: rec.role === 'admin' ? 'admin' : 'user', function: rec.function || '', loginId: rec.loginId };
  }
  const token = await createSession(env, user);
  return json({ token, user: sessionUser(user) }, 200, env);
}

async function handleMe(request, env){
  const { session, error } = await requireAuth(request, env);
  if(error) return error;
  return json({ user: sessionUser(session) }, 200, env);
}

async function handleLogout(request, env){
  const token = bearerToken(request);
  if(token) await env.MOC_KV.delete(SESSION_PREFIX + token);
  return json({ ok: true }, 200, env);
}

/* -------------------------------------------------------------------------- */
/* Change Owner / PIC pick-lists — derived from the User Directory */
/* -------------------------------------------------------------------------- */
const PEOPLE_FLAG = { owner: 'isOwner', pic: 'isPic' };
// What the MoC/Action forms offer: every enabled account ticked Change Owner / PIC,
// under its display name — the same name edit rights are matched against.
function derivedPeople(users){
  const out = [];
  Object.values(users).filter(u => u.enabled).forEach(u => {
    Object.keys(PEOPLE_FLAG).forEach(kind => {
      if(u[PEOPLE_FLAG[kind]]) out.push({ id: u.id + ':' + kind, kind, name: u.name, updatedAt: u.updatedAt });
    });
  });
  return out;
}
// Entries of the old free-typed lists (Settings tab, stored in moc_data.people).
function legacyPeople(stored){
  return (stored.people || []).filter(p => p && !p.deleted && p.name && PEOPLE_FLAG[p.kind]);
}
// Old-list names no account carries yet — shown to the Admin so nobody is silently dropped.
function unmatchedLegacyPeople(stored, users){
  const list = Object.values(users);
  return legacyPeople(stored)
    .filter(p => !list.some(u => u[PEOPLE_FLAG[p.kind]] && normalizeName(u.name) === normalizeName(p.name)))
    .map(p => ({ kind: p.kind, name: p.name }));
}
// Loads moc_data; the first time after the lists moved to the User Directory, ticks
// Change Owner / PIC on every account whose name was on the matching old list.
async function loadData(env, users){
  const stored = (await env.MOC_KV.get(DATA_KEY, 'json')) || emptyData();
  if(!stored.peopleMigrated && legacyPeople(stored).length){
    let touched = false;
    legacyPeople(stored).forEach(p => {
      const u = Object.values(users).find(x => normalizeName(x.name) === normalizeName(p.name));
      if(u && !u[PEOPLE_FLAG[p.kind]]){ u[PEOPLE_FLAG[p.kind]] = true; touched = true; }
    });
    if(touched) await saveUsers(env, users);
    stored.peopleMigrated = true;
    await env.MOC_KV.put(DATA_KEY, JSON.stringify(stored));
  }
  return stored;
}
function clientData(stored, users){
  const { peopleMigrated, ...rest } = stored;
  return { ...rest, people: derivedPeople(users) };
}

async function handleUsersList(request, env){
  const { error } = await requireAdmin(request, env);
  if(error) return error;
  const users = await loadUsers(env);
  const stored = await loadData(env, users);
  return json({ users: Object.values(users).map(publicUser), unmatchedPeople: unmatchedLegacyPeople(stored, users) }, 200, env);
}

// Admin has dealt with (or doesn't need) the leftover old-list names.
async function handleClearLegacyPeople(request, env){
  const { error } = await requireAdmin(request, env);
  if(error) return error;
  const stored = (await env.MOC_KV.get(DATA_KEY, 'json')) || emptyData();
  stored.people = [];
  stored.peopleMigrated = true;
  await env.MOC_KV.put(DATA_KEY, JSON.stringify(stored));
  return json({ ok: true }, 200, env);
}

function loginIdError(env, users, loginId, exceptId){
  const lower = loginId.toLowerCase();
  if(!(loginId.includes('@') ? EMAIL_RE.test(loginId) : USERNAME_RE.test(lower))) return 'login_invalid';
  const clash = findUserByLogin(users, loginId);
  if((clash && clash.id !== exceptId) || lower === bootstrapAdminLogin(env)) return 'login_taken';
  return null;
}
function nameTaken(users, name, exceptId){
  return Object.values(users).some(u => u.id !== exceptId && normalizeName(u.name) === normalizeName(name));
}

async function handleUsersCreate(request, env){
  const { error } = await requireAdmin(request, env);
  if(error) return error;
  let body;
  try{ body = await request.json(); }catch(e){ return json({ error: 'invalid_json' }, 400, env); }
  const name = String(body.name || '').trim();
  const loginId = String(body.loginId || '').trim().toLowerCase();
  const password = String(body.password || '');
  if(!name) return json({ error: 'name_required' }, 400, env);
  const users = await loadUsers(env);
  // MoC edit rights are matched by display name, so two accounts can't share one
  if(nameTaken(users, name)) return json({ error: 'name_taken' }, 409, env);
  const loginErr = loginIdError(env, users, loginId);
  if(loginErr) return json({ error: loginErr }, loginErr === 'login_taken' ? 409 : 400, env);
  if(password.length < MIN_PASSWORD_LENGTH) return json({ error: 'password_too_short' }, 400, env);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  users[id] = {
    id, name, loginId, function: String(body.function || '').trim(), role: body.role === 'admin' ? 'admin' : 'user',
    isOwner: !!body.isOwner, isPic: !!body.isPic,
    enabled: true, createdAt: now, updatedAt: now
  };
  await setPassword(users[id], password);
  await saveUsers(env, users);
  return json({ user: publicUser(users[id]) }, 201, env);
}

async function handleUserUpdate(request, env, id){
  const { session, error } = await requireAdmin(request, env);
  if(error) return error;
  let body;
  try{ body = await request.json(); }catch(e){ return json({ error: 'invalid_json' }, 400, env); }
  const users = await loadUsers(env);
  const rec = users[id];
  if(!rec) return json({ error: 'not_found' }, 404, env);
  const isSelf = session.userId === id;

  if(typeof body.name === 'string' && body.name.trim()){
    if(nameTaken(users, body.name.trim(), id)) return json({ error: 'name_taken' }, 409, env);
    rec.name = body.name.trim();
  }
  if(typeof body.function === 'string') rec.function = body.function.trim();
  if(typeof body.isOwner === 'boolean') rec.isOwner = body.isOwner;
  if(typeof body.isPic === 'boolean') rec.isPic = body.isPic;
  if(typeof body.enabled === 'boolean'){
    if(isSelf && !body.enabled) return json({ error: 'cannot_disable_self' }, 400, env);
    rec.enabled = body.enabled;
  }
  if(body.role === 'admin' || body.role === 'user'){
    if(isSelf && body.role !== 'admin' && !hasOtherActiveAdmin(env, users, id)) return json({ error: 'last_admin' }, 400, env);
    rec.role = body.role;
  }
  if(typeof body.password === 'string' && body.password){
    if(body.password.length < MIN_PASSWORD_LENGTH) return json({ error: 'password_too_short' }, 400, env);
    await setPassword(rec, body.password);
  }
  rec.updatedAt = new Date().toISOString();
  await saveUsers(env, users);
  return json({ user: publicUser(rec) }, 200, env);
}

// Permanent: the account is removed from the directory, so its sessions die on their
// next request (resolveSession) and its name leaves the Change Owner / PIC lists.
// MoC/Action records that mention the name are left as they are.
async function handleUserDelete(request, env, id){
  const { session, error } = await requireAdmin(request, env);
  if(error) return error;
  if(session.userId === id) return json({ error: 'cannot_delete_self' }, 400, env);
  const users = await loadUsers(env);
  if(!users[id]) return json({ error: 'not_found' }, 404, env);
  delete users[id];
  await saveUsers(env, users);
  return json({ ok: true }, 200, env);
}

async function handleDataGet(request, env){
  const { error } = await requireAuth(request, env);
  if(error) return error;
  const users = await loadUsers(env);
  return json(clientData(await loadData(env, users), users), 200, env);
}

async function handleDataPut(request, env){
  const { session, error } = await requireAuth(request, env);
  if(error) return error;
  let incoming;
  try{ incoming = await request.json(); }catch(e){ return json({ error: 'invalid_json' }, 400, env); }
  const users = await loadUsers(env);
  const stored = await loadData(env, users);

  // `people` in the payload is ignored (not rejected): the lists are derived from the
  // User Directory, and a tab still running an older frontend may keep sending them.
  try{
    ['mocList', 'actionPlan', 'agenda', 'attendant'].forEach(col => {
      assertWriteAllowed(col, incoming[col], stored[col], session);
    });
  }catch(e){
    if(e && e.status) return json(e.body, e.status, env);
    throw e;
  }

  const merged = mergeData(incoming, stored);
  await env.MOC_KV.put(DATA_KEY, JSON.stringify(merged));
  return json(clientData(merged, users), 200, env);
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

    if(path === '/users' && request.method === 'GET') return handleUsersList(request, env);
    if(path === '/users' && request.method === 'POST') return handleUsersCreate(request, env);
    if(path === '/users/clear-legacy-people' && request.method === 'POST') return handleClearLegacyPeople(request, env);
    const userMatch = /^\/users\/([^/]+)$/.exec(path);
    if(userMatch && request.method === 'PUT') return handleUserUpdate(request, env, userMatch[1]);
    if(userMatch && request.method === 'DELETE') return handleUserDelete(request, env, userMatch[1]);

    if(path === '/data' && request.method === 'GET') return handleDataGet(request, env);
    if(path === '/data' && request.method === 'PUT') return handleDataPut(request, env);

    return json({ error: 'not_found' }, 404, env);
  }
};

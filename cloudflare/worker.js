/*
 * MoC Management App — Cloudflare Worker data API.
 *
 * Stores the app's single JSON data blob (mocList/actionPlan/agenda/attendant/users)
 * in a KV namespace, mirroring the merge-by-updatedAt logic the app previously used
 * with a shared OneDrive file (so concurrent edits from different browsers/machines
 * don't clobber each other).
 *
 * Endpoints (all require header  X-Api-Key: <API_KEY secret>):
 *   GET  /data   -> returns the current stored data (empty shape if never saved)
 *   PUT  /data   -> body = client's full data object; merged with what's stored,
 *                   the merge result is saved and returned
 *
 * Bindings expected (see wrangler.toml):
 *   KV namespace  MOC_KV
 *   secret        API_KEY
 *   var           ALLOWED_ORIGIN   (the GitHub Pages origin, e.g. https://user.github.io)
 */

const DATA_KEY = 'moc_data';

function emptyData(){
  return { schemaVersion: 1, mocList: [], actionPlan: [], agenda: [], attendant: [], users: {} };
}

function corsHeaders(env){
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, env){
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(env))
  });
}

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

function mergeUsers(a, b){
  const out = Object.assign({}, b || {});
  Object.entries(a || {}).forEach(([name, rec]) => {
    const existing = out[name];
    if (!existing || String((rec && rec.updatedAt) || '') >= String((existing && existing.updatedAt) || '')) out[name] = rec;
  });
  return out;
}

// Merges `incoming` (the freshest write from a client) on top of `stored` (what's
// currently in KV) — ties go to `incoming`. Same rule the client used to apply when
// merging its local state on top of the shared file.
function mergeData(incoming, stored){
  if (!stored) return incoming;
  return {
    schemaVersion: incoming.schemaVersion || stored.schemaVersion || 1,
    mocList: mergeCollections(incoming.mocList, stored.mocList),
    actionPlan: mergeCollections(incoming.actionPlan, stored.actionPlan),
    agenda: mergeCollections(incoming.agenda, stored.agenda),
    attendant: mergeCollections(incoming.attendant, stored.attendant),
    users: mergeUsers(incoming.users, stored.users)
  };
}

function checkAuth(request, env){
  const key = request.headers.get('X-Api-Key') || '';
  return !!env.API_KEY && key === env.API_KEY;
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname !== '/data') {
      return json({ error: 'not_found' }, 404, env);
    }

    if (!checkAuth(request, env)) {
      return json({ error: 'unauthorized' }, 401, env);
    }

    if (request.method === 'GET') {
      const stored = await env.MOC_KV.get(DATA_KEY, 'json');
      return json(stored || emptyData(), 200, env);
    }

    if (request.method === 'PUT') {
      let incoming;
      try {
        incoming = await request.json();
      } catch (e) {
        return json({ error: 'invalid_json' }, 400, env);
      }
      const stored = await env.MOC_KV.get(DATA_KEY, 'json');
      const merged = mergeData(incoming, stored);
      await env.MOC_KV.put(DATA_KEY, JSON.stringify(merged));
      return json(merged, 200, env);
    }

    return json({ error: 'method_not_allowed' }, 405, env);
  }
};

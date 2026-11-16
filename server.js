// Batch training API + static viewer. One process steps hundreds of envs per request;
// run several processes on different ports (PORT=8081 node server.js) to use more cores.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Env, ACTION_SIZE } from './sim/core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080, MAX_ENVS = 8192, MAX_BODY = 64 << 20;
const envs = new Map();
let nextId = 1;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2' };

const maps = new Map(); // imported maps (public/maps/<name>), loaded once and shared by all envs
function loadMap(name) {
  if (!/^[\w-]+$/.test(name)) throw new HttpError(400, 'bad map name');
  if (!maps.has(name)) {
    const dir = path.join(ROOT, 'public', 'maps', name);
    if (!fs.existsSync(path.join(dir, 'map.json'))) throw new HttpError(404, `map ${name} not imported (see tools/import-map.js)`);
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
    const surf = path.join(dir, 'surfaces.json'); // real floor heights (tools/surface-map.js): eyes/hitboxes on the real floor
    maps.set(name, { ...json, grid: { ...json.grid, bits: new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'grid.bin.gz')))) },
      surfaces: fs.existsSync(surf) ? JSON.parse(fs.readFileSync(surf, 'utf8')) : undefined });
  }
  return maps.get(name);
}
const getEnv = id => { const e = envs.get(id); if (!e) throw new HttpError(404, `no env ${id}`); return e; };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const ids = body => (Array.isArray(body.ids) ? body.ids : [...envs.keys()]);

const routes = {
  'GET /api/spec': () => { const e = new Env(); return { obsSize: e.obsSize, actionSize: ACTION_SIZE, nAgents: e.nAgents, tick: 64, defaults: e.cfg }; },
  'GET /api/envs': () => ({ ids: [...envs.keys()] }),
  'GET /api/demos': () => { // the viewer's start menu: demos in public/demos (tools/import-demo.py, tools/record-demo.js), newest first
    const dir = path.join(ROOT, 'public', 'demos');
    const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json.gz')) : [];
    return { demos: list.map(f => { const s = fs.statSync(path.join(dir, f)); return { name: f.slice(0, -8), size: s.size, mtime: s.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime) };
  },
  'POST /api/envs': ({ count = 1, config = {} }) => {
    count = Math.floor(Number(count));
    if (!(count >= 1) || envs.size + count > MAX_ENVS) throw new HttpError(400, `count must be 1..${MAX_ENVS - envs.size}`);
    const { autoReset = true, ...cfg } = config;
    if (typeof cfg.map === 'string') cfg.map = loadMap(cfg.map);
    const out = [];
    for (let i = 0; i < count; i++) {
      const env = new Env(cfg); env.autoReset = autoReset; env.episode = 0;
      envs.set(nextId, env); out.push(nextId++);
    }
    const e = envs.get(out[0]);
    return { ids: out, obsSize: e.obsSize, actionSize: ACTION_SIZE, nAgents: e.nAgents };
  },
  'POST /api/reset': body => {
    const list = ids(body);
    return { ids: list, obs: list.map((id, i) => getEnv(id).reset(body.seed == null ? undefined : body.seed + i)) };
  },
  // { ids: [...], actions: [[agentAction, ...], ...] } → arrays in the same order as ids
  'POST /api/step': body => {
    const list = ids(body), acts = Array.isArray(body.actions) ? body.actions : [];
    const res = { ids: list, obs: [], rewards: [], dones: [], infos: [] };
    list.forEach((id, i) => {
      const env = getEnv(id), r = env.step(acts[i]);
      env.lastEvents = env.events;
      if (r.done && env.autoReset) { r.info.final_obs = r.obs; r.info.episode = env.episode++; r.obs = env.reset(); }
      res.obs.push(r.obs); res.rewards.push(r.rewards); res.dones.push(r.done); res.infos.push(r.info);
    });
    return res;
  },
  'POST /api/close': body => { const list = ids(body); list.forEach(id => envs.delete(id)); return { closed: list.length }; },
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Valve exports stay where they are (srcDir): an imported map's glTF, and the agent/weapon models (public/models/models.json)
  const src = rel.match(/^\/maps\/([\w-]+)\/src\/(.+)$/) || rel.match(/^\/models\/()src\/(.+)$/);
  if (src) {
    let dir;
    try { dir = src[1] ? loadMap(src[1]).srcDir : JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'models', 'models.json'), 'utf8')).srcDir; }
    catch (e) { return send(res, e.code || 404, { error: e.message }); }
    const file = dir && path.join(dir, path.normalize('/' + src[2]));
    if (!file || !file.startsWith(path.resolve(dir) + path.sep)) return send(res, 403, { error: 'forbidden' });
    return fs.createReadStream(file, { highWaterMark: 4 << 20 }).on('error', () => send(res, 404, { error: 'not found' }))
      .once('open', function () { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'max-age=86400' }); this.pipe(res); });
  }
  if (rel === '/') rel = '/public/index.html';
  else if (!rel.startsWith('/sim/') && !rel.startsWith('/public/')) rel = '/public' + rel;
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(path.join(ROOT, 'public')) && !file.startsWith(path.join(ROOT, 'sim'))) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    // no-cache: the browser revalidates the viewer's modules (sim/core.js…) so an edit shows up on a plain reload
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const state = url.pathname.match(/^\/api\/state\/(\d+)$/);
  if (state && req.method === 'GET') {
    try { const env = getEnv(Number(state[1])); return send(res, 200, { ...env.state(), events: env.lastEvents || [], map: url.searchParams.has('map') ? (env.map.grid ? env.map.name : env.map) : undefined }); }
    catch (e) { return send(res, e.code || 500, { error: e.message }); }
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return url.pathname.startsWith('/api/') ? send(res, 404, { error: 'unknown endpoint' }) : serveStatic(req, res);
  let body = '', size = 0;
  req.on('data', c => { size += c.length; if (size > MAX_BODY) req.destroy(); else body += c; });
  req.on('end', () => {
    try { send(res, 200, route(body ? JSON.parse(body) : {})); }
    catch (e) { send(res, e.code || 400, { error: e.message }); }
  });
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`arena on http://127.0.0.1:${PORT}  (viewer: /  watch env: /?watch=ID)`));

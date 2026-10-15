import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Service } from './service.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDirectory = path.join(project, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }
async function jsonBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 2 * 1024 ** 2) throw new Error('请求超过 2MB'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export async function startServer({ directory = process.env.MODEL_SYNC_DATA || path.join(project, '.data'), port = 0, service = null } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const lockFile = path.join(directory, 'workspace.lock');
  const lockToken = randomBytes(16).toString('hex');
  try {
    const fd = fs.openSync(lockFile, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: lockToken })); fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('工作空间锁无效，请保留文件并检查');
    try { process.kill(previous.pid, 0); throw new Error('该工作空间已在另一个进程中打开，请先关闭其他实例'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    fs.unlinkSync(lockFile);
    const fd = fs.openSync(lockFile, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: lockToken })); fs.closeSync(fd);
  }
  const unlock = () => { try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).token === lockToken) fs.unlinkSync(lockFile); } catch {} };
  try { service ||= new Service(directory); } catch (error) { unlock(); throw error; }
  const csrf = randomBytes(32).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) return reply(403, { error: 'Host 不受支持' });
      if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: '仅允许本机工作台访问' });
      const url = new URL(req.url, origin), p = url.pathname;
      if (p.startsWith('/api/')) {
        if (!equal(req.headers['x-model-sync-token'], csrf)) return reply(403, { error: '会话校验失败，请刷新工作台' });
        if (req.method === 'GET' && p === '/api/state') return reply(200, service.state());
        if (req.method !== 'POST') return reply(405, { error: '不支持的操作' });
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return reply(415, { error: '仅支持 JSON 请求' });
        const body = await jsonBody(req);
        let result;
        switch (p) {
          case '/api/models/add': result = service.add(body.urls); break;
          case '/api/browser/connect': result = await service.connectBrowser(); break;
          case '/api/models/collect': result = service.collect(body.id); break;
          case '/api/models/edit': result = service.edit(body.id, body); break;
          case '/api/models/delete': result = service.removeModel(body.id, { mode: body.mode, confirmPermanent: body.confirmPermanent }); break;
          case '/api/models/restore': result = service.restoreModel(body.id); break;
          case '/api/models/attach': result = service.attach(body.id, body.files, body.kind); break;
          case '/api/preview': result = service.plans(body.modelIds, body.targets); break;
          case '/api/tasks/create': result = service.enqueue(body.modelIds, body.targets); break;
          case '/api/tasks/cancel': result = await service.queue.cancel(body.id); break;
          case '/api/tasks/delete': result = await service.queue.remove(body.id, { mode: body.mode, confirmPermanent: body.confirmPermanent }); break;
          case '/api/trash/cleanup': result = service.store.retryFileCleanup(); break;
          case '/api/tasks/restore': result = service.queue.restore(body.id); break;
          case '/api/tasks/commit': result = await service.queue.commit(body.id, body.consent); break;
          case '/api/tasks/retry': result = service.queue.retry(body.id, body.checked); break;
          case '/api/tasks/verify': result = await service.queue.verify(body.id); break;
          case '/api/tasks/resolve': result = service.queue.resolve(body.id, body.url); break;
          case '/api/platform/open': result = await service.browser.openPlatform(body.platform); break;
          default: return reply(404, { error: '接口不存在' });
        }
        return reply(200, result ?? { ok: true });
      }
      if (req.method !== 'GET') return reply(405, { error: '不支持的操作' });
      if (p.startsWith('/asset/')) {
        const asset = service.asset(decodeURIComponent(p.slice(7)));
        res.writeHead(200, { 'Content-Type': asset.mime }); fs.createReadStream(asset.path).pipe(res); return;
      }
      if (p.startsWith('/evidence/')) {
        const filename = p.slice(10);
        if (!/^[a-zA-Z0-9-]+\.png$/.test(filename)) return reply(400, { error: '截图路径无效' });
        const file = path.join(service.store.directory, 'evidence', filename);
        if (!fs.existsSync(file)) return reply(404, { error: '截图不存在' });
        res.writeHead(200, { 'Content-Type': 'image/png' }); fs.createReadStream(file).pipe(res); return;
      }
      const routes = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/icon.svg': 'icon.svg' };
      const file = routes[p];
      if (!file) return reply(404, { error: '页面不存在' });
      let content = fs.readFileSync(path.join(publicDirectory, file));
      if (file === 'index.html') content = Buffer.from(content.toString('utf8').replace('__CSRF_TOKEN__', csrf));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] }); res.end(content);
    } catch (error) { if (!res.headersSent) reply(400, { error: error.message }); else res.destroy(); }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { unlock(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, service, url: origin, close: async () => { service.queue.stopped = true; try { await service.browser.close(); await new Promise(resolve => server.close(resolve)); } finally { unlock(); } } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const instance = await startServer({ port: Number(process.env.PORT || 4317) });
  console.log(`MODEL_SYNC_URL=${instance.url}`);
  process.on('SIGINT', async () => { await instance.close(); process.exit(0); });
}

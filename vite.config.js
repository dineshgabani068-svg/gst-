import { defineConfig } from 'vite';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function expressApi() {
  return {
    name: 'express-api',
    configureServer(server) {
      const dataDir = path.join(__dirname, 'data');
      const dirs = ['bills', 'clients', 'templates', 'products', 'expenses', 'recurring', 'receipts', 'profiles', 'purchases'];
      for (const dir of dirs) {
        const p = path.join(dataDir, dir);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      }

      const app = express();
      app.use(express.json({ limit: '5mb' }));

      app.use((req, res, next) => {
        const origin = req.headers.origin;
        const allow = !origin ||
          /^https?:\/\/localhost(:\d+)?$/i.test(origin) ||
          /^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin);
        if (!allow) return res.status(403).json({ error: 'Cross-origin request refused' });
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
      });

      const DATA_DIR = dataDir;
      const safeFileName = (id) => String(id).replace(/[/\\:*?"<>|]/g, '_');
      const isPathInside = (resolved, root) => { const r = path.resolve(root); const p = path.resolve(resolved); return p === r || p.startsWith(r + path.sep); };
      const writeFileAtomic = (fp, c) => { const t = fp + '.tmp'; fs.writeFileSync(t, c, 'utf-8'); fs.renameSync(t, fp); };
      const readJSON = (fp, fb = null) => { try { if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {} return fb; };
      const writeJSON = (fp, d) => writeFileAtomic(fp, JSON.stringify(d, null, 2));
      const deleteFile = (fp) => { if (fs.existsSync(fp)) fs.unlinkSync(fp); };

      const dirCache = {};
      function readAllFromDir(dir) {
        const e = dirCache[dir];
        if (e && (Date.now() - e.at) < 5000) return e.value;
        const dp = path.join(DATA_DIR, dir);
        if (!fs.existsSync(dp)) return [];
        const results = fs.readdirSync(dp).filter(f => f.endsWith('.json'))
          .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dp, f), 'utf-8')); } catch { return null; } }).filter(Boolean);
        dirCache[dir] = { at: Date.now(), value: results };
        return results;
      }

      const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
      const DEFAULT_PROFILE = { businessName: '', address: '', state: '', gstin: '', pan: '', email: '', phone: '', bankName: '', accountNumber: '', ifsc: '', logo: '', signature: '', upiId: '', googleClientId: '', googleDriveFolder: 'GST Billing Invoices' };
      const META_PATH = path.join(DATA_DIR, 'meta.json');

      const mkCrud = (dirName, sortKey) => {
        app.get('/api/' + dirName, (req, res) => { const items = readAllFromDir(dirName); if (sortKey) items.sort((a, b) => { const av = a[sortKey] || '', bv = b[sortKey] || ''; return av.localeCompare ? av.localeCompare(bv) : new Date(bv) - new Date(av); }); res.json(items); });
        app.post('/api/' + dirName, (req, res) => { const item = req.body; if (!item.id) item.id = dirName.slice(0, 3) + '_' + Date.now(); writeJSON(path.join(DATA_DIR, dirName, safeFileName(item.id) + '.json'), item); res.json({ success: true, id: item.id }); });
        app.delete('/api/' + dirName + '/:id', (req, res) => { deleteFile(path.join(DATA_DIR, dirName, safeFileName(req.params.id) + '.json')); res.json({ success: true }); });
      };

      // Bills (special: dupe check + soft delete)
      app.get('/api/bills', (req, res) => { const b = readAllFromDir('bills'); b.sort((a, c) => new Date(c.invoiceDate) - new Date(a.invoiceDate)); res.json(b); });
      app.post('/api/bills', (req, res) => {
        const bill = req.body; if (!bill || !bill.id) return res.status(400).json({ error: 'Bill must have an id' });
        const fp = path.join(DATA_DIR, 'bills', safeFileName(bill.id) + '.json');
        const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
        if (!overwrite && fs.existsSync(fp)) return res.status(409).json({ error: 'A bill with this invoice number already exists', invoiceNumber: bill.id });
        writeJSON(fp, bill); res.json({ success: true });
      });
      app.delete('/api/bills/:id', (req, res) => {
        const fname = safeFileName(req.params.id) + '.json';
        const fp = path.join(DATA_DIR, 'bills', fname);
        if (!fs.existsSync(fp)) return res.json({ success: true });
        if (req.query.permanent === '1') { try { fs.unlinkSync(fp); } catch {} return res.json({ success: true, permanent: true }); }
        try { const td = path.join(DATA_DIR, 'trash'); if (!fs.existsSync(td)) fs.mkdirSync(td, { recursive: true }); fs.renameSync(fp, path.join(td, fname)); res.json({ success: true, trashed: true }); }
        catch { res.status(500).json({ error: 'Internal server error' }); }
      });

      app.get('/api/profile', (req, res) => res.json(readJSON(PROFILE_PATH, DEFAULT_PROFILE)));
      app.post('/api/profile', (req, res) => { writeJSON(PROFILE_PATH, req.body); res.json({ success: true }); });

      mkCrud('clients', 'name');
      mkCrud('templates', 'name');
      mkCrud('products', 'name');
      mkCrud('expenses', 'date');
      mkCrud('recurring', 'clientName');
      mkCrud('receipts', 'date');
      mkCrud('purchases', 'date');
      mkCrud('profiles', 'businessName');

      app.get('/api/meta/:key', (req, res) => { const m = readJSON(META_PATH, {}); res.json({ value: m[req.params.key] ?? null }); });
      app.post('/api/meta/:key', (req, res) => { const m = readJSON(META_PATH, {}); m[req.params.key] = req.body.value; writeJSON(META_PATH, m); res.json({ success: true }); });
      app.post('/api/meta/:key/increment', (req, res) => { const m = readJSON(META_PATH, {}); const next = (Number(m[req.params.key]) || 0) + 1; m[req.params.key] = next; writeJSON(META_PATH, m); res.json({ value: next }); });

      app.get('/api/export', (req, res) => {
        res.json({ bills: readAllFromDir('bills'), profile: readJSON(PROFILE_PATH, DEFAULT_PROFILE), clients: readAllFromDir('clients'), termsTemplates: readAllFromDir('templates'), products: readAllFromDir('products'), expenses: readAllFromDir('expenses'), recurring: readAllFromDir('recurring'), receipts: readAllFromDir('receipts'), profiles: readAllFromDir('profiles'), purchases: readAllFromDir('purchases'), meta: readJSON(META_PATH, {}), exportedAt: new Date().toISOString() });
      });
      app.post('/api/import', (req, res) => {
        const data = req.body; const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
        const upsert = (dn, entity) => { if (!entity?.id) return; const p = path.join(DATA_DIR, dn, safeFileName(entity.id) + '.json'); if (!overwrite && fs.existsSync(p)) return; writeJSON(p, entity); };
        if (data.profile && (overwrite || !fs.existsSync(PROFILE_PATH))) writeJSON(PROFILE_PATH, data.profile);
        (data.bills || []).forEach(b => upsert('bills', b));
        (data.clients || []).forEach(c => upsert('clients', c));
        (data.termsTemplates || []).forEach(t => upsert('templates', t));
        (data.products || []).forEach(p => upsert('products', p));
        (data.expenses || []).forEach(e => upsert('expenses', e));
        (data.recurring || []).forEach(r => upsert('recurring', r));
        (data.receipts || []).forEach(r => upsert('receipts', r));
        (data.profiles || []).forEach(p => upsert('profiles', p));
        (data.purchases || []).forEach(p => upsert('purchases', p));
        if (data.meta && (overwrite || !fs.existsSync(META_PATH))) writeJSON(META_PATH, data.meta);
        res.json({ success: true });
      });

      app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.10.69', uptimeSec: 0, pid: process.pid, hasRecentErrors: false, errorsTail: '' }));
      app.get('/api/version', (req, res) => res.json({ current: '1.10.69' }));

      const BILL_TRASH_DIR = path.join(DATA_DIR, 'trash');
      if (!fs.existsSync(BILL_TRASH_DIR)) fs.mkdirSync(BILL_TRASH_DIR, { recursive: true });
      app.get('/api/trash', (req, res) => {
        const files = fs.readdirSync(BILL_TRASH_DIR).filter(n => n.endsWith('.json'))
          .map(name => { try { const p = path.join(BILL_TRASH_DIR, name); const bill = readJSON(p, null); const stat = fs.statSync(p); return bill ? { ...bill, _trashedAt: stat.mtime.toISOString() } : null; } catch { return null; } })
          .filter(Boolean);
        res.json(files);
      });
      app.post('/api/trash/:id/restore', (req, res) => {
        const fname = safeFileName(req.params.id) + '.json';
        const tp = path.join(BILL_TRASH_DIR, fname);
        const bp = path.join(DATA_DIR, 'bills', fname);
        if (!fs.existsSync(tp)) return res.status(404).json({ error: 'Not in trash' });
        fs.renameSync(tp, bp); res.json({ success: true });
      });
      app.delete('/api/trash/:id', (req, res) => { const fp = path.join(BILL_TRASH_DIR, safeFileName(req.params.id) + '.json'); if (fs.existsSync(fp)) fs.unlinkSync(fp); res.json({ success: true }); });

      const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
      if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      app.get('/api/backups', (req, res) => {
        const list = fs.readdirSync(BACKUPS_DIR).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()
          .map(name => { const stat = fs.statSync(path.join(BACKUPS_DIR, name)); return { date: name, createdAt: stat.mtime.toISOString() }; });
        res.json(list);
      });

      const INVOICES_DIR = path.join(__dirname, 'Saved Invoices');
      if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true });
      app.post('/api/save-pdf', express.raw({ type: 'application/pdf', limit: '20mb' }), (req, res) => {
        try {
          const rawName = req.query.name || `invoice-${Date.now()}.pdf`;
          let safeName = String(rawName).replace(/[/\\:*?"<>|]/g, '_');
          if (!safeName.toLowerCase().endsWith('.pdf')) safeName += '.pdf';
          const folderPath = path.join(INVOICES_DIR, 'General', new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' }));
          const filePath = path.join(folderPath, safeName);
          if (!isPathInside(filePath, INVOICES_DIR)) return res.status(400).json({ error: 'Invalid path' });
          if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
          fs.writeFileSync(filePath, req.body);
          res.json({ saved: true, relPath: path.relative(__dirname, filePath).split(path.sep).join('/') });
        } catch { res.status(500).json({ error: 'Internal server error' }); }
      });

      server.middlewares.use(app);
    },
  };
}

export default defineConfig({
  plugins: [expressApi()],
  server: {
    port: 5173,
    root: 'dist',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
  },
  optimizeDeps: {
    exclude: ['tesseract.js'],
  },
});

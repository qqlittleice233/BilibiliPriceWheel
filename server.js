import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig = {
      prizes: [
        { name: '谢谢参与', weight: 1 },
        { name: '纪念贴纸', weight: 2 },
        { name: 'B站小礼物', weight: 1 },
        { name: '红包5元', weight: 0.5 },
        { name: '红包10元', weight: 0.3 },
        { name: '周边一份', weight: 0.2 },
        { name: '定制礼品', weight: 0.1 },
        { name: '大奖！', weight: 0.05 }
      ]
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
  }
  if (!fs.existsSync(HISTORY_PATH)) {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify([], null, 2), 'utf-8');
  }
  if (!fs.existsSync(SETTINGS_PATH)) {
    const defaultSettings = { rounds: 4, duration: 4500, modalMs: 2500 };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2), 'utf-8');
  }
}

ensureDataFiles();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

// WebSocket connection (limit to /ws path)
wss.on('connection', (ws, request) => {
  if (request.url !== '/ws') {
    ws.close();
    return;
  }
  // Send initial config and history
  const cfg = readJson(CONFIG_PATH) || { prizes: [] };
  const hist = readJson(HISTORY_PATH) || [];
  const settings = readJson(SETTINGS_PATH) || { rounds: 4, duration: 4500, modalMs: 2500 };
  ws.send(JSON.stringify({ type: 'config', payload: cfg }));
  ws.send(JSON.stringify({ type: 'history', payload: hist.slice(-50) }));
  ws.send(JSON.stringify({ type: 'settings', payload: settings }));
});

// API: Get config
app.get('/config', (req, res) => {
  const cfg = readJson(CONFIG_PATH);
  res.json(cfg || { prizes: [] });
});

// API: Update config
app.post('/config', (req, res) => {
  const { prizes } = req.body || {};
  if (!Array.isArray(prizes) || prizes.length === 0) {
    return res.status(400).json({ error: 'Invalid prizes' });
  }
  const normalized = prizes.map(p => ({
    name: String(p.name || '').slice(0, 50) || '未命名',
    weight: Math.max(0, Number(p.weight) || 0)
  })).filter(p => p.weight > 0);
  if (normalized.length === 0) {
    return res.status(400).json({ error: 'All weights are zero' });
  }
  writeJson(CONFIG_PATH, { prizes: normalized });
  broadcast({ type: 'config', payload: { prizes: normalized } });
  res.json({ ok: true });
});

// API: Get history (recent 200)
app.get('/history', (req, res) => {
  const hist = readJson(HISTORY_PATH) || [];
  res.json(hist.slice(-200));
});

// API: Trigger spin via POST
// Body: { participant: string, count: number }
app.post('/spin', (req, res) => {
  const body = req.body || {};
  let participantRaw = '';
  // 支持 base64 形式以避免上游编码问题
  if (typeof body.participant_b64 === 'string') {
    try {
      participantRaw = Buffer.from(body.participant_b64, 'base64').toString('utf8');
    } catch {
      participantRaw = '';
    }
  } else if (typeof body.participantB64 === 'string') {
    try {
      participantRaw = Buffer.from(body.participantB64, 'base64').toString('utf8');
    } catch {
      participantRaw = '';
    }
  } else if (typeof body.participant === 'string') {
    participantRaw = body.participant;
  }
  // 若请求以百分号编码传入，尝试解码
  if (/%[0-9A-Fa-f]{2}/.test(participantRaw)) {
    try { participantRaw = decodeURIComponent(participantRaw); } catch {}
  }
  let participant = String(participantRaw || '').normalize('NFC').slice(0, 100) || '匿名';
  let count = Number((req.body && req.body.count) || 1);
  if (!Number.isFinite(count) || count <= 0) count = 1;
  if (count > 20) count = 20; // prevent abuse
  // 权威抽取：根据当前配置选择结果并写入历史
  const cfg = readJson(CONFIG_PATH) || { prizes: [] };
  const list = Array.isArray(cfg.prizes) ? cfg.prizes.filter(p => (Number(p.weight) || 0) > 0) : [];
  function pickOne() {
    if (!list.length) return '未命名';
    const total = list.reduce((s, p) => s + (Number(p.weight) || 0), 0);
    let rnd = Math.random() * total;
    for (let i = 0; i < list.length; i++) {
      rnd -= (Number(list[i].weight) || 0);
      if (rnd <= 0) return String(list[i].name || '未命名');
    }
    return String(list[list.length - 1].name || '未命名');
  }
  const results = [];
  for (let i = 0; i < count; i++) results.push(pickOne());
  const hist = readJson(HISTORY_PATH) || [];
  const now = Date.now();
  results.forEach(name => {
    const item = { participant, prize: name, time: now };
    hist.push(item);
    broadcast({ type: 'history_append', payload: item });
  });
  writeJson(HISTORY_PATH, hist.slice(-2000));
  // 广播统一抽奖结果，客户端按此结果进行动画
  broadcast({ type: 'spin', payload: { participant, results } });
  res.json({ ok: true, queued: count, results });
});

// Persist history entries
app.post('/history', (req, res) => {
  const { participant, prize, time } = req.body || {};
  if (!participant || !prize) return res.status(400).json({ error: 'Missing fields' });
  const hist = readJson(HISTORY_PATH) || [];
  hist.push({ participant, prize, time: time || Date.now() });
  writeJson(HISTORY_PATH, hist.slice(-2000));
  broadcast({ type: 'history_append', payload: { participant, prize, time: time || Date.now() } });
  res.json({ ok: true });
});

// Clear history (admin action)
app.post('/history/clear', (req, res) => {
  writeJson(HISTORY_PATH, []);
  // Broadcast empty history to all clients
  broadcast({ type: 'history', payload: [] });
  res.json({ ok: true, cleared: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
// API: Get settings
app.get('/settings', (req, res) => {
  const s = readJson(SETTINGS_PATH) || { rounds: 4, duration: 4500, modalMs: 2500 };
  res.json(s);
});

// API: Update settings
app.post('/settings', (req, res) => {
  const body = req.body || {};
  let rounds = Math.floor(Number(body.rounds));
  let duration = Math.floor(Number(body.duration));
  let modalMs = Math.floor(Number(body.modalMs));

  if (!Number.isFinite(rounds)) rounds = 4;
  if (!Number.isFinite(duration)) duration = 4500;
  if (!Number.isFinite(modalMs)) modalMs = 2500;

  rounds = Math.max(1, Math.min(12, rounds));
  duration = Math.max(1500, Math.min(12000, duration));
  modalMs = Math.max(500, Math.min(10000, modalMs));

  const s = { rounds, duration, modalMs };
  writeJson(SETTINGS_PATH, s);
  broadcast({ type: 'settings', payload: s });
  res.json({ ok: true, settings: s });
});

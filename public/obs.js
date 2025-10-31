const state = {
  config: { prizes: [] },
  sectors: [],
  rotationDeg: 0,
  spinning: false,
  highlightIndex: null,
  ws: null,
  spinQueue: [],
  canvas: null,
  ctx: null,
  dpr: 1,
  cssW: 800,
  cssH: 800,
  settings: { rounds: 4, duration: 4500, modalMs: 2500 }
};

function degToRad(d) { return d * Math.PI / 180; }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

const wheelCanvas = document.getElementById('wheelCanvas');
const winnerModal = document.getElementById('winnerModal');
const winnerText = document.getElementById('winnerText');
state.canvas = wheelCanvas;
state.ctx = wheelCanvas.getContext('2d');

function generateColors(n) {
  const colors = [];
  const golden = 0.61803398875;
  let h = Math.random();
  for (let i = 0; i < n; i++) {
    h += golden; h %= 1;
    const s = 0.7; const l = 0.5;
    colors.push(`hsl(${Math.round(h * 360)}, ${Math.round(s*100)}%, ${Math.round(l*100)}%)`);
  }
  return colors;
}

function buildSectors() {
  const prizes = state.config.prizes || [];
  const n = prizes.length || 1;
  const sliceDeg = 360 / n;
  const colors = generateColors(n);
  state.sectors = prizes.map((p, idx) => {
    const startDeg = idx * sliceDeg;
    const endDeg = (idx + 1) * sliceDeg;
    const centerDeg = startDeg + sliceDeg / 2;
    const w = Number(p.weight) || 0; // 仅用于抽中概率
    return { name: p.name, weight: w, startDeg, endDeg, centerDeg, color: colors[idx] };
  });
}

function drawWheel() {
  const ctx = state.ctx;
  const W = state.cssW;
  const H = state.cssH;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  const cx = W/2, cy = H/2, r = Math.min(W, H)/2 - 10;
  ctx.translate(cx, cy);
  ctx.rotate(degToRad(state.rotationDeg));

  // base circle
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fill();

  // sectors
  state.sectors.forEach((s, idx) => {
    const startRad = degToRad(s.startDeg - 90);
    const endRad = degToRad(s.endDeg - 90);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, startRad, endRad);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();

    if (state.highlightIndex === idx) {
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 6;
      ctx.stroke();
    }

    // label
    ctx.save();
    const midRad = (startRad + endRad) / 2;
    const tx = Math.cos(midRad) * (r * 0.65);
    const ty = Math.sin(midRad) * (r * 0.65);
    ctx.translate(tx, ty);
    ctx.rotate(midRad + Math.PI/2);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(r*0.08)}px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'SimHei', 'SimSun', Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(s.name, 0, 0);
    ctx.restore();
  });

  // hub
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.1, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

function pickPrize() {
  const total = state.sectors.reduce((s, x) => s + x.weight, 0);
  const rnd = Math.random() * total;
  let acc = 0;
  for (let i = 0; i < state.sectors.length; i++) {
    acc += state.sectors[i].weight;
    if (rnd <= acc) return i;
  }
  return state.sectors.length - 1;
}

function showWinner(participant, text) {
  if (!winnerModal || !winnerText) return;
  winnerText.textContent = `${participant} 抽中：${text}`;
  winnerModal.classList.remove('hidden');
  setTimeout(() => {
    winnerModal.classList.add('hidden');
  }, Math.max(500, Math.min(10000, Number(state.settings.modalMs) || 2500)));
}

function startSpin(participant = 'OBS', forcedPrizeName = null) {
  if (state.spinning || state.sectors.length === 0) return;
  state.spinning = true;
  state.highlightIndex = null;

  const startRotation = state.rotationDeg;
  const currentModulo = ((startRotation % 360) + 360) % 360;
  let winIdx = -1;
  if (forcedPrizeName) {
    winIdx = state.sectors.findIndex(s => String(s.name) === String(forcedPrizeName));
    if (winIdx < 0) winIdx = pickPrize();
  } else {
    winIdx = pickPrize();
  }
  const targetCenter = state.sectors[winIdx].centerDeg;
  const extraSpin = Math.floor(Math.random() * 180);
  const baseSpins = state.settings.rounds * 360;
  const targetMod = ((360 - targetCenter) % 360 + 360) % 360;
  const newMod = ((currentModulo + extraSpin) % 360 + 360) % 360;
  const deltaToTop = ((targetMod - newMod + 360) % 360);
  const targetDeg = startRotation + baseSpins + extraSpin + deltaToTop;

  const duration = Math.max(1500, Math.min(12000, Number(state.settings.duration) || 4500));
  const start = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = easeOutCubic(t);
    const deg = lerp(startRotation, targetDeg, eased);
    state.rotationDeg = deg;
    drawWheel();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      state.spinning = false;
      state.highlightIndex = winIdx;
      state.rotationDeg = targetDeg;
      drawWheel();
      // OBS页面显示中奖弹窗，历史由服务器写入
      const prizeName = state.sectors[winIdx].name;
      showWinner(participant, prizeName);
    }
  }
  requestAnimationFrame(frame);
}

function connectWS() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  try {
    state.ws = new WebSocket(url);
    state.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'config') {
        state.config = msg.payload;
        buildSectors();
        drawWheel();
      } else if (msg.type === 'settings') {
        const s = msg.payload || {};
        if (typeof s.rounds === 'number') state.settings.rounds = s.rounds;
        if (typeof s.duration === 'number') state.settings.duration = s.duration;
        if (typeof s.modalMs === 'number') state.settings.modalMs = s.modalMs;
      } else if (msg.type === 'spin') {
        const { participant, results, count } = msg.payload || {};
        if (Array.isArray(results) && results.length > 0) {
          results.forEach(name => state.spinQueue.push({ participant: participant || 'OBS', prizeName: name }));
        } else {
          const c = Number(count) || 1;
          for (let i = 0; i < c; i++) state.spinQueue.push({ participant: participant || 'OBS', prizeName: null });
        }
      }
    };
    state.ws.onclose = () => setTimeout(connectWS, 2000);
  } catch (e) {
    console.warn('WS connect failed');
  }
}

function tickQueue() {
  if (!state.spinning && state.spinQueue.length > 0) {
    const item = state.spinQueue.shift();
    const p = item ? item.participant : 'OBS';
    const prizeName = item ? item.prizeName : null;
    startSpin(p, prizeName);
  }
  requestAnimationFrame(tickQueue);
}

async function loadInitialConfig() {
  try {
    const res = await fetch('/config');
    if (res.ok) {
      state.config = await res.json();
      buildSectors();
      drawWheel();
    }
  } catch {}
}

function resizeCanvas() {
  const rect = wheelCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  state.dpr = dpr;
  state.cssW = Math.round(rect.width);
  state.cssH = Math.round(rect.height);
  wheelCanvas.width = Math.round(state.cssW * dpr);
  wheelCanvas.height = Math.round(state.cssH * dpr);
  state.ctx.setTransform(1, 0, 0, 1, 0, 0);
  state.ctx.scale(dpr, dpr);
  drawWheel();
}

window.addEventListener('resize', resizeCanvas);
// 点击关闭弹窗（可选）
winnerModal && winnerModal.addEventListener('click', () => winnerModal.classList.add('hidden'));

function loadSettings() {
  try {
    const raw = localStorage.getItem('wheel_settings');
    if (raw) {
      const s = JSON.parse(raw);
      if (typeof s.rounds === 'number') state.settings.rounds = s.rounds;
      if (typeof s.duration === 'number') state.settings.duration = s.duration;
      if (typeof s.modalMs === 'number') state.settings.modalMs = s.modalMs;
    }
  } catch {}
}

(async function init() {
  await loadInitialConfig();
  try {
    const res = await fetch('/settings');
    if (res.ok) {
      const s = await res.json();
      if (typeof s.rounds === 'number') state.settings.rounds = s.rounds;
      if (typeof s.duration === 'number') state.settings.duration = s.duration;
      if (typeof s.modalMs === 'number') state.settings.modalMs = s.modalMs;
    }
  } catch {}
  resizeCanvas();
  loadSettings();
  connectWS();
  tickQueue();
})();

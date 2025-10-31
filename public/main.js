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

const wheelCanvas = document.getElementById('wheelCanvas');
const winnerModal = document.getElementById('winnerModal');
const winnerText = document.getElementById('winnerText');
const closeModalBtn = document.getElementById('closeModalBtn');
// 主页面不包含设置输入框（在控制页中配置并通过localStorage共享）

state.canvas = wheelCanvas;
state.ctx = wheelCanvas.getContext('2d');

function degToRad(d) { return d * Math.PI / 180; }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

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

  // Draw base circle
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fill();

  // Draw sectors
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

    // Label (rotated with wheel)
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

  // Center hub
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

 function startSpin(participant = '本地', forcedPrizeName = null) {
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
  const targetCenter = state.sectors[winIdx].centerDeg; // align to pointer at top
  // 由于绘制时将角度整体偏移-90度，使顶部为0，因此需要让最终rotationDeg对齐到(360 - centerDeg)
  const extraSpin = Math.floor(Math.random() * 180); // 额外角度（非整圈）
  const baseSpins = state.settings.rounds * 360; // 整圈数
  const targetMod = ((360 - targetCenter) % 360 + 360) % 360;
  const newMod = ((currentModulo + extraSpin) % 360 + 360) % 360; // 整圈不影响模值
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
      state.rotationDeg = targetDeg; // 结束时确保精确对齐
      drawWheel();
      showWinner(state.sectors[winIdx].name);
      // 历史由服务器写入，这里不再持久化，避免重复
      appendHistory({ participant, prize: state.sectors[winIdx].name }, false, false);
    }
  }
  requestAnimationFrame(frame);
}

function showWinner(text) {
  winnerText.textContent = `中奖：${text}`;
  winnerModal.classList.remove('hidden');
  setTimeout(() => {
    winnerModal.classList.add('hidden');
  }, Math.max(500, Math.min(10000, Number(state.settings.modalMs) || 2500)));
}

function appendHistory({ participant, prize, time }, persist = false, display = false) {
  if (display) {
    const listEl = document.getElementById('historyList');
    if (listEl) {
      const li = document.createElement('li');
      const ts = time ? new Date(time).toLocaleTimeString() : new Date().toLocaleTimeString();
      li.textContent = `${ts}｜${participant} 抽中「${prize}」`;
      listEl.prepend(li);
    }
  }
  if (persist) {
    fetch('/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant, prize, time: Date.now() })
    }).catch(() => {});
  }
}

// 主页面不包含配置编辑器

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
        // 设置更新无需立即重绘，只影响后续动画与弹窗
      } else if (msg.type === 'history') {
        // 主页面不显示历史
      } else if (msg.type === 'history_append') {
        // 主页面不显示历史
      } else if (msg.type === 'spin') {
        const { participant, results, count } = msg.payload || {};
        if (Array.isArray(results) && results.length > 0) {
          results.forEach(name => state.spinQueue.push({ participant, prizeName: name }));
        } else {
          const c = Number(count) || 1;
          for (let i = 0; i < c; i++) state.spinQueue.push({ participant, prizeName: null });
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
    const participant = (item && item.participant) || '本地';
    const prizeName = item ? item.prizeName : null;
    startSpin(participant, prizeName);
  }
  requestAnimationFrame(tickQueue);
}

async function loadInitialConfig() {
  const res = await fetch('/config');
  state.config = await res.json();
  buildSectors();
  drawWheel();
}

async function loadRemoteSettings() {
  try {
    const res = await fetch('/settings');
    if (res.ok) {
      const s = await res.json();
      if (typeof s.rounds === 'number') state.settings.rounds = s.rounds;
      if (typeof s.duration === 'number') state.settings.duration = s.duration;
      if (typeof s.modalMs === 'number') state.settings.modalMs = s.modalMs;
    }
  } catch {}
}

function resizeCanvas() {
  const rect = wheelCanvas.getBoundingClientRect();
  // Set internal resolution to device pixels for crisp rendering
  const dpr = window.devicePixelRatio || 1;
  state.dpr = dpr;
  state.cssW = Math.round(rect.width);
  state.cssH = Math.round(rect.height);
  wheelCanvas.width = Math.round(state.cssW * dpr);
  wheelCanvas.height = Math.round(state.cssH * dpr);
  state.ctx.setTransform(1, 0, 0, 1, 0, 0); // reset
  state.ctx.scale(dpr, dpr); // draw using CSS pixel coordinates
  drawWheel();
}

// 统一走服务器触发抽奖，收到WS或HTTP结果后再动画
async function triggerServerSpin(participant = '本地') {
  if (state.spinning) return;
  try {
    const res = await fetch('/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant, count: 1 })
    });
    // 回退：如果WS暂时不可用，直接用HTTP返回的结果入队执行
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && Array.isArray(data.results) && data.results.length > 0) {
        data.results.forEach(name => state.spinQueue.push({ participant, prizeName: name }));
      }
    }
  } catch {}
}

window.addEventListener('resize', resizeCanvas);

// 点击转盘开始抽奖（桌面与移动端）
wheelCanvas.addEventListener('click', () => triggerServerSpin('本地'));
wheelCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); triggerServerSpin('本地'); }, { passive: false });

// 主页面不再包含配置与设置面板，移除相关事件绑定

closeModalBtn.addEventListener('click', () => winnerModal.classList.add('hidden'));

// 主页面不再使用面板快捷键

(async function init() {
  await loadInitialConfig();
  await loadRemoteSettings();
  resizeCanvas();
  connectWS();
  tickQueue();
  loadSettings();
})();
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

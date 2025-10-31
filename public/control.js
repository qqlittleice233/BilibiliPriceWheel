const state = {
  ws: null,
  settings: { rounds: 4, duration: 4500, modalMs: 2500 },
  prizes: [],
};

const roundsInput = document.getElementById('roundsInput');
const durationInput = document.getElementById('durationInput');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const modalInput = document.getElementById('modalInput');
const testSpinBtn = document.getElementById('testSpinBtn');
const historyListEl = document.getElementById('historyList');
const prizeListEl = document.getElementById('prizeList');
const addPrizeBtn = document.getElementById('addPrizeBtn');
const savePrizesBtn = document.getElementById('savePrizesBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
// 自定义二次确认弹窗元素
const confirmModal = document.getElementById('confirmModal');
const confirmText = document.getElementById('confirmText');
const confirmYesBtn = document.getElementById('confirmYesBtn');
const confirmNoBtn = document.getElementById('confirmNoBtn');

async function loadSettings() {
  // 优先从服务器读取统一设置，其次回退本地
  try {
    const res = await fetch('/settings');
    if (res.ok) {
      const s = await res.json();
      if (typeof s.rounds === 'number') state.settings.rounds = s.rounds;
      if (typeof s.duration === 'number') state.settings.duration = s.duration;
      if (typeof s.modalMs === 'number') state.settings.modalMs = s.modalMs;
    }
  } catch {}
  try {
    const raw = localStorage.getItem('wheel_settings');
    if (raw) {
      const s = JSON.parse(raw);
      if (typeof s.rounds === 'number') state.settings.rounds = s.rounds;
      if (typeof s.duration === 'number') state.settings.duration = s.duration;
      if (typeof s.modalMs === 'number') state.settings.modalMs = s.modalMs;
    }
  } catch {}
  roundsInput.value = state.settings.rounds;
  durationInput.value = state.settings.duration;
  if (modalInput) modalInput.value = state.settings.modalMs || 2500;
}

async function loadConfig() {
  try {
    const res = await fetch('/config');
    if (res.ok) {
      const cfg = await res.json();
      state.prizes = Array.isArray(cfg.prizes) ? cfg.prizes : [];
      renderPrizeEditor();
    }
  } catch {}
}

function renderPrizeEditor() {
  if (!prizeListEl) return;
  prizeListEl.innerHTML = '';
  const list = state.prizes && Array.isArray(state.prizes) ? state.prizes : [];
  if (list.length === 0) {
    addPrizeRow({ name: '', weight: 1 });
    return;
  }
  for (const p of list) addPrizeRow(p);
}

function addPrizeRow(p = { name: '', weight: 1 }) {
  const row = document.createElement('div');
  row.className = 'config-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = '礼物名称';
  nameInput.value = String(p.name || '');
  const weightInput = document.createElement('input');
  weightInput.type = 'number';
  weightInput.min = '0';
  weightInput.step = '0.1';
  weightInput.placeholder = '权重';
  weightInput.value = String(p.weight || 0);
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn small';
  removeBtn.textContent = '删除';
  removeBtn.addEventListener('click', () => {
    row.remove();
  });
  row.appendChild(nameInput);
  row.appendChild(weightInput);
  row.appendChild(removeBtn);
  prizeListEl.appendChild(row);
}

function collectPrizesFromUI() {
  const rows = prizeListEl.querySelectorAll('.config-row');
  const out = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const name = inputs[0] ? String(inputs[0].value || '').trim() : '';
    const weight = inputs[1] ? Number(inputs[1].value) : 0;
    out.push({ name, weight: Number.isFinite(weight) ? weight : 0 });
  });
  return out;
}

async function savePrizes() {
  let list = collectPrizesFromUI()
    .map(p => ({ name: String(p.name || '').slice(0, 50), weight: Math.max(0, Number(p.weight) || 0) }))
    .filter(p => p.name);
  if (list.length === 0) {
    alert('请至少填写一个礼物名称');
    return;
  }
  if (!list.some(p => p.weight > 0)) {
    alert('至少需要一个礼物的权重大于 0');
    return;
  }
  try {
    const res = await fetch('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prizes: list })
    });
    if (res.ok) {
      state.prizes = list;
      // 保存后由服务器广播 config，其他页面同步更新
    } else {
      const err = await res.json().catch(() => ({}));
      alert('保存失败：' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('保存失败，请稍后重试');
  }
}

async function saveSettings() {
  const r = Math.max(1, Math.min(12, Math.floor(Number(roundsInput.value) || state.settings.rounds)));
  const d = Math.max(1500, Math.min(12000, Math.floor(Number(durationInput.value) || state.settings.duration)));
  const m = Math.max(500, Math.min(10000, Math.floor(Number(modalInput && modalInput.value) || (state.settings.modalMs || 2500))));
  state.settings.rounds = r;
  state.settings.duration = d;
  state.settings.modalMs = m;
  // 写入服务器持久化文件，同时保留本地回退
  try {
    await fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.settings),
    });
  } catch {}
  try { localStorage.setItem('wheel_settings', JSON.stringify(state.settings)); } catch {}
}

function renderHistory(items) {
  if (!Array.isArray(items)) return;
  historyListEl.innerHTML = '';
  for (const it of items) appendHistory(it);
}

function appendHistory({ participant, prize, time }) {
  const li = document.createElement('li');
  const t = time ? new Date(time) : new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const prizeName = typeof prize === 'string' ? prize : (prize && prize.name ? prize.name : '未知');
  li.textContent = `[${hh}:${mm}:${ss}] ${participant} 抽中：${prizeName}`;
  historyListEl.prepend(li);
}

async function loadHistory() {
  try {
    const res = await fetch('/history');
    if (res.ok) {
      const list = await res.json();
      renderHistory(list);
    }
  } catch {}
}

function connectWS() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  try {
    state.ws = new WebSocket(url);
    state.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'config') {
        const cfg = msg.payload || { prizes: [] };
        state.prizes = Array.isArray(cfg.prizes) ? cfg.prizes : [];
        renderPrizeEditor();
      } else if (msg.type === 'history') {
        renderHistory(msg.payload || []);
      } else if (msg.type === 'history_append') {
        appendHistory(msg.payload);
      } else if (msg.type === 'settings') {
        const s = msg.payload || {};
        if (typeof s.rounds === 'number') state.settings.rounds = s.rounds;
        if (typeof s.duration === 'number') state.settings.duration = s.duration;
        if (typeof s.modalMs === 'number') state.settings.modalMs = s.modalMs;
        roundsInput.value = state.settings.rounds;
        durationInput.value = state.settings.duration;
        if (modalInput) modalInput.value = state.settings.modalMs || 2500;
      }
    };
    state.ws.onclose = () => setTimeout(connectWS, 2000);
  } catch (e) {
    console.warn('WS connect failed');
  }
}

saveSettingsBtn.addEventListener('click', () => {
  saveSettings();
});

if (addPrizeBtn) {
  addPrizeBtn.addEventListener('click', () => addPrizeRow({ name: '', weight: 1 }));
}
if (savePrizesBtn) {
  savePrizesBtn.addEventListener('click', () => savePrizes());
}

async function clearHistory() {
  const ok = await openTwoStepConfirm();
  if (!ok) return;
  try {
    clearHistoryBtn && (clearHistoryBtn.disabled = true);
    const res = await fetch('/history/clear', { method: 'POST' });
    if (res.ok) {
      renderHistory([]);
    } else {
      alert('清空失败：' + res.statusText);
    }
  } catch (e) {
    alert('清空失败，请稍后重试');
  } finally {
    clearHistoryBtn && (clearHistoryBtn.disabled = false);
  }
}

function openTwoStepConfirm() {
  // 如果未能获取到弹窗元素，则回退为浏览器原生确认（保证功能可用）
  if (!confirmModal || !confirmText || !confirmYesBtn || !confirmNoBtn) {
    const c1 = window.confirm('确认清空历史记录吗？此操作不可撤销。');
    if (!c1) return Promise.resolve(false);
    const c2 = window.confirm('再次确认：确定要清空全部历史记录？');
    return Promise.resolve(!!c2);
  }
  return new Promise((resolve) => {
    let stage = 1;
    confirmText.textContent = '确认清空历史记录吗？此操作不可撤销。';
    confirmYesBtn.textContent = '确认';
    confirmModal.classList.remove('hidden');

    const onNo = () => { cleanup(); resolve(false); };
    const onYes = () => {
      if (stage === 1) {
        stage = 2;
        confirmYesBtn.textContent = '再次确认';
        confirmText.textContent = '再次确认：确定要清空全部历史记录？';
      } else {
        cleanup();
        resolve(true);
      }
    };
    function cleanup() {
      confirmModal.classList.add('hidden');
      confirmYesBtn.removeEventListener('click', onYes);
      confirmNoBtn.removeEventListener('click', onNo);
      // 复位文本以便下次使用
      confirmYesBtn.textContent = '确认';
      confirmText.textContent = '确认清空历史记录吗？此操作不可撤销。';
    }

    confirmYesBtn.addEventListener('click', onYes);
    confirmNoBtn.addEventListener('click', onNo);
  });
}

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => clearHistory());
}

if (testSpinBtn) {
  testSpinBtn.addEventListener('click', async () => {
    testSpinBtn.disabled = true;
    try {
      await fetch('/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participant: '控制页测试', count: 1 })
      });
    } catch {}
    setTimeout(() => { testSpinBtn.disabled = false; }, 800);
  });
}

(async function init() {
  await loadSettings();
  await loadConfig();
  await loadHistory();
  connectWS();
})();

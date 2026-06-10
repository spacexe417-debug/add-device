/* ══════════════════════════════════════════════════════════════
   OmniHome — app.js  (Multi-Device Edition)
   Pure JS + MQTT.js  |  No backend  |  No database
   ══════════════════════════════════════════════════════════════ */

'use strict';

/* ─── BROKER CONFIG ─────────────────────────────────────── */
const BROKER_URL  = 'wss://broker.emqx.io:8084/mqtt';
const BROKER_OPTS = () => ({
  clientId: 'omnihome_web_' + Math.random().toString(36).slice(2, 9),
  username: '',
  password: '',
  keepalive: 30,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
  clean: true,
});

/* ─── MULTI-DEVICE STATE ────────────────────────────────── */
/*
  devices: Map<deviceId, {
    id: string,
    secret: string,
    mqttClient: MqttClient | null,
    ledState: boolean | null,
    lastHeartbeat: Date | null,
    brokerStatus: 'offline'|'connecting'|'online',
    deviceStatus: 'offline'|'online',
    stats: { online, led, uptime, lastSeen, heartbeat }
    logEntries: Array<{type, msg, ts}>
  }>
*/
const devices = new Map();
let activeDeviceId = null;

/* ─── DOM REFS ──────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const screenPair       = $('screenPair');
const screenDash       = $('screenDash');
const deviceInput      = $('deviceInput');
const secretInput      = $('secretInput');
const pairBtn          = $('pairBtn');
const brokerDot        = $('brokerDot');
const brokerLabel      = $('brokerLabel');
const deviceTabBar     = $('deviceTabBar');
const addDeviceBtn     = $('addDeviceBtn');
const disconnectBtn    = $('disconnectBtn');
const dashDeviceId     = $('dashDeviceId');
const deviceDot        = $('deviceDot');
const deviceStatus     = $('deviceStatus');
const ledBulb          = $('ledBulb');
const ledStateLabel    = $('ledStateLabel');
const btnOn            = $('btnOn');
const btnOff           = $('btnOff');
const statOnline       = $('statOnline');
const statLed          = $('statLed');
const statUptime       = $('statUptime');
const statLastSeen     = $('statLastSeen');
const statHeartbeat    = $('statHeartbeat');
const qrCode           = $('qrCode');
const qrUrl            = $('qrUrl');
const copyUrlBtn       = $('copyUrlBtn');
const logBody          = $('logBody');
const clearLogBtn      = $('clearLogBtn');
const toastStack       = $('toastStack');

/* ─── STARTUP ───────────────────────────────────────────── */
(function init() {
  const params = new URLSearchParams(window.location.search);
  const urlDevice = params.get('device');
  if (urlDevice) {
    deviceInput.value = urlDevice.trim().toUpperCase();
    deviceInput.setAttribute('readonly', 'true');
    secretInput.focus();
    // If we already have devices, go straight to dash and show pair modal
    if (devices.size > 0) {
      showAddDeviceModal();
      return;
    }
    log(null, 'sys', 'Device ID loaded from URL. Enter your device secret to continue.');
  }

  pairBtn.addEventListener('click', handlePair);
  disconnectBtn.addEventListener('click', handleDisconnect);
  addDeviceBtn.addEventListener('click', showPairScreen);
  btnOn.addEventListener('click', () => sendLedCommand(activeDeviceId, 1));
  btnOff.addEventListener('click', () => sendLedCommand(activeDeviceId, 0));
  copyUrlBtn.addEventListener('click', handleCopyUrl);
  clearLogBtn.addEventListener('click', () => {
    const dev = devices.get(activeDeviceId);
    if (dev) { dev.logEntries = []; renderLog(); }
  });

  deviceInput.addEventListener('keydown', e => { if (e.key === 'Enter') secretInput.focus(); });
  secretInput.addEventListener('keydown', e => { if (e.key === 'Enter') handlePair(); });
})();

/* ─── PAIR SCREEN TOGGLE ────────────────────────────────── */
function showPairScreen() {
  deviceInput.removeAttribute('readonly');
  deviceInput.value = '';
  secretInput.value = '';
  screenDash.classList.add('hidden');
  screenPair.classList.remove('hidden');
}

/* ─── PAIRING ───────────────────────────────────────────── */
function handlePair() {
  const id  = deviceInput.value.trim().toUpperCase();
  const sec = secretInput.value.trim();

  if (!id) { toast('Enter a Device ID', 'error'); deviceInput.focus(); return; }
  if (id.length < 8) { toast('Device ID looks too short', 'error'); deviceInput.focus(); return; }
  if (!sec) { toast('Enter the Device Secret', 'error'); secretInput.focus(); return; }
  if (devices.has(id)) { toast('Device already added', 'error'); return; }

  // Create device state
  const dev = {
    id,
    secret: sec,
    mqttClient: null,
    ledState: null,
    lastHeartbeat: null,
    brokerStatus: 'offline',
    deviceStatus: 'offline',
    stats: { online: '—', led: '—', uptime: '—', lastSeen: '—', heartbeat: '—' },
    logEntries: [],
  };
  devices.set(id, dev);

  // Switch to dashboard
  screenPair.classList.add('hidden');
  screenDash.classList.remove('hidden');

  // Activate this device
  setActiveDevice(id);

  // Connect MQTT for this device
  connectMQTT(id);
}

function handleDisconnect() {
  if (!activeDeviceId) return;
  const dev = devices.get(activeDeviceId);
  if (dev && dev.mqttClient) {
    dev.mqttClient.end(true);
  }
  devices.delete(activeDeviceId);
  toast(`Device ${activeDeviceId} removed`, 'info');

  if (devices.size === 0) {
    activeDeviceId = null;
    screenDash.classList.add('hidden');
    screenPair.classList.remove('hidden');
    deviceInput.removeAttribute('readonly');
    deviceInput.value = '';
    secretInput.value = '';
    renderTabs();
  } else {
    // Switch to first remaining device
    const nextId = devices.keys().next().value;
    setActiveDevice(nextId);
    renderTabs();
  }
}

/* ─── ACTIVE DEVICE ─────────────────────────────────────── */
function setActiveDevice(id) {
  activeDeviceId = id;
  const dev = devices.get(id);
  if (!dev) return;

  // Update header
  dashDeviceId.textContent = id;

  // Render tabs
  renderTabs();

  // Render dashboard content for this device
  renderDashboard(dev);
}

/* ─── TAB BAR ───────────────────────────────────────────── */
function renderTabs() {
  // Clear existing tabs (keep the add button)
  const existing = deviceTabBar.querySelectorAll('.dev-tab');
  existing.forEach(t => t.remove());

  // Insert tabs before the add button
  devices.forEach((dev, id) => {
    const tab = document.createElement('button');
    tab.className = 'dev-tab' + (id === activeDeviceId ? ' active' : '');
    tab.dataset.deviceId = id;

    const dot = document.createElement('span');
    dot.className = 'tab-dot status-dot ' + dev.brokerStatus;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = id.length > 14 ? id.slice(0, 14) + '…' : id;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Remove device';
    close.innerHTML = '✕';
    close.addEventListener('click', e => {
      e.stopPropagation();
      removeDevice(id);
    });

    tab.appendChild(dot);
    tab.appendChild(label);
    tab.appendChild(close);
    tab.addEventListener('click', () => setActiveDevice(id));
    deviceTabBar.insertBefore(tab, addDeviceBtn);
  });
}

function removeDevice(id) {
  const dev = devices.get(id);
  if (dev && dev.mqttClient) dev.mqttClient.end(true);
  devices.delete(id);
  toast(`Device ${id} removed`, 'info');

  if (devices.size === 0) {
    activeDeviceId = null;
    screenDash.classList.add('hidden');
    screenPair.classList.remove('hidden');
    deviceInput.removeAttribute('readonly');
    deviceInput.value = '';
    secretInput.value = '';
    renderTabs();
  } else if (id === activeDeviceId) {
    const nextId = devices.keys().next().value;
    setActiveDevice(nextId);
  } else {
    renderTabs();
  }
}

/* ─── RENDER DASHBOARD FOR ACTIVE DEVICE ───────────────── */
function renderDashboard(dev) {
  // Header / broker status
  setBrokerStatus(dev.brokerStatus);
  setDeviceStatus(dev.deviceStatus);

  // LED
  setLed(dev.ledState === true);

  // Stats
  const s = dev.stats;
  statOnline.textContent  = s.online;
  statOnline.className    = 'stat-val ' + (s.online === 'Online' ? 'good' : s.online === 'Offline' ? 'bad' : '');
  statLed.textContent     = s.led;
  statLed.className       = 'stat-val ' + (s.led === 'ON' ? 'good' : s.led === 'OFF' ? 'warn' : '');
  statUptime.textContent  = s.uptime;
  statUptime.className    = 'stat-val';
  statLastSeen.textContent = s.lastSeen;
  statLastSeen.className  = 'stat-val';
  statHeartbeat.textContent = s.heartbeat;
  statHeartbeat.className = 'stat-val ' + (dev.lastHeartbeat ? 'good' : '');

  // QR
  buildQR(dev.id);

  // Log
  renderLog();
}

/* ─── MQTT ──────────────────────────────────────────────── */
function connectMQTT(deviceId) {
  const dev = devices.get(deviceId);
  if (!dev) return;

  dev.brokerStatus = 'connecting';
  if (deviceId === activeDeviceId) setBrokerStatus('connecting');
  renderTabs();

  log(deviceId, 'sys', `Connecting to ${BROKER_URL} …`);

  const client = mqtt.connect(BROKER_URL, BROKER_OPTS());
  dev.mqttClient = client;

  client.on('connect', () => {
    dev.brokerStatus = 'online';
    if (deviceId === activeDeviceId) setBrokerStatus('online');
    renderTabs();
    log(deviceId, 'sys', 'Broker connected ✓');
    if (deviceId === activeDeviceId) toast('Broker connected', 'success');
    subscribeTopics(deviceId);
  });

  client.on('reconnect', () => {
    dev.brokerStatus = 'connecting';
    if (deviceId === activeDeviceId) setBrokerStatus('connecting');
    renderTabs();
    log(deviceId, 'sys', 'Reconnecting …');
  });

  client.on('offline', () => {
    dev.brokerStatus = 'offline';
    dev.deviceStatus = 'offline';
    if (deviceId === activeDeviceId) { setBrokerStatus('offline'); setDeviceStatus('offline'); }
    renderTabs();
    log(deviceId, 'err', 'Broker offline');
  });

  client.on('error', err => {
    dev.brokerStatus = 'offline';
    if (deviceId === activeDeviceId) setBrokerStatus('offline');
    renderTabs();
    log(deviceId, 'err', 'MQTT error: ' + err.message);
    if (deviceId === activeDeviceId) toast('MQTT error: ' + err.message, 'error');
  });

  client.on('message', (topic, payload) => {
    handleMessage(deviceId, topic, payload.toString());
  });
}

function subscribeTopics(deviceId) {
  const dev = devices.get(deviceId);
  if (!dev || !dev.mqttClient) return;

  const topics = [
    `device/${deviceId}/status`,
    `device/${deviceId}/heartbeat`,
    `device/${deviceId}/info`,
  ];
  topics.forEach(t => {
    dev.mqttClient.subscribe(t, { qos: 1 }, err => {
      if (err) log(deviceId, 'err', `Subscribe failed: ${t}`);
      else     log(deviceId, 'sys', `Subscribed: ${t}`);
    });
  });
}

function handleMessage(deviceId, topic, raw) {
  log(deviceId, 'in', `[${shortTopic(topic)}] ${raw}`);

  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const type = topicType(topic);
  const dev  = devices.get(deviceId);
  if (!dev) return;

  if (type === 'status') {
    updateStatus(deviceId, data);
  } else if (type === 'heartbeat') {
    dev.lastHeartbeat = new Date();
    const hbStr = fmtTime(dev.lastHeartbeat);
    dev.stats.heartbeat = hbStr;
    if (deviceId === activeDeviceId) {
      statHeartbeat.textContent = hbStr;
      statHeartbeat.className = 'stat-val good';
    }
  } else if (type === 'info') {
    log(deviceId, 'sys', `Device info: ${JSON.stringify(data)}`);
  }
}

/* ─── STATUS UPDATE ─────────────────────────────────────── */
function updateStatus(deviceId, data) {
  const dev = devices.get(deviceId);
  if (!dev) return;
  const now = new Date();

  const online = data.online === true || data.online === 1;
  dev.deviceStatus = online ? 'online' : 'offline';
  dev.stats.online = online ? 'Online' : 'Offline';

  const ledOn = data.led === 1 || data.led === true;
  dev.ledState = ledOn;
  dev.stats.led = ledOn ? 'ON' : 'OFF';

  if (data.uptime !== undefined) dev.stats.uptime = fmtUptime(data.uptime);
  dev.stats.lastSeen = fmtTime(now);

  if (deviceId === activeDeviceId) {
    setDeviceStatus(dev.deviceStatus);
    statOnline.textContent = dev.stats.online;
    statOnline.className   = 'stat-val ' + (online ? 'good' : 'bad');
    setLed(ledOn);
    statLed.textContent = dev.stats.led;
    statLed.className   = 'stat-val ' + (ledOn ? 'good' : 'warn');
    if (data.uptime !== undefined) { statUptime.textContent = dev.stats.uptime; statUptime.className = 'stat-val'; }
    statLastSeen.textContent = dev.stats.lastSeen;
    statLastSeen.className   = 'stat-val';
  }
  renderTabs();
}

/* ─── LED COMMAND ───────────────────────────────────────── */
function sendLedCommand(deviceId, state) {
  const dev = devices.get(deviceId);
  if (!dev || !dev.mqttClient || !dev.mqttClient.connected) {
    toast('Not connected to broker', 'error');
    return;
  }

  const payload = JSON.stringify({ secret: dev.secret, action: 'led', state });
  const topic   = `device/${deviceId}/command`;

  dev.mqttClient.publish(topic, payload, { qos: 1 }, err => {
    if (err) {
      log(deviceId, 'err', 'Publish failed: ' + err.message);
      toast('Command failed', 'error');
    } else {
      log(deviceId, 'out', `[command] ${payload}`);
      toast(state ? 'LED ON command sent' : 'LED OFF command sent', 'success');
      // Optimistic UI
      dev.ledState = state === 1;
      dev.stats.led = state === 1 ? 'ON' : 'OFF';
      if (deviceId === activeDeviceId) {
        setLed(state === 1);
        statLed.textContent = dev.stats.led;
        statLed.className   = 'stat-val ' + (state === 1 ? 'good' : 'warn');
      }
    }
  });
}

/* ─── LED UI ─────────────────────────────────────────────── */
function setLed(on) {
  if (on) {
    ledBulb.classList.add('on');
    ledStateLabel.textContent = 'ON';
    ledStateLabel.classList.add('on');
  } else {
    ledBulb.classList.remove('on');
    ledStateLabel.textContent = 'OFF';
    ledStateLabel.classList.remove('on');
  }
}

/* ─── BROKER / DEVICE STATUS UI ─────────────────────────── */
function setBrokerStatus(state) {
  brokerDot.className = 'status-dot';
  if (state === 'online')      { brokerDot.classList.add('online');     brokerLabel.textContent = 'Connected'; }
  else if (state === 'connecting') { brokerDot.classList.add('connecting'); brokerLabel.textContent = 'Connecting…'; }
  else                          { brokerLabel.textContent = 'Disconnected'; }
}

function setDeviceStatus(state) {
  deviceDot.className = 'status-dot';
  if (state === 'online')      { deviceDot.classList.add('online');     deviceStatus.textContent = 'Online'; }
  else if (state === 'connecting') { deviceDot.classList.add('connecting'); deviceStatus.textContent = 'Waiting…'; }
  else                          { deviceStatus.textContent = 'Offline'; }
}

/* ─── QR CODE ───────────────────────────────────────────── */
function buildQR(deviceId) {
  qrCode.innerHTML = '';
  const url = `${location.origin}${location.pathname}?device=${deviceId}`;
  qrUrl.textContent = url;
  new QRCode(qrCode, {
    text: url, width: 148, height: 148,
    colorDark: '#000000', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function handleCopyUrl() {
  const url = `${location.origin}${location.pathname}?device=${activeDeviceId}`;
  navigator.clipboard.writeText(url)
    .then(() => toast('Link copied!', 'success'))
    .catch(() => toast('Copy failed — use the URL above', 'error'));
}

/* ─── LOG ────────────────────────────────────────────────── */
function log(deviceId, type, msg) {
  const entry = { type, msg, ts: new Date() };

  if (deviceId) {
    const dev = devices.get(deviceId);
    if (dev) {
      dev.logEntries.push(entry);
      if (dev.logEntries.length > 120) dev.logEntries.shift();
    }
  }

  if (deviceId === activeDeviceId || deviceId === null) {
    appendLogEntry(entry);
  }
}

function appendLogEntry(entry) {
  const empty = logBody.querySelector('.log-empty');
  if (empty) empty.remove();

  const el   = document.createElement('div');
  el.className = `log-entry ${entry.type}`;
  const ts   = entry.ts.toTimeString().slice(0, 8);
  const dirs = { in: '↓IN ', out: '↑OUT', sys: 'SYS ', err: 'ERR ' };
  el.innerHTML =
    `<span class="log-time">${ts}</span>` +
    `<span class="log-dir ${entry.type}">${dirs[entry.type] || entry.type.toUpperCase()}</span>` +
    `<span class="log-msg">${escHtml(entry.msg)}</span>`;

  logBody.appendChild(el);
  logBody.scrollTop = logBody.scrollHeight;
  while (logBody.children.length > 120) logBody.removeChild(logBody.firstChild);
}

function renderLog() {
  logBody.innerHTML = '';
  const dev = activeDeviceId ? devices.get(activeDeviceId) : null;
  if (!dev || dev.logEntries.length === 0) {
    logBody.innerHTML = '<div class="log-empty">No messages yet…</div>';
    return;
  }
  dev.logEntries.forEach(e => appendLogEntry(e));
}

/* ─── TOAST ──────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, 2800);
}

/* ─── HELPERS ────────────────────────────────────────────── */
function topicType(topic)  { const p = topic.split('/'); return p[p.length - 1]; }
function shortTopic(topic) { const p = topic.split('/'); return p.slice(-2).join('/'); }

function fmtUptime(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
function fmtTime(date) { return date.toTimeString().slice(0, 8); }
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ─── MODAL ADD-DEVICE (QR URL auto-fill when already on dash) ─ */
function showAddDeviceModal() {
  // Already on dashboard, just show the pair screen with pre-filled ID
  screenDash.classList.add('hidden');
  screenPair.classList.remove('hidden');
}

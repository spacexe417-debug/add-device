/* ══════════════════════════════════════════════════════════════
   OmniHome — app.js
   Pure JS + MQTT.js  |  No backend  |  No database
   ══════════════════════════════════════════════════════════════ */

'use strict';

/* ─── BROKER CONFIG ─────────────────────────────────────── */
// Using ws:// port 8083 (plain WebSocket) to match ESP32's plain
// TCP port 1883. Both are unencrypted — same broker, different
// transport. Use wss://broker.emqx.io:8084 only if ESP32 uses 8883.
const BROKER_URL  = 'ws://broker.emqx.io:8083/mqtt';
const BROKER_OPTS = {
  clientId: 'omnihome_web_' + Math.random().toString(36).slice(2, 9),
  username: '',          // leave blank for public broker
  password: '',          // leave blank for public broker
  keepalive: 30,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
  clean: true,
  protocolVersion: 4,    // MQTT 3.1.1
};

/* ─── APP STATE ─────────────────────────────────────────── */
let mqttClient   = null;
let deviceId     = '';
let deviceSecret = '';
let ledState     = null;    // true = ON, false = OFF
let lastHeartbeat = null;

/* ─── DOM REFS ──────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const screenPair       = $('screenPair');
const screenDash       = $('screenDash');

const deviceInput      = $('deviceInput');
const secretInput      = $('secretInput');
const pairBtn          = $('pairBtn');

const brokerDot        = $('brokerDot');
const brokerLabel      = $('brokerLabel');

const dashDeviceId     = $('dashDeviceId');
const deviceDot        = $('deviceDot');
const deviceStatus     = $('deviceStatus');
const disconnectBtn    = $('disconnectBtn');

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
  // Check for ?device= in URL (QR code auto-pair)
  const params = new URLSearchParams(window.location.search);
  const urlDevice = params.get('device');
  if (urlDevice) {
    deviceInput.value = urlDevice.trim().toUpperCase();
    deviceInput.setAttribute('readonly', 'true');
    secretInput.focus();
    log('sys', 'Device ID loaded from URL. Enter your device secret to continue.');
  }

  pairBtn.addEventListener('click', handlePair);
  disconnectBtn.addEventListener('click', handleDisconnect);
  btnOn.addEventListener('click', () => sendLedCommand(1));
  btnOff.addEventListener('click', () => sendLedCommand(0));
  copyUrlBtn.addEventListener('click', handleCopyUrl);
  clearLogBtn.addEventListener('click', clearLog);

  deviceInput.addEventListener('keydown', e => { if (e.key === 'Enter') secretInput.focus(); });
  secretInput.addEventListener('keydown', e => { if (e.key === 'Enter') handlePair(); });
})();

/* ─── PAIRING ───────────────────────────────────────────── */
function handlePair() {
  const id  = deviceInput.value.trim().toUpperCase();
  const sec = secretInput.value.trim();

  if (!id) {
    toast('Enter a Device ID', 'error');
    deviceInput.focus();
    return;
  }
  if (id.length < 8) {
    toast('Device ID looks too short', 'error');
    deviceInput.focus();
    return;
  }
  if (!sec) {
    toast('Enter the Device Secret', 'error');
    secretInput.focus();
    return;
  }

  deviceId     = id;
  deviceSecret = sec;

  // Switch to dashboard
  screenPair.classList.add('hidden');
  screenDash.classList.remove('hidden');

  dashDeviceId.textContent = deviceId;

  // Generate QR code
  buildQR();

  // Connect MQTT
  connectMQTT();
}

function handleDisconnect() {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
  deviceId = '';
  deviceSecret = '';
  ledState = null;
  lastHeartbeat = null;
  qrCode.innerHTML = '';

  screenDash.classList.add('hidden');
  screenPair.classList.remove('hidden');
  deviceInput.removeAttribute('readonly');
  deviceInput.value = '';
  secretInput.value = '';

  setBrokerStatus('offline');
  setDeviceStatus('offline');
  clearLog();
  toast('Disconnected', 'info');
}

/* ─── MQTT ──────────────────────────────────────────────── */
function connectMQTT() {
  setBrokerStatus('connecting');
  log('sys', `Connecting to ${BROKER_URL} …`);

  mqttClient = mqtt.connect(BROKER_URL, BROKER_OPTS);

  mqttClient.on('connect', () => {
    setBrokerStatus('online');
    log('sys', 'Broker connected ✓');
    toast('Broker connected', 'success');
    subscribeTopics();
  });

  mqttClient.on('reconnect', () => {
    setBrokerStatus('connecting');
    log('sys', 'Reconnecting …');
  });

  mqttClient.on('offline', () => {
    setBrokerStatus('offline');
    setDeviceStatus('offline');
    log('err', 'Broker offline');
  });

  mqttClient.on('error', err => {
    setBrokerStatus('offline');
    log('err', 'MQTT error: ' + err.message);
    toast('MQTT error: ' + err.message, 'error');
  });

  mqttClient.on('message', (topic, payload) => {
    handleMessage(topic, payload.toString());
  });
}

function subscribeTopics() {
  const topics = [
    `device/${deviceId}/status`,
    `device/${deviceId}/heartbeat`,
    `device/${deviceId}/info`,
  ];
  topics.forEach(t => {
    mqttClient.subscribe(t, { qos: 1 }, (err) => {
      if (err) {
        log('err', `Subscribe failed: ${t}`);
      } else {
        log('sys', `Subscribed: ${t}`);
      }
    });
  });
}

function handleMessage(topic, raw) {
  log('in', `[${shortTopic(topic)}] ${raw}`);

  let data;
  try { data = JSON.parse(raw); } catch { return; }

  const type = topicType(topic);

  if (type === 'status') {
    updateStatus(data);
  } else if (type === 'heartbeat') {
    lastHeartbeat = new Date();
    statHeartbeat.textContent = fmtTime(lastHeartbeat);
    statHeartbeat.className = 'stat-val good';
  } else if (type === 'info') {
    log('sys', `Device info: ${JSON.stringify(data)}`);
  }
}

/* ─── STATUS UPDATE ─────────────────────────────────────── */
function updateStatus(data) {
  const now = new Date();

  // Online
  const online = data.online === true || data.online === 1;
  setDeviceStatus(online ? 'online' : 'offline');
  statOnline.textContent = online ? 'Online' : 'Offline';
  statOnline.className   = 'stat-val ' + (online ? 'good' : 'bad');

  // LED
  const ledOn = data.led === 1 || data.led === true;
  setLed(ledOn);
  statLed.textContent = ledOn ? 'ON' : 'OFF';
  statLed.className   = 'stat-val ' + (ledOn ? 'good' : 'warn');

  // Uptime
  if (data.uptime !== undefined) {
    statUptime.textContent = fmtUptime(data.uptime);
    statUptime.className   = 'stat-val';
  }

  // Last seen
  statLastSeen.textContent = fmtTime(now);
  statLastSeen.className   = 'stat-val';
}

/* ─── LED COMMAND ───────────────────────────────────────── */
function sendLedCommand(state) {
  if (!mqttClient || !mqttClient.connected) {
    toast('Not connected to broker', 'error');
    return;
  }

  const payload = JSON.stringify({
    secret: deviceSecret,
    action: 'led',
    state:  state,
  });

  const topic = `device/${deviceId}/command`;
  mqttClient.publish(topic, payload, { qos: 1 }, err => {
    if (err) {
      log('err', 'Publish failed: ' + err.message);
      toast('Command failed', 'error');
    } else {
      log('out', `[command] ${payload}`);
      toast(state ? 'LED ON command sent' : 'LED OFF command sent', 'success');
      // Optimistic UI update
      setLed(state === 1);
    }
  });
}

/* ─── LED UI ─────────────────────────────────────────────── */
function setLed(on) {
  ledState = on;
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
  if (state === 'online') {
    brokerDot.classList.add('online');
    brokerLabel.textContent = 'Connected';
  } else if (state === 'connecting') {
    brokerDot.classList.add('connecting');
    brokerLabel.textContent = 'Connecting…';
  } else {
    brokerLabel.textContent = 'Disconnected';
  }
}

function setDeviceStatus(state) {
  deviceDot.className = 'status-dot';
  if (state === 'online') {
    deviceDot.classList.add('online');
    deviceStatus.textContent = 'Online';
  } else if (state === 'connecting') {
    deviceDot.classList.add('connecting');
    deviceStatus.textContent = 'Waiting…';
  } else {
    deviceStatus.textContent = 'Offline';
  }
}

/* ─── QR CODE ───────────────────────────────────────────── */
function buildQR() {
  qrCode.innerHTML = '';
  const url = `${location.origin}${location.pathname}?device=${deviceId}`;
  qrUrl.textContent = url;

  new QRCode(qrCode, {
    text:          url,
    width:         148,
    height:        148,
    colorDark:     '#000000',
    colorLight:    '#ffffff',
    correctLevel:  QRCode.CorrectLevel.M,
  });
}

function handleCopyUrl() {
  const url = `${location.origin}${location.pathname}?device=${deviceId}`;
  navigator.clipboard.writeText(url).then(() => {
    toast('Link copied!', 'success');
  }).catch(() => {
    toast('Copy failed — use the URL above', 'error');
  });
}

/* ─── LOG ────────────────────────────────────────────────── */
function log(type, msg) {
  const empty = logBody.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;

  const now = new Date();
  const ts  = now.toTimeString().slice(0, 8);

  const dirLabels = { in: '↓IN ', out: '↑OUT', sys: 'SYS ', err: 'ERR ' };
  entry.innerHTML =
    `<span class="log-time">${ts}</span>` +
    `<span class="log-dir ${type}">${dirLabels[type] || type.toUpperCase()}</span>` +
    `<span class="log-msg">${escHtml(msg)}</span>`;

  logBody.appendChild(entry);
  logBody.scrollTop = logBody.scrollHeight;

  // Keep max 120 entries
  while (logBody.children.length > 120) {
    logBody.removeChild(logBody.firstChild);
  }
}

function clearLog() {
  logBody.innerHTML = '<div class="log-empty">No messages yet…</div>';
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
function topicType(topic) {
  const parts = topic.split('/');
  return parts[parts.length - 1];
}

function shortTopic(topic) {
  const parts = topic.split('/');
  return parts.slice(-2).join('/');
}

function fmtUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtTime(date) {
  return date.toTimeString().slice(0, 8);
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

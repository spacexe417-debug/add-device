/* ══════════════════════════════════════════════════════════════
   Ellectra — app.js  (Firebase Auth + Multi-Device MQTT)
   Pure JS + MQTT.js + Firebase SDK  |  No backend required
   ══════════════════════════════════════════════════════════════ */

'use strict';

/* ─── BROKER CONFIG ─────────────────────────────────────── */
const BROKER_URL  = 'wss://broker.emqx.io:8084/mqtt';
const BROKER_OPTS = () => ({
  clientId: 'ellectra_web_' + Math.random().toString(36).slice(2, 9),
  username: '',
  password: '',
  keepalive: 30,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
  clean: true,
});

/* ─── STATE ─────────────────────────────────────────────── */
/*
  devices: Map<deviceId, {
    id, secret, nickname,
    mqttClient, ledState, lastHeartbeat,
    brokerStatus, deviceStatus,
    stats: { online, led, uptime, lastSeen, heartbeat },
    logEntries: []
  }>
*/
const devices = new Map();
let activeDeviceId = null;
let currentUser    = null;
let firestoreUnsub = null;   // Firestore snapshot unsubscribe
let qrScanner      = null;
let scannerBusy    = false;

/* ─── DOM REFS ──────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const screenAuth        = $('screenAuth');
const appShell          = $('appShell');
const googleSignInBtn   = $('googleSignInBtn');
const signOutBtn        = $('signOutBtn');
const userAvatar        = $('userAvatar');
const userName          = $('userName');
const screenPair        = $('screenPair');
const screenDash        = $('screenDash');
const deviceNickname    = $('deviceNickname');
const pairBtn           = $('pairBtn');
const scannerModal      = $('scannerModal');
const closeScannerBtn   = $('closeScannerBtn');
const qrReader          = $('qrReader');
const scannerNote       = $('scannerNote');
const brokerDot         = $('brokerDot');
const brokerLabel       = $('brokerLabel');
const deviceList        = $('deviceList');
const addDeviceBtn      = $('addDeviceBtn');
const noDeviceSelected  = $('noDeviceSelected');
const activeDevicePanel = $('activeDevicePanel');
const disconnectBtn     = $('disconnectBtn');
const dashDeviceId      = $('dashDeviceId');
const dashDeviceNick    = $('dashDeviceNick');
const deviceDot         = $('deviceDot');
const deviceStatus      = $('deviceStatus');
const ledBulb           = $('ledBulb');
const ledStateLabel     = $('ledStateLabel');
const btnOn             = $('btnOn');
const btnOff            = $('btnOff');
const statOnline        = $('statOnline');
const statLed           = $('statLed');
const statUptime        = $('statUptime');
const statLastSeen      = $('statLastSeen');
const statHeartbeat     = $('statHeartbeat');
const qrCode            = $('qrCode');
const qrUrl             = $('qrUrl');
const copyUrlBtn        = $('copyUrlBtn');
const logBody           = $('logBody');
const clearLogBtn       = $('clearLogBtn');
const toastStack        = $('toastStack');

/* ─── WAIT FOR FIREBASE ─────────────────────────────────── */
function waitForFirebase() {
  return new Promise(resolve => {
    const check = () => window._firebase ? resolve(window._firebase) : setTimeout(check, 50);
    check();
  });
}

/* ─── BOOT ──────────────────────────────────────────────── */
(async function boot() {
  const fb = await waitForFirebase();

  // Auth state listener
  fb.onAuthStateChanged(fb.auth, user => {
    if (user) {
      currentUser = user;
      showApp(user);
    } else {
      currentUser = null;
      showAuthScreen();
    }
  });

  // Google Sign-In
  googleSignInBtn.addEventListener('click', async () => {
    const provider = new fb.GoogleAuthProvider();
    try {
      await fb.signInWithPopup(fb.auth, provider);
    } catch (e) {
      toast('Sign-in failed: ' + e.message, 'error');
    }
  });

  // Sign-Out
  signOutBtn.addEventListener('click', async () => {
    disconnectAllDevices();
    if (firestoreUnsub) firestoreUnsub();
    await fb.signOut(fb.auth);
  });

  // Other UI listeners
  pairBtn.addEventListener('click', startQrScanner);
  closeScannerBtn.addEventListener('click', stopQrScanner);
  disconnectBtn.addEventListener('click', handleDisconnect);
  addDeviceBtn.addEventListener('click', showPairScreen);
  btnOn.addEventListener('click', () => sendLedCommand(activeDeviceId, 1));
  btnOff.addEventListener('click', () => sendLedCommand(activeDeviceId, 0));
  copyUrlBtn.addEventListener('click', handleCopyUrl);
  clearLogBtn.addEventListener('click', () => {
    const dev = devices.get(activeDeviceId);
    if (dev) { dev.logEntries = []; renderLog(); }
  });
  deviceNickname.addEventListener('keydown', e => { if (e.key === 'Enter') startQrScanner(); });
})();

/* ─── AUTH SCREENS ──────────────────────────────────────── */
function showAuthScreen() {
  screenAuth.classList.remove('hidden');
  appShell.classList.add('hidden');
  stopQrScanner();
  // Disconnect everything if previously connected
  disconnectAllDevices();
  devices.clear();
  activeDeviceId = null;
  if (firestoreUnsub) { firestoreUnsub(); firestoreUnsub = null; }
}

async function showApp(user) {
  screenAuth.classList.add('hidden');
  appShell.classList.remove('hidden');

  userAvatar.src = user.photoURL || '';
  userAvatar.style.display = user.photoURL ? 'block' : 'none';
  userName.textContent = user.displayName || user.email || '';

  // Always show Add Device page after login
  screenDash.classList.add('hidden');
  screenPair.classList.remove('hidden');

  await loadDevicesFromFirestore(user.uid);
}

/* ─── FIRESTORE DEVICE PERSISTENCE ─────────────────────── */
async function loadDevicesFromFirestore(uid) {
  const fb = window._firebase;
  const devicesRef = fb.collection(fb.db, 'users', uid, 'devices');

  // Live listener for realtime sync
  if (firestoreUnsub) firestoreUnsub();
  firestoreUnsub = fb.onSnapshot(devicesRef, snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added' && !devices.has(change.doc.id)) {
        const data = change.doc.data();
        addDeviceFromSaved({ id: change.doc.id, secret: data.secret, nickname: data.nickname || '' });
      }
      if (change.type === 'removed' && devices.has(change.doc.id)) {
        // Removed from another tab/session
        const dev = devices.get(change.doc.id);
        if (dev && dev.mqttClient) dev.mqttClient.end(true);
        devices.delete(change.doc.id);
        if (change.doc.id === activeDeviceId) {
          activeDeviceId = null;
          updateActivePanel();
        }
        renderDeviceList();
      }
    });
    renderDeviceList();
  });
}

async function saveDeviceToFirestore(dev) {
  if (!currentUser) return;
  const fb = window._firebase;
  try {
    await fb.setDoc(fb.doc(fb.db, 'users', currentUser.uid, 'devices', dev.id), {
      secret: dev.secret,
      nickname: dev.nickname || '',
      addedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Firestore save error:', e);
  }
}

async function deleteDeviceFromFirestore(deviceId) {
  if (!currentUser) return;
  const fb = window._firebase;
  try {
    await fb.deleteDoc(fb.doc(fb.db, 'users', currentUser.uid, 'devices', deviceId));
  } catch (e) {
    console.error('Firestore delete error:', e);
  }
}

/* ─── ADD DEVICE FROM SAVED DATA (no MQTT yet) ─────────── */
function addDeviceFromSaved({ id, secret, nickname }) {
  if (devices.has(id)) return;
  const dev = makeDeviceState(id, secret, nickname);
  devices.set(id, dev);
  connectMQTT(id);
}

function makeDeviceState(id, secret, nickname) {
  return {
    id, secret, nickname: nickname || '',
    mqttClient: null,
    ledState: null,
    lastHeartbeat: null,
    brokerStatus: 'offline',
    deviceStatus: 'offline',
    stats: { online: '—', led: '—', uptime: '—', lastSeen: '—', heartbeat: '—' },
    logEntries: [],
  };
}

/* ─── PAIR SCREEN ───────────────────────────────────────── */
function showPairScreen() {
  deviceNickname.value = '';
  screenDash.classList.add('hidden');
  screenPair.classList.remove('hidden');
}

/* ─── PAIRING ───────────────────────────────────────────── */
async function startQrScanner() {
  if (!currentUser) {
    toast('Sign in before pairing a device', 'error');
    return;
  }
  if (typeof Html5Qrcode === 'undefined') {
    toast('QR scanner library failed to load', 'error');
    return;
  }

  scannerBusy = false;
  scannerModal.classList.remove('hidden');
  scannerModal.setAttribute('aria-hidden', 'false');
  scannerNote.textContent = 'Allow camera access, then point the camera at the device QR code.';

  if (!qrScanner) qrScanner = new Html5Qrcode('qrReader');

  try {
    await qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: qrboxSize },
      onQrDecoded,
      () => {}
    );
  } catch (e) {
    scannerNote.textContent = 'Camera could not be opened. Check browser camera permission and try again.';
    toast('Camera could not be opened', 'error');
  }
}

async function stopQrScanner() {
  scannerBusy = false;
  if (qrScanner && qrScanner.isScanning) {
    try {
      await qrScanner.stop();
      await qrScanner.clear();
    } catch (e) {
      console.warn('QR scanner stop error:', e);
    }
  }
  scannerModal.classList.add('hidden');
  scannerModal.setAttribute('aria-hidden', 'true');
}

function qrboxSize(viewfinderWidth, viewfinderHeight) {
  const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.72);
  const size = Math.max(180, Math.min(edge, 280));
  return { width: size, height: size };
}

async function onQrDecoded(decodedText) {
  if (scannerBusy) return;
  scannerBusy = true;
  scannerNote.textContent = 'QR detected. Linking device...';

  let payload;
  try {
    payload = parseDeviceQrPayload(decodedText);
  } catch (e) {
    scannerBusy = false;
    scannerNote.textContent = e.message;
    toast(e.message, 'error');
    return;
  }

  await stopQrScanner();
  await pairScannedDevice(payload);
}

function parseDeviceQrPayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('Invalid QR code. Expected device JSON.');
  }

  const deviceId = String(data.deviceId || '').trim().toUpperCase();
  const secret = String(data.secret || '').trim();

  if (!deviceId) throw new Error('QR code missing deviceId.');
  if (!secret) throw new Error('QR code missing secret.');
  if (deviceId.length < 8) throw new Error('Device ID too short.');

  return { deviceId, secret };
}

async function pairScannedDevice({ deviceId, secret }) {
  if (!currentUser) return;
  if (devices.has(deviceId)) {
    toast('Device already added.', 'error');
    return;
  }

  const fb = window._firebase;
  const nick = deviceNickname.value.trim();
  const deviceRef = fb.doc(fb.db, 'devices', deviceId);
  const userDeviceRef = fb.doc(fb.db, 'users', currentUser.uid, 'devices', deviceId);

  try {
    await fb.runTransaction(fb.db, async transaction => {
      const userDeviceSnap = await transaction.get(userDeviceRef);
      if (userDeviceSnap.exists()) {
        throw new Error('Device already added.');
      }

      const deviceSnap = await transaction.get(deviceRef);
      if (deviceSnap.exists()) {
        const ownerUid = deviceSnap.data().ownerUid;
        if (ownerUid && ownerUid !== currentUser.uid) {
          throw new Error('Device already linked to another account.');
        }
      }

      transaction.set(deviceRef, {
        ownerUid: currentUser.uid,
        paired: true,
        pairedAt: fb.serverTimestamp(),
      }, { merge: true });

      transaction.set(userDeviceRef, {
        secret,
        nickname: nick,
        addedAt: fb.serverTimestamp(),
      });
    });

    if (!devices.has(deviceId)) {
      addDeviceFromSaved({ id: deviceId, secret, nickname: nick });
    }

    screenPair.classList.add('hidden');
    screenDash.classList.remove('hidden');
    renderDeviceList();
    setActiveDevice(deviceId);

    toast(`Device ${nick || deviceId} added`, 'success');
  } catch (e) {
    const message = e && e.message ? e.message : 'Device pairing failed.';
    toast(message, 'error');
  }
}

/* ─── DISCONNECT / REMOVE ───────────────────────────────── */
function handleDisconnect() {
  if (activeDeviceId) removeDevice(activeDeviceId);
}

async function removeDevice(id) {
  const dev = devices.get(id);
  if (dev && dev.mqttClient) dev.mqttClient.end(true);
  devices.delete(id);

  await deleteDeviceFromFirestore(id);
  toast(`Device ${id} removed`, 'info');

  if (devices.size === 0) {
    activeDeviceId = null;
    screenDash.classList.add('hidden');
    screenPair.classList.remove('hidden');
    renderDeviceList();
  } else {
    if (id === activeDeviceId) {
      const nextId = devices.keys().next().value;
      setActiveDevice(nextId);
    } else {
      renderDeviceList();
    }
  }
}

function disconnectAllDevices() {
  devices.forEach(dev => {
    if (dev.mqttClient) dev.mqttClient.end(true);
  });
}

/* ─── ACTIVE DEVICE ─────────────────────────────────────── */
function setActiveDevice(id) {
  activeDeviceId = id;
  const dev = devices.get(id);
  if (!dev) { updateActivePanel(); return; }

  dashDeviceId.textContent   = id;
  dashDeviceNick.textContent = dev.nickname || '';

  renderDeviceList();
  updateActivePanel();
  renderDashboard(dev);
}

function updateActivePanel() {
  if (!activeDeviceId || !devices.has(activeDeviceId)) {
    noDeviceSelected.classList.remove('hidden');
    activeDevicePanel.classList.add('hidden');
  } else {
    noDeviceSelected.classList.add('hidden');
    activeDevicePanel.classList.remove('hidden');
  }
}

/* ─── DEVICE LIST (sidebar) ─────────────────────────────── */
function renderDeviceList() {
  deviceList.innerHTML = '';

  if (devices.size === 0) {
    deviceList.innerHTML = '<p style="font-size:0.75rem;color:var(--text-3);text-align:center;padding:1rem 0;">No devices yet</p>';
    return;
  }

  devices.forEach((dev, id) => {
    const item = document.createElement('div');
    item.className = 'dev-item' + (id === activeDeviceId ? ' active' : '');
    item.dataset.deviceId = id;

    const dot = document.createElement('span');
    dot.className = 'dev-item-dot status-dot ' + dev.brokerStatus;

    const info = document.createElement('div');
    info.className = 'dev-item-info';

    const nick = document.createElement('div');
    nick.className = 'dev-item-nick';
    nick.textContent = dev.nickname || ('Device ' + id.slice(-4));

    const idEl = document.createElement('div');
    idEl.className = 'dev-item-id';
    idEl.textContent = id.length > 16 ? id.slice(0, 16) + '…' : id;

    info.appendChild(nick);
    info.appendChild(idEl);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'dev-item-remove';
    removeBtn.title = 'Remove device';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeDevice(id);
    });

    item.appendChild(dot);
    item.appendChild(info);
    item.appendChild(removeBtn);
    item.addEventListener('click', () => setActiveDevice(id));

    deviceList.appendChild(item);
  });
}

/* ─── RENDER DASHBOARD FOR ACTIVE DEVICE ───────────────── */
function renderDashboard(dev) {
  setBrokerStatus(dev.brokerStatus);
  setDeviceStatus(dev.deviceStatus);
  setLed(dev.ledState === true);

  const s = dev.stats;
  statOnline.textContent   = s.online;
  statOnline.className     = 'stat-val ' + (s.online === 'Online' ? 'good' : s.online === 'Offline' ? 'bad' : '');
  statLed.textContent      = s.led;
  statLed.className        = 'stat-val ' + (s.led === 'ON' ? 'good' : s.led === 'OFF' ? 'warn' : '');
  statUptime.textContent   = s.uptime;
  statUptime.className     = 'stat-val';
  statLastSeen.textContent = s.lastSeen;
  statLastSeen.className   = 'stat-val';
  statHeartbeat.textContent = s.heartbeat;
  statHeartbeat.className  = 'stat-val ' + (dev.lastHeartbeat ? 'good' : '');

  buildQR(dev);
  renderLog();
}

/* ─── MQTT ──────────────────────────────────────────────── */
function connectMQTT(deviceId) {
  const dev = devices.get(deviceId);
  if (!dev) return;
  if (dev.mqttClient) dev.mqttClient.end(true);

  dev.brokerStatus = 'connecting';
  if (deviceId === activeDeviceId) setBrokerStatus('connecting');
  renderDeviceList();

  log(deviceId, 'sys', `Connecting to broker…`);

  const client = mqtt.connect(BROKER_URL, BROKER_OPTS());
  dev.mqttClient = client;

  client.on('connect', () => {
    dev.brokerStatus = 'online';
    if (deviceId === activeDeviceId) setBrokerStatus('online');
    renderDeviceList();
    log(deviceId, 'sys', 'Broker connected ✓');
    if (deviceId === activeDeviceId) toast('Broker connected', 'success');
    subscribeTopics(deviceId);
  });

  client.on('reconnect', () => {
    dev.brokerStatus = 'connecting';
    if (deviceId === activeDeviceId) setBrokerStatus('connecting');
    renderDeviceList();
    log(deviceId, 'sys', 'Reconnecting…');
  });

  client.on('offline', () => {
    dev.brokerStatus = 'offline';
    dev.deviceStatus = 'offline';
    if (deviceId === activeDeviceId) { setBrokerStatus('offline'); setDeviceStatus('offline'); }
    renderDeviceList();
    log(deviceId, 'err', 'Broker offline');
  });

  client.on('error', err => {
    dev.brokerStatus = 'offline';
    if (deviceId === activeDeviceId) setBrokerStatus('offline');
    renderDeviceList();
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
  dev.deviceStatus  = online ? 'online' : 'offline';
  dev.stats.online  = online ? 'Online' : 'Offline';

  const ledOn = data.led === 1 || data.led === true;
  dev.ledState     = ledOn;
  dev.stats.led    = ledOn ? 'ON' : 'OFF';

  if (data.uptime !== undefined) dev.stats.uptime = fmtUptime(data.uptime);
  dev.stats.lastSeen = fmtTime(now);

  if (deviceId === activeDeviceId) {
    setDeviceStatus(dev.deviceStatus);
    statOnline.textContent = dev.stats.online;
    statOnline.className   = 'stat-val ' + (online ? 'good' : 'bad');
    setLed(ledOn);
    statLed.textContent = dev.stats.led;
    statLed.className   = 'stat-val ' + (ledOn ? 'good' : 'warn');
    if (data.uptime !== undefined) { statUptime.textContent = dev.stats.uptime; }
    statLastSeen.textContent = dev.stats.lastSeen;
  }
  renderDeviceList();
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
      dev.ledState   = state === 1;
      dev.stats.led  = state === 1 ? 'ON' : 'OFF';
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

/* ─── STATUS UI ──────────────────────────────────────────── */
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
function buildQR(dev) {
  qrCode.innerHTML = '';
  const payload = JSON.stringify({ deviceId: dev.id, secret: dev.secret });
  qrUrl.textContent = payload;
  new QRCode(qrCode, {
    text: payload, width: 148, height: 148,
    colorDark: '#000000', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M,
  });
}
function handleCopyUrl() {
  const dev = activeDeviceId ? devices.get(activeDeviceId) : null;
  if (!dev) return;
  const payload = JSON.stringify({ deviceId: dev.id, secret: dev.secret });
  navigator.clipboard.writeText(payload)
    .then(() => toast('QR payload copied!', 'success'))
    .catch(() => toast('Copy failed', 'error'));
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
  if (deviceId === activeDeviceId || deviceId === null) appendLogEntry(entry);
}

function appendLogEntry(entry) {
  const empty = logBody.querySelector('.log-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
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

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5200';

// userData 경로를 명시적으로 분리
// prod: ~/Library/Application Support/StretchWidget/
// dev:  ~/Library/Application Support/stretching-alarm-dev/
if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'stretching-alarm-dev'));
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'StretchWidget'));
}

let tray = null;
let settingsWindow = null;

// --- Single instance guard (production only — dev restarts release the lock slowly) ---
if (!isDev && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
  }
});

// --- Icon paths ---
// dev: public/  |  prod: extraResources → resources/icons/ (outside ASAR, readable by nativeImage)
const _iconDir = isDev
  ? path.join(__dirname, '../public')
  : path.join(process.resourcesPath, 'icons');
const ICON_16  = path.join(_iconDir, isDev ? 'icon-16-dev.png' : 'icon-16.png');
const ICON_256 = path.join(_iconDir, 'icon-256.png');

// --- Toast window dimensions ---
const TOAST_W      = 360;
const TOAST_MARGIN = 16;

// 테스트용 고정값 — 프로덕션에서는 config.intervalMinutes 로 교체
const ALARM_INTERVAL_MS = 30 * 1000;

// --- User config (userData/config.json 에 저장) ---
const DEFAULT_CONFIG = {
  activeDays:          [1, 2, 3, 4, 5],
  startHour:           9,
  endHour:             18,
  intervalMinutes:     60,
  alarmX:              null,
  alarmY:              null,
  userId:              null,
  nickname:            null,
  groups:              [], // [{ groupCode, groupName }]
  pendingLogs:         [],
  todayLogs:           [], // 오늘 로컬 완료 기록 (타임스탬프 표시용, 자정 리셋)
  pendingInteractions: [], // 팝업 응답/무응답 로그 (대시보드 열 때 Firestore로 flush)
  dailyGoal:           8,
  dailyCount:          0,
  lastDateStr:         '',
  supplementsEnabled:  false,
  supplements:         [], // [{ id, name, time: "HH:MM" }]
  supplementLogs:      [], // 오늘 복용 기록 [{ id, takenAt }], 자정 리셋
};

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const raw = readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf-8');
    const saved = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...saved };
    // 구버전 단일 그룹 포맷 마이그레이션
    if (saved.groupCode && !saved.groups?.length) {
      merged.groups = [{ groupCode: saved.groupCode, groupName: saved.groupName || '' }];
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(updates) {
  config = { ...config, ...updates };
  try {
    writeFileSync(
      path.join(app.getPath('userData'), 'config.json'),
      JSON.stringify(config, null, 2),
    );
  } catch (e) {
    console.error('[Config] 저장 실패:', e.message);
  }
}

// --- Active hours ---
function isInActiveHours(now = new Date()) {
  const totalMin = now.getHours() * 60 + now.getMinutes();
  return (
    config.activeDays.includes(now.getDay()) &&
    totalMin >= config.startHour * 60 &&
    totalMin <  config.endHour   * 60
  );
}

// 다음 가동 시작까지 남은 밀리초 계산
function msUntilNextActiveStart(from = new Date()) {
  for (let i = 0; i <= 7; i++) {
    const t = new Date(from);
    t.setDate(t.getDate() + i);
    t.setHours(config.startHour, 0, 0, 0);
    if (config.activeDays.includes(t.getDay()) && t > from) return t - from;
  }
  return 24 * 60 * 60 * 1000; // fallback
}

// --- Alarm state ---
let alarmWindow  = null;
let alarmTimer   = null;
let supplementWindow  = null;
let supplementTimers  = {}; // { supId: timeoutId }
let nextAlarmAt  = null; // 다음 알람 예정 시각 (ms), 렌더러에 전달
let dndUntil     = null;
let dailyCount   = 0;
let lastDateStr  = '';
const GUIDE_COUNT = 10;
let actionTaken  = false; // 현재 알람에 버튼 클릭 여부 (무응답 감지용)

function checkDailyReset() {
  const today = new Date().toDateString();
  if (lastDateStr !== today) {
    lastDateStr = today;
    dailyCount  = 0;
    saveConfig({ dailyCount: 0, lastDateStr: today, todayLogs: [], supplementLogs: [] });
  }
}

function isDndActive() {
  return dndUntil !== null && Date.now() < dndUntil;
}

function setDnd(minutes) {
  if (minutes === -1) {
    // 오늘 자정까지
    const eod = new Date();
    eod.setHours(23, 59, 59, 999);
    dndUntil = eod.getTime();
  } else {
    dndUntil = Date.now() + minutes * 60 * 1000;
  }
}

// 실제 알람 주기: 개발 모드는 30초 고정, 프로덕션은 config.intervalMinutes 사용
const getIntervalMs = () =>
  isDev ? ALARM_INTERVAL_MS : config.intervalMinutes * 60 * 1000;

// tick: 조건 확인 후 알람 표시 또는 다음 실행 예약
function tick() {
  clearTimeout(alarmTimer);
  const now = new Date();

  if (!isInActiveHours(now)) {
    const wait = msUntilNextActiveStart(now);
    console.log(`[Alarm] 가동 시간 외. ${Math.round(wait / 60000)}분 후 재시도`);
    nextAlarmAt = Date.now() + wait;
    alarmTimer = setTimeout(tick, wait);
    return;
  }

  if (isDndActive()) {
    const wait = dndUntil - Date.now() + 1000;
    console.log(`[Alarm] DND 중. ${Math.round(wait / 60000)}분 후 재시도`);
    nextAlarmAt = dndUntil;
    alarmTimer = setTimeout(tick, wait);
    return;
  }

  // 이전 알람이 닫히지 않은 채 버튼 클릭 없이 다음 tick이 왔으면 → 무응답
  if (alarmWindow && !alarmWindow.isDestroyed() && !actionTaken) {
    console.log('[Alarm] 무응답 감지 — no_response 로그 저장');
    const pendingInteractions = [
      ...(config.pendingInteractions ?? []).slice(-49), // 최대 50개
      { type: 'no_response', occurredAt: new Date().toISOString() },
    ];
    saveConfig({ pendingInteractions });
    // 이전 창 참조를 먼저 null로 치워 showAlarm()이 새 창을 만들 수 있게 함
    const oldWin = alarmWindow;
    alarmWindow = null;
    oldWin.close(); // 닫기 이벤트에서 alarmWindow를 null로 재설정하지 않도록 아래 클로저 참고
  }

  showAlarm();
  nextAlarmAt = Date.now() + getIntervalMs();
  alarmTimer = setTimeout(tick, getIntervalMs());
}

// 딜레이 후 tick 실행 (버튼 액션에서 사용)
function scheduleNextAlarm(delayMs = getIntervalMs()) {
  clearTimeout(alarmTimer);
  nextAlarmAt = Date.now() + delayMs;
  alarmTimer = setTimeout(tick, delayMs);
}

// 저장된 위치가 연결된 디스플레이 중 하나에 있으면 그대로 사용,
// 없으면(모니터 분리 등) primary 기본 위치로 폴백
function getAlarmPos() {
  const primary = screen.getPrimaryDisplay();
  const { width: sw } = primary.workAreaSize;
  const defaultPos = { x: sw - TOAST_W - TOAST_MARGIN, y: TOAST_MARGIN };

  if (config.alarmX == null || config.alarmY == null) return defaultPos;

  const onAnyDisplay = screen.getAllDisplays().some(d => {
    const { x, y, width, height } = d.workArea;
    return (
      config.alarmX >= x &&
      config.alarmX + TOAST_W <= x + width &&
      config.alarmY >= y &&
      config.alarmY + 80 <= y + height
    );
  });

  return onAnyDisplay ? { x: config.alarmX, y: config.alarmY } : defaultPos;
}

function showAlarm() {
  if (alarmWindow && !alarmWindow.isDestroyed()) return;

  actionTaken = false; // 새 알람마다 응답 여부 초기화
  checkDailyReset();
  const { x: ax, y: ay } = getAlarmPos();

  alarmWindow = new BrowserWindow({
    width:  TOAST_W,
    height: 500, // temporary; auto-corrected in ready-to-show
    x: ax,
    y: ay,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    show:        false, // hide until height is measured
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  alarmWindow.loadFile(path.join(__dirname, 'notification.html'), {
    query: {
      guide: String(Math.floor(Math.random() * GUIDE_COUNT)),
      count: String(dailyCount),
      goal:  String(config.dailyGoal ?? 8),
      dev:   isDev ? '1' : '0',
    },
  });

  alarmWindow.once('ready-to-show', async () => {
    if (!alarmWindow || alarmWindow.isDestroyed()) return;
    const h = await alarmWindow.webContents
      .executeJavaScript("document.getElementById('toast').offsetHeight + 8")
      .catch(() => 420);
    const { x, y, width } = alarmWindow.getBounds();
    alarmWindow.setBounds({ x, y, width, height: Math.ceil(h) });
    alarmWindow.showInactive();
  });

  // 드래그로 이동이 끝날 때마다 위치 저장
  alarmWindow.on('moved', () => {
    if (alarmWindow && !alarmWindow.isDestroyed()) {
      const { x, y } = alarmWindow.getBounds();
      console.log('[Alarm] 위치 저장:', x, y);
      saveConfig({ alarmX: x, alarmY: y });
    }
  });

  // 클로저로 thisWindow를 캡처 — tick()이 alarmWindow를 미리 null로 치운 뒤
  // 새 창을 만들어도 이전 창의 closed 이벤트가 새 창 참조를 덮어쓰지 않도록 방지
  const thisWindow = alarmWindow;
  thisWindow.on('closed', () => {
    if (alarmWindow === thisWindow) alarmWindow = null;
  });
}

// --- Supplement scheduler ---
function scheduleSupplements() {
  Object.values(supplementTimers).forEach(id => clearTimeout(id));
  supplementTimers = {};
  if (!config.supplementsEnabled || !config.supplements?.length) return;
  for (const sup of config.supplements) scheduleSupplement(sup);
}

function scheduleSupplement(sup) {
  if (!sup?.id || !sup?.time) return;
  const [h, m] = sup.time.split(':').map(Number);
  const now = new Date();
  const fire = new Date(now);
  fire.setHours(h, m, 0, 0);
  if (fire <= now) fire.setDate(fire.getDate() + 1);
  supplementTimers[sup.id] = setTimeout(() => {
    if (config.supplementsEnabled) {
      const current = config.supplements?.find(s => s.id === sup.id);
      if (current) showSupplementNotification(current);
    }
    scheduleSupplement(sup); // 다음 날 재예약
  }, fire - now);
}

function showSupplementNotification(sup) {
  if (supplementWindow && !supplementWindow.isDestroyed()) supplementWindow.close();
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  supplementWindow = new BrowserWindow({
    width: 340, height: 140,
    x: sw - 340 - 16, y: 16,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  supplementWindow.loadFile(path.join(__dirname, 'supplement-notification.html'), {
    query: { id: sup.id, name: sup.name },
  });
  supplementWindow.once('ready-to-show', () => {
    if (!supplementWindow || supplementWindow.isDestroyed()) return;
    supplementWindow.showInactive();
  });
  supplementWindow.on('closed', () => { supplementWindow = null; });
}

function closeAlarm() {
  if (alarmWindow && !alarmWindow.isDestroyed()) {
    alarmWindow.close();
  }
}

// --- IPC handlers ---
ipcMain.on('alarm:resize', (_, height) => {
  if (!alarmWindow || alarmWindow.isDestroyed()) return;
  const { x, y, width } = alarmWindow.getBounds();
  alarmWindow.setBounds({ x, y, width, height });
});

ipcMain.on('alarm:action', (_, { action, value }) => {
  actionTaken = true; // 버튼을 눌렀으므로 응답으로 표시

  // 응답 interaction 로그 추가
  const responseLog = { type: 'response', occurredAt: new Date().toISOString() };
  const pendingInteractions = [
    ...(config.pendingInteractions ?? []).slice(-49),
    responseLog,
  ];

  closeAlarm();

  if (action === 'complete') {
    checkDailyReset();
    dailyCount++;
    const completedAt = new Date().toISOString();
    const pendingLogs = [...(config.pendingLogs ?? []), { completedAt }];
    const todayLogs   = [...(config.todayLogs   ?? []), { completedAt }];
    saveConfig({ pendingLogs, todayLogs, pendingInteractions, dailyCount, lastDateStr });
    scheduleNextAlarm();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('config:updated', { ...config, dailyCount, isDev, nextAlarmAt, dndUntil });
    }
  } else if (action === 'snooze') {
    saveConfig({ pendingInteractions });
    scheduleNextAlarm(5 * 60 * 1000);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('config:updated', { ...config, dailyCount, isDev, nextAlarmAt, dndUntil });
    }
  } else if (action === 'dnd') {
    saveConfig({ pendingInteractions });
    setDnd(value);
    scheduleNextAlarm();
    nextAlarmAt = dndUntil; // 방해금지 종료 시각을 다음 알림으로 표시
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('config:updated', { ...config, dailyCount, isDev, nextAlarmAt, dndUntil });
    }
  }
});

// --- Supplement IPC ---
ipcMain.on('supplement:resize', (_, height) => {
  if (!supplementWindow || supplementWindow.isDestroyed()) return;
  const { x, y, width } = supplementWindow.getBounds();
  supplementWindow.setBounds({ x, y, width, height });
});

ipcMain.on('supplement:taken', (_, supId) => {
  const logs = config.supplementLogs ?? [];
  if (!logs.some(l => l.id === supId)) {
    saveConfig({ supplementLogs: [...logs, { id: supId, takenAt: new Date().toISOString() }] });
  }
  if (supplementWindow && !supplementWindow.isDestroyed()) supplementWindow.close();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('config:updated', { ...config, dailyCount, isDev, nextAlarmAt, dndUntil });
  }
});

ipcMain.on('supplement:snooze', (_, supId) => {
  if (supplementWindow && !supplementWindow.isDestroyed()) supplementWindow.close();
  const sup = config.supplements?.find(s => s.id === supId);
  if (sup) {
    supplementTimers[`${supId}_snooze`] = setTimeout(() => {
      if (config.supplementsEnabled) showSupplementNotification(sup);
    }, 5 * 60 * 1000);
  }
});

ipcMain.on('supplement:skip', (_, supId) => {
  if (supplementWindow && !supplementWindow.isDestroyed()) supplementWindow.close();
  const snoozeKey = `${supId}_snooze`;
  if (supplementTimers[snoozeKey]) {
    clearTimeout(supplementTimers[snoozeKey]);
    delete supplementTimers[snoozeKey];
  }
});

ipcMain.handle('supplement:toggle', (_, supId) => {
  const logs = config.supplementLogs ?? [];
  const taken = logs.some(l => l.id === supId);
  const supplementLogs = taken
    ? logs.filter(l => l.id !== supId)
    : [...logs, { id: supId, takenAt: new Date().toISOString() }];
  saveConfig({ supplementLogs });
  return { ...config, dailyCount, isDev, nextAlarmAt, dndUntil };
});

ipcMain.handle('config:get', () => {
  checkDailyReset();
  return { ...config, dailyCount, isDev, nextAlarmAt, dndUntil };
});
ipcMain.handle('config:set', (_, updates) => {
  saveConfig(updates);
  if ('dailyCount'  in updates) dailyCount  = updates.dailyCount;
  if ('lastDateStr' in updates) lastDateStr = updates.lastDateStr;
  // 알람 관련 설정이 바뀔 때만 재스케줄 (그룹/닉네임 저장 등에서는 타이머 건드리지 않음)
  const alarmKeys = new Set(['intervalMinutes', 'startHour', 'endHour', 'activeDays']);
  const suppKeys  = new Set(['supplements', 'supplementsEnabled']);
  if (Object.keys(updates).some(k => alarmKeys.has(k))) scheduleNextAlarm();
  if (Object.keys(updates).some(k => suppKeys.has(k))) { scheduleSupplements(); rebuildTrayMenu(); }
  return { ...config, dailyCount, isDev, nextAlarmAt, dndUntil };
});

ipcMain.handle('dnd:cancel', () => {
  dndUntil = null;
  scheduleNextAlarm();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('config:updated', { ...config, dailyCount, isDev, nextAlarmAt, dndUntil });
  }
  return { ...config, dailyCount, isDev, nextAlarmAt, dndUntil };
});

// --- Settings window ---
function openSettings() {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    skipTaskbar: true,
    title: 'StretchWidget 설정',
    icon: ICON_256,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    settingsWindow.loadURL(DEV_URL);
    settingsWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    settingsWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// --- Tray ---
let updateReady = false;

function rebuildTrayMenu() {
  if (!tray) return;
  const items = [];

  if (isDev) {
    items.push({ label: '[DEV] 알림 즉시 띄우기', click: showAlarm });
    if (config.supplements?.length > 0) {
      items.push({
        label: '[DEV] 영양제 알림 즉시 띄우기',
        click: () => showSupplementNotification(config.supplements[0]),
      });
    }
    items.push({ type: 'separator' });
  }

  if (updateReady) {
    items.push({ label: '재시작하여 업데이트 설치', click: () => autoUpdater.quitAndInstall(true, true) });
    items.push({ type: 'separator' });
  }

  items.push({ label: '열기', click: openSettings });
  items.push({ type: 'separator' });
  items.push({ label: '종료', click: () => app.quit() });

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_16);
  tray = new Tray(icon);
  tray.setToolTip('StretchWidget');
  rebuildTrayMenu();
}

// --- Auto updater ---
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', () => {
    tray?.setToolTip('StretchWidget — 업데이트 다운로드 중...');
  });

  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    tray?.setToolTip('StretchWidget — 업데이트 준비 완료');
    rebuildTrayMenu();
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message);
    tray?.setToolTip('StretchWidget');
    // 에러는 조용히 처리 — 체크/다운로드 단계 오류를 팝업으로 띄우면
    // 정상 설치 직후에도 오탐 발생하므로 트레이 툴팁만 복원
  });

  autoUpdater.checkForUpdates();
  // 4시간마다 재확인 (앱 장시간 켜둔 경우 대비)
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}

// --- 자정 자동 리셋 타이머 ---
function scheduleMidnightReset() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 1, 0); // 자정 1초 후 (DST 경계 안전 마진)
  const delay = nextMidnight - now;
  setTimeout(() => {
    checkDailyReset();
    // settingsWindow(대시보드)가 열려 있으면 리셋된 값 즉시 반영
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('config:updated', { ...config, dailyCount, isDev, nextAlarmAt });
    }
    scheduleMidnightReset(); // 다음 날 자정 예약
  }, delay);
}

// --- App lifecycle ---
app.whenReady().then(() => {
  config = loadConfig();
  if (!config.userId) saveConfig({ userId: randomUUID() });
  // 재시작 후 오늘 데이터 복원
  lastDateStr = config.lastDateStr ?? '';
  dailyCount  = config.dailyCount  ?? 0;
  checkDailyReset(); // 날짜가 바뀌었으면 리셋
  app.dock?.hide();
  app.setAppUserModelId('com.stretchwidget.app');

  // 로그인 시 자동 시작 (패키징된 앱에서만)
  // --hidden 플래그: Windows에서 부팅 자동 시작 시 창 없이 트레이만 뜨도록
  const startHidden = process.argv.includes('--hidden')
    || (app.getLoginItemSettings().wasOpenedAsHidden ?? false);

  if (!isDev) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,   // macOS: 창 없이 시작
      args: ['--hidden'],   // Windows: 위 플래그 전달
    });
  }

  createTray();
  if (!startHidden) openSettings();
  scheduleNextAlarm();
  scheduleSupplements();
  scheduleMidnightReset();
  if (!isDev && !process.windowsStore) setupAutoUpdater();
});

// Tray-only app: do not quit when all windows close
app.on('window-all-closed', () => {});

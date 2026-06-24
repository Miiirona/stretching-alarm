import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5200';

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
const ICON_16  = path.join(_iconDir, 'icon-16.png');
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
  groupCode:           null,
  nickname:            null,
  pendingLogs:         [],
  pendingInteractions: [], // 팝업 응답/무응답 로그 (대시보드 열 때 Firestore로 flush)
  dailyGoal:           8,
  dailyCount:          0,
  lastDateStr:         '',
  groupName:           null,
};

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const raw = readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
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
let dndUntil     = null;
let dailyCount   = 0;
let lastDateStr  = '';
let guideIndex   = 0;
let actionTaken  = false; // 현재 알람에 버튼 클릭 여부 (무응답 감지용)

function checkDailyReset() {
  const today = new Date().toDateString();
  if (lastDateStr !== today) {
    lastDateStr = today;
    dailyCount  = 0;
    saveConfig({ dailyCount: 0, lastDateStr: today });
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
    alarmTimer = setTimeout(tick, wait);
    return;
  }

  if (isDndActive()) {
    const wait = dndUntil - Date.now() + 1000;
    console.log(`[Alarm] DND 중. ${Math.round(wait / 60000)}분 후 재시도`);
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
  alarmTimer = setTimeout(tick, getIntervalMs());
}

// 딜레이 후 tick 실행 (버튼 액션에서 사용)
function scheduleNextAlarm(delayMs = getIntervalMs()) {
  clearTimeout(alarmTimer);
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
      guide: String(guideIndex),
      count: String(dailyCount),
      goal:  String(config.dailyGoal ?? 8),
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
    guideIndex++;
    const pendingLogs = [...(config.pendingLogs ?? []), { completedAt: new Date().toISOString() }];
    saveConfig({ pendingLogs, pendingInteractions, dailyCount, lastDateStr });
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('config:updated', { ...config, dailyCount });
    }
    scheduleNextAlarm();
  } else if (action === 'snooze') {
    saveConfig({ pendingInteractions });
    scheduleNextAlarm(5 * 60 * 1000);
  } else if (action === 'dnd') {
    saveConfig({ pendingInteractions });
    setDnd(value);
    scheduleNextAlarm();
  }
});

ipcMain.handle('config:get', () => {
  checkDailyReset(); // UI가 열릴 때마다 날짜 변경 여부 확인
  return { ...config, dailyCount };
});
ipcMain.handle('config:set', (_, updates) => {
  saveConfig(updates);
  // config:set으로 dailyCount / lastDateStr 을 받으면 런타임 변수도 동기화
  if ('dailyCount'  in updates) dailyCount  = updates.dailyCount;
  if ('lastDateStr' in updates) lastDateStr = updates.lastDateStr;
  scheduleNextAlarm();
  return { ...config, dailyCount };
});

// --- Settings window ---
function openSettings() {
  if (settingsWindow) {
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
function createTray() {
  const icon = nativeImage.createFromPath(ICON_16);
  tray = new Tray(icon);
  tray.setToolTip('StretchWidget');

  const menuItems = [
    { label: '설정', click: openSettings },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ];

  if (isDev) {
    menuItems.unshift(
      { label: '[DEV] 알림 즉시 띄우기', click: showAlarm },
      { type: 'separator' },
    );
  }

  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
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
      settingsWindow.webContents.send('config:updated', { ...config, dailyCount });
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
  createTray();
  scheduleNextAlarm();
  scheduleMidnightReset(); // 자정마다 dailyCount 자동 리셋
});

// Tray-only app: do not quit when all windows close
app.on('window-all-closed', () => {});

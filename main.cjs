const {app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, globalShortcut, clipboard, shell} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

app.setName('Rug Maker');
if (process.platform === 'win32') app.setAppUserModelId('local.rugmaker.desktop');
let cursorTimer, win, tray, settings, ignoring = true, dragging = false, quitting = false, hasAlpha = false;
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {mode: null, tol: 40, autoStart: false, imageFile: null, imageName: null, weight: 'normal', effect: 'none', displayId: null, seen: false};
const MODES = [['cutout', '배경 지우기'], ['circle', '동그랗게'], ['round', '둥근 네모'], ['asis', '그대로']];
const WEIGHTS = [['light', '가볍게'], ['normal', '보통'], ['heavy', '묵직하게']];
const EFFECTS = [['none', '없음'], ['faint', '아주 약하게'], ['soft', '약하게'], ['normal', '보통'], ['strong', '강하게']];
const MAX_IMAGE = 40 * 1024 * 1024;

function loadSettings() {
  try { return {...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'))}; } catch { return {...DEFAULTS}; }
}
function save(patch) {
  settings = {...settings, ...patch};
  try { fs.mkdirSync(path.dirname(SETTINGS()), {recursive: true}); fs.writeFileSync(SETTINGS(), JSON.stringify(settings)); } catch (e) { console.error(e); }
}
const log = m => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'rug.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} };
const send = cmd => { if (win && !win.isDestroyed()) win.webContents.send('rug:command', cmd); };

if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { win.showInactive(); send('help'); } });
  app.whenReady().then(create).catch(e => { if (!quitting) dialog.showErrorBox('Rug Maker', e.message); app.quit(); });
}

/* 맥: 창 높이를 「바탕화면 아이콘 바로 위, 일반 창 아래」로 맞춘다 */
let winBottomTimer;
function attachDesktopLayer() {
  try {
    if (process.platform === 'win32') return attachWindowsBottom();
    if (process.platform !== 'darwin') return 'normal-window';
    const koffi = require('koffi');
    const handle = win.getNativeWindowHandle().readBigUInt64LE();
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const sel = objc.func('void *sel_registerName(const char *name)');
    const sendObject = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const sendInteger = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'int64_t']);
    const level = cg.func('int32_t CGWindowLevelForKey(int32_t key)');
    const nsWindow = sendObject(handle, sel('window'));
    sendInteger(nsWindow, sel('setLevel:'), level(18) + 1);          // kCGDesktopIconWindowLevelKey + 1
    sendInteger(nsWindow, sel('setCollectionBehavior:'), 1 | 16 | 64); // 모든 데스크탑·고정·창 전환 목록 제외
    return 'mac-desktop';
  } catch (e) { return 'fallback: ' + e.message; }
}

/* 윈도우: 창을 「일반 창 맨 아래(HWND_BOTTOM)」로 내려 둔다. 바탕화면 아이콘 위, 다른 프로그램 창 아래다.
   창은 포커스를 받지 않게 만들었으므로 클릭해도 위로 올라오지 않지만, 혹시 올라오면 1초마다 다시 내린다. */
function attachWindowsBottom() {
  const koffi = require('koffi');
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE();
  const user32 = koffi.load('user32.dll');
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)');
  const HWND_BOTTOM = 1n, FLAGS = 0x0001 | 0x0002 | 0x0010;   // NOSIZE | NOMOVE | NOACTIVATE
  const down = () => { try { if (win && !win.isDestroyed() && win.isVisible()) SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, FLAGS); } catch (e) { log('bottom ' + e.message); } };
  down();
  clearInterval(winBottomTimer); winBottomTimer = setInterval(down, 1000);
  win.on('show', down); win.on('focus', down);
  return 'win-bottom';
}

/* 로그인할 때 자동 시작 */
function setAutoStart(on) {
  if (!app.isPackaged) return false;
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents'), file = path.join(dir, 'local.rugmaker.desktop.plist');
    if (on) {
      fs.mkdirSync(dir, {recursive: true});
      const x = v => String(v).replace(/[<>&]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;'}[c]));
      fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>local.rugmaker.desktop</string>\n<key>ProgramArguments</key><array><string>${x(process.execPath)}</string></array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n</dict></plist>\n`);
    } else if (fs.existsSync(file)) fs.unlinkSync(file);
    return fs.existsSync(file);
  }
  app.setLoginItemSettings({openAtLogin: on});
  return on;
}

async function pickImage() {
  const r = await dialog.showOpenDialog({title: '러그로 만들 이미지를 고르세요', properties: ['openFile'],
    filters: [{name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']}]});
  if (r.canceled || !r.filePaths[0]) return;
  const file = r.filePaths[0], ext = path.extname(file).toLowerCase();
  if (fs.statSync(file).size > MAX_IMAGE) { dialog.showErrorBox('Rug Maker', '이미지가 너무 커요(40MB 이하만 가능해요).'); return; }
  const keep = path.join(app.getPath('userData'), 'rug-image' + ext);
  clearImages(path.basename(keep));
  fs.copyFileSync(file, keep);
  save({imageFile: path.basename(keep), imageName: path.basename(file), mode: null});
  send({type: 'image', dataUrl: imageDataUrl(), mode: undefined});
  refresh();
}
function clearImages(except) {
  for (const f of fs.readdirSync(app.getPath('userData'))) if (f.startsWith('rug-image') && f !== except) fs.unlinkSync(path.join(app.getPath('userData'), f));
}
/* 이미지를 복사해 두면(브라우저·사진 앱·캡처) 파일을 고르지 않고 바로 러그로 만든다 */
function pasteImage() {
  const img = clipboard.readImage();
  if (img.isEmpty()) {
    dialog.showMessageBox({type: 'info', message: '복사한 이미지가 없어요', detail: '브라우저나 사진 앱에서 이미지를 복사(' + (process.platform === 'darwin' ? 'Cmd+C' : 'Ctrl+C') + ')한 뒤 다시 눌러 주세요.', buttons: ['확인']});
    return;
  }
  const png = img.toPNG();
  if (png.length > MAX_IMAGE) { dialog.showErrorBox('Rug Maker', '이미지가 너무 커요(40MB 이하만 가능해요).'); return; }
  clearImages('rug-image.png');
  fs.writeFileSync(path.join(app.getPath('userData'), 'rug-image.png'), png);
  save({imageFile: 'rug-image.png', imageName: '복사한 이미지', mode: null});
  send({type: 'image', dataUrl: imageDataUrl(), mode: undefined});
  refresh();
}
function selectedDisplay() {
  return screen.getAllDisplays().find(d => d.id === settings.displayId) || screen.getPrimaryDisplay();
}
function showAbout() {
  dialog.showMessageBox({type: 'info', title: 'Rug Maker 정보', message: 'Rug Maker ' + app.getVersion(), buttons: ['확인'], detail:
    '내가 고른 이미지로 바탕화면에 러그를 깔아요.\n\n이미지는 이 컴퓨터 안에서만 처리하고 밖으로 보내지 않아요.\n\n' +
    '제작: 심팀장님 (@shimteamjjang_ai)\n출처: Terkel (@terkelg)의 바탕화면 러그를 참고해서 만들었어요.\n이 앱의 코드는 새로 만들었어요.'});
}
function imageDataUrl() {
  try {
    if (!settings.imageFile) return 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets', 'default-cat.png')).toString('base64');   // 기본 러그 = 고양이
    const f = path.join(app.getPath('userData'), settings.imageFile), ext = path.extname(f).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,` + fs.readFileSync(f).toString('base64');
  } catch { return null; }
}

function buildMenu() {
  const displays = screen.getAllDisplays(), cur = selectedDisplay(), primary = screen.getPrimaryDisplay();
  const items = [
    {label: '이미지 바꾸기…', click: () => pickImage()},
    {label: '복사한 이미지로 만들기', click: () => pasteImage()},
    {type: 'separator'},
    {label: '러그 모양', submenu: MODES.map(([v, l]) => ({label: l, type: 'radio', checked: settings.mode === v, click: () => { save({mode: v}); send({type: 'mode', value: v}); }}))},
    {label: '크기', submenu: [
      {label: '작게', click: () => send({type: 'scale', factor: .85})},
      {label: '크게', click: () => send({type: 'scale', factor: 1.18})},
      {type: 'separator'},
      {label: '원래 크기', click: () => send('scaleReset')}]},
    {label: '무게', submenu: WEIGHTS.map(([v, l]) => ({label: l, type: 'radio', checked: settings.weight === v, click: () => { save({weight: v}); send({type: 'weight', value: v}); }}))},
    {label: '러그 효과', submenu: EFFECTS.map(([v, l]) => ({label: l, type: 'radio', checked: settings.effect === v, click: () => { save({effect: v}); send({type: 'effect', value: v}); }}))}
  ];
  if (displays.length > 1) items.push({label: '화면 선택', submenu: displays.map((d, i) => ({
    label: `화면 ${i + 1} · ${d.size.width}×${d.size.height}${d.id === primary.id ? ' (주 화면)' : ''}`, type: 'radio', checked: d.id === cur.id,
    click: () => { save({displayId: d.id}); win.setBounds(d.workArea); send('center'); }}))});
  items.push(
    {type: 'separator'},
    {label: '펼치기', click: () => send('flatten')},
    {label: '처음 상태로', click: () => send('reset')},
    {label: '러그를 화면 가운데로', click: () => { send('center'); win.showInactive(); }},
    {label: win && win.isVisible() ? '잠깐 숨기기' : '러그 보이기', accelerator: 'CommandOrControl+Alt+Shift+R', registerAccelerator: false, click: toggle},
    {type: 'separator'},
    {label: '로그인할 때 자동 시작', type: 'checkbox', checked: settings.autoStart, enabled: app.isPackaged, click: item => {
      try { setAutoStart(item.checked); save({autoStart: item.checked}); } catch (e) { dialog.showErrorBox('자동 시작 설정', e.message); }
      refresh();
    }},
    {label: '제작 · @shimteamjjang_ai', click: () => shell.openExternal('https://www.instagram.com/shimteamjjang_ai/').catch(e => log('credit link ' + e.message))},
    {label: 'Rug Maker 정보…', click: showAbout},
    {type: 'separator'},
    {label: '종료', click: () => app.quit()});
  return Menu.buildFromTemplate(items);
}
function refresh() { if (tray && !tray.isDestroyed() && !quitting) tray.setContextMenu(buildMenu()); }
function toggle() { if (win.isVisible()) win.hide(); else { win.showInactive(); send('wake'); } refresh(); }
function setIgnored(v) { if (!win || win.isDestroyed() || ignoring === v) return; ignoring = v; win.setIgnoreMouseEvents(v, {forward: true}); }

async function create() {
  settings = loadSettings();
  const area = selectedDisplay().workArea;
  win = new BrowserWindow({...area, title: 'Rug Maker', transparent: true, frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, show: false, focusable: false, fullscreenable: false, maximizable: false, minimizable: false, backgroundColor: '#00000000',
    webPreferences: {preload: path.join(__dirname, 'renderer', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false}});
  win.webContents.on('render-process-gone', (_e, d) => { log('renderer gone ' + JSON.stringify(d)); if (!quitting && d.reason !== 'clean-exit') setTimeout(() => { try { win.reload(); } catch {} }, 500); });
  win.on('unresponsive', () => log('window unresponsive'));
  app.on('child-process-gone', (_e, d) => log('child gone ' + JSON.stringify(d)));
  try { log('gpu ' + JSON.stringify(app.getGPUFeatureStatus())); } catch {}
  win.setMenu(null); win.setIgnoreMouseEvents(true, {forward: true});
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  win.once('ready-to-show', () => { win.showInactive(); const layer = attachDesktopLayer(); console.log('layer', layer); log('layer ' + layer); });
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('Rug Maker · 클릭하면 러그를 보여줘요');
  tray.on('click', () => { win.showInactive(); send('wake'); });
  refresh();
  const valid = e => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle('rug:init', e => { if (!valid(e)) return null; const out = {settings, imageDataUrl: imageDataUrl()}; if (!settings.seen) save({seen: true}); return out; });
  ipcMain.on('rug:hit', (e, v) => { if (valid(e) && !dragging) { setIgnored(!v); log('hit ' + v); } });
  ipcMain.on('rug:dragging', (e, v) => { if (valid(e)) { dragging = v; if (v) setIgnored(false); log('dragging ' + v); } });
  ipcMain.on('rug:log', (e, m) => { if (valid(e)) log('renderer ' + String(m).slice(0, 200)); });
  ipcMain.on('rug:menu', e => { if (valid(e)) buildMenu().popup({window: win}); });
  ipcMain.on('rug:report', (e, d) => { if (valid(e) && d && d.mode && d.mode !== settings.mode) { save({mode: d.mode}); hasAlpha = !!d.hasAlpha; refresh(); } });
  // 바탕화면 층의 창은 「마우스가 러그 위에 있다」는 신호를 못 받는다 → 커서 위치를 직접 읽어 화면에 알려 준다
  let lastKey = '', lastSent = 0;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint(), key = p.x + ',' + p.y, now = Date.now();
    if (key === lastKey && now - lastSent < 250) return;
    lastKey = key; lastSent = now;
    const b = win.getBounds();
    win.webContents.send('rug:cursor', {x: p.x - b.x, y: p.y - b.y});
  }, process.platform === 'win32' ? 33 : 20);
  globalShortcut.register('CommandOrControl+Alt+Shift+R', toggle);
  screen.on('display-metrics-changed', () => { win.setBounds(selectedDisplay().workArea); refresh(); });
  screen.on('display-added', () => refresh());
  screen.on('display-removed', () => { win.setBounds(selectedDisplay().workArea); refresh(); });
  if (process.platform === 'darwin') app.dock && app.dock.hide();
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dump-menu')) {   // 점검용: 메뉴 구성을 글자로 찍고 끝낸다
    const dump = (items, d = 0) => items.forEach(i => {
      if (i.type === 'separator') { console.log('  '.repeat(d) + '────'); return; }
      console.log('  '.repeat(d) + (i.type === 'radio' || i.type === 'checkbox' ? (i.checked ? '(●) ' : '( ) ') : '') + i.label + (i.enabled === false ? '  [비활성]' : '') + (i.accelerator ? '  [' + i.accelerator + ']' : ''));
      if (i.submenu) dump(i.submenu.items, d + 1);
    });
    dump(buildMenu().items); setTimeout(() => app.quit(), 300);
  }
}
app.on('before-quit', () => { quitting = true; clearInterval(cursorTimer); clearInterval(winBottomTimer); globalShortcut.unregisterAll(); if (tray) tray.destroy(); });
app.on('window-all-closed', () => { if (quitting) app.quit(); });

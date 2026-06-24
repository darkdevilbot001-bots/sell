const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  
  // Default settings with placeholder URLs
  return {
    server1: {
      name: 'Render Instance 1',
      url: 'https://multi-bot-audio-1.onrender.com',
      username: 'veera',
      password: 'admin123'
    },
    server2: {
      name: 'Render Instance 2',
      url: 'https://multi-bot-audio-2.onrender.com',
      username: 'veera',
      password: 'admin123'
    },
    activeServer: 1
  };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'default',
    frame: true,
    title: 'Multi-Bot Audio Control'
  });

  // Load the app
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Remove menu bar
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('save-settings', (event, settings) => {
  saveSettings(settings);
  return { success: true };
});

ipcMain.handle('switch-server', (event, serverNumber) => {
  const settings = loadSettings();
  settings.activeServer = serverNumber;
  saveSettings(settings);
  return settings;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
import {
  app,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Menu,
  MenuItem,
  MenuItemConstructorOptions,
  powerMonitor,
  screen,
  Rectangle,
} from "electron";
import * as log from "electron-log";
import * as Store from "electron-store";
import { type as osType, release as osRelease, arch as osArch } from "os";
import { join } from "path";
import { format as urlFormat } from "url";
import { inspect } from "util";
import * as platform from "./platform";
import { initializeAppUpdateIpcHandlers, initializeAppUpdater } from "./app-updater";
import { initializeIpcHandlers } from "./ipc-events";
import {
  COLLAPSE_TO_TRAY_PREFERENCE_KEY,
  CURRENT_THEME_KEY,
  DEFAULT_BG_COLOR,
  DEFAULT_LIGHT_BG_COLOR,
  USE_HARDWARE_ACCELERATION_PREFERENCE_KEY,
  WINDOW_BOUNDS_KEY,
  WINDOW_MAXIMIZED_KEY,
  WINDOW_MINIMIZED_KEY,
} from "./src/common/constants";
import { AppOptions } from "./src/common/wowup/app-options";

// LOGGING SETUP
// Override the default log path so they aren't a pain to find on Mac
const LOG_PATH = join(app.getPath("userData"), "logs");
app.setAppLogsPath(LOG_PATH);
log.transports.file.resolvePath = (variables: log.PathVariables) => {
  return join(LOG_PATH, variables.fileName);
};
log.info("Main starting");

// ERROR HANDLING SETUP
process.on("uncaughtException", (error) => {
  log.error("uncaughtException", error);
});

process.on("unhandledRejection", (error) => {
  log.error("unhandledRejection", error);
});

// VARIABLES
const startedAt = Date.now();
const preferenceStore = new Store({ name: "preferences" });
const argv = require("minimist")(process.argv.slice(1), {
  boolean: ["serve", "hidden"],
}) as AppOptions;
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const USER_AGENT = getUserAgent();
log.info("USER_AGENT", USER_AGENT);
const WINDOW_DEFAULT_WIDTH = 1280;
const WINDOW_DEFAULT_HEIGHT = 720;
const WINDOW_MIN_WIDTH = 940;
const WINDOW_MIN_HEIGHT = 500;
const MIN_VISIBLE_ON_SCREEN = 32;

let appIsQuitting = false;
let win: BrowserWindow = null;

// APP MENU SETUP
Menu.setApplicationMenu(Menu.buildFromTemplate(getAppMenu()));

// Set the app ID so that our notifications work correctly on Windows
app.setAppUserModelId("io.wowup.jliddev");

// HARDWARE ACCELERATION SETUP
if (preferenceStore.get(USE_HARDWARE_ACCELERATION_PREFERENCE_KEY) === "false") {
  log.info("Hardware acceleration disabled");
  app.disableHardwareAcceleration();
} else {
  log.info("Hardware acceleration enabled");
}

app.allowRendererProcessReuse = false;

// Some servers don't supply good CORS headers for us, so we ignore them.
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");

// Only allow one instance of the app to run at a time, focus running window if user opens a 2nd time
// Adapted from https://github.com/electron/electron/blob/master/docs/api/app.md#apprequestsingleinstancelock
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone tried to run a second instance, we should focus our window.
    if (!win) {
      log.warn("Second instance launched, but no window found");
      return;
    }

    if (win.isMinimized()) {
      win.restore();
    } else if (!win.isVisible() && !platform.isMac) {
      win.show();
    }

    win.focus();
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// Added 400 ms to fix the black background issue while using transparent window. More details at https://github.com/electron/electron/issues/15947
if (app.isReady()) {
  log.info(`App already ready: ${Date.now() - startedAt}ms`);
} else {
  app.once("ready", () => {
    log.info(`App ready: ${Date.now() - startedAt}ms`);
    // setTimeout(() => {
    createWindow();
    // }, 400);
  });
}

app.on("before-quit", () => {
  saveWindowConfig(win);
  win = null;
  appIsQuitting = true;
});

// Quit when all windows are closed.
app.on("window-all-closed", () => {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  // if (process.platform !== "darwin") {
  app.quit();
  // }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (platform.isMac) {
    app.dock.show();
    win?.show();
  }

  if (win === null) {
    createWindow();
  }
});

app.on("child-process-gone", (e, details) => {
  log.warn("child-process-gone", inspect(details));
  if (details.reason === "killed") {
    app.quit();
  }
});

powerMonitor.on("resume", () => {
  log.info("powerMonitor resume");
});

powerMonitor.on("suspend", () => {
  log.info("powerMonitor suspend");
});

powerMonitor.on("lock-screen", () => {
  log.info("powerMonitor lock-screen");
});

powerMonitor.on("unlock-screen", () => {
  log.info("powerMonitor unlock-screen");
});

function createWindow(): BrowserWindow {
  // Main object for managing window state
  // Initialize with a window name and default size
  // const mainWindowManager = windowStateManager("main", {
  //   width: 900,
  //   height: 600,
  // });

  const windowOptions: BrowserWindowConstructorOptions = {
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    transparent: false,
    resizable: true,
    backgroundColor: getBackgroundColor(),
    title: "WowUp",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: true, // TODO remove this
      allowRunningInsecureContent: argv.serve,
      webSecurity: false,
      nativeWindowOpen: true,
      enableRemoteModule: true,
    },
    show: false,
  };

  if (platform.isWin || platform.isLinux) {
    windowOptions.frame = false;
  }

  // Attempt to fix the missing icon issue on Ubuntu
  if (platform.isLinux) {
    windowOptions.icon = join(__dirname, "assets", "wowup_logo_512np.png");
  }

  setWindowBounds(windowOptions);

  // Create the browser window.
  win = new BrowserWindow(windowOptions);

  if (preferenceStore.get(WINDOW_MAXIMIZED_KEY, false)) {
    win.maximize();
  }

  if (preferenceStore.get(WINDOW_MINIMIZED_KEY, false)) {
    win.minimize();
  }

  initializeIpcHandlers(win);
  initializeAppUpdater(win);
  initializeAppUpdateIpcHandlers(win);

  // Keep track of window state
  // mainWindowManager.monitorState(win);

  win.webContents.userAgent = USER_AGENT;

  // See https://www.electronjs.org/docs/api/web-contents#event-render-process-gone
  win.webContents.on("render-process-gone", (evt, details) => {
    log.error("webContents render-process-gone");
    log.error(evt);
    log.error(details);
  });

  // See https://www.electronjs.org/docs/api/web-contents#event-unresponsive
  win.webContents.on("unresponsive", () => {
    log.error("webContents unresponsive");
  });

  // See https://www.electronjs.org/docs/api/web-contents#event-responsive
  win.webContents.on("responsive", () => {
    log.error("webContents responsive");
  });

  win.once("ready-to-show", () => {
    if (canStartHidden()) {
      return;
    }
    win.show();
  });

  win.once("show", () => {
    // if (mainWindowManager.isFullScreen) {
    //   win.setFullScreen(true);
    // } else if (mainWindowManager.isMaximized) {
    //   win.maximize();
    // }
  });

  if (platform.isMac) {
    win.on("close", (e) => {
      if (appIsQuitting || preferenceStore.get(COLLAPSE_TO_TRAY_PREFERENCE_KEY) !== "true") {
        return;
      }

      e.preventDefault();
      win.hide();
      app.dock.hide();
    });
  }

  win.on("close", () => {
    if (!win) {
      return;
    }

    saveWindowConfig(win);
  });

  win.once("closed", () => {
    win = null;
  });

  log.info(`Loading app URL: ${Date.now() - startedAt}ms`);
  if (argv.serve) {
    require("electron-reload")(__dirname, {
      electron: require(`${__dirname}/node_modules/electron`),
    });
    win.loadURL("http://localhost:4200");
  } else {
    win.loadURL(
      urlFormat({
        pathname: join(__dirname, "dist/index.html"),
        protocol: "file:",
        slashes: true,
      })
    );
  }

  return win;
}

function saveWindowConfig(browserWindow: BrowserWindow) {
  try {
    if (!browserWindow) {
      return;
    }

    preferenceStore.set(WINDOW_MAXIMIZED_KEY, browserWindow.isMaximized());
    preferenceStore.set(WINDOW_MINIMIZED_KEY, browserWindow.isMinimized());

    if (!preferenceStore.get(WINDOW_MAXIMIZED_KEY, false) && !preferenceStore.get(WINDOW_MINIMIZED_KEY, false)) {
      preferenceStore.set(WINDOW_BOUNDS_KEY, browserWindow.getBounds());
    }
  } catch (e) {
    log.error(e);
  }
}

// Lifted from Discord to check where to display the window
function setWindowBounds(windowOptions: BrowserWindowConstructorOptions) {
  const savedBounds = preferenceStore.get(WINDOW_BOUNDS_KEY) as Rectangle;
  if (!savedBounds) {
    windowOptions.center = true;
    return;
  }

  savedBounds.width = Math.max(WINDOW_MIN_WIDTH, savedBounds.width);
  savedBounds.height = Math.max(WINDOW_MIN_HEIGHT, savedBounds.height);

  let isVisibleOnAnyScreen = false;

  const displays = screen.getAllDisplays();
  for (let display of displays) {
    const displayBound = display.workArea;
    displayBound.x += MIN_VISIBLE_ON_SCREEN;
    displayBound.y += MIN_VISIBLE_ON_SCREEN;
    displayBound.width -= 2 * MIN_VISIBLE_ON_SCREEN;
    displayBound.height -= 2 * MIN_VISIBLE_ON_SCREEN;
    isVisibleOnAnyScreen = doRectanglesOverlap(savedBounds, displayBound);

    if (isVisibleOnAnyScreen) {
      break;
    }
  }

  if (isVisibleOnAnyScreen) {
    windowOptions.width = savedBounds.width;
    windowOptions.height = savedBounds.height;
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  } else {
    windowOptions.center = true;
  }
}

function getBackgroundColor() {
  const savedTheme = preferenceStore.get(CURRENT_THEME_KEY) as string;
  return savedTheme && savedTheme.indexOf("light") !== -1 ? DEFAULT_LIGHT_BG_COLOR : DEFAULT_BG_COLOR;
}

function canStartHidden() {
  return argv.hidden || app.getLoginItemSettings().wasOpenedAsHidden;
}

function getUserAgent() {
  const portableStr = isPortable ? " portable;" : "";
  return `WowUp-Client/${app.getVersion()} (${osType()}; ${osRelease()}; ${osArch()}; ${portableStr} +https://wowup.io)`;
}

function getAppMenu(): Array<MenuItemConstructorOptions | MenuItem> {
  if (platform.isMac) {
    return [
      {
        label: app.name,
        submenu: [{ role: "quit" }],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools", accelerator: "CommandOrControl+Shift+I" },
          { type: "separator" },
          // { role: "resetZoom" },
          // { role: "zoomIn", accelerator: "CommandOrControl+=" },
          // { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ];
  } else if (platform.isWin) {
    return [
      {
        label: "View",
        submenu: [
          // { role: "resetZoom" },
          { role: "toggleDevTools" },
          // { role: "zoomIn", accelerator: "CommandOrControl+=" },
          // { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ];
  } else if (platform.isLinux) {
    return [
      {
        label: app.name,
        submenu: [{ role: "quit" }],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          // { role: "resetZoom" },
          // { role: "zoomIn", accelerator: "CommandOrControl+=" },
          // { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ];
  }

  return [];
}

function doRectanglesOverlap(a: Rectangle, b: Rectangle) {
  const ax1 = a.x + a.width;
  const bx1 = b.x + b.width;
  const ay1 = a.y + a.height;
  const by1 = b.y + b.height; // clamp a to b, see if it is non-empty

  const cx0 = a.x < b.x ? b.x : a.x;
  const cx1 = ax1 < bx1 ? ax1 : bx1;

  if (cx1 - cx0 > 0) {
    const cy0 = a.y < b.y ? b.y : a.y;
    const cy1 = ay1 < by1 ? ay1 : by1;

    if (cy1 - cy0 > 0) {
      return true;
    }
  }

  return false;
}

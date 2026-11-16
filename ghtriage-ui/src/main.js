const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const {
  parseTriageYaml,
  generateGhScript,
  serializeTriageYaml,
} = require('./triage-core');

let mainWindow = null;
const githubBodyCache = new Map();

function resolveInitialYamlPath() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const resolved = path.resolve(process.cwd(), arg);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  const defaultSample = path.resolve(__dirname, '..', 'sample-triage.yaml');
  if (fs.existsSync(defaultSample)) {
    return defaultSample;
  }
  return null;
}

/**
 * Fetches the body text of a GitHub PR or Issue using `gh` CLI first,
 * falling back to the public GitHub REST API if `gh` fails.
 */
function fetchGithubDescription({ repo, number, type, link }) {
  const cacheKey = `${repo}#${number}` || link;
  if (githubBodyCache.has(cacheKey)) {
    return Promise.resolve({ body: githubBodyCache.get(cacheKey) });
  }

  return new Promise((resolve) => {
    const subcommand = type === 'pr' ? 'pr' : 'issue';
    const args =
      repo && number
        ? [subcommand, 'view', String(number), '-R', repo, '--json', 'body', '-q', '.body']
        : [subcommand, 'view', String(link), '--json', 'body', '-q', '.body'];

    execFile('gh', args, { timeout: 10000 }, (err, stdout) => {
      if (!err && typeof stdout === 'string' && stdout.trim()) {
        const cleaned = stdout.trim();
        githubBodyCache.set(cacheKey, cleaned);
        resolve({ body: cleaned });
        return;
      }

      // Fallback to GitHub REST API if repo and number are known
      if (!repo || !number) {
        resolve({ error: err ? err.message : 'Unable to fetch description' });
        return;
      }

      const apiUrl = `https://api.github.com/repos/${repo}/issues/${number}`;
      const req = https.get(
        apiUrl,
        {
          headers: {
            'User-Agent': 'ghtriage-ui',
            Accept: 'application/vnd.github+json',
          },
          timeout: 8000,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(raw);
                const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
                githubBodyCache.set(cacheKey, body);
                resolve({ body });
                return;
              } catch (parseErr) {
                resolve({ error: parseErr.message });
                return;
              }
            }
            resolve({
              error: `GitHub returned HTTP ${res.statusCode}`,
            });
          });
        }
      );

      req.on('error', (reqErr) => {
        resolve({ error: reqErr.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ error: 'Request timed out' });
      });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'GitHub Issue & PR Triage UI',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.handle('triage:get-initial-data', async () => {
  const initialPath = resolveInitialYamlPath();
  if (!initialPath) {
    return { filePath: null, rawYaml: '', items: [] };
  }
  try {
    const rawYaml = fs.readFileSync(initialPath, 'utf8');
    const items = parseTriageYaml(rawYaml);
    return { filePath: initialPath, rawYaml, items };
  } catch (err) {
    return { filePath: initialPath, rawYaml: '', items: [], error: err.message };
  }
});

ipcMain.handle('triage:open-yaml-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Triage YAML File',
    filters: [
      { name: 'YAML Files', extensions: ['yaml', 'yml'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
    const rawYaml = fs.readFileSync(filePath, 'utf8');
    const items = parseTriageYaml(rawYaml);
    return { canceled: false, filePath, rawYaml, items };
  } catch (err) {
    return { canceled: false, filePath, error: err.message };
  }
});

ipcMain.handle('triage:parse-yaml-string', async (_event, rawYaml, sourceLabel) => {
  try {
    const items = parseTriageYaml(rawYaml);
    return { filePath: sourceLabel || 'Pasted YAML', rawYaml, items };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('triage:fetch-github-description', async (_event, itemMeta) => {
  return fetchGithubDescription(itemMeta || {});
});

ipcMain.handle('triage:generate-script', async (_event, items) => {
  return generateGhScript(items);
});

ipcMain.handle('triage:serialize-yaml', async (_event, items) => {
  return serializeTriageYaml(items);
});

ipcMain.handle('triage:copy-clipboard', async (_event, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('triage:save-script', async (_event, scriptContent) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save gh Triage Script',
    defaultPath: path.join(process.cwd(), 'apply-triage.sh'),
    filters: [
      { name: 'Shell Script', extensions: ['sh'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  fs.writeFileSync(result.filePath, scriptContent, { encoding: 'utf8', mode: 0o755 });
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('triage:save-yaml', async (_event, items) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Edited Triage YAML',
    defaultPath: path.join(process.cwd(), 'triage-edited.yaml'),
    filters: [{ name: 'YAML Files', extensions: ['yaml', 'yml'] }],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  const yamlOut = serializeTriageYaml(items);
  fs.writeFileSync(result.filePath, yamlOut, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('triage:open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

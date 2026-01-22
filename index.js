/*
 Copyright (c) 2026 DarkNio
 Licensed under the MIT License. See LICENSE file in project root.
*/

const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');

function _cookiesArg(opts = {}) {
  const cwdCookies = path.join(process.cwd(), 'cookies.txt');
  if (fs.existsSync(cwdCookies)) {
    console.log('darkchair_api_youtube: using cookies.txt from process.cwd():', cwdCookies);
    const useFromBrowser = (process.env.USE_COOKIES_FROM_BROWSER === '1' || process.env.USE_COOKIES_FROM_BROWSER === 'true');
    if (useFromBrowser) {
      const product = process.env.PUPPETEER_PRODUCT || 'firefox';
      return ['--cookies-from-browser', product, '--cookies', cwdCookies];
    }
    return ['--cookies', cwdCookies];
  }

  let projectRoot = path.resolve(process.cwd(), '..');
  try {
    const parts = projectRoot.split(path.sep);
    const nmIndex = parts.lastIndexOf('node_modules');
    if (nmIndex !== -1) {
      projectRoot = parts.slice(0, nmIndex).join(path.sep) || path.sep;
    }
  } catch (e) {}
  console.log('darkchair_api_youtube: determined project root as', projectRoot);
  let cookiesPath = path.join(projectRoot, 'cookies.txt');
  if (!fs.existsSync(cookiesPath)) {
    console.error('darkchair_api_youtube: cookies.txt non trovato (checked):', cookiesPath);
  }

  const useFromBrowser = (process.env.USE_COOKIES_FROM_BROWSER === '1' || process.env.USE_COOKIES_FROM_BROWSER === 'true');
  if (useFromBrowser) {
    const product = process.env.PUPPETEER_PRODUCT || 'firefox';
    return ['--cookies-from-browser', product, '--cookies', cookiesPath];
  }
  return ['--cookies', cookiesPath];
}

function isAvailable() {
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', ['--version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function stream(url, opts = {}) {
  const preferred = opts.format || null; // allow caller to pass a specific format id or expression
  const fallbacks = ['bestaudio/best','bestaudio','best'];
  const cookies = _cookiesArg(opts);
  const outStream = new PassThrough();
  let tried = 0;
  let currentProc = null;

  const trySpawn = (fmt) => {
    const args = ['-o', '-', '-f', fmt, '--no-playlist', '--no-warnings', '--js-runtimes', 'node', url];
    if (cookies.length) args.splice(0, 0, ...cookies);
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    currentProc = proc;

    proc.on('error', (e) => {
      console.error('darkchair_api_youtube: yt-dlp spawn error for', url, e && e.message ? e.message : e);
    });

    // Buffer stderr chunks and flush them as an in-place console line (carriage return)
    let _stderrBuf = '';
    let _stderrTimer = null;
    let _lastLineLen = 0;
    const _flushStderr = (final = false) => {
      try {
        if (!_stderrBuf) return;
        const msg = _stderrBuf.replace(/\s+/g, ' ').trim();
        if (!msg) return;
        const prefix = 'darkchair_api_youtube yt-dlp stderr: ';
        const out = prefix + msg;
        // pad with spaces if new out is shorter than previous to clear residual chars
        let pad = '';
        if (_lastLineLen > out.length) pad = ' '.repeat(_lastLineLen - out.length);
        if (final) {
          try { process.stderr.write('\r' + out + pad + '\n'); } catch (e) { console.error(prefix + msg); }
          _lastLineLen = 0;
        } else {
          try { process.stderr.write('\r' + out + pad); } catch (e) { console.error(prefix + msg); }
          _lastLineLen = out.length;
        }
      } catch (e) {
        try { console.error('darkchair_api_youtube stderr flush error', e && e.message ? e.message : e); } catch (er) {}
      } finally {
        _stderrBuf = '';
        if (_stderrTimer) { clearTimeout(_stderrTimer); _stderrTimer = null; }
      }
    };
    proc.stderr.on('data', (d) => {
      try {
        let text = String(d || '').replace(/\r?\n/g, ' ').trim();
        if (!text) return;
        if (_stderrBuf) _stderrBuf += ' | ' + text; else _stderrBuf = text;
        if (_stderrTimer) clearTimeout(_stderrTimer);
        _stderrTimer = setTimeout(() => _flushStderr(false), 120);
      } catch (e) {
        // fallback to simple logging
        try { console.error('darkchair_api_youtube yt-dlp stderr:', String(d).trim()); } catch (er) {}
      }
    });
    proc.on('close', () => { _flushStderr(true); });

    if (proc.stdout) proc.stdout.pipe(outStream, { end: false });
    proc.on('close', (code, signal) => {
      if (code === 0) {
        try { outStream.end(); } catch (e) {}
      } else {
        tried += 1;
        if (tried < fallbacks.length) {
          const nextFmt = fallbacks[tried];
          console.warn('darkchair_api_youtube: format failed, retrying with', nextFmt);
          trySpawn(nextFmt);
        } else {
          console.error(`darkchair_api_youtube: yt-dlp exited with code=${code} signal=${signal} for ${url}`);
          try { outStream.end(); } catch (e) {}
        }
      }
    });
    return proc;
  };

  const pickBestAudioFormat = (formats) => {
    if (!Array.isArray(formats) || formats.length === 0) return null;
    const preferExts = ['opus', 'webm', 'm4a', 'mp3'];
    const audioOnly = formats.filter(f => {
      try {
        const v = (f.vcodec || '').toLowerCase();
        return !v || v === 'none' || v === 'unknown';
      } catch (e) { return false; }
    });
    if (audioOnly.length === 0) return null;
    audioOnly.sort((a, b) => {
      const ia = preferExts.indexOf((a.ext || '').toLowerCase());
      const ib = preferExts.indexOf((b.ext || '').toLowerCase());
      const pa = ia === -1 ? preferExts.length : ia;
      const pb = ib === -1 ? preferExts.length : ib;
      if (pa !== pb) return pa - pb;
      const abrA = a.abr || a.tbr || 0;
      const abrB = b.abr || b.tbr || 0;
      if (abrB !== abrA) return abrB - abrA;
      return (b.filesize || 0) - (a.filesize || 0);
    });
    return audioOnly[0] && (audioOnly[0].format_id || audioOnly[0].format) ? (audioOnly[0].format_id || audioOnly[0].format) : null;
  };

  (async () => {
    try {
      let fmtToUse = null;
      if (preferred && /^\d+$/.test(String(preferred))) {
        fmtToUse = String(preferred);
      } else if (preferred && typeof preferred === 'string') {
        fmtToUse = preferred;
      } else {
        try {
          const info = await getInfo(url);
          if (info && Array.isArray(info.formats)) {
            const picked = pickBestAudioFormat(info.formats);
            if (picked) fmtToUse = picked;
          }
        } catch (e) {
          console.warn('darkchair_api_youtube: getInfo failed while selecting format, falling back', e && e.message ? e.message : e);
        }
      }
      if (!fmtToUse) fmtToUse = fallbacks[0];
      trySpawn(fmtToUse);
    } catch (e) {
      console.error('darkchair_api_youtube: async format selection error', e && e.message ? e.message : e);
      trySpawn(fallbacks[0]);
    }
  })();
  return { stream: outStream, proc: { current: () => currentProc } };
}

async function getInfo(url, opts = {}) {
  return new Promise((resolve) => {
    const args = ['--dump-json', '--js-runtimes', 'node', '--no-playlist', '--no-warnings', url];
    const cookies = _cookiesArg(opts);
    if (cookies.length) args.splice(0, 0, ...cookies);
    console.log('darkchair_api_youtube: getInfo spawn yt-dlp with args:', args.join(' '));
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code === 0 && out) {
        try { resolve(JSON.parse(out)); } catch (e) { resolve(null); }
      } else resolve(null);
    });
  });
}

const express = require('express');
const crypto = require('crypto');
const PROJECT_ROOT = path.resolve(process.cwd(), '..');
try {
  const sep = path.delimiter || ':';
  if (!process.env.PATH || !process.env.PATH.split(sep).includes(PROJECT_ROOT)) {
    process.env.PATH = PROJECT_ROOT + sep + (process.env.PATH || '');
  }
} catch (e) {}
const COOKIES_FILE = path.join(PROJECT_ROOT, 'cookies.txt');
function makeId() { return crypto.randomBytes(6).toString('hex'); }
function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by darkchair_api_youtube/index.js'];
  for (const c of cookies) {
    const domain = c.domain || c.hostname || '';
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const pathVal = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const rawExpires = (typeof c.expires === 'number') ? Math.floor(c.expires) : 0;
    const expires = rawExpires > 0 ? rawExpires : 0;
    const name = c.name || c.key || '';
    const value = c.value || '';
    lines.push([domain, flag, pathVal, secure, expires, name, value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function createAuthApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    try {
      const orig = req.originalUrl || req.url || '';
      if (orig.includes('.env') || orig.includes('/..') || /\.+\/|\.\.$/.test(orig)) {
        return res.status(403).send('Forbidden');
      }
    } catch (e) {}
    return next();
  });
  const UI_SESSIONS = new Map();
  const SESSIONS = new Map();
  const ACCESS_LOG = [];
  const ACCESS_LOG_PATH = path.join(PROJECT_ROOT, 'auth_access.log');
  function _getRemoteIp(req) {
    const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
    if (xf && typeof xf === 'string') return xf.split(',')[0].trim();
    if (req.ip) return req.ip;
    return req.connection && (req.connection.remoteAddress || null);
  }

  function appendAccessLog(entry) {
    try {
      const e = Object.assign({ time: Date.now() }, entry);
      ACCESS_LOG.push(e);
      if (ACCESS_LOG.length > 1000) ACCESS_LOG.shift();
      const line = JSON.stringify(e);
      fs.appendFile(ACCESS_LOG_PATH, line + '\n', (err) => { if (err) console.error('failed write access log', err && err.message ? err.message : err); });
    } catch (e) {
      try { fs.appendFileSync(ACCESS_LOG_PATH, JSON.stringify({ time: Date.now(), error: String(e) }) + '\n'); } catch (er) {}
    }
  }

  const FAILED_ATTEMPTS = new Map();
  const LOGIN_MAX_ATTEMPTS = parseInt(process.env.AUTH_LOGIN_MAX || '5', 10); // default 5
  const LOGIN_WINDOW_MS = parseInt(process.env.AUTH_LOGIN_WINDOW_MS || String(60 * 60 * 1000), 10); // default 1 hour

  function _now() { return Date.now(); }

  function pruneAttempts(arr) {
    const cutoff = _now() - LOGIN_WINDOW_MS;
    while (arr.length && arr[0] < cutoff) arr.shift();
    return arr;
  }

  function recordFailedAttempt(key) {
    try {
      if (!key) return;
      const a = FAILED_ATTEMPTS.get(key) || [];
      a.push(_now());
      pruneAttempts(a);
      FAILED_ATTEMPTS.set(key, a);
    } catch (e) {}
  }

  function clearAttempts(key) {
    try { if (!key) return; FAILED_ATTEMPTS.delete(key); } catch (e) {}
  }

  function attemptsCount(key) {
    try { const a = FAILED_ATTEMPTS.get(key) || []; pruneAttempts(a); return a.length; } catch (e) { return 0; }
  }

  function isBlocked(key) {
    try { return attemptsCount(key) >= LOGIN_MAX_ATTEMPTS; } catch (e) { return false; }
  }

  function _getUiCookie(req) {
    const raw = req.headers && req.headers.cookie;
    if (!raw) return null;
    const parts = raw.split(';').map(s => s.trim());
    for (const p of parts) {
      if (p.startsWith('darkchair_ui=')) return p.split('=')[1];
    }
    return null;
  }

  function requireUiAuth(req, res, next) {
    const token = _getUiCookie(req);
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const sess = UI_SESSIONS.get(token);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });
    req._authUsername = sess.username;
    return next();
  }

  app.use('/auth/ui', (req, res, next) => {
    // multi-user UI auth: support AUTH_UI_USERS (comma-separated user:pass)
    // fallback to single AUTH_UI_PASSWORD for legacy setups
    const usersCfg = process.env.AUTH_UI_USERS || '';
    const singlePw = process.env.AUTH_UI_PASSWORD || '';
    if (!usersCfg && !singlePw) return next();
    if (req.path === '/login' || req.path === '/login.html') return next();
    const token = _getUiCookie(req);
    if (token) {
      const sess = UI_SESSIONS.get(token);
      if (sess) return next();
    }

    try {
      const loginPath = path.join(__dirname, 'public', 'login.html');
      if (fs.existsSync(loginPath)) {
        const html = fs.readFileSync(loginPath, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
    } catch (e) {}
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Login</title>
        </head>
        <body style="font-family:system-ui,Arial;margin:20px">
          <h3>Auth UI Login</h3>
          <form method="POST" action="/auth/ui/login">
            <div style="margin-bottom:8px">
              <input name="username" type="text" placeholder="Username" style="padding:8px;width:300px" />
            </div>
            <div style="margin-bottom:8px">
              <input name="password" type="password" placeholder="Password" style="padding:8px;width:300px" />
            </div>
            <button type="submit" style="padding:8px 12px">Login</button>
          </form>
        </body>
      </html>
      `);
  });

  app.use('/auth/ui', express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore' }));

  app.post('/auth/ui/login', express.urlencoded({ extended: false }), (req, res) => {
    const usersCfg = process.env.AUTH_UI_USERS;
    const singlePw = process.env.AUTH_UI_PASSWORD;
    const providedUser = String(req.body.username || '').trim();
    const providedPw = String(req.body.password || '');
    const ip = _getRemoteIp(req);
    const rlKey = providedUser || ip || 'unknown';
    if (isBlocked(rlKey)) {
      try { appendAccessLog({ type: 'ui_login_blocked', username: providedUser || null, ip }); } catch (e) {}
      const accept = (req.headers && req.headers.accept) ? req.headers.accept : '';
      const isAjax = req.xhr || (req.headers['x-requested-with'] === 'XMLHttpRequest') || (accept.indexOf && accept.indexOf('application/json') !== -1);
      if (isAjax) return res.status(429).json({ error: 'rate_limited', message: 'Troppi tentativi. Riprova più tardi.' });
      return res.redirect('/auth/ui/login.html?error=blocked');
    }

    let allowed = false;
    let username = providedUser;
    if (usersCfg) {
      // parse users e.g. "alice:pass,bob:secret"
      const parts = usersCfg.split(',').map(s=>s.trim()).filter(Boolean);
      for (const p of parts) {
        const idx = p.indexOf(':');
        if (idx === -1) continue;
        const u = p.slice(0, idx);
        const pw = p.slice(idx+1);
        if (u == providedUser && pw == providedPw) { allowed = true; username = u; break; }
      }
    } else if (singlePw) {
      if (providedPw == singlePw) allowed = true;
    }

    if (!allowed) {
      try { appendAccessLog({ type: 'ui_login_failed', username: providedUser || null, ip }); } catch (e) {}
      try { recordFailedAttempt(rlKey); } catch (e) {}
      const accept = (req.headers && req.headers.accept) ? req.headers.accept : '';
      const isAjax = req.xhr || (req.headers['x-requested-with'] === 'XMLHttpRequest') || (accept.indexOf && accept.indexOf('application/json') !== -1);
      if (isAjax) return res.status(401).json({ error: 'invalid_credentials', message: 'Credenziali non valide' });
      return res.redirect('/auth/ui/login.html?error=1');
    }
    try { clearAttempts(rlKey); } catch (e) {}
    const token = makeId();
    UI_SESSIONS.set(token, { createdAt: Date.now(), username });
    try {
      const ip = _getRemoteIp(req);
      appendAccessLog({ type: 'ui_login', username, ip });
    } catch (e) {}
    const maxAge = 24 * 60 * 60 * 1000;
    res.setHeader('Set-Cookie', `darkchair_ui=${token}; Path=/; HttpOnly; Max-Age=${Math.floor(maxAge/1000)}`);
    return res.redirect('/auth/ui');
  });

  app.get('/auth/login/attempts', (req, res) => {
    try {
      const username = String(req.query.username || '').trim();
      const ip = _getRemoteIp(req);
      const key = username || ip || 'unknown';
      const arr = FAILED_ATTEMPTS.get(key) || [];
      pruneAttempts(arr);
      const count = arr.length;
      const max = LOGIN_MAX_ATTEMPTS;
      const remaining = Math.max(0, max - count);
      let blockedUntil = null;
      if (count >= max && arr[0]) blockedUntil = arr[0] + LOGIN_WINDOW_MS;
      return res.json({ remaining, max, windowMs: LOGIN_WINDOW_MS, blockedUntil });
    } catch (e) {
      return res.status(500).json({ error: 'failed', detail: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/auth/start', requireUiAuth, async (req, res) => {
    const id = makeId();
    try {
      try { const ip = _getRemoteIp(req); const username = req._authUsername || null; appendAccessLog({ type: 'start_session', id, username, ip }); } catch (e) {}
      const puppeteer = require('puppeteer-extra');
      const StealthPlugin = require('puppeteer-extra-plugin-stealth');
      const stealth = StealthPlugin();
      try { stealth.enabledEvasions.delete('iframe.contentWindow'); } catch (e) {}
      try { stealth.enabledEvasions.delete('media.codecs'); } catch (e) {}
      puppeteer.use(stealth);
      const headlessEnv = process.env.AUTH_HEADLESS;
      const headless = headlessEnv === '1' || headlessEnv === 'true';
      const debugPort = process.env.AUTH_DEBUG_PORT || '9222';
      const debugHost = process.env.AUTH_DEBUG_HOST || '127.0.0.1';
      const execPath = process.env.PUPPETEER_EXEC || process.env.PUPPETEER_EXEC_PATH || undefined;
      const product = process.env.PUPPETEER_PRODUCT || 'firefox';
      const userAgent = process.env.AUTH_USER_AGENT || (product === 'firefox'
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36');

      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ];

      if (product === 'chrome') {
        launchArgs.push(`--remote-debugging-port=${debugPort}`);
        launchArgs.push(`--remote-debugging-address=${debugHost}`);
      }

      const launchOpts = { headless, args: launchArgs, product };
      if (execPath) launchOpts.executablePath = execPath;
      const profileEnv = process.env.PUPPETEER_PROFILE || process.env.PUPPETEER_USER_DATA_DIR || null;
      const profilesRoot = path.join(PROJECT_ROOT, '.profiles');
      try { if (!fs.existsSync(profilesRoot)) fs.mkdirSync(profilesRoot, { recursive: true }); } catch (e) {}
      const sessionProfileDir = path.join(profilesRoot, id);
      let ownedProfile = false;
      try {
        const removeLockFiles = (root) => {
          try {
            const names = ['SingletonLock', 'SingletonSocket', 'lock', 'LOCK', 'parent.lock'];
            const walk = (dir) => {
              let entries = [];
              try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
              for (const ent of entries) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                  walk(p);
                } else {
                  if (names.includes(ent.name)) {
                    try { fs.rmSync(p, { force: true }); } catch (e) {}
                  }
                }
              }
            };
            walk(root);
          } catch (e) {}
        };

        if (profileEnv) {
          const resolved = path.isAbsolute(profileEnv) ? profileEnv : path.join(PROJECT_ROOT, profileEnv);
          if (fs.existsSync(resolved)) {
            try {
              fs.cpSync(resolved, sessionProfileDir, { recursive: true });
              removeLockFiles(sessionProfileDir);
              ownedProfile = true;
            } catch (e) {
              try { fs.mkdirSync(sessionProfileDir, { recursive: true }); ownedProfile = true; } catch (err) {}
            }
          } else {
            try { fs.mkdirSync(sessionProfileDir, { recursive: true }); ownedProfile = true; } catch (e) {}
          }
        } else {
          try { fs.mkdirSync(sessionProfileDir, { recursive: true }); ownedProfile = true; } catch (e) {}
        }
      } catch (e) {}
      if (fs.existsSync(sessionProfileDir)) launchOpts.userDataDir = sessionProfileDir;

      const browser = await puppeteer.launch(launchOpts);
      const page = await browser.newPage();
      await page.setUserAgent(userAgent);
      await page.evaluateOnNewDocument(() => {
        try {
          const fakePlugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' }
          ];
          const pluginArray = fakePlugins;
          pluginArray.item = function(i) { return this[i] || null; };
          pluginArray.namedItem = function(name) { return this.find(p => p.name === name) || null; };
          Object.defineProperty(pluginArray, 'length', { get: function() { return Array.prototype.length.call(this); }, configurable: true });
          Object.defineProperty(navigator, 'plugins', { get: () => pluginArray, configurable: true });
          const fakeMimeTypes = [];
          //Object.defineProperty(navigator, 'mimeTypes', { get: () => fakeMimeTypes, configurable: true });
          window.chrome = window.chrome || { runtime: {} };
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4, configurable: true });
          Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
          Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
          try {
            if (navigator.permissions && navigator.permissions.query) {
              const origQuery = navigator.permissions.query.bind(navigator.permissions);
              navigator.permissions.query = (parameters) => {
                if (parameters && parameters.name === 'notifications') {
                  return Promise.resolve({ state: Notification && Notification.permission ? Notification.permission : 'default' });
                }
                return origQuery(parameters);
              };
            }
          } catch (e) {}
          try {
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(param) {
              if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
              if (param === 37446) return 'Intel Iris'; // UNMASKED_RENDERER_WEBGL
              return getParameter.call(this, param);
            };
          } catch (e) {}
        } catch (e) {}
      });
      await page.evaluateOnNewDocument(() => {
        try {
          try {
            if (typeof navigator.userAgentData === 'undefined') {
              Object.defineProperty(navigator, 'userAgentData', { get: () => ({
                brands: [{ brand: 'Chromium', version: '117' }, { brand: 'Google Chrome', version: '117' }],
                mobile: false,
                getHighEntropyValues: (hints) => Promise.resolve({
                  platform: 'Windows',
                  architecture: 'x64',
                  model: '',
                  uaFullVersion: (navigator.userAgent && navigator.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/) && navigator.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/)[1]) || '117.0.0.0'
                })
              }), configurable: true });
            }
          } catch (e) {}
          try { window.chrome = window.chrome || {}; window.chrome.runtime = window.chrome.runtime || {}; window.chrome.webstore = window.chrome.webstore || {}; } catch(e){}
          try {
            const perms = navigator.permissions;
            if (perms && perms.query) {
              const orig = perms.query.bind(perms);
              perms.query = (params) => {
                if (params && params.name === 'notifications') return Promise.resolve({ state: Notification && Notification.permission ? Notification.permission : 'default' });
                return orig(params);
              };
            }
          } catch (e) {}
          try {
            const nativeToString = Function.prototype.toString;
            const oldToString = nativeToString.call.bind(nativeToString);
            Function.prototype.toString = function() {
              try {
                if (this && this.name && (this.name === 'getParameter' || this.name === 'query')) {
                  return 'function ' + (this.name || '') + '() { [native code] }';
                }
              } catch (e) {}
              return oldToString(this);
            };
          } catch (e) {}
          try {
            const makePlugin = (p) => ({ name: p.name || '', filename: p.filename || '', description: p.description || '' });
            const fake = [];
            //Object.defineProperty(navigator, 'plugins', { get: () => fake, configurable: true });
            //Object.defineProperty(navigator, 'mimeTypes', { get: () => [], configurable: true });
          } catch(e){}

        } catch (e) {}
      });
      await page.goto('https://accounts.google.com/ServiceLogin?service=youtube', { waitUntil: 'networkidle2' });
      SESSIONS.set(id, { browser, page, startedAt: Date.now(), profileDir: fs.existsSync(sessionProfileDir) ? sessionProfileDir : null, ownedProfile });
      res.json({ id, message: 'Browser opened. Complete login in the opened window on the server.' });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error('auth-server: start error', msg, e && e.stack ? e.stack : '');
      res.status(500).json({ error: 'failed to start browser', detail: msg });
    }
  });

    app.post('/auth/export/:id', requireUiAuth, async (req, res) => {
    const id = req.params.id;
    const sess = SESSIONS.get(id);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    try {
      const { page, browser } = sess;
      const cookies = await page.cookies('https://www.youtube.com');
      let list = cookies;
      if (!cookies || cookies.length === 0) {
        try {
          const all = await page._client.send('Network.getAllCookies');
          list = all && all.cookies ? all.cookies : [];
        } catch (e) {
          list = [];
        }
      }
      const out = cookiesToNetscape(list);
      fs.writeFileSync(COOKIES_FILE, out, 'utf8');
      const sessProfile = sess.profileDir || null;
      if (!sessProfile) {
        try { await browser.close(); } catch (e) {}
        SESSIONS.delete(id);
      } else {
        sess.startedAt = Date.now();
        SESSIONS.set(id, sess);
      }
      return res.json({ saved: true, cookies: list.length });
    } catch (e) {
      console.error('auth-server: export error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'failed to export cookies' });
    }
  });

  app.get('/auth/status/:id', requireUiAuth, (req, res) => {
    const id = req.params.id;
    const sess = SESSIONS.get(id);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    res.json({ id, startedAt: sess.startedAt });
  });

  app.get('/auth/sessions', requireUiAuth, (req, res) => {
    try {
      const arr = [];
      for (const [id, sess] of SESSIONS.entries()) {
        let url = null;
        try { url = (sess.page && typeof sess.page.url === 'function') ? sess.page.url() : null; } catch (e) { url = null; }
        arr.push({ id, startedAt: sess.startedAt, url });
      }
      return res.json({ sessions: arr });
    } catch (e) {
      return res.status(500).json({ error: 'failed to list sessions' });
    }
  });

  app.get('/auth/admin/logs', requireUiAuth, (req, res) => {
    try {
      const token = _getUiCookie(req);
      if (!token) return res.status(401).json({ error: 'unauthorized' });
      const sess = UI_SESSIONS.get(token);
      if (!sess) return res.status(401).json({ error: 'unauthorized' });
      const allowedCfg = process.env.AUTH_ADMIN_USERS || '';
      if (allowedCfg) {
        const allowed = allowedCfg.split(',').map(s=>s.trim()).filter(Boolean);
        if (!allowed.includes(sess.username)) return res.status(403).json({ error: 'forbidden' });
      }
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '50', 10)));
      const items = ACCESS_LOG.slice(-limit).map(i => i);
      return res.json({ count: items.length, logs: items });
    } catch (e) {
      return res.status(500).json({ error: 'failed to read logs', detail: e && e.message ? e.message : String(e) });
    }
  });

    async function runStealthChecks(page) {
      try {
        const result = await page.evaluate(async () => {
          const out = {};
          out.webdriver = !!navigator.webdriver;
          out.userAgent = navigator.userAgent || null;
          out.languages = navigator.languages || null;
          out.pluginsLength = (navigator.plugins && navigator.plugins.length) ? navigator.plugins.length : 0;
          out.hasChrome = !!window.chrome;
          out.vendor = navigator.vendor || null;
          out.platform = navigator.platform || null;
          out.doNotTrack = navigator.doNotTrack || null;
          try {
            if (navigator.permissions && navigator.permissions.query) {
              const p = await navigator.permissions.query({ name: 'notifications' });
              out.notificationsPermission = p && p.state ? p.state : null;
            } else {
              out.notificationsPermission = null;
            }
          } catch (e) { out.notificationsPermission = 'error'; }
          out.uaContainsHeadless = /HeadlessChrome|PhantomJS/i.test(navigator.userAgent);
          return out;
        });
        return { ok: true, checks: result };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }

    app.get('/auth/tests/:id', requireUiAuth, async (req, res) => {
      const id = req.params.id;
      const sess = SESSIONS.get(id);
      if (!sess) return res.status(404).json({ error: 'session not found' });
      try {
        const r = await runStealthChecks(sess.page);
        res.json(r);
      } catch (e) {
        res.status(500).json({ error: 'tests failed', detail: e && e.message ? e.message : String(e) });
      }
    });

    app.post('/auth/navigate/:id', requireUiAuth, async (req, res) => {
      const id = req.params.id;
      const sess = SESSIONS.get(id);
      if (!sess) return res.status(404).json({ error: 'session not found' });
      try {
        const body = req.body || {};
        const url = body.url || req.query.url;
        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'missing url' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid url scheme' });
        await sess.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        return res.json({ ok: true, url });
      } catch (e) {
        console.error('auth-server: navigate error', e && e.message ? e.message : e);
        return res.status(500).json({ error: 'navigate failed', detail: e && e.message ? e.message : String(e) });
      }
    });

    app.post('/auth/login/:id', requireUiAuth, async (req, res) => {
      const id = req.params.id;
      const sess = SESSIONS.get(id);
      if (!sess) return res.status(404).json({ error: 'session not found' });
      try {
        const { page } = sess;
        const body = req.body || {};
        const email = body.email || ''; const password = body.password || '';
        if (!email || !password) return res.status(400).json({ error: 'missing email or password' });
        try {
          await page.waitForSelector('input[type="email"]', { timeout: 10000 });
          await page.focus('input[type="email"]');
          await page.keyboard.type(email, { delay: 50 });
          try { await page.click('#identifierNext'); } catch (e) {}
          try { await page.click('button[jsname="LgbsSe"]'); } catch (e) {}
          await page.waitForTimeout(1000);
        } catch (e) {
          console.log('auth-server: email input not found during login attempt');
          return res.status(400).json({ error: 'email field not found', detail: e && e.message ? e.message : String(e) });
        }

        try {
          await page.waitForSelector('input[type="password"]', { timeout: 10000 });
          await page.focus('input[type="password"]');
          await page.keyboard.type(password, { delay: 50 });
          try { await page.click('#passwordNext'); } catch (e) {}
          try { await page.click('button[jsname="LgbsSe"]'); } catch (e) {}
        } catch (e) {
          console.warn('auth-server: password input not found during login attempt');
          return res.status(400).json({ error: 'password field not found', detail: e && e.message ? e.message : String(e) });
        }

        await page.waitForTimeout(2000);
        return res.json({ ok: true, message: 'login submitted — check session window for any additional verification' });
      } catch (e) {
        console.error('auth-server: login error', e && e.message ? e.message : e);
        return res.status(500).json({ error: 'login failed', detail: e && e.message ? e.message : String(e) });
      }
    });
    app.get('/auth/screenshot/:id', requireUiAuth, async (req, res) => {
    const id = req.params.id;
    const sess = SESSIONS.get(id);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    try {
      const { page } = sess;
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(buf);
    } catch (e) {
      console.error('auth-server: screenshot error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'failed to capture screenshot', detail: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/auth/stream/:id', requireUiAuth, async (req, res) => {
    const id = req.params.id;
    const sess = SESSIONS.get(id);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    const fps = Math.max(1, parseInt(req.query.fps || '1', 10));
    const intervalMs = Math.round(1000 / fps);
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection': 'close'
    });

    let stopped = false;
    req.on('close', () => { stopped = true; });

    const captureAndWrite = async () => {
      if (stopped) return;
      try {
        const current = SESSIONS.get(id);
        if (!current) {
          stopped = true; try { res.end(); } catch (er) {}
          return;
        }
        if (!current.page || (typeof current.page.isClosed === 'function' && current.page.isClosed()) || !current.browser || (typeof current.browser.isConnected === 'function' && !current.browser.isConnected())) {
          stopped = true; try { res.end(); } catch (er) {}
          return;
        }

        const buf = await current.page.screenshot({ type: 'jpeg', quality: 60 });
        res.write('--frame\r\n');
        res.write('Content-Type: image/jpeg\r\n');
        res.write('Content-Length: ' + buf.length + '\r\n\r\n');
        res.write(buf);
        res.write('\r\n');
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (/Session closed|Session is closed|Target closed|Protocol error/i.test(msg)) {
          stopped = true;
          try { res.end(); } catch (er) {}
          return;
        }
        console.error('auth-server: stream capture error', msg);
        stopped = true;
        try { res.end(); } catch (er) {}
      }
    };
    await captureAndWrite();
    const timer = setInterval(() => { if (!stopped) captureAndWrite(); else clearInterval(timer); }, intervalMs);
  });

  app.post('/auth/keyboard/:id', requireUiAuth, async (req, res) => {
    const id = req.params.id;
    const sess = SESSIONS.get(id);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    try {
      const { page } = sess;
      const body = req.body || {};
      if (body.type === 'type' && typeof body.text === 'string') {
        await page.keyboard.type(body.text, { delay: body.delay || 0 });
        return res.json({ ok: true });
      }
      if (body.type === 'press' && typeof body.key === 'string') {
        await page.keyboard.press(body.key, { delay: body.delay || 0 });
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: 'invalid payload' });
    } catch (e) {
      console.error('auth-server: keyboard error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'keyboard failed', detail: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/auth/mouse/:id', requireUiAuth, async (req, res) => {
    const id = req.params.id;
    const sess = SESSIONS.get(id);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    try {
      const { page } = sess;
      const body = req.body || {};
      const action = body.action || 'click';
      const button = body.button || 'left';

      let vw = null;
      let vh = null;
      if (page.viewport && page.viewport()) {
        const vp = page.viewport(); if (vp) { vw = vp.width; vh = vp.height; }
      }
      if (!vw || !vh) {
        const dims = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        vw = dims.w; vh = dims.h;
      }

      const px = typeof body.px === 'number' ? body.px : 0.5;
      const py = typeof body.py === 'number' ? body.py : 0.5;
      const x = Math.round(Math.max(0, Math.min(1, px)) * (vw || 1));
      const y = Math.round(Math.max(0, Math.min(1, py)) * (vh || 1));

      if (action === 'click') {
        await page.mouse.click(x, y, { button: button, clickCount: body.clickCount || 1 });
        return res.json({ ok: true, x, y });
      }
      if (action === 'move') {
        await page.mouse.move(x, y);
        return res.json({ ok: true, x, y });
      }
      if (action === 'down') { await page.mouse.down({ button }); return res.json({ ok: true }); }
      if (action === 'up') { await page.mouse.up({ button }); return res.json({ ok: true }); }

      return res.status(400).json({ error: 'invalid mouse action' });
    } catch (e) {
      console.error('auth-server: mouse error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'mouse failed', detail: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/auth/close/:id', requireUiAuth, async (req, res) => {
    const id = req.params.id;
    const sess = SESSIONS.get(id);
    if (!sess) return res.status(404).json({ error: 'session not found' });
    try { await sess.browser.close(); } catch (e) {}
    try {
      if (sess && sess.profileDir && sess.ownedProfile) {
        try { fs.rmSync(sess.profileDir, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {}
    SESSIONS.delete(id);
    res.json({ closed: true });
  });

  return app;
}

async function startAuthServer(port = process.env.AUTH_PORT || 3001) {
  const app = createAuthApp();
  return new Promise((resolve, reject) => {
    const s = app.listen(port, (err) => {
      if (err) return reject(err);
      console.log('darkchair_api_youtube auth-server listening on', port);
      resolve(s);
    });
  });
}

if (require.main === module) {
  startAuthServer().catch((e) => console.error('failed to start auth-server:', e && e.message ? e.message : e));
}

module.exports = { isAvailable, stream, getInfo, startAuthServer, createAuthApp };

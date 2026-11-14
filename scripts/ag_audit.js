#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const childProcess = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DICTS_DIR = path.join(PROJECT_ROOT, 'dicts');
const ENGINE_PATH = path.join(PROJECT_ROOT, 'localization_engine.js');

// ---------------------------------------------------------------------------
// 0. 命令行参数解析与 Engine 只读沙箱加载
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const positionals = [];
  const options = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--asar' || arg === '--install-dir') {
      options.asarPath = argv[++i] || '';
    } else if (arg === '--port') {
      options.port = Number(argv[++i]);
    } else if (arg === '--main-js') {
      options.mainJsPath = argv[++i] || '';
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      positionals.push(arg);
    }
  }

  return { cmd: positionals[0], args: positionals.slice(1), options };
}

/** 创建只读 fs 视图，确保在加载/调用 localization_engine.js 时绝不修改磁盘 */
function createReadOnlyFsProxy() {
  const blocked = fnName => () => {
    throw new Error(`[安全拦截] 只读巡检模式下禁止调用 fs.${fnName}`);
  };
  const writeMethods = new Set([
    'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
    'unlinkSync', 'unlink', 'renameSync', 'rename',
    'copyFileSync', 'copyFile', 'chmodSync', 'chmod',
    'rmSync', 'rm', 'rmdirSync', 'rmdir', 'mkdirSync', 'mkdir',
    'openSync'
  ]);
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'openSync') {
        return (filePath, flags, mode) => {
          if (typeof flags === 'string' && !/^r\+?$/.test(flags) && flags !== 'r') {
            throw new Error(`[安全拦截] 只读巡检模式下禁止以写入标志 (${flags}) 打开文件: ${filePath}`);
          }
          return target.openSync(filePath, flags, mode);
        };
      }
      if (writeMethods.has(prop)) return blocked(String(prop));
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

let cachedEngineRuntime = null;

/** 在独立 VM 沙箱中加载 localization_engine.js（剥离 main() 入口，纯只读） */
function loadEngineSandbox() {
  if (cachedEngineRuntime) return cachedEngineRuntime;
  if (!fs.existsSync(ENGINE_PATH)) return null;

  const rawCode = fs.readFileSync(ENGINE_PATH, 'utf8');
  const strippedCode = rawCode.replace(/\n\s*main\(\);\s*$/, '\n');

  const safeProcess = Object.assign(Object.create(process), {
    argv: [process.execPath, ENGINE_PATH]
  });

  const roFs = createReadOnlyFsProxy();
  const safeRequire = id => {
    if (id === 'fs') return roFs;
    return require(id);
  };

  const sandbox = {
    require: safeRequire,
    process: safeProcess,
    console: { log() {}, warn() {}, error() {} },
    Buffer,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    __filename: ENGINE_PATH,
    __dirname: PROJECT_ROOT
  };

  vm.createContext(sandbox);
  vm.runInContext(strippedCode, sandbox, { filename: 'localization_engine.readonly.js' });

  cachedEngineRuntime = { rawCode, sandbox };
  return cachedEngineRuntime;
}

// ---------------------------------------------------------------------------
// 1. 词典加载与静态规范质检 (dicts)
// ---------------------------------------------------------------------------

function loadAllDicts() {
  const files = fs.readdirSync(DICTS_DIR).filter(f => f.endsWith('.json')).sort();
  const byFile = {};
  for (const file of files) {
    byFile[file] = JSON.parse(fs.readFileSync(path.join(DICTS_DIR, file), 'utf8'));
  }
  return { files, byFile };
}

/** 动态收集仓库技能名与内置高危英文停用词，避免通配单字污染 */
function buildRiskyWordSet() {
  const words = new Set([
    'on', 'in', 'to', 'at', 'by', 'of', 'for', 'from', 'with', 'as', 'is', 'are',
    'be', 'will', 'can', 'may', 'do', 'does', 'did', 'has', 'have', 'had', 'this',
    'that', 'it', 'its', 'or', 'and', 'not', 'no', 'yes', 'all', 'any', 'new',
    'automation', 'plugin', 'command', 'skill', 'agent', 'swarm'
  ]);

  const skillRoots = [
    path.join(PROJECT_ROOT, '.agents', 'skills'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.gemini', 'antigravity', 'builtin', 'skills')
  ];
  for (const root of skillRoots) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-z]+$/i.test(entry.name)) {
          words.add(entry.name.toLowerCase());
        }
      }
    } catch (e) {}
  }
  return words;
}

/** 检查分包重复键、大小写冗余、1:1 半角标点规范及孤立单字风险 */
function auditDictionaries() {
  const { files, byFile } = loadAllDicts();
  const riskyWords = buildRiskyWordSet();
  const stats = {};
  const crossFileDuplicates = [];
  const caseCollisions = [];
  const punctuationIssues = [];
  const riskySingleWords = [];

  const seenExact = new Map();
  const seenLower = new Map();

  for (const file of files) {
    const data = byFile[file];
    const entries = Object.entries(data);
    stats[file] = entries.length;

    for (const [key, val] of entries) {
      if (seenExact.has(key)) {
        crossFileDuplicates.push({ key, files: [seenExact.get(key), file], value: val });
      } else {
        seenExact.set(key, file);
      }

      const lk = key.toLowerCase();
      if (seenLower.has(lk) && seenLower.get(lk).key !== key) {
        caseCollisions.push({ first: seenLower.get(lk), second: { file, key, value: val } });
      } else if (!seenLower.has(lk)) {
        seenLower.set(lk, { file, key, value: val });
      }

      if (typeof val === 'string' && val.length > 0) {
        const kLast = key.slice(-1);
        const vLast = val.slice(-1);
        if (kLast === '.' && !key.endsWith('...') && vLast !== '.') {
          punctuationIssues.push({ type: '缺少或错误末尾句号(.)', file, key, value: val });
        } else if (kLast !== '.' && kLast !== '…' && (vLast === '.' || vLast === '。')) {
          punctuationIssues.push({ type: '英文无句号但译文末尾多了句号', file, key, value: val });
        }
        if (/[：（）！？；“”‘’]/.test(val)) {
          const matched = val.match(/[：（）！？；“”‘’]/g).join('');
          punctuationIssues.push({ type: `包含全角标点(${matched})`, file, key, value: val });
        }
      }

      if (/^[a-zA-Z]+$/.test(key) && riskyWords.has(lk)) {
        riskySingleWords.push({ file, key, value: val });
      }
    }
  }

  const totalEntries = Object.values(stats).reduce((a, b) => a + b, 0);
  return {
    totalEntries,
    stats,
    crossFileDuplicates,
    caseCollisions,
    punctuationIssues,
    riskySingleWords
  };
}

// ---------------------------------------------------------------------------
// 2. 注入脚本生成只读沙箱校验 (engine)
// ---------------------------------------------------------------------------

/** 校验 localization_engine.js 的 generateJs() 编译合法性（不执行安装） */
function auditEngineScript() {
  const engine = loadEngineSandbox();
  if (!engine || typeof engine.sandbox.generateJs !== 'function') {
    return { ok: false, error: '未能在 localization_engine.js 中加载 generateJs()' };
  }

  try {
    const generated = engine.sandbox.generateJs();
    new vm.Script(generated, { filename: 'preload_injection_preview.js' });
    return {
      ok: true,
      scriptBytes: Buffer.byteLength(generated, 'utf8'),
      scriptLines: generated.split('\n').length
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 3. 动态提取 Engine 主进程补丁锚点 & app.asar 只读体检 (asar)
// ---------------------------------------------------------------------------

/** 从指定索引扫描一个 JS 字符串或正则字面量并安全解码为值 */
function parseJsLiteralAt(code, startIdx) {
  let i = startIdx;
  while (i < code.length && /\s/.test(code[i])) i++;
  const ch = code[i];

  if (ch === "'" || ch === '"' || ch === '`') {
    const quote = ch;
    i++;
    let raw = '';
    while (i < code.length) {
      const c = code[i];
      if (c === '\\' && i + 1 < code.length) {
        const next = code[i + 1];
        if (next === 'n') raw += '\n';
        else if (next === 'r') raw += '\r';
        else if (next === 't') raw += '\t';
        else if (next === '\\') raw += '\\';
        else if (next === quote) raw += quote;
        else if (next === "'" || next === '"' || next === '`') raw += next;
        else raw += '\\' + next;
        i += 2;
      } else if (c === quote) {
        return { kind: 'string', value: raw, endIdx: i + 1 };
      } else {
        raw += c;
        i++;
      }
    }
  }

  if (ch === '/') {
    i++;
    let body = '';
    let inClass = false;
    while (i < code.length) {
      const c = code[i];
      if (c === '\\' && i + 1 < code.length) {
        body += c + code[i + 1];
        i += 2;
      } else if (c === '[') {
        inClass = true;
        body += c;
        i++;
      } else if (c === ']' && inClass) {
        inClass = false;
        body += c;
        i++;
      } else if (c === '/' && !inClass) {
        i++;
        let flags = '';
        while (i < code.length && /[gimsuvy]/.test(code[i])) flags += code[i++];
        return { kind: 'regex', value: new RegExp(body, flags.replace(/g/g, '')), endIdx: i };
      } else {
        body += c;
        i++;
      }
    }
  }

  return null;
}

/** 将代码块中的字符串、模板字面量及正则内部屏蔽为空格，只保留外层调用与声明结构 */
function maskNonCodeRegions(code) {
  const out = code.split('');
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') { out[i++] = ' '; }
    } else if (ch === '/' && code[i + 1] === '*') {
      out[i++] = ' '; out[i++] = ' ';
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { out[i++] = ' '; }
      if (i + 1 < code.length) { out[i++] = ' '; out[i++] = ' '; }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const lit = parseJsLiteralAt(code, i);
      if (lit) {
        for (let k = i; k < lit.endIdx; k++) out[k] = ' ';
        i = lit.endIdx;
        continue;
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** 解析代码片段外层声明的字面量变量映射（const/let/var name = literal） */
function extractLocalLiteralVars(blockCode, maskedCode) {
  const vars = new Map();
  const varRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = varRe.exec(maskedCode)) !== null) {
    const parsed = parseJsLiteralAt(blockCode, varRe.lastIndex);
    if (parsed) vars.set(m[1], parsed.value);
  }
  return vars;
}

/** 从 localization_engine.js 动态解析各 dist/*.js 补丁锚点与所在块源码 */
function extractEnginePatchSpecs() {
  const engine = loadEngineSandbox();
  if (!engine) return { sections: new Map(), anchors: [] };

  const code = engine.rawCode;
  const startIdx = code.indexOf('function installLocalization(');
  if (startIdx === -1) return { sections: new Map(), anchors: [] };
  const body = code.slice(startIdx);

  const sectionRe = /\/\/\s*\d+\.\s*(dist\/[A-Za-z0-9_.-]+\.js)\b/g;
  const headers = [];
  let hm;
  while ((hm = sectionRe.exec(body)) !== null) {
    headers.push({ file: hm[1], index: hm.index });
  }

  const sections = new Map();
  const anchors = [];

  for (let i = 0; i < headers.length; i++) {
    const file = headers[i].file;
    const end = i + 1 < headers.length ? headers[i + 1].index : body.indexOf('// 10.', headers[i].index);
    const block = body.slice(headers[i].index, end > headers[i].index ? end : body.length);
    const maskedBlock = maskNonCodeRegions(block);
    sections.set(file, block);

    const vars = extractLocalLiteralVars(block, maskedBlock);
    const seenKeys = new Set();
    const pushAnchor = (pattern, descHint) => {
      const key = pattern instanceof RegExp ? pattern.source : String(pattern);
      if (!key || seenKeys.has(key)) return;
      seenKeys.add(key);
      anchors.push({ file, desc: descHint, pattern });
    };

    // 仅在外层非字符串/模板字面量代码区提取 .replace / .match / .indexOf / .includes 的匹配目标
    const callRe = /\.(?:replace|replaceAll|match|indexOf|includes)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(maskedBlock)) !== null) {
      let argIdx = callRe.lastIndex;
      while (argIdx < block.length && /\s/.test(block[argIdx])) argIdx++;

      const lit = parseJsLiteralAt(block, argIdx);
      if (lit) {
        const preview = (lit.value instanceof RegExp ? lit.value.source : String(lit.value)).replace(/\s+/g, ' ').slice(0, 52);
        pushAnchor(lit.value, preview);
        continue;
      }

      const identMatch = maskedBlock.slice(argIdx).match(/^([A-Za-z_$][\w$]*)\b/);
      if (identMatch && vars.has(identMatch[1])) {
        const val = vars.get(identMatch[1]);
        const preview = `${identMatch[1]}: ${(val instanceof RegExp ? val.source : String(val)).replace(/\s+/g, ' ').slice(0, 42)}`;
        pushAnchor(val, preview);
      }
    }
  }

  return { sections, anchors };
}

/** 将候选安装根目录、exe 或资源路径规范解析为存在 app.asar(.bak) 的目录 */
function resolveResourcesFromPath(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return null;
  let resolved = path.resolve(candidate);
  const stat = fs.statSync(resolved);

  if (stat.isFile()) {
    const base = path.basename(resolved).toLowerCase();
    if (base === 'app.asar' || base === 'app.asar.bak') {
      resolved = path.dirname(resolved);
    } else {
      resolved = path.dirname(resolved);
    }
  }

  const dirsToTry = [
    resolved,
    path.join(resolved, 'resources'),
    path.join(resolved, 'Contents', 'Resources'),
    path.resolve(resolved, '..'),
    path.resolve(resolved, '..', 'resources'),
    path.resolve(resolved, '..', 'Contents', 'Resources')
  ];

  for (const dir of dirsToTry) {
    const bak = path.join(dir, 'app.asar.bak');
    const asar = path.join(dir, 'app.asar');
    if (fs.existsSync(bak)) return { resourcesDir: dir, targetPath: bak, isBackup: true };
    if (fs.existsSync(asar)) return { resourcesDir: dir, targetPath: asar, isBackup: false };
  }
  return null;
}

/** 通过运行态 Electron 主进程实时定位当前使用的 Antigravity 目录 */
function detectRunningAppCandidates() {
  const paths = [];
  try {
    if (process.platform === 'linux') {
      const out = childProcess.execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        if (/antigravity/i.test(line) && !line.includes('--type=') && !line.includes('language_server')) {
          const m = line.trim().match(/^(\d+)\s+/);
          if (!m) continue;
          try {
            const exeReal = fs.realpathSync(`/proc/${m[1]}/exe`);
            paths.push(path.dirname(exeReal));
          } catch (e) {}
        }
      }
    } else if (process.platform === 'darwin') {
      const out = childProcess.execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/(\/[^\n]*?\.app)\/Contents\/MacOS\/Antigravity\b/i);
        if (m) paths.push(m[1]);
      }
    } else if (process.platform === 'win32') {
      const out = childProcess.execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object -ExpandProperty ExecutablePath"],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) paths.push(path.dirname(trimmed));
      }
    }
  } catch (e) {}
  return paths;
}

/** 动态探测 Antigravity app.asar(.bak)：显式参数 > 环境变量 > 运行中进程 > Engine 跨平台探测 */
function locateAsarPath(explicitPath) {
  const directInputs = [
    explicitPath,
    process.env.ANTIGRAVITY_ASAR,
    process.env.ANTIGRAVITY_INSTALL_DIR
  ].filter(Boolean);

  for (const input of directInputs) {
    const found = resolveResourcesFromPath(input);
    if (found) return found;
  }

  for (const runningDir of detectRunningAppCandidates()) {
    const found = resolveResourcesFromPath(runningDir);
    if (found) return found;
  }

  const engine = loadEngineSandbox();
  if (engine && typeof engine.sandbox.detectInstallationDir === 'function') {
    try {
      const installDir = engine.sandbox.detectInstallationDir('', { quiet: true });
      const found = resolveResourcesFromPath(installDir);
      if (found) return found;
    } catch (e) {}
  }

  return null;
}

function openAsarReader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const headerPickleSize = sizeBuf.readUInt32LE(4);
  const headerStrLen = sizeBuf.readUInt32LE(12);
  const headerBuf = Buffer.alloc(headerStrLen);
  fs.readSync(fd, headerBuf, 0, headerStrLen, 16);
  const header = JSON.parse(headerBuf.toString('utf8'));
  const baseOffset = 8 + headerPickleSize;

  const fileEntries = new Map();
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, full);
      else fileEntries.set(full, entry);
    }
  };
  walk(header, '');

  return {
    listPaths: () => [...fileEntries.keys()].sort(),
    readText: relPath => {
      const entry = fileEntries.get(relPath);
      if (!entry || entry.unpacked) return null;
      const buf = Buffer.alloc(Number(entry.size));
      fs.readSync(fd, buf, 0, buf.length, baseOffset + Number(entry.offset));
      return buf.toString('utf8');
    },
    close: () => fs.closeSync(fd)
  };
}

/** 验证 app.asar 注入锚点（全部动态源自 localization_engine.js）及原生菜单覆盖情况 */
function auditAsarPackage(explicitPath) {
  const loc = locateAsarPath(explicitPath);
  if (!loc) return { found: false };

  const reader = openAsarReader(loc.targetPath);
  try {
    const allPaths = reader.listPaths();
    const distFiles = allPaths.filter(p => p.startsWith('dist/') && !p.includes('node_modules'));

    const { sections, anchors } = extractEnginePatchSpecs();
    const anchorResults = anchors.map(a => {
      const text = reader.readText(a.file);
      if (!text) return { ...a, status: 'MISSING_FILE' };
      const ok = typeof a.pattern === 'string' ? text.includes(a.pattern) : a.pattern.test(text);
      return { ...a, status: ok ? 'OK' : 'BROKEN' };
    });

    const nativeFindings = [];

    const updaterSection = sections.get('dist/updater.js') || '';
    const updaterText = reader.readText('dist/updater.js') || '';
    for (const m of updaterText.matchAll(/MenuUpdateStep\["[^"]+"\]\s*=\s*"([^"]+)"/g)) {
      const label = m[1];
      if (!updaterSection.includes(`'${label}'`) && !updaterSection.includes(`"${label}"`)) {
        nativeFindings.push({
          file: 'dist/updater.js',
          location: '应用菜单栏 - 检查更新动态状态 (MenuUpdateStep)',
          text: label
        });
      }
    }

    const menuSection = sections.get('dist/menu.js') || '';
    const menuText = reader.readText('dist/menu.js') || '';
    for (const m of menuText.matchAll(/\blabel\s*:\s*(?:'([^']+)'|"([^"]+)")/g)) {
      const label = (m[1] || m[2] || '').replace('&', '');
      if (label && /[A-Za-z]{2,}/.test(label) && !menuSection.includes(`'${label}'`) && !menuSection.includes(`"${label}"`)) {
        nativeFindings.push({
          file: 'dist/menu.js',
          location: '应用主菜单定义',
          text: label
        });
      }
    }

    return {
      found: true,
      targetPath: loc.targetPath,
      distFilesCount: distFiles.length,
      anchorResults,
      nativeFindings
    };
  } finally {
    reader.close();
  }
}

// ---------------------------------------------------------------------------
// 4. 本地运行态 language_server 连接（仅用于 main.js 搜索与切片）
// ---------------------------------------------------------------------------

/** 枚举全部正在运行的 language_server 实例及其监听端口 */
function discoverLanguageServers() {
  const servers = [];
  try {
    if (process.platform === 'win32') {
      const out = childProcess.execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (!out.trim()) return servers;
      let list = JSON.parse(out.trim());
      if (!Array.isArray(list)) list = [list];
      for (const proc of list) {
        if (!proc || !proc.ProcessId || !proc.CommandLine || !proc.CommandLine.includes('language_server')) continue;
        try {
          const netOut = childProcess.execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `Get-NetTCPConnection -OwningProcess ${proc.ProcessId} -State Listen | Select-Object -ExpandProperty LocalPort`],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          );
          const ports = netOut.trim().split(/\r?\n/).map(x => Number(x.trim())).filter(n => !isNaN(n));
          if (ports.length > 0) servers.push({ pid: proc.ProcessId, ports });
        } catch (e) {}
      }
      return servers;
    }

    const psOut = childProcess.execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of psOut.split(/\r?\n/)) {
      if (!line.includes('language_server')) continue;
      const m = line.trim().match(/^(\d+)\s+/);
      if (!m) continue;
      const pid = Number(m[1]);
      try {
        const lsofOut = childProcess.execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const ports = [];
        for (const pm of lsofOut.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
          const p = Number(pm[1]);
          if (!ports.includes(p)) ports.push(p);
        }
        if (ports.length > 0) servers.push({ pid, ports });
      } catch (e) {}
    }
  } catch (e) {}
  return servers;
}

function localHttpsRequest(port, reqPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: options.method || 'GET',
        rejectUnauthorized: false,
        timeout: options.timeout || 5000,
        headers: options.headers || {}
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function looksLikeJavaScriptBundle(res) {
  if (!res || res.statusCode !== 200 || !res.body) return false;
  const ct = String((res.headers && res.headers['content-type']) || '');
  if (/javascript|ecmascript/i.test(ct) && res.body.length > 1024) return true;
  return /^(?:'use strict'|"use strict"|!\s*function|\(\s*function|var\s+|\/\*)/i.test(res.body.trimStart()) && res.body.length > 1024;
}

async function connectLiveRuntime(options = {}) {
  if (options.mainJsPath && fs.existsSync(options.mainJsPath)) {
    return { pid: 0, port: 0, mainJs: fs.readFileSync(options.mainJsPath, 'utf8') };
  }

  if (options.port && !isNaN(options.port)) {
    try {
      const res = await localHttpsRequest(options.port, '/main.js', { timeout: 2500 });
      if (looksLikeJavaScriptBundle(res)) {
        return { pid: 0, port: options.port, mainJs: res.body };
      }
    } catch (e) {}
    return null;
  }

  const servers = discoverLanguageServers();
  for (const srv of servers) {
    for (const port of srv.ports) {
      try {
        const res = await localHttpsRequest(port, '/main.js', { timeout: 2500 });
        if (looksLikeJavaScriptBundle(res)) {
          return { pid: srv.pid, port, mainJs: res.body };
        }
      } catch (e) {}
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. CLI 输出与分发
// ---------------------------------------------------------------------------

function printDictsReport(res) {
  console.log(`词典统计: 共 ${res.totalEntries} 条 (${Object.keys(res.stats).length} 个文件)`);
  console.log(`跨文件重键: ${res.crossFileDuplicates.length} | 大小写冲突: ${res.caseCollisions.length} | 标点规范差异: ${res.punctuationIssues.length} | 高危单字: ${res.riskySingleWords.length}`);
  if (res.crossFileDuplicates.length > 0) {
    console.log('\n[跨分包重键]');
    for (const d of res.crossFileDuplicates) console.log(`  - ${d.files.join(' / ')}: ${d.key}`);
  }
  if (res.caseCollisions.length > 0) {
    console.log('\n[大小写重复键]');
    for (const c of res.caseCollisions) console.log(`  - [${c.first.file}] "${c.first.key}" <-> [${c.second.file}] "${c.second.key}"`);
  }
  if (res.punctuationIssues.length > 0) {
    console.log('\n[标点规范差异]');
    for (const p of res.punctuationIssues) console.log(`  - [${p.file}] ${p.type}: "${p.key}" => "${p.value}"`);
  }
  if (res.riskySingleWords.length > 0) {
    console.log('\n[孤立单字预警（确认需受独立控件守卫保护）]');
    for (const w of res.riskySingleWords) console.log(`  - [${w.file}] "${w.key}" => "${w.value}"`);
  }
}

function printEngineReport(res) {
  if (res.ok) {
    console.log(`generateJs() 只读沙箱编译通过 (${res.scriptBytes} bytes, ${res.scriptLines} 行)`);
  } else {
    console.error(`[!] generateJs() 编译失败: ${res.error}`);
  }
}

function printAsarReport(res) {
  if (!res.found) {
    console.error('[!] 未在系统或运行态进程中定位到 Antigravity app.asar（可通过 --asar <path> 指定）');
    return;
  }
  console.log(`已读取: ${res.targetPath} (${res.distFilesCount} 个 dist 模块 | 动态提取 ${res.anchorResults.length} 项 Engine 锚点)`);
  for (const a of res.anchorResults) {
    console.log(`  [${a.status}] ${a.file} - ${a.desc}`);
  }
  if (res.nativeFindings.length > 0) {
    console.log('\n原生菜单/状态未覆盖文案:');
    for (const n of res.nativeFindings) console.log(`  - [${n.file}] (${n.location}) "${n.text}"`);
  }
}

async function runCommand() {
  const { cmd, args, options } = parseCliArgs(process.argv.slice(2));

  if (!cmd || cmd === 'help' || options.help) {
    console.log('Antigravity 中文汉化巡检与源码排查工具 (scripts/ag_audit.js)');
    console.log('可用子命令:');
    console.log('  node scripts/ag_audit.js check [--asar <path>]             # 一键运行 dicts + engine + asar 全套静态巡检');
    console.log('  node scripts/ag_audit.js dicts                             # 词典规范静态质检 (重键/大小写/标点/孤立单字)');
    console.log('  node scripts/ag_audit.js engine                            # 只读沙箱校验 generateJs() 注入脚本语法');
    console.log('  node scripts/ag_audit.js asar [--asar <path>]              # 动态解析 Engine 锚点并体检 app.asar 原生菜单');
    console.log('  node scripts/ag_audit.js search <kw> [len] [--port <p>]    # 在运行中 main.js 搜索关键词上下文');
    console.log('  node scripts/ag_audit.js slice <pos> [len] [--main-js <f>] # 查看运行中或本地 main.js 指定偏移切片');
    return;
  }

  if (cmd === 'dicts') {
    const res = auditDictionaries();
    printDictsReport(res);
    if (res.crossFileDuplicates.length > 0 || res.caseCollisions.length > 0 || res.punctuationIssues.length > 0) {
      process.exit(1);
    }
    return;
  }

  if (cmd === 'engine') {
    const res = auditEngineScript();
    printEngineReport(res);
    if (!res.ok) process.exit(1);
    return;
  }

  if (cmd === 'asar') {
    const res = auditAsarPackage(options.asarPath);
    printAsarReport(res);
    if (!res.found || res.anchorResults.some(a => a.status !== 'OK')) {
      process.exit(1);
    }
    return;
  }

  if (cmd === 'check') {
    console.log('=== 1. 词典规范质检 (dicts) ===');
    const dictsRes = auditDictionaries();
    printDictsReport(dictsRes);

    console.log('\n=== 2. 注入脚本只读沙箱校验 (engine) ===');
    const engineRes = auditEngineScript();
    printEngineReport(engineRes);

    console.log('\n=== 3. 桌面壳动态锚点体检 (asar) ===');
    const asarRes = auditAsarPackage(options.asarPath);
    printAsarReport(asarRes);

    const hasDictIssue = dictsRes.crossFileDuplicates.length > 0 || dictsRes.caseCollisions.length > 0 || dictsRes.punctuationIssues.length > 0;
    const hasAnchorIssue = asarRes.found && asarRes.anchorResults.some(a => a.status !== 'OK');
    if (hasDictIssue || !engineRes.ok || hasAnchorIssue) {
      process.exit(1);
    }
    return;
  }

  if (cmd !== 'search' && cmd !== 'slice') {
    console.error(`[!] 未知子命令: ${cmd}，请运行 node scripts/ag_audit.js --help 查看用法。`);
    process.exit(1);
  }

  const rt = await connectLiveRuntime(options);
  if (!rt) {
    console.error('[!] 未检测到正在运行的 Antigravity 客户端 (language_server)，请先启动客户端或使用 --main-js 指定脚本。');
    process.exit(1);
  }

  if (cmd === 'search') {
    const kw = args[0];
    const ctxLen = Number(args[1]) || 240;
    if (!kw) return console.error('用法: node scripts/ag_audit.js search <keyword> [contextLen]');
    let idx = 0;
    let count = 0;
    while ((idx = rt.mainJs.indexOf(kw, idx)) !== -1) {
      count++;
      console.log(`\n--- 匹配 #${count} @${idx} ---`);
      console.log(rt.mainJs.slice(Math.max(0, idx - ctxLen), Math.min(rt.mainJs.length, idx + kw.length + ctxLen)));
      idx += kw.length;
      if (count >= 20) {
        console.log('\n...(已限制显示前 20 条)');
        break;
      }
    }
    console.log(`\n共找到 ${count} 处匹配。`);
    return;
  }

  if (cmd === 'slice') {
    const pos = Number(args[0]);
    const len = Number(args[1]) || 500;
    if (isNaN(pos)) return console.error('用法: node scripts/ag_audit.js slice <offset> [len]');
    console.log(rt.mainJs.slice(pos, pos + len));
    return;
  }
}

runCommand().catch(err => {
  console.error('[错误]', err.message);
  process.exit(1);
});

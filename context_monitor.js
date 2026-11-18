'use strict';

(function initAntigravityContextMonitor() {
    if (typeof process === 'undefined' || process.type !== 'browser') return;
    if (global.__agContextMonitorInstalled) return;
    global.__agContextMonitorInstalled = true;

    const http = require('http');
    const https = require('https');
    const { app, ipcMain, BrowserWindow, webContents } = require('electron');
    const languageServer = require('./languageServer');
    let hubUtils = null;
    try {
        hubUtils = require('./utils');
    } catch {}

    const RPC_SERVICE = '/exa.language_server_pb.LanguageServerService/';
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const SETTLED_STATUS_RE = /IDLE|WAITING_FOR_USER|DONE|COMPLETED|CANCELLED|CANCELED|STOPPED|FAILED|ERROR/i;
    const RUNNING_STATUS_RE = /RUNNING|BUSY|IN_PROGRESS/i;
    const LOCAL_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;

    const portProtocols = new Map();
    const sessionCache = new Map();
    const inflightRequests = new Map();
    let summariesCache = { endpointKey: '', pending: null };
    let modelCatalogCache = { endpointKey: '', map: new Map(), fetchedAt: 0, pending: null };

    // -------------------------------------------------------------------------
    // 1. 轻量级流式 JSON 白名单投影器（避免长对话大包占用内存）
    // -------------------------------------------------------------------------

    const SCALAR = 'scalar';
    const DURATION = Symbol('duration');
    const DURATION_OBJECT_SCHEMA = { seconds: SCALAR, nanos: SCALAR };
    const DROP = Symbol('drop');
    const SUMMARY_ENTRY = Symbol('summaryEntry');

    const TOKEN_GROUP_SCHEMA = {
        name: SCALAR,
        numTokens: SCALAR,
        children: {
            '*': {
                name: SCALAR,
                numTokens: SCALAR,
            },
        },
    };
    const TOP_LEVEL_TOKEN_GROUP_SCHEMA = {
        name: SCALAR,
        type: SCALAR,
        source: SCALAR,
        numTokens: SCALAR,
        children: { '*': TOKEN_GROUP_SCHEMA },
    };

    const SUMMARY_SCHEMA = {
        stepCount: SCALAR,
        lastModifiedTime: SCALAR,
        status: SCALAR,
        lastUserInputStepIndex: SCALAR,
    };
    const GENERATOR_SCHEMA = {
        chatModel: {
            model: SCALAR,
            modelDisplayName: SCALAR,
            responseModel: SCALAR,
            timeToFirstToken: DURATION,
            streamingDuration: DURATION,
            usage: {
                apiProvider: SCALAR,
                inputTokens: SCALAR,
                outputTokens: SCALAR,
                responseOutputTokens: SCALAR,
                thinkingOutputTokens: SCALAR,
                cacheReadTokens: SCALAR,
                cacheWriteTokens: SCALAR,
            },
            chatStartMetadata: {
                createdAt: SCALAR,
                startStepIndex: SCALAR,
                checkpointIndex: SCALAR,
                contextWindowMetadata: {
                    estimatedTokensUsed: SCALAR,
                    maxContextTokens: SCALAR,
                    tokenBreakdown: {
                        totalTokens: SCALAR,
                        groups: { '*': TOP_LEVEL_TOKEN_GROUP_SCHEMA },
                    },
                },
            },
        },
    };
    const CLIENT_MODEL_CONFIG_SCHEMA = {
        label: SCALAR,
        modelId: SCALAR,
        modelOrAlias: {
            model: SCALAR,
            alias: SCALAR,
        },
    };
    const MODEL_CONFIG_DATA_SCHEMA = {
        clientModelConfigs: { '*': CLIENT_MODEL_CONFIG_SCHEMA },
    };
    const SUMMARIES_MAP_SCHEMA = { [SUMMARY_ENTRY]: SUMMARY_SCHEMA };
    const GENERATORS_ARRAY_SCHEMA = { '*': GENERATOR_SCHEMA };
    const RPC_PROJECTION_SCHEMA = {
        trajectorySummaries: SUMMARIES_MAP_SCHEMA,
        generatorMetadata: GENERATORS_ARRAY_SCHEMA,
        generatorMetadatas: GENERATORS_ARRAY_SCHEMA,
        userStatus: { cascadeModelConfigData: MODEL_CONFIG_DATA_SCHEMA },
        cascadeModelConfigData: MODEL_CONFIG_DATA_SCHEMA,
    };

    const STREAM_MAX_BYTES = 4 * 1024 * 1024;
    const STREAM_MAX_DEPTH = 64;
    const JSON_ESCAPE_CHARS = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    const JSON_NUMBER_RE = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

    /** 创建按白名单裁剪字段的流式 JSON 解析器，防止长对话 RPC 响应占满内存 */
    function createRpcJsonFilter(rootSchema = RPC_PROJECTION_SCHEMA, maxBytes = STREAM_MAX_BYTES) {
        const frames = [];
        let activeToken = null;
        let rootValue;
        let completed = false;
        let retainedBytes = 0;

        const raise = (msg) => {
            throw new Error(msg || 'Language server 返回了无效 JSON');
        };

        const addCost = (bytes) => {
            retainedBytes += bytes;
            if (retainedBytes > maxBytes) raise('RPC 响应投影体积超出内存上限');
        };

        const topFrame = () => frames[frames.length - 1];

        const resolveSlotSchema = () => {
            const top = topFrame();
            if (!top) return rootSchema;
            if (top.schema === SUMMARIES_MAP_SCHEMA) {
                return !top.isArray && UUID_RE.test(top.field || '') ? top.schema[SUMMARY_ENTRY] : undefined;
            }
            const lookupKey = top.isArray ? '*' : top.field;
            return top.schema && typeof top.schema === 'object' && Object.prototype.hasOwnProperty.call(top.schema, lookupKey)
                ? top.schema[lookupKey]
                : undefined;
        };

        const canReadValue = () => {
            const top = topFrame();
            return top ? (top.stage === 'value' || top.stage === 'valueOrEnd') : !completed;
        };

        const commitValue = (val) => {
            const top = topFrame();
            if (!top) {
                if (completed) raise();
                rootValue = val;
                completed = true;
                return;
            }
            if (top.stage !== 'value' && top.stage !== 'valueOrEnd') raise();
            if (val !== DROP && top.target) {
                addCost(32 + (top.schema === SUMMARIES_MAP_SCHEMA ? top.field.length * 2 : 0));
                if (top.isArray) {
                    top.target.push(val);
                } else {
                    Object.defineProperty(top.target, top.field, {
                        value: val,
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    });
                }
            }
            top.stage = 'commaOrEnd';
            top.field = null;
        };

        const appendStringChunk = (text) => {
            const tk = activeToken;
            if (!tk.isKey && tk.schema !== SCALAR && tk.schema !== DURATION) return;
            if (tk.truncated) return;
            tk.buf += text;
            const cap = tk.isKey ? 1024 : 4096;
            if (tk.buf.length > cap) {
                tk.buf = tk.isKey ? '' : tk.buf.slice(0, cap);
                tk.truncated = true;
            }
        };

        const closeString = () => {
            const tk = activeToken;
            activeToken = null;
            if (tk.isKey) {
                const top = topFrame();
                top.field = tk.truncated
                    ? null
                    : (top.schema === SUMMARIES_MAP_SCHEMA && UUID_RE.test(tk.buf) ? tk.buf.toLowerCase() : tk.buf);
                top.stage = 'colon';
                return;
            }
            let out = DROP;
            if (tk.schema === SCALAR || tk.schema === DURATION) {
                out = tk.buf;
                addCost(out.length * 2);
            }
            commitValue(out);
        };

        const closePrimitive = () => {
            const tk = activeToken;
            activeToken = null;
            if (!JSON_NUMBER_RE.test(tk.buf)) raise();
            const parsed = JSON.parse(tk.buf);
            commitValue(tk.schema === SCALAR || tk.schema === DURATION ? parsed : DROP);
        };

        const onDelimiter = (ch) => {
            const top = topFrame();
            if (ch === '{' || ch === '[') {
                if (!canReadValue() || frames.length >= STREAM_MAX_DEPTH) raise();
                const isArray = ch === '[';
                const raw = resolveSlotSchema();
                const schema = !isArray && raw === DURATION ? DURATION_OBJECT_SCHEMA : raw;
                const keep = typeof schema === 'object' && schema !== null && (!isArray || schema !== SUMMARIES_MAP_SCHEMA);
                const target = keep ? (isArray ? [] : {}) : null;
                if (target) addCost(64);
                frames.push({
                    schema,
                    isArray,
                    target,
                    field: null,
                    stage: isArray ? 'valueOrEnd' : 'keyOrEnd',
                });
                return;
            }
            if (ch === '}' || ch === ']') {
                const emptyStage = top && (top.isArray ? 'valueOrEnd' : 'keyOrEnd');
                if (!top || top.isArray !== (ch === ']') || (top.stage !== 'commaOrEnd' && top.stage !== emptyStage)) {
                    raise();
                }
                frames.pop();
                commitValue(top.target || DROP);
                return;
            }
            if (ch === ':') {
                if (!top || top.isArray || top.stage !== 'colon') raise();
                top.stage = 'value';
                return;
            }
            if (ch === ',') {
                if (!top || top.stage !== 'commaOrEnd') raise();
                top.stage = top.isArray ? 'value' : 'key';
                return;
            }
            raise();
        };

        return {
            write(chunk) {
                let pos = 0;
                while (pos < chunk.length) {
                    const tk = activeToken;
                    if (tk && tk.kind === 'str') {
                        if (tk.esc === 1) {
                            const ch = chunk[pos++];
                            if (ch === 'u') { tk.esc = 2; tk.hex = ''; continue; }
                            const mapped = JSON_ESCAPE_CHARS[ch];
                            if (mapped === undefined) raise();
                            appendStringChunk(mapped);
                            tk.esc = 0;
                            continue;
                        }
                        if (tk.esc === 2) {
                            const ch = chunk[pos++];
                            if (!/[0-9a-f]/i.test(ch)) raise();
                            tk.hex += ch;
                            if (tk.hex.length === 4) {
                                appendStringChunk(String.fromCharCode(parseInt(tk.hex, 16)));
                                tk.esc = 0;
                            }
                            continue;
                        }
                        const scan = /["\\\x00-\x1f]/g;
                        scan.lastIndex = pos;
                        const hit = scan.exec(chunk);
                        const segEnd = hit ? hit.index : chunk.length;
                        appendStringChunk(chunk.slice(pos, segEnd));
                        pos = segEnd;
                        if (!hit) continue;
                        const ctrl = chunk[pos++];
                        if (ctrl === '"') closeString();
                        else if (ctrl === '\\') tk.esc = 1;
                        else raise();
                        continue;
                    }
                    if (tk && tk.kind === 'prim') {
                        const start = pos;
                        while (pos < chunk.length && /[a-zA-Z0-9+\-.]/.test(chunk[pos])) pos++;
                        tk.buf += chunk.slice(start, pos);
                        if (tk.buf.length > 1024) raise();
                        if (pos < chunk.length) closePrimitive();
                        continue;
                    }
                    const ch = chunk[pos++];
                    if (ch === ' ' || ch === '\r' || ch === '\n' || ch === '\t') continue;
                    if (ch === '"') {
                        const top = topFrame();
                        const isKey = Boolean(top && !top.isArray && (top.stage === 'key' || top.stage === 'keyOrEnd'));
                        if (!isKey && !canReadValue()) raise();
                        activeToken = {
                            kind: 'str',
                            isKey,
                            schema: isKey ? null : resolveSlotSchema(),
                            buf: '',
                            truncated: false,
                            esc: 0,
                            hex: '',
                        };
                        continue;
                    }
                    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
                        onDelimiter(ch);
                        continue;
                    }
                    if (!canReadValue() || !/[tfn\d-]/.test(ch)) raise();
                    activeToken = { kind: 'prim', schema: resolveSlotSchema(), buf: ch };
                }
            },
            finish() {
                if (activeToken && activeToken.kind === 'prim') closePrimitive();
                if (activeToken || frames.length || !completed || !rootValue || typeof rootValue !== 'object') {
                    raise();
                }
                return rootValue;
            },
        };
    }

    // -------------------------------------------------------------------------
    // 2. 本地 Language Server 发现与 ConnectRPC 调用
    // -------------------------------------------------------------------------

    function getLsEndpoint() {
        const port = typeof languageServer.getLsPort === 'function' ? Number(languageServer.getLsPort()) : 0;
        const proc = typeof languageServer.getLsProcess === 'function' ? languageServer.getLsProcess() : null;
        const args = Array.isArray(proc && proc.spawnargs) ? proc.spawnargs : [];
        let csrf = '';
        for (let i = 0; i < args.length; i++) {
            const arg = String(args[i] || '');
            if (arg === '--csrf_token' && i + 1 < args.length) {
                csrf = String(args[i + 1] || '');
                break;
            }
            if (arg.startsWith('--csrf_token=')) {
                csrf = arg.slice('--csrf_token='.length);
                break;
            }
        }
        if (!Number.isInteger(port) || port <= 0 || port > 65535 || !csrf) return null;
        return { port, csrf, key: `${port}:${csrf}` };
    }

    function sendRpcOnce(protocol, port, csrf, method, payloadText) {
        return new Promise((resolve, reject) => {
            const mod = protocol === 'https' ? https : http;
            const req = mod.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: RPC_SERVICE + method,
                    method: 'POST',
                    agent: false,
                    ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
                    headers: {
                        'Content-Type': 'application/json',
                        'Connect-Protocol-Version': '1',
                        'x-codeium-csrf-token': csrf,
                        'Content-Length': Buffer.byteLength(payloadText),
                    },
                },
                (res) => {
                    const streamFilter = createRpcJsonFilter();
                    let settled = false;
                    const fail = (err) => {
                        if (settled) return;
                        settled = true;
                        reject(err);
                        res.destroy();
                        req.destroy();
                    };
                    res.setEncoding('utf8');
                    res.on('error', fail);
                    res.on('data', (chunk) => {
                        if (settled) return;
                        if (res.statusCode !== 200) return;
                        try {
                            streamFilter.write(chunk);
                        } catch (err) {
                            fail(err);
                        }
                    });
                    res.on('end', () => {
                        if (settled) return;
                        settled = true;
                        if (res.statusCode !== 200) {
                            reject(Object.assign(new Error(`RPC ${method} HTTP ${res.statusCode}`), { status: res.statusCode }));
                            return;
                        }
                        try {
                            resolve(streamFilter.finish());
                        } catch (err) {
                            reject(err);
                        }
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(10000, () => req.destroy(new Error(`RPC ${method} timeout`)));
            req.end(payloadText);
        });
    }

    async function callLsRpc(endpoint, method, body) {
        const payloadText = JSON.stringify(body || {});
        const preferred = portProtocols.get(endpoint.port) || 'https';
        const order = preferred === 'https' ? ['https', 'http'] : ['http', 'https'];
        let lastErr = null;
        for (const protocol of order) {
            try {
                const result = await sendRpcOnce(protocol, endpoint.port, endpoint.csrf, method, payloadText);
                portProtocols.set(endpoint.port, protocol);
                if (portProtocols.size > 16) portProtocols.delete(portProtocols.keys().next().value);
                return result;
            } catch (err) {
                lastErr = err;
                // HTTP 4xx/5xx 说明协议层已通，无需再换协议重试
                if (err && typeof err.status === 'number') throw err;
            }
        }
        throw lastErr || new Error('Language server RPC failed');
    }

    // -------------------------------------------------------------------------
    // 3. 上下文占用计算与增量分页读取
    // -------------------------------------------------------------------------

    function parseNonNegInt(value) {
        if (typeof value === 'number') {
            return Number.isSafeInteger(value) && value >= 0 ? value : null;
        }
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            const n = Number(value);
            return Number.isSafeInteger(n) && n >= 0 ? n : null;
        }
        return null;
    }

    const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
    const CONTROL_CHARS_RE = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
    const EFFORT_SUFFIX_RE = /^(.+?)[-_ ](thinking|xhigh|high|medium|low)$/i;
    const UPPER_ACRONYMS = new Map([
        ['gpt', 'GPT'],
        ['oss', 'OSS'],
        ['api', 'API'],
        ['oai', 'OpenAI'],
        ['openai', 'OpenAI'],
    ]);

    function cleanModelText(raw) {
        const str = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
        if (typeof str !== 'string') return '';
        return str.replace(CONTROL_CHARS_RE, '').trim().slice(0, 160);
    }

    /** 将底层枚举或连字符模型 ID 转为可读名称，不预设特定内部型号映射 */
    function formatFallbackModelLabel(rawName) {
        if (!rawName) return null;
        if (/\s/.test(rawName) && !/^MODEL_/i.test(rawName)) {
            return rawName;
        }
        let body = rawName.replace(/^models?\//i, '').replace(/^MODEL_/i, '');
        if (/^[a-z0-9._-]+$/i.test(body)) {
            body = body.replace(/-\d{8}$/, '');
            let effort = '';
            const effortMatch = body.match(EFFORT_SUFFIX_RE);
            if (effortMatch) {
                body = effortMatch[1];
                const tag = effortMatch[2].toLowerCase();
                effort = ` (${tag === 'xhigh' ? 'XHigh' : tag[0].toUpperCase() + tag.slice(1)})`;
            }
            const formatted = body
                .replace(/(\d)[_-](\d)/g, '$1.$2')
                .split(/[-_]+/)
                .filter(Boolean)
                .map((part) => {
                    const low = part.toLowerCase();
                    if (UPPER_ACRONYMS.has(low)) return UPPER_ACRONYMS.get(low);
                    if (/^\d/.test(part)) return part;
                    return part[0].toUpperCase() + part.slice(1).toLowerCase();
                })
                .join(' ');
            if (formatted) return formatted + effort;
        }
        return rawName;
    }

    /** 从官方 Language Server GetUserStatus 动态获取客户端当前可用模型显示名称映射 */
    async function getModelCatalog(endpoint) {
        if (modelCatalogCache.endpointKey !== endpoint.key) {
            modelCatalogCache = { endpointKey: endpoint.key, map: new Map(), fetchedAt: 0, pending: null };
        }
        const age = Date.now() - modelCatalogCache.fetchedAt;
        const ttl = modelCatalogCache.map.size > 0 ? MODEL_CATALOG_TTL_MS : 15000;
        if (modelCatalogCache.fetchedAt > 0 && age < ttl) {
            return modelCatalogCache.map;
        }
        if (modelCatalogCache.pending) return modelCatalogCache.pending;

        modelCatalogCache.pending = callLsRpc(endpoint, 'GetUserStatus', {})
            .then((res) => {
                const configs = (res && res.userStatus && res.userStatus.cascadeModelConfigData && res.userStatus.cascadeModelConfigData.clientModelConfigs)
                    || (res && res.cascadeModelConfigData && res.cascadeModelConfigData.clientModelConfigs)
                    || [];
                const nextMap = new Map();
                if (Array.isArray(configs)) {
                    for (const cfg of configs) {
                        if (!cfg || typeof cfg !== 'object') continue;
                        const label = cleanModelText(cfg.label);
                        if (!label) continue;
                        const refs = [
                            cfg.modelOrAlias && cfg.modelOrAlias.model,
                            cfg.modelOrAlias && cfg.modelOrAlias.alias,
                            cfg.modelId,
                        ];
                        for (const ref of refs) {
                            const key = cleanModelText(ref).toLowerCase();
                            if (!key) continue;
                            if (!nextMap.has(key)) nextMap.set(key, label);
                        }
                    }
                }
                modelCatalogCache.map = nextMap;
                modelCatalogCache.fetchedAt = Date.now();
                return nextMap;
            })
            .catch(() => {
                modelCatalogCache.fetchedAt = Date.now();
                return modelCatalogCache.map;
            })
            .finally(() => {
                modelCatalogCache.pending = null;
            });
        return modelCatalogCache.pending;
    }

    function resolveModelDisplayName(chatModel, modelCatalog) {
        if (!chatModel || typeof chatModel !== 'object') return null;
        const explicitDisplay = cleanModelText(chatModel.modelDisplayName);
        if (explicitDisplay && !/^MODEL_/i.test(explicitDisplay)) {
            return explicitDisplay;
        }
        const rawCandidates = [chatModel.modelDisplayName, chatModel.responseModel, chatModel.model];
        if (modelCatalog && modelCatalog.size > 0) {
            for (const raw of rawCandidates) {
                const text = cleanModelText(raw);
                if (!text) continue;
                const mapped = modelCatalog.get(text.toLowerCase());
                if (mapped) return mapped;
            }
        }
        for (const raw of rawCandidates) {
            const text = cleanModelText(raw);
            if (!text) continue;
            return formatFallbackModelLabel(text);
        }
        return null;
    }

    /** 解析数值、秒字符串 ("1.25s") 或 Protobuf Duration ({ seconds, nanos }) */
    function readDurationSec(value) {
        if (typeof value === 'number') {
            return Number.isFinite(value) && value >= 0 ? value : null;
        }
        if (typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value)) {
            const secs = Number(value.slice(0, -1));
            return Number.isFinite(secs) && secs >= 0 ? secs : null;
        }
        if (value && typeof value === 'object') {
            if (value.seconds === undefined && value.nanos === undefined) return null;
            const secPart = Number(value.seconds ?? 0);
            const nanoPart = Number(value.nanos ?? 0);
            if (!Number.isSafeInteger(secPart) || secPart < 0 || !Number.isInteger(nanoPart) || nanoPart < 0 || nanoPart >= 1e9) {
                return null;
            }
            const total = secPart + nanoPart / 1e9;
            return Number.isFinite(total) && total >= 0 ? total : null;
        }
        return null;
    }

    /** 提取单轮对话响应的生成速率、首字延迟与思考 token 数 */
    function readSpeedSlot(chat) {
        if (!chat || typeof chat !== 'object') return null;
        const usage = chat.usage && typeof chat.usage === 'object' ? chat.usage : null;
        const ttft = readDurationSec(chat.timeToFirstToken);
        const duration = readDurationSec(chat.streamingDuration);
        const totalOut = usage ? parseNonNegInt(usage.outputTokens) : null;
        const visibleOut = usage ? parseNonNegInt(usage.responseOutputTokens) : null;
        const thinkOut = usage ? parseNonNegInt(usage.thinkingOutputTokens) : null;
        const generated = visibleOut !== null
            ? visibleOut
            : (totalOut !== null && thinkOut !== null ? Math.max(0, totalOut - thinkOut) : totalOut);

        const isRatioReliable = Boolean(
            generated !== null &&
            generated > 0 &&
            duration !== null &&
            duration >= 0.3 &&
            !(ttft !== null && ttft >= 2 && duration < 1 && ttft / duration >= 20)
        );
        if (ttft === null && !isRatioReliable && thinkOut === null) return null;
        return {
            ttft,
            duration: isRatioReliable ? duration : null,
            responseTokens: isRatioReliable ? generated : null,
            tps: isRatioReliable ? generated / duration : null,
            thinkingTokens: thinkOut,
        };
    }

    /** 汇总整段会话的最近速率与加权平均速率 */
    function aggregateSpeedSlots(slots) {
        if (!Array.isArray(slots) || slots.length === 0) return null;
        let sumTokens = 0;
        let sumSeconds = 0;
        let lastSpeed = null;
        let lastLatency = null;
        for (const item of slots) {
            if (!item) continue;
            if (item.tps !== null && item.duration > 0 && item.responseTokens > 0) {
                sumTokens += item.responseTokens;
                sumSeconds += item.duration;
                lastSpeed = item;
            }
            if (item.ttft !== null || item.thinkingTokens !== null) {
                lastLatency = item;
            }
        }
        const sessionTps = sumSeconds > 0 ? sumTokens / sumSeconds : null;
        if (!lastSpeed && !lastLatency && sessionTps === null) return null;
        return {
            latestTps: lastSpeed ? lastSpeed.tps : null,
            latestTokens: lastSpeed ? lastSpeed.responseTokens : null,
            latestDuration: lastSpeed ? lastSpeed.duration : null,
            sessionTps,
            ttftSeconds: lastLatency ? lastLatency.ttft : null,
            thinkingTokens: lastLatency ? lastLatency.thinkingTokens : null,
        };
    }

    /** 提取单次模型请求的输入缓存读写统计 */
    function readCacheSlot(usage) {
        if (!usage || typeof usage !== 'object') return null;
        const input = parseNonNegInt(usage.inputTokens);
        if (input === null) return null;
        if (usage.cacheReadTokens !== undefined && parseNonNegInt(usage.cacheReadTokens) === null) return null;
        if (usage.cacheWriteTokens !== undefined && parseNonNegInt(usage.cacheWriteTokens) === null) return null;
        const read = parseNonNegInt(usage.cacheReadTokens) ?? 0;
        const write = parseNonNegInt(usage.cacheWriteTokens) ?? 0;
        const total = input + read + write;
        if (!Number.isSafeInteger(total) || total < 0 || read + write > total) return null;
        const provider = String(usage.apiProvider || '');
        if (total > 0 && !/GOOGLE_GEMINI|OPENAI|ANTHROPIC/.test(provider)) return null;
        return { input, read, write, total };
    }

    /** 汇总整段会话的缓存命中率 */
    function aggregateCacheSlots(slots) {
        if (!Array.isArray(slots) || slots.length === 0) return null;
        let totalRead = 0;
        let totalWrite = 0;
        let totalInput = 0;
        let count = 0;
        let lastSlot = null;
        for (const item of slots) {
            if (!item) continue;
            totalRead += item.read;
            totalWrite += item.write;
            totalInput += item.total;
            count++;
            lastSlot = item;
        }
        if (count === 0) return null;
        return {
            latest: lastSlot ? {
                readTokens: lastSlot.read,
                writeTokens: lastSlot.write,
                totalTokens: lastSlot.total,
                hitRate: lastSlot.total > 0 ? lastSlot.read / lastSlot.total : null,
            } : null,
            session: {
                readTokens: totalRead,
                writeTokens: totalWrite,
                totalTokens: totalInput,
                hitRate: totalInput > 0 ? totalRead / totalInput : null,
                requests: count,
            },
        };
    }

    function buildContextMetrics(chatModel, modelCatalog) {
        if (!chatModel || typeof chatModel !== 'object') return null;
        const startMeta = chatModel.chatStartMetadata;
        const ctxMeta = startMeta && startMeta.contextWindowMetadata;
        if (!ctxMeta || typeof ctxMeta !== 'object') return null;
        const usedTokens = parseNonNegInt(ctxMeta.estimatedTokensUsed);
        if (usedTokens === null) return null;
        const rawMax = parseNonNegInt(ctxMeta.maxContextTokens);
        const maxTokens = rawMax !== null && rawMax > 0 ? rawMax : null;
        return {
            usedTokens,
            maxTokens,
            remainingTokens: maxTokens === null ? null : Math.max(0, maxTokens - usedTokens),
            usedFraction: maxTokens === null ? null : usedTokens / maxTokens,
            remainingFraction: maxTokens === null ? null : Math.max(0, 1 - usedTokens / maxTokens),
            model: resolveModelDisplayName(chatModel, modelCatalog),
        };
    }

    async function getSummaries(endpoint) {
        if (summariesCache.endpointKey !== endpoint.key) {
            summariesCache = { endpointKey: endpoint.key, pending: null };
            sessionCache.clear();
        }
        if (summariesCache.pending) return summariesCache.pending;
        summariesCache.pending = callLsRpc(endpoint, 'GetAllCascadeTrajectories', { excludeSubtrajectories: false })
            .then((res) => (res && res.trajectorySummaries && typeof res.trajectorySummaries === 'object')
                ? res.trajectorySummaries
                : {})
            .finally(() => {
                summariesCache.pending = null;
            });
        return summariesCache.pending;
    }

    async function fetchLatestChatModel(endpoint, cascadeId, startOffset, initialChat, initialCacheSlots, initialSpeedSlots, modelCatalog) {
        let offset = startOffset;
        let latestChat = initialChat || null;
        const cacheSlots = Array.isArray(initialCacheSlots) ? initialCacheSlots.slice(0, startOffset) : [];
        const speedSlots = Array.isArray(initialSpeedSlots) ? initialSpeedSlots.slice(0, startOffset) : [];
        const visitedOffsets = new Set();
        for (let pageIdx = 0; pageIdx < 1024; pageIdx++) {
            if (visitedOffsets.has(offset)) break;
            visitedOffsets.add(offset);
            const page = await callLsRpc(endpoint, 'GetCascadeTrajectoryGeneratorMetadata', {
                cascadeId,
                generatorMetadataOffset: offset,
                includeMessages: false,
            });
            const items = (page && (page.generatorMetadata || page.generatorMetadatas)) || [];
            if (!Array.isArray(items) || items.length === 0) {
                return { offset, latestChat, cacheSlots, speedSlots, emptyAtStart: pageIdx === 0 && startOffset > 0 };
            }
            for (let i = 0; i < items.length; i++) {
                const chat = items[i] && items[i].chatModel;
                if (chat) {
                    if (buildContextMetrics(chat, modelCatalog) || !latestChat) {
                        latestChat = chat;
                    }
                    cacheSlots[offset + i] = readCacheSlot(chat.usage);
                    speedSlots[offset + i] = readSpeedSlot(chat);
                } else {
                    cacheSlots[offset + i] = null;
                    speedSlots[offset + i] = null;
                }
            }
            offset += items.length;
        }
        cacheSlots.length = offset;
        speedSlots.length = offset;
        return { offset, latestChat, cacheSlots, speedSlots, emptyAtStart: false };
    }

    const TOKEN_TYPE_META = [
        { match: /(?:^|_)SYSTEM_PROMPT$|^1$/, key: 'system_prompt', label: '系统提示词', color: '#10b981', order: 1 },
        { match: /(?:^|_)MCP_TOOLS$|^4$/, key: 'mcp_tools', label: 'MCP 工具', color: '#f97316', order: 2 },
        { match: /(?:^|_)TOOLS$|^2$/, key: 'tools', label: '系统工具', color: '#8b5cf6', order: 3 },
        { match: /(?:^|_)RULES$|^3$/, key: 'rules', label: '规则文件', color: '#06b6d4', order: 4 },
        { match: /(?:^|_)SKILLS$|^5$/, key: 'skills', label: '技能定义', color: '#eab308', order: 5 },
        { match: /(?:^|_)SUBAGENTS$|^6$/, key: 'subagents', label: '子代理', color: '#ec4899', order: 6 },
        { match: /(?:^|_)(?:WORKFLOWS|PLUGINS|FLOWS)$|^(?:8|9|10)$/, key: 'extensions', label: '扩展与工作流', color: '#a855f7', order: 7 },
        { match: /(?:^|_)CHAT_MESSAGES$|^7$/, key: 'chat_messages', label: '对话消息', color: '#3b82f6', order: 8 },
    ];

    function resolveTokenTypeMeta(rawType) {
        const str = String(rawType ?? '').trim();
        for (const item of TOKEN_TYPE_META) {
            if (item.match.test(str)) return item;
        }
        return { key: 'other', label: '其他上下文', color: '#94a3b8', order: 90 };
    }

    /** 按官方 tokenBreakdown 原生分类直接构建上下文构成（不做步骤估算二次拆分） */
    function buildContextBreakdown(context, latestChat) {
        if (!context) return null;
        const denom = context.maxTokens !== null && context.maxTokens > 0 ? context.maxTokens : context.usedTokens;
        const basis = context.maxTokens !== null && context.maxTokens > 0 ? 'window' : 'used';

        const rawBreakdown = latestChat &&
            latestChat.chatStartMetadata &&
            latestChat.chatStartMetadata.contextWindowMetadata &&
            latestChat.chatStartMetadata.contextWindowMetadata.tokenBreakdown;
        const rawGroups = rawBreakdown && Array.isArray(rawBreakdown.groups) ? rawBreakdown.groups : [];

        const grouped = new Map();
        for (const grp of rawGroups) {
            if (!grp || typeof grp !== 'object') continue;
            const n = parseNonNegInt(grp.numTokens);
            if (n === null || n <= 0) continue;
            const meta = resolveTokenTypeMeta(grp.type);
            let cur = grouped.get(meta.key);
            if (!cur) {
                cur = { key: meta.key, label: meta.label, color: meta.color, order: meta.order, tokens: 0, isFree: false };
                grouped.set(meta.key, cur);
            }
            cur.tokens += n;
        }

        const categories = [];
        if (grouped.size > 0) {
            for (const g of grouped.values()) {
                if (g.tokens > 0) categories.push(g);
            }
            const totalPlaced = categories.reduce((s, c) => s + c.tokens, 0);
            if (context.usedTokens - totalPlaced > 64) {
                categories.push({
                    key: 'residual',
                    label: '其余会话上下文',
                    color: '#94a3b8',
                    order: 89,
                    tokens: context.usedTokens - totalPlaced,
                    isFree: false,
                });
            }
            categories.sort((a, b) => a.order - b.order);
        } else if (context.usedTokens > 0) {
            categories.push({
                key: 'messages_and_system',
                label: '已用上下文 (消息/提示/工具)',
                color: '#3b82f6',
                order: 8,
                tokens: context.usedTokens,
                isFree: false,
            });
        }

        if (context.remainingTokens !== null && context.maxTokens !== null) {
            categories.push({
                key: 'free_space',
                label: '可用空间',
                color: '#475569',
                order: 99,
                tokens: context.remainingTokens,
                isFree: true,
            });
        }

        return {
            basis,
            denomTokens: denom,
            categories: categories.map((r) => ({
                ...r,
                fraction: denom > 0 ? r.tokens / denom : null,
            })),
        };
    }

    async function queryConversationContext(rawId, force) {
        const endpoint = getLsEndpoint();
        if (!endpoint) return { status: 'offline', running: false, conversationId: null, context: null, cache: null, speed: null, breakdown: null };
        if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) {
            return { status: 'new', running: false, conversationId: null, context: null, cache: null, speed: null, breakdown: null };
        }
        const id = rawId.toLowerCase();
        const summaries = await getSummaries(endpoint);
        const summary = summaries[id];
        if (!summary) {
            return { status: 'new', running: false, conversationId: id, context: null, cache: null, speed: null, breakdown: null };
        }

        const stepCount = parseNonNegInt(summary.stepCount);
        const lastInputIdx = parseNonNegInt(summary.lastUserInputStepIndex);
        const statusStr = String(summary.status || '');
        const running = RUNNING_STATUS_RE.test(statusStr);
        const mark = JSON.stringify([stepCount, summary.lastModifiedTime || null, statusStr || null, lastInputIdx]);
        const settled = SETTLED_STATUS_RE.test(statusStr);

        const cached = sessionCache.get(id);
        const now = Date.now();
        if (cached && cached.endpointKey === endpoint.key && !force && cached.mark === mark) {
            const ttl = settled ? 10000 : 1200;
            if (now - cached.verifiedAt < ttl) {
                return cached.payload;
            }
        }

        const canIncremental = Boolean(
            cached &&
            cached.endpointKey === endpoint.key &&
            !force &&
            cached.offset > 0 &&
            (
                (stepCount !== null && cached.stepCount !== null && stepCount > cached.stepCount) ||
                !cached.settled ||
                cached.mark === mark
            ) &&
            (stepCount === null || cached.stepCount === null || stepCount >= cached.stepCount) &&
            (lastInputIdx === null || cached.lastInputIdx === null || lastInputIdx >= cached.lastInputIdx)
        );

        const [modelCatalog, initialScan] = await Promise.all([
            getModelCatalog(endpoint),
            fetchLatestChatModel(
                endpoint,
                id,
                canIncremental ? Math.max(0, cached.offset - 1) : 0,
                canIncremental ? cached.lastChat : null,
                canIncremental ? cached.cacheSlots : null,
                canIncremental ? cached.speedSlots : null
            ),
        ]);
        let scan = initialScan;
        if (scan.emptyAtStart) {
            scan = await fetchLatestChatModel(endpoint, id, 0, null, null, null, modelCatalog);
        }

        const context = buildContextMetrics(scan.latestChat, modelCatalog);
        const cache = aggregateCacheSlots(scan.cacheSlots);
        const speed = aggregateSpeedSlots(scan.speedSlots);
        const breakdown = buildContextBreakdown(context, scan.latestChat);
        const payload = {
            status: context ? 'ready' : 'waiting',
            running,
            conversationId: id,
            context,
            cache,
            speed,
            breakdown,
        };

        sessionCache.delete(id);
        sessionCache.set(id, {
            endpointKey: endpoint.key,
            mark,
            settled,
            stepCount,
            lastInputIdx,
            offset: scan.offset,
            lastChat: scan.latestChat,
            cacheSlots: scan.cacheSlots,
            speedSlots: scan.speedSlots,
            verifiedAt: Date.now(),
            payload,
        });
        while (sessionCache.size > 32) {
            sessionCache.delete(sessionCache.keys().next().value);
        }
        return payload;
    }

    ipcMain.handle('ag-ctx:metrics', async (event, rawId, force) => {
        const senderUrl = event && event.senderFrame ? event.senderFrame.url : '';
        if (!LOCAL_ORIGIN_RE.test(senderUrl)) {
            return { status: 'offline', running: false, conversationId: null, context: null, cache: null, speed: null, breakdown: null };
        }
        const key = (typeof rawId === 'string' && UUID_RE.test(rawId) ? rawId.toLowerCase() : 'none') + ':' + (force ? '1' : '0');
        if (inflightRequests.has(key)) return inflightRequests.get(key);
        const promise = queryConversationContext(rawId, Boolean(force))
            .catch(() => ({ status: 'error', running: false, conversationId: typeof rawId === 'string' ? rawId.toLowerCase() : null, context: null, cache: null, speed: null, breakdown: null }))
            .finally(() => {
                inflightRequests.delete(key);
            });
        inflightRequests.set(key, promise);
        return promise;
    });

    // -------------------------------------------------------------------------
    // 4. 渲染层注入脚本（函数体直接序列化注入，避免模板字符串转义陷阱）
    // -------------------------------------------------------------------------

    function rendererBootstrap() {
        if (window.__agCtxMonitorInstalled) return;
        if (!window.__agCtxBridge || typeof window.__agCtxBridge.getMetrics !== 'function') return;
        window.__agCtxMonitorInstalled = true;

        const RING_HOST_CLASS = 'ag-ctx-monitor-host';
        const SPEED_HOST_CLASS = 'ag-ctx-speed-host';
        const CARD_PORTAL_ID = 'ag-ctx-card-portal';
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const RING_R = 6;
        const RING_C = 2 * Math.PI * RING_R;
        const RING_ARC = RING_C * 0.75;
        const BIG_R = 25;
        const BIG_C = 2 * Math.PI * BIG_R;
        const BIG_ARC = BIG_C * 0.75;

        const instances = new Map();
        let cardPortal = null;
        let cardRoot = null;
        let activeInst = null;
        let activeAnchor = 'ring';
        let pinnedOpen = false;
        let hoverOpen = false;
        let breakdownOpen = false;
        let hoverTimer = null;
        let closeTimer = null;
        let layoutScheduled = false;

        function isVisible(el) {
            return Boolean(el && el.isConnected && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
        }

        function formatCompactTokens(n) {
            if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
            if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
            return String(n);
        }

        function formatExactTokens(n) {
            if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
            return n.toLocaleString('en-US');
        }

        function formatCacheStat(entry, extraRequests) {
            if (!entry || typeof entry.totalTokens !== 'number') {
                return { text: '—', title: '' };
            }
            const pctText = typeof entry.hitRate === 'number' && Number.isFinite(entry.hitRate)
                ? `${(entry.hitRate * 100).toFixed(entry.hitRate >= 0.9995 || entry.hitRate === 0 ? 0 : 1)}%`
                : '—';
            const text = entry.hitRate === null
                ? '—'
                : `${pctText} · ${formatCompactTokens(entry.readTokens)}`;
            const parts = [
                `命中 ${formatExactTokens(entry.readTokens)}`,
                `输入 ${formatExactTokens(entry.totalTokens)}`,
            ];
            if (entry.writeTokens > 0) parts.push(`写入 ${formatExactTokens(entry.writeTokens)}`);
            if (typeof extraRequests === 'number' && extraRequests > 0) parts.push(`${extraRequests} 次请求`);
            return { text, title: parts.join(' / ') };
        }

        function formatDuration(seconds) {
            if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
            if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
            if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
            const mins = Math.floor(seconds / 60);
            const rem = Math.round(seconds % 60);
            return `${mins}m${rem < 10 ? '0' : ''}${rem}s`;
        }

        function formatTps(tps) {
            if (typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0) return '—';
            return tps >= 100 ? `${Math.round(tps)} t/s` : `${tps.toFixed(1).replace(/\.0$/, '')} t/s`;
        }

        function formatSpeedView(speed, running) {
            const hasLatestTps = Boolean(speed && typeof speed.latestTps === 'number' && Number.isFinite(speed.latestTps));
            const hasSessionTps = Boolean(speed && typeof speed.sessionTps === 'number' && Number.isFinite(speed.sessionTps));
            const hasTtft = Boolean(speed && typeof speed.ttftSeconds === 'number' && Number.isFinite(speed.ttftSeconds));
            const thinkingTokens = speed && typeof speed.thinkingTokens === 'number' ? speed.thinkingTokens : 0;

            const primaryTps = hasLatestTps ? speed.latestTps : (hasSessionTps ? speed.sessionTps : null);
            const mainText = primaryTps !== null
                ? formatTps(primaryTps)
                : (running ? '思考中' : '-- t/s');
            const subText = hasTtft ? formatDuration(speed.ttftSeconds) : '';

            const tpsText = hasLatestTps
                ? (hasSessionTps ? `${formatTps(speed.latestTps)} · 均 ${Math.round(speed.sessionTps)}` : formatTps(speed.latestTps))
                : (hasSessionTps ? `均 ${formatTps(speed.sessionTps)}` : '—');
            const tpsTitleParts = [];
            if (hasLatestTps && speed.latestTokens && speed.latestDuration) {
                tpsTitleParts.push(`最近输出 ${formatExactTokens(speed.latestTokens)} tok / ${formatDuration(speed.latestDuration)}`);
            }
            if (hasSessionTps) {
                tpsTitleParts.push(`会话平均 ${formatTps(speed.sessionTps)}`);
            }

            const pillTitleParts = [];
            if (primaryTps !== null) {
                pillTitleParts.push(`${hasLatestTps ? '生成速率' : '会话均速'} ${formatTps(primaryTps)}`);
            }
            if (hasTtft) {
                pillTitleParts.push(`首字耗时(含读取与思考) ${formatDuration(speed.ttftSeconds)}`);
            }
            if (thinkingTokens > 0) {
                pillTitleParts.push(`思考 ${formatCompactTokens(thinkingTokens)} tok`);
            }
            if (running) {
                pillTitleParts.push('正在运行');
            }
            if (!pillTitleParts.length) {
                pillTitleParts.push('模型生成速率与首字耗时');
            }

            return {
                mainText,
                subText,
                hasMetrics: primaryTps !== null || hasTtft || thinkingTokens > 0,
                pillTitle: pillTitleParts.join(' · '),
                tpsText,
                tpsTitle: tpsTitleParts.join(' / '),
            };
        }

        function detectDarkTheme(targetBox) {
            const html = document.documentElement;
            if (html.classList.contains('dark')) return true;
            if (html.classList.contains('light')) return false;
            const probeEls = [document.body, targetBox, html].filter(Boolean);
            for (const el of probeEls) {
                const bg = getComputedStyle(el).backgroundColor;
                const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (!m) continue;
                const alpha = m[4] === undefined ? 1 : Number(m[4]);
                if (alpha === 0) continue;
                const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
                return lum < 0.5;
            }
            return matchMedia('(prefers-color-scheme: dark)').matches;
        }

        function resolveSpeedAnchor(container, modelBtn) {
            if (!modelBtn || !isVisible(modelBtn)) {
                return { speedParent: null, speedAfter: null };
            }
            const p = modelBtn.parentElement;
            if (p && p.children.length === 1 && p.parentElement && container.contains(p.parentElement)) {
                return { speedParent: p.parentElement, speedAfter: p };
            }
            if (p && container.contains(p)) {
                return { speedParent: p, speedAfter: modelBtn };
            }
            return { speedParent: null, speedAfter: null };
        }

        function findAllComposers() {
            const boxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]')).filter(isVisible);
            const candidates = [];
            for (const box of boxes) {
                const footer = box.querySelector('.agy-composer-footer, [data-agent-composer-root]');
                if (footer && isVisible(footer) && footer.children.length >= 2) {
                    const rightGroup = footer.lastElementChild;
                    const leftGroup = footer.firstElementChild;
                    if (rightGroup && isVisible(rightGroup)) {
                        const sendEl = rightGroup.querySelector('[data-testid="send-button"], .agy-send-button, [data-testid="input-cancel-button"]');
                        let beforeNode = null;
                        if (sendEl) {
                            beforeNode = sendEl;
                            while (beforeNode && beforeNode.parentElement !== rightGroup) {
                                beforeNode = beforeNode.parentElement;
                            }
                        }
                        const modelBtn = footer.querySelector('[data-testid="model-selector-trigger"]');
                        const { speedParent, speedAfter } = resolveSpeedAnchor(footer, modelBtn);
                        candidates.push({
                            box,
                            toolbar: footer,
                            mountParent: rightGroup,
                            beforeNode,
                            afterNode: null,
                            leftGroup,
                            modelBtn,
                            speedParent,
                            speedAfter,
                        });
                        continue;
                    }
                }

                // 兜底：若未来 footer 结构变化，回退到 model-selector-trigger 所在行
                const modelBtn = box.querySelector('[data-testid="model-selector-trigger"]');
                if (!modelBtn || !isVisible(modelBtn)) continue;
                const row = modelBtn.closest('.agy-composer-footer, [data-agent-composer-root], [data-testid="input-box-bottom-toolbar"]') || modelBtn.parentElement;
                if (!row || !isVisible(row)) continue;
                let leftGroup = modelBtn.parentElement;
                while (leftGroup && leftGroup.parentElement && leftGroup !== row && leftGroup.parentElement !== row) {
                    leftGroup = leftGroup.parentElement;
                }
                if (!leftGroup) leftGroup = row;
                let branch = modelBtn;
                while (branch && branch.parentElement !== leftGroup) branch = branch.parentElement;
                const { speedParent, speedAfter } = resolveSpeedAnchor(row, modelBtn);
                candidates.push({
                    box,
                    toolbar: row,
                    mountParent: leftGroup,
                    beforeNode: branch ? branch.nextSibling : null,
                    afterNode: branch || null,
                    leftGroup,
                    modelBtn,
                    speedParent,
                    speedAfter,
                });
            }
            return candidates;
        }

        function resolveConversationId(comp) {
            if (!comp || !comp.box || !comp.box.isConnected) return null;
            const readValidId = (el) => {
                if (!el) return null;
                const val = el.getAttribute('data-cascade-id');
                return UUID_RE.test(val || '') ? val.toLowerCase() : null;
            };

            let branch = null;
            for (let el = comp.box, hops = 0; el && el !== document.body && hops < 28; branch = el, el = el.parentElement, hops++) {
                if (el.matches('[data-testid="conversation-view"]')) {
                    return readValidId(el);
                }
                const direct = readValidId(el);
                if (direct) return direct;

                // 子代理或侧边问答标签页中，对话区通常是输入框父级容器的兄弟分支
                if (branch) {
                    for (const sibling of el.children) {
                        if (sibling === branch || sibling.contains(comp.box)) continue;
                        if (!isVisible(sibling)) continue;
                        const subView = sibling.matches('[data-testid="subagent-tab-conversation"],[data-testid="side-question-tab-conversation"]')
                            ? sibling
                            : sibling.querySelector('[data-testid="subagent-tab-conversation"],[data-testid="side-question-tab-conversation"]');
                        if (subView && isVisible(subView)) {
                            return readValidId(subView);
                        }
                    }
                }
                if (el.matches('[data-testid="side-question-tab-content"],[data-media-drop-scope="subpane"],aside,[role="tabpanel"],[data-pane-id]')) {
                    return null;
                }
            }

            const pathMatch = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
            return pathMatch && UUID_RE.test(pathMatch[1]) ? pathMatch[1].toLowerCase() : null;
        }

        function h(tag, attrs, ...children) {
            const el = document.createElement(tag);
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
                }
            }
            for (const ch of children) {
                if (ch === undefined || ch === null) continue;
                el.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
            }
            return el;
        }

        function svgEl(tag, attrs, ...children) {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
                }
            }
            for (const ch of children) {
                if (ch) el.appendChild(ch);
            }
            return el;
        }

        const THEME_VARS_CSS = `
            :host {
                --ctx-fg: rgba(235, 238, 245, 0.92);
                --ctx-muted: rgba(164, 173, 190, 0.78);
                --ctx-pill-hover: rgba(255, 255, 255, 0.08);
                --ctx-pill-active: rgba(255, 255, 255, 0.13);
                --ctx-track: rgba(255, 255, 255, 0.14);
                --ctx-card-bg: rgba(24, 27, 34, 0.94);
                --ctx-card-border: rgba(255, 255, 255, 0.12);
                --ctx-card-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
                --ctx-divider: rgba(255, 255, 255, 0.08);
                --ctx-badge-bg: rgba(255, 255, 255, 0.07);
                --ctx-accent: #38bdf8;
                --ctx-warn: #f59e0b;
                --ctx-danger: #ef4444;
                --ctx-idle: rgba(164, 173, 190, 0.52);
                --ctx-tone: var(--ctx-idle);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            }
            :host([data-theme="light"]) {
                --ctx-fg: rgba(23, 27, 36, 0.92);
                --ctx-muted: rgba(88, 96, 112, 0.84);
                --ctx-pill-hover: rgba(15, 23, 42, 0.06);
                --ctx-pill-active: rgba(15, 23, 42, 0.10);
                --ctx-track: rgba(15, 23, 42, 0.14);
                --ctx-card-bg: rgba(255, 255, 255, 0.96);
                --ctx-card-border: rgba(15, 23, 42, 0.11);
                --ctx-card-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
                --ctx-divider: rgba(15, 23, 42, 0.08);
                --ctx-badge-bg: rgba(15, 23, 42, 0.05);
                --ctx-accent: #0284c7;
                --ctx-warn: #d97706;
                --ctx-danger: #dc2626;
                --ctx-idle: rgba(100, 116, 139, 0.55);
            }
            :host([data-level="normal"]) { --ctx-tone: var(--ctx-accent); }
            :host([data-level="warn"]) { --ctx-tone: var(--ctx-warn); }
            :host([data-level="danger"]) { --ctx-tone: var(--ctx-danger); }
            :host([data-level="idle"]) { --ctx-tone: var(--ctx-idle); }
            * { box-sizing: border-box; }
        `;

        function getPortalMountParent() {
            return document.body || document.documentElement;
        }

        function ensureCardPortal() {
            if (!cardPortal) {
                cardPortal = document.createElement('div');
                cardPortal.id = CARD_PORTAL_ID;
                cardPortal.setAttribute('data-ag-localization-skip', 'true');
                cardPortal.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
                cardRoot = cardPortal.attachShadow({ mode: 'open' });

                const styleEl = document.createElement('style');
                styleEl.textContent = `
                    ${THEME_VARS_CSS}
                    .card {
                        pointer-events: auto;
                        position: fixed;
                        z-index: 2147483647;
                        width: 292px;
                        max-width: calc(100vw - 16px);
                        padding: 13px 15px 12px;
                        border-radius: 14px;
                        background: var(--ctx-card-bg);
                        backdrop-filter: blur(14px);
                        -webkit-backdrop-filter: blur(14px);
                        border: 1px solid var(--ctx-card-border);
                        box-shadow: var(--ctx-card-shadow);
                        color: var(--ctx-fg);
                        font-size: 12px;
                    }
                    .card[hidden] { display: none; }
                    .card-head {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 8px;
                        margin-bottom: 12px;
                    }
                    .card-head-left {
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        min-width: 0;
                    }
                    .card-title {
                        font-size: 12px;
                        font-weight: 600;
                        letter-spacing: 0.01em;
                    }
                    .bd-toggle {
                        appearance: none;
                        border: 0;
                        margin: 0;
                        background: transparent;
                        color: var(--ctx-muted);
                        display: inline-flex;
                        align-items: center;
                        gap: 3px;
                        height: 20px;
                        padding: 0 5px;
                        border-radius: 5px;
                        font: inherit;
                        font-size: 10px;
                        cursor: pointer;
                        transition: background-color 140ms ease, color 140ms ease;
                    }
                    .bd-toggle:hover,
                    .bd-toggle[aria-expanded="true"] {
                        background: var(--ctx-pill-hover);
                        color: var(--ctx-fg);
                    }
                    .bd-toggle:focus-visible {
                        outline: 1.5px solid var(--ctx-accent);
                        outline-offset: 1px;
                    }
                    .bd-chevron {
                        width: 11px;
                        height: 11px;
                        display: block;
                        flex: none;
                        transition: transform 160ms ease;
                    }
                    .bd-toggle[aria-expanded="true"] .bd-chevron {
                        transform: rotate(180deg);
                    }
                    .breakdown {
                        max-height: 236px;
                        overflow-y: auto;
                        padding-bottom: 9px;
                        margin-bottom: 10px;
                        border-bottom: 1px solid var(--ctx-divider);
                        display: flex;
                        flex-direction: column;
                        gap: 5px;
                        scrollbar-width: thin;
                    }
                    .breakdown[hidden] { display: none; }
                    .bd-bar {
                        display: flex;
                        align-items: stretch;
                        gap: 1.5px;
                        width: 100%;
                        height: 8px;
                        border-radius: 999px;
                        overflow: hidden;
                        background: var(--ctx-track);
                        margin-bottom: 4px;
                        flex: none;
                    }
                    .bd-bar[hidden] { display: none; }
                    .bd-seg {
                        height: 100%;
                        flex: 0 1 auto;
                        min-width: 2px;
                        transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1);
                    }
                    .bd-seg[data-free="true"] {
                        flex: 1 1 auto;
                        min-width: 0;
                        background: transparent !important;
                    }
                    .bd-list {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    .bd-row {
                        display: grid;
                        grid-template-columns: 8px minmax(0, 1fr) auto 42px;
                        align-items: center;
                        gap: 7px;
                        font-size: 11px;
                        line-height: 1.35;
                    }
                    .bd-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 2px;
                        flex: none;
                    }
                    .bd-name {
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        color: var(--ctx-fg);
                    }
                    .bd-row[data-free="true"] .bd-name,
                    .bd-row[data-free="true"] .bd-pct {
                        color: var(--ctx-muted);
                    }
                    .bd-tokens {
                        font-variant-numeric: tabular-nums;
                        color: var(--ctx-muted);
                        text-align: right;
                    }
                    .bd-pct {
                        font-variant-numeric: tabular-nums;
                        font-weight: 550;
                        text-align: right;
                    }
                    .bd-empty {
                        font-size: 11px;
                        color: var(--ctx-muted);
                        padding: 2px 0;
                    }
                    .state-badge {
                        font-size: 10px;
                        font-weight: 550;
                        padding: 2px 7px;
                        border-radius: 999px;
                        background: var(--ctx-badge-bg);
                        color: var(--ctx-tone);
                    }
                    .card-body {
                        display: flex;
                        align-items: center;
                        gap: 14px;
                    }
                    .big-gauge-wrap {
                        position: relative;
                        width: 64px;
                        height: 64px;
                        flex: none;
                    }
                    .big-gauge {
                        width: 64px;
                        height: 64px;
                        display: block;
                    }
                    .big-track {
                        fill: none;
                        stroke: var(--ctx-track);
                        stroke-width: 5;
                        stroke-linecap: round;
                    }
                    .big-arc {
                        fill: none;
                        stroke: var(--ctx-tone);
                        stroke-width: 5;
                        stroke-linecap: round;
                        transition: stroke-dasharray 260ms cubic-bezier(0.22, 1, 0.36, 1), stroke 180ms ease;
                    }
                    .big-center {
                        position: absolute;
                        inset: 0;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        padding-top: 2px;
                    }
                    .big-pct {
                        font-size: 14px;
                        font-weight: 650;
                        font-variant-numeric: tabular-nums;
                        letter-spacing: -0.02em;
                    }
                    .big-sub {
                        font-size: 9px;
                        color: var(--ctx-muted);
                        margin-top: 1px;
                    }
                    .stats {
                        flex: 1;
                        min-width: 0;
                        display: grid;
                        gap: 6px;
                    }
                    .stat-row {
                        display: flex;
                        align-items: baseline;
                        justify-content: space-between;
                        gap: 8px;
                    }
                    .stat-label {
                        font-size: 11px;
                        color: var(--ctx-muted);
                        white-space: nowrap;
                    }
                    .stat-value {
                        font-size: 11.5px;
                        font-weight: 550;
                        font-variant-numeric: tabular-nums;
                        text-align: right;
                    }
                    .card-foot {
                        margin-top: 11px;
                        padding-top: 9px;
                        border-top: 1px solid var(--ctx-divider);
                        display: grid;
                        gap: 5px;
                    }
                    .foot-row {
                        display: flex;
                        align-items: baseline;
                        justify-content: space-between;
                        gap: 10px;
                        font-size: 11px;
                    }
                    .foot-row .stat-value {
                        font-size: 11px;
                        font-weight: 500;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        max-width: 196px;
                    }
                `;

                const card = h(
                    'section',
                    { class: 'card', id: 'ctx-card', role: 'dialog', 'aria-label': '上下文窗口详情', hidden: '' },
                    h(
                        'div',
                        { class: 'breakdown', id: 'card-breakdown', hidden: '' },
                        h('div', { class: 'bd-bar', id: 'bd-bar', hidden: '' }),
                        h('div', { class: 'bd-list', id: 'bd-categories' }),
                        h('div', { class: 'bd-empty', id: 'bd-note', hidden: '' }, '')
                    ),
                    h(
                        'div',
                        { class: 'card-head' },
                        h(
                            'div',
                            { class: 'card-head-left' },
                            h('span', { class: 'card-title' }, '上下文窗口'),
                            h(
                                'button',
                                {
                                    type: 'button',
                                    class: 'bd-toggle',
                                    id: 'card-breakdown-toggle',
                                    'aria-expanded': 'false',
                                    'aria-label': '展开上下文分类构成',
                                    title: '向上展开上下文分类构成',
                                },
                                svgEl(
                                    'svg',
                                    { class: 'bd-chevron', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
                                    svgEl('path', {
                                        d: 'M2.5 7.5L6 4l3.5 3.5',
                                        fill: 'none',
                                        stroke: 'currentColor',
                                        'stroke-width': '1.5',
                                        'stroke-linecap': 'round',
                                        'stroke-linejoin': 'round',
                                    })
                                ),
                                h('span', { id: 'bd-toggle-text' }, '构成')
                            )
                        ),
                        h('span', { class: 'state-badge', id: 'card-badge' }, '待采样')
                    ),
                    h(
                        'div',
                        { class: 'card-body' },
                        h(
                            'div',
                            { class: 'big-gauge-wrap' },
                            svgEl(
                                'svg',
                                { class: 'big-gauge', viewBox: '0 0 64 64', 'aria-hidden': 'true' },
                                svgEl('circle', {
                                    class: 'big-track',
                                    cx: '32',
                                    cy: '32',
                                    r: String(BIG_R),
                                    'stroke-dasharray': `${BIG_ARC.toFixed(2)} ${BIG_C.toFixed(2)}`,
                                    transform: 'rotate(135 32 32)',
                                }),
                                svgEl('circle', {
                                    class: 'big-arc',
                                    id: 'big-arc',
                                    cx: '32',
                                    cy: '32',
                                    r: String(BIG_R),
                                    'stroke-dasharray': `0 ${BIG_C.toFixed(2)}`,
                                    transform: 'rotate(135 32 32)',
                                })
                            ),
                            h(
                                'div',
                                { class: 'big-center' },
                                h('span', { class: 'big-pct', id: 'card-pct' }, '--'),
                                h('span', { class: 'big-sub' }, '已用')
                            )
                        ),
                        h(
                            'div',
                            { class: 'stats' },
                            h('div', { class: 'stat-row' }, h('span', { class: 'stat-label' }, '已用 Token'), h('span', { class: 'stat-value', id: 'card-used' }, '—')),
                            h('div', { class: 'stat-row' }, h('span', { class: 'stat-label' }, '剩余可用'), h('span', { class: 'stat-value', id: 'card-rem' }, '—')),
                            h('div', { class: 'stat-row' }, h('span', { class: 'stat-label' }, '窗口上限'), h('span', { class: 'stat-value', id: 'card-max' }, '—'))
                        )
                    ),
                    h(
                        'div',
                        { class: 'card-foot' },
                        h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '采样模型'), h('span', { class: 'stat-value', id: 'card-model', title: '' }, '—')),
                        h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '生成速率'), h('span', { class: 'stat-value', id: 'card-tps', title: '' }, '—')),
                        h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '本次缓存'), h('span', { class: 'stat-value', id: 'card-cache-last', title: '' }, '—')),
                        h('div', { class: 'foot-row' }, h('span', { class: 'stat-label' }, '累计缓存'), h('span', { class: 'stat-value', id: 'card-cache-total', title: '' }, '—'))
                    )
                );

                const wrap = h('div', { class: 'ctx-portal-wrap', 'data-ag-localization-skip': 'true' }, card);
                cardRoot.appendChild(styleEl);
                cardRoot.appendChild(wrap);

                cardRoot.getElementById('card-breakdown-toggle').addEventListener('click', (e) => {
                    e.stopPropagation();
                    breakdownOpen = !breakdownOpen;
                    pinnedOpen = true;
                    updateCardVisibility();
                });

                card.addEventListener('pointerenter', () => {
                    clearTimeout(closeTimer);
                });
                card.addEventListener('pointerleave', () => {
                    scheduleHoverClose();
                });
                cardRoot.addEventListener('pointerdown', (e) => e.stopPropagation());
                cardRoot.addEventListener('click', (e) => e.stopPropagation());
            }

            const mountParent = getPortalMountParent();
            if (mountParent && cardPortal.parentElement !== mountParent) {
                mountParent.appendChild(cardPortal);
            }
        }

        function createInstance(comp) {
            const host = document.createElement('div');
            host.className = RING_HOST_CLASS;
            host.setAttribute('data-ag-ctx-role', 'ring');
            host.setAttribute('data-ag-localization-skip', 'true');
            host.style.cssText = 'display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;position:relative;';

            const root = host.attachShadow({ mode: 'open' });
            const styleEl = document.createElement('style');
            styleEl.textContent = `
                ${THEME_VARS_CSS}
                :host([data-compact="hidden"]) { display: none !important; }
                .trigger {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    height: 26px;
                    padding: 0 7px 0 5px;
                    border: 0;
                    border-radius: 999px;
                    background: transparent;
                    color: var(--ctx-muted);
                    font: inherit;
                    font-size: 11.5px;
                    line-height: 1;
                    cursor: pointer;
                    user-select: none;
                    transition: background-color 140ms ease, color 140ms ease;
                }
                .trigger:hover,
                .trigger[aria-expanded="true"] {
                    background: var(--ctx-pill-hover);
                    color: var(--ctx-fg);
                }
                .trigger:active { background: var(--ctx-pill-active); }
                .trigger:focus-visible {
                    outline: 2px solid var(--ctx-accent);
                    outline-offset: 1px;
                }
                :host([data-compact="icon"]) .trigger {
                    width: 26px;
                    padding: 0;
                    justify-content: center;
                }
                :host([data-compact="icon"]) .pct-text { display: none; }
                .mini-gauge {
                    width: 16px;
                    height: 16px;
                    flex: none;
                    display: block;
                }
                .mini-track {
                    fill: none;
                    stroke: var(--ctx-track);
                    stroke-width: 1.9;
                    stroke-linecap: round;
                }
                .mini-arc {
                    fill: none;
                    stroke: var(--ctx-tone);
                    stroke-width: 1.9;
                    stroke-linecap: round;
                    transition: stroke-dasharray 240ms cubic-bezier(0.22, 1, 0.36, 1), stroke 180ms ease;
                }
                .mini-core {
                    fill: var(--ctx-tone);
                    transition: fill 180ms ease, opacity 180ms ease;
                }
                :host([data-level="idle"]) .mini-core { opacity: 0.45; }
                .pct-text {
                    font-variant-numeric: tabular-nums;
                    font-weight: 550;
                    letter-spacing: -0.01em;
                    color: var(--ctx-fg);
                }
                :host([data-level="idle"]) .pct-text { color: var(--ctx-muted); }
            `;

            const trigger = h(
                'button',
                { type: 'button', class: 'trigger', id: 'ctx-trigger', 'aria-label': '上下文窗口占用', 'aria-expanded': 'false' },
                svgEl(
                    'svg',
                    { class: 'mini-gauge', viewBox: '0 0 18 18', 'aria-hidden': 'true' },
                    svgEl('circle', {
                        class: 'mini-track',
                        cx: '9',
                        cy: '9',
                        r: String(RING_R),
                        'stroke-dasharray': `${RING_ARC.toFixed(2)} ${RING_C.toFixed(2)}`,
                        transform: 'rotate(135 9 9)',
                    }),
                    svgEl('circle', {
                        class: 'mini-arc',
                        id: 'mini-arc',
                        cx: '9',
                        cy: '9',
                        r: String(RING_R),
                        'stroke-dasharray': `0 ${RING_C.toFixed(2)}`,
                        transform: 'rotate(135 9 9)',
                    }),
                    svgEl('circle', { class: 'mini-core', cx: '9', cy: '9', r: '2.05' })
                ),
                h('span', { class: 'pct-text', id: 'mini-pct' }, '--')
            );
            const wrap = h('div', { class: 'ctx-wrap', 'data-ag-localization-skip': 'true' }, trigger);
            root.appendChild(styleEl);
            root.appendChild(wrap);

            const speedHost = document.createElement('div');
            speedHost.className = SPEED_HOST_CLASS;
            speedHost.setAttribute('data-ag-ctx-role', 'speed');
            speedHost.setAttribute('data-ag-localization-skip', 'true');
            speedHost.setAttribute('data-theme', detectDarkTheme(comp.box) ? 'dark' : 'light');

            const speedRoot = speedHost.attachShadow({ mode: 'open' });
            const speedStyle = document.createElement('style');
            speedStyle.textContent = `
                :host {
                    display: inline-flex;
                    align-items: center;
                    flex: 0 0 auto;
                    margin: 0 2px 0 4px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
                    --sp-ink: #e5e7eb;
                    --sp-muted: rgba(229, 231, 235, 0.62);
                    --sp-hover: rgba(255, 255, 255, 0.08);
                    --sp-dot-idle: rgba(229, 231, 235, 0.34);
                    --sp-dot-ok: #34d399;
                    --sp-dot-run: #38bdf8;
                    --sp-run-ink: #7dd3fc;
                }
                :host([data-theme="light"]) {
                    --sp-ink: #1f2937;
                    --sp-muted: rgba(31, 41, 55, 0.60);
                    --sp-hover: rgba(15, 23, 42, 0.06);
                    --sp-dot-idle: rgba(31, 41, 55, 0.28);
                    --sp-dot-ok: #16a34a;
                    --sp-dot-run: #0284c7;
                    --sp-run-ink: #0369a1;
                }
                :host([data-compact="hidden"]) { display: none; }
                :host([data-compact="brief"]) .speed-sep,
                :host([data-compact="brief"]) .speed-sub { display: none; }
                .ctx-speed-wrap { display: inline-flex; align-items: center; }
                .speed-pill {
                    appearance: none;
                    border: none;
                    margin: 0;
                    background: transparent;
                    color: var(--sp-muted);
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    height: 22px;
                    padding: 0 6px;
                    border-radius: 6px;
                    cursor: pointer;
                    font: inherit;
                    font-size: 11px;
                    font-weight: 500;
                    line-height: 1;
                    font-variant-numeric: tabular-nums;
                    white-space: nowrap;
                    transition: background-color 140ms ease, color 140ms ease;
                }
                .speed-pill:hover,
                .speed-pill[aria-expanded="true"] {
                    background: var(--sp-hover);
                    color: var(--sp-ink);
                }
                .speed-pill:focus-visible {
                    outline: 1.5px solid var(--sp-dot-run);
                    outline-offset: 1px;
                }
                :host([data-running="true"]) .speed-pill { color: var(--sp-run-ink); }
                .speed-dot {
                    width: 5px;
                    height: 5px;
                    border-radius: 50%;
                    flex: none;
                    background: var(--sp-dot-idle);
                    transition: background-color 180ms ease;
                }
                :host([data-has-speed="true"]) .speed-dot { background: var(--sp-dot-ok); }
                :host([data-running="true"]) .speed-dot {
                    background: var(--sp-dot-run);
                    animation: agCtxPulse 1.3s ease-in-out infinite;
                }
                .speed-sep { opacity: 0.55; }
                @keyframes agCtxPulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.4; transform: scale(0.82); }
                }
            `;

            const speedTrigger = h(
                'button',
                {
                    type: 'button',
                    class: 'speed-pill',
                    id: 'speed-trigger',
                    'aria-label': '模型生成速率与首字耗时',
                    'aria-expanded': 'false',
                },
                h('span', { class: 'speed-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'speed-main', id: 'speed-main' }, '-- t/s'),
                h('span', { class: 'speed-sep', id: 'speed-sep', hidden: '' }, '·'),
                h('span', { class: 'speed-sub', id: 'speed-sub', hidden: '' }, '')
            );
            const speedWrap = h('div', { class: 'ctx-speed-wrap', 'data-ag-localization-skip': 'true' }, speedTrigger);
            speedRoot.appendChild(speedStyle);
            speedRoot.appendChild(speedWrap);

            const inst = {
                box: comp.box,
                comp,
                host,
                root,
                speedHost,
                speedRoot,
                conversationId: null,
                latestPayload: null,
                lastFetchAt: 0,
                lastToolbarWidth: -1,
                isFetching: false,
                fetchEpoch: 0,
                resizeObserver: null,
            };

            bindCardTrigger(inst, trigger, 'ring');
            root.addEventListener('pointerdown', (e) => e.stopPropagation());
            root.addEventListener('click', (e) => e.stopPropagation());

            bindCardTrigger(inst, speedTrigger, 'speed');
            speedRoot.addEventListener('pointerdown', (e) => e.stopPropagation());
            speedRoot.addEventListener('click', (e) => e.stopPropagation());

            return inst;
        }

        function ensureInstanceUi(inst, comp) {
            inst.comp = comp;
            const { host, speedHost } = inst;

            let speedMoved = false;
            if (comp.speedParent && comp.speedParent.isConnected && comp.speedAfter && comp.speedAfter.parentElement === comp.speedParent) {
                if (speedHost.parentElement !== comp.speedParent || speedHost.previousElementSibling !== comp.speedAfter) {
                    comp.speedParent.insertBefore(speedHost, comp.speedAfter.nextSibling);
                    speedMoved = true;
                }
            } else if (speedHost.isConnected) {
                speedHost.remove();
                speedMoved = true;
            }

            let ringMoved = false;
            const parent = comp.mountParent;
            const targetBefore = comp.beforeNode && comp.beforeNode.parentElement === parent ? comp.beforeNode : null;
            const rawAfter = comp.afterNode && comp.afterNode.parentElement === parent ? comp.afterNode : null;
            const targetAfter = rawAfter && speedHost && speedHost.parentElement === parent && rawAfter === comp.speedAfter
                ? speedHost
                : rawAfter;
            if (targetAfter) {
                if (host.parentElement !== parent || host.previousElementSibling !== targetAfter) {
                    parent.insertBefore(host, targetAfter.nextSibling);
                    ringMoved = true;
                }
            } else if (targetBefore) {
                if (host.parentElement !== parent || host.nextElementSibling !== targetBefore) {
                    parent.insertBefore(host, targetBefore);
                    ringMoved = true;
                }
            } else if (host.parentElement !== parent) {
                parent.appendChild(host);
                ringMoved = true;
            }
            if (speedMoved || ringMoved || !inst.resizeObserver) {
                observeToolbar(inst, comp);
            }
            return Boolean(speedMoved || ringMoved);
        }

        function bindCardTrigger(inst, btn, anchorName) {
            btn.addEventListener('pointerenter', () => {
                clearTimeout(closeTimer);
                if (pinnedOpen) return;
                hoverTimer = setTimeout(() => {
                    activeInst = inst;
                    activeAnchor = anchorName;
                    hoverOpen = true;
                    renderPortalCard(inst);
                    updateCardVisibility();
                }, 220);
            });
            btn.addEventListener('pointerleave', () => {
                clearTimeout(hoverTimer);
                scheduleHoverClose();
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                clearTimeout(hoverTimer);
                clearTimeout(closeTimer);
                if (pinnedOpen && activeInst === inst && activeAnchor === anchorName) {
                    pinnedOpen = false;
                    hoverOpen = false;
                } else {
                    activeInst = inst;
                    activeAnchor = anchorName;
                    pinnedOpen = true;
                    renderPortalCard(inst);
                }
                updateCardVisibility();
            });
        }

        function closeCard() {
            pinnedOpen = false;
            hoverOpen = false;
            updateCardVisibility();
        }

        function scheduleHoverClose() {
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => {
                hoverOpen = false;
                updateCardVisibility();
            }, 160);
        }

        function getActiveAnchorTrigger() {
            if (!activeInst) return { mode: 'ring', el: null };
            const useSpeed = Boolean(
                activeAnchor === 'speed' &&
                activeInst.speedHost &&
                activeInst.speedHost.isConnected &&
                activeInst.speedHost.getAttribute('data-compact') !== 'hidden'
            );
            return {
                mode: useSpeed ? 'speed' : 'ring',
                el: useSpeed
                    ? activeInst.speedRoot.getElementById('speed-trigger')
                    : activeInst.root.getElementById('ctx-trigger'),
            };
        }

        function updateCardVisibility(skipFetch = false) {
            ensureCardPortal();
            const card = cardRoot ? cardRoot.getElementById('ctx-card') : null;
            if (!card) return;
            const anchor = getActiveAnchorTrigger();
            const canShow = Boolean(
                activeInst &&
                activeInst.host.isConnected &&
                anchor.el &&
                (anchor.mode === 'speed' || activeInst.host.getAttribute('data-compact') !== 'hidden')
            );
            const open = Boolean((pinnedOpen || hoverOpen) && canShow);

            for (const inst of instances.values()) {
                const isThisInst = open && inst === activeInst;
                inst.root.getElementById('ctx-trigger').setAttribute('aria-expanded', String(isThisInst && anchor.mode === 'ring'));
                inst.speedRoot.getElementById('speed-trigger').setAttribute('aria-expanded', String(isThisInst && anchor.mode === 'speed'));
            }

            card.hidden = !open;
            if (open) {
                renderPortalCard(activeInst);
                positionCard();
            }
        }

        function positionCard() {
            if (!cardRoot) return;
            const card = cardRoot.getElementById('ctx-card');
            if (!card || card.hidden) return;
            const anchor = getActiveAnchorTrigger();
            if (!anchor.el || !anchor.el.isConnected) {
                card.hidden = true;
                return;
            }
            const tr = anchor.el.getBoundingClientRect();
            const cw = card.offsetWidth || 292;
            const ch = card.offsetHeight || 205;
            const idealLeft = anchor.mode === 'ring' ? (tr.right - cw) : tr.left;
            const left = Math.min(Math.max(8, idealLeft), Math.max(8, window.innerWidth - cw - 8));
            let top = tr.top - ch - 8;
            if (top < 8) {
                top = Math.min(Math.max(8, window.innerHeight - ch - 8), tr.bottom + 8);
            }
            card.style.left = `${Math.round(left)}px`;
            card.style.top = `${Math.round(top)}px`;
        }

        function observeToolbar(inst, comp) {
            if (inst.resizeObserver) inst.resizeObserver.disconnect();
            if (typeof ResizeObserver !== 'function') return;
            inst.resizeObserver = new ResizeObserver(() => {
                fitInstanceLayout(inst);
                if (inst === activeInst) positionCard();
            });
            if (comp.toolbar) inst.resizeObserver.observe(comp.toolbar);
            if (comp.leftGroup) inst.resizeObserver.observe(comp.leftGroup);
            if (comp.speedParent && comp.speedParent !== comp.leftGroup) {
                inst.resizeObserver.observe(comp.speedParent);
            }
            if (comp.mountParent && comp.mountParent !== comp.leftGroup && comp.mountParent !== comp.speedParent) {
                inst.resizeObserver.observe(comp.mountParent);
            }
        }

        function fitInstanceLayout(inst) {
            const { host, speedHost, comp } = inst;
            if (!host || !comp || !comp.toolbar || !comp.toolbar.isConnected) return;
            const dark = detectDarkTheme(comp.box);
            const prevHostCompact = host.getAttribute('data-compact') || '';
            const prevSpeedCompact = speedHost && speedHost.isConnected ? (speedHost.getAttribute('data-compact') || '') : '';
            host.setAttribute('data-theme', dark ? 'dark' : 'light');
            host.removeAttribute('data-compact');

            const tbWidth = comp.toolbar.clientWidth || 0;
            inst.lastToolbarWidth = tbWidth;
            const lg = comp.leftGroup;
            const inLeft = Boolean(lg && comp.mountParent === lg);
            const isWrappedBelowModel = (el) => {
                if (!el || !el.isConnected || !comp.modelBtn || !comp.modelBtn.isConnected) return false;
                const mr = comp.modelBtn.getBoundingClientRect();
                const er = el.getBoundingClientRect();
                return er.width > 0 && mr.height > 0 && er.top >= mr.bottom - 2;
            };
            const leftOverflow = () => Boolean(lg && lg.isConnected && lg.scrollWidth > lg.clientWidth + 2);

            let nextSpeedCompact = '';
            if (speedHost && speedHost.isConnected) {
                speedHost.setAttribute('data-theme', dark ? 'dark' : 'light');
                speedHost.removeAttribute('data-compact');
                if ((tbWidth > 0 && tbWidth < 380) || isWrappedBelowModel(speedHost) || leftOverflow()) {
                    nextSpeedCompact = 'brief';
                    speedHost.setAttribute('data-compact', 'brief');
                    if ((tbWidth > 0 && tbWidth < 250) || isWrappedBelowModel(speedHost) || leftOverflow()) {
                        nextSpeedCompact = 'hidden';
                        speedHost.setAttribute('data-compact', 'hidden');
                    }
                }
            }

            let nextHostCompact = '';
            const wrapped = () => Boolean(inLeft && isWrappedBelowModel(host));
            const ringLeftOverflow = () => Boolean(inLeft && leftOverflow());
            const needCompact = (tbWidth > 0 && tbWidth < 310) || wrapped() || ringLeftOverflow();
            if (needCompact) {
                nextHostCompact = 'icon';
                host.setAttribute('data-compact', 'icon');
                if ((tbWidth > 0 && tbWidth < 190) || wrapped() || ringLeftOverflow()) {
                    nextHostCompact = 'hidden';
                    host.setAttribute('data-compact', 'hidden');
                }
            }

            if (inst === activeInst && (pinnedOpen || hoverOpen)) {
                if (prevHostCompact !== nextHostCompact || prevSpeedCompact !== nextSpeedCompact) {
                    updateCardVisibility(true);
                } else {
                    positionCard();
                }
            }
        }

        function computeStatusState(payload) {
            const ctx = payload && payload.context;
            const hasRatio = Boolean(ctx && typeof ctx.usedFraction === 'number' && Number.isFinite(ctx.usedFraction));
            const ratio = hasRatio ? Math.max(0, ctx.usedFraction) : 0;
            const clampedRatio = Math.min(1, ratio);

            let level = 'idle';
            let badgeText = '待采样';
            if (payload && payload.status === 'offline') {
                badgeText = '等待服务';
            } else if (ctx && !hasRatio) {
                badgeText = '容量未知';
            } else if (hasRatio) {
                if (ratio >= 0.9) { level = 'danger'; badgeText = '接近上限'; }
                else if (ratio >= 0.7) { level = 'warn'; badgeText = '占用偏高'; }
                else { level = 'normal'; badgeText = '正常'; }
            }
            return { ctx, hasRatio, ratio, clampedRatio, level, badgeText };
        }

        function formatPct(fraction) {
            if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0) return '0.0%';
            if (fraction < 0.0005) return '<0.1%';
            return `${(fraction * 100).toFixed(1)}%`;
        }

        function replaceChildrenSafe(parent, nodes) {
            if (!parent) return;
            while (parent.firstChild) parent.removeChild(parent.firstChild);
            for (const n of nodes) parent.appendChild(n);
        }

        function renderBreakdownSection(inst) {
            if (!cardRoot) return;
            const breakdownEl = cardRoot.getElementById('card-breakdown');
            const toggleBtn = cardRoot.getElementById('card-breakdown-toggle');
            const toggleText = cardRoot.getElementById('bd-toggle-text');
            const barEl = cardRoot.getElementById('bd-bar');
            const catListEl = cardRoot.getElementById('bd-categories');
            const noteEl = cardRoot.getElementById('bd-note');
            if (!breakdownEl || !toggleBtn) return;

            const bd = inst && inst.latestPayload ? inst.latestPayload.breakdown : null;
            toggleBtn.setAttribute('aria-expanded', String(breakdownOpen));
            if (toggleText) {
                toggleText.textContent = '构成';
            }

            breakdownEl.hidden = !breakdownOpen;
            if (!breakdownOpen) return;

            const denom = bd && typeof bd.denomTokens === 'number' ? bd.denomTokens : 0;
            const segs = [];
            const catRows = [];
            const categories = bd && Array.isArray(bd.categories) ? bd.categories : [];
            for (const cat of categories) {
                const tokStr = formatCompactTokens(cat.tokens);
                const pctStr = cat.fraction === null || cat.fraction === undefined ? '—' : formatPct(cat.fraction);
                const title = `${cat.label}: ${formatExactTokens(cat.tokens)}${pctStr !== '—' ? ` · ${pctStr}` : ''}`;
                const frac = typeof cat.fraction === 'number'
                    ? cat.fraction
                    : (denom > 0 && typeof cat.tokens === 'number' ? cat.tokens / denom : 0);
                if (denom > 0 && typeof cat.tokens === 'number' && cat.tokens > 0 && frac > 0) {
                    const pct = Math.min(100, Math.max(0, frac * 100));
                    segs.push(
                        h('span', {
                            class: 'bd-seg',
                            title,
                            'data-free': cat.isFree ? 'true' : undefined,
                            style: `width:${pct.toFixed(2)}%;${cat.isFree ? '' : `background:${cat.color || '#64748b'};`}`,
                        })
                    );
                }
                catRows.push(
                    h(
                        'div',
                        { class: 'bd-row', title, 'data-free': cat.isFree ? 'true' : undefined },
                        h('span', { class: 'bd-dot', style: `background:${cat.color || '#64748b'}` }),
                        h('span', { class: 'bd-name' }, cat.label || cat.key),
                        h('span', { class: 'bd-tokens' }, tokStr),
                        h('span', { class: 'bd-pct' }, pctStr)
                    )
                );
            }
            if (barEl) {
                replaceChildrenSafe(barEl, segs);
                barEl.hidden = segs.length === 0;
            }
            replaceChildrenSafe(catListEl, catRows);

            if (noteEl) {
                if (!bd) {
                    noteEl.hidden = false;
                    noteEl.textContent = '等待首个请求后展示分类构成';
                } else if (categories.length === 0) {
                    noteEl.hidden = false;
                    noteEl.textContent = '暂无可拆分的构成数据';
                } else {
                    noteEl.hidden = true;
                    noteEl.textContent = '';
                }
            }
        }

        function renderPortalCard(inst) {
            ensureCardPortal();
            if (!cardPortal || !cardRoot || !inst) return;
            const dark = detectDarkTheme(inst.box);
            const payload = inst.latestPayload;
            const { ctx, hasRatio, ratio, clampedRatio, level, badgeText } = computeStatusState(payload);

            cardPortal.setAttribute('data-theme', dark ? 'dark' : 'light');
            cardPortal.setAttribute('data-level', level);

            const pctDetail = hasRatio ? `${(ratio * 100).toFixed(1)}%` : '--';
            cardRoot.getElementById('big-arc').setAttribute('stroke-dasharray', `${(BIG_ARC * clampedRatio).toFixed(2)} ${BIG_C.toFixed(2)}`);
            cardRoot.getElementById('card-pct').textContent = pctDetail;
            cardRoot.getElementById('card-badge').textContent = badgeText;

            const usedEl = cardRoot.getElementById('card-used');
            const remEl = cardRoot.getElementById('card-rem');
            const maxEl = cardRoot.getElementById('card-max');
            const modelEl = cardRoot.getElementById('card-model');
            const tpsEl = cardRoot.getElementById('card-tps');
            const cacheLastEl = cardRoot.getElementById('card-cache-last');
            const cacheTotalEl = cardRoot.getElementById('card-cache-total');

            if (ctx) {
                usedEl.textContent = formatCompactTokens(ctx.usedTokens);
                usedEl.title = formatExactTokens(ctx.usedTokens);
                remEl.textContent = ctx.remainingTokens === null ? '—' : formatCompactTokens(ctx.remainingTokens);
                remEl.title = ctx.remainingTokens === null ? '' : formatExactTokens(ctx.remainingTokens);
                maxEl.textContent = ctx.maxTokens === null ? '不可用' : formatCompactTokens(ctx.maxTokens);
                maxEl.title = ctx.maxTokens === null ? '' : formatExactTokens(ctx.maxTokens);
                modelEl.textContent = ctx.model || '—';
                modelEl.title = ctx.model || '';
            } else {
                usedEl.textContent = '—';
                usedEl.title = '';
                remEl.textContent = '—';
                remEl.title = '';
                maxEl.textContent = '—';
                maxEl.title = '';
                modelEl.textContent = '—';
                modelEl.title = '';
            }

            const isRunning = Boolean(payload && payload.running);
            const speedView = formatSpeedView(payload && payload.speed, isRunning);
            tpsEl.textContent = speedView.tpsText;
            tpsEl.title = speedView.tpsTitle;

            const cache = payload && payload.cache;
            const lastStat = formatCacheStat(cache && cache.latest);
            const totalStat = formatCacheStat(cache && cache.session, cache && cache.session && cache.session.requests);
            cacheLastEl.textContent = lastStat.text;
            cacheLastEl.title = lastStat.title;
            cacheTotalEl.textContent = totalStat.text;
            cacheTotalEl.title = totalStat.title;

            renderBreakdownSection(inst);
        }

        function renderInstance(inst) {
            const { host, root, speedHost, speedRoot } = inst;
            const dark = detectDarkTheme(inst.box);
            const payload = inst.latestPayload;
            const { hasRatio, ratio, clampedRatio, level } = computeStatusState(payload);
            const isRunning = Boolean(payload && payload.running);

            host.setAttribute('data-theme', dark ? 'dark' : 'light');
            host.setAttribute('data-level', level);

            const miniArc = root.getElementById('mini-arc');
            miniArc.setAttribute('stroke-dasharray', `${(RING_ARC * clampedRatio).toFixed(2)} ${RING_C.toFixed(2)}`);

            const pctShort = hasRatio ? `${Math.round(ratio * 100)}%` : '--';
            const pctDetail = hasRatio ? `${(ratio * 100).toFixed(1)}%` : '--';
            root.getElementById('mini-pct').textContent = pctShort;
            root.getElementById('ctx-trigger').setAttribute(
                'aria-label',
                hasRatio ? `上下文窗口占用 ${pctDetail}` : '上下文窗口待采样'
            );

            const speedView = formatSpeedView(payload && payload.speed, isRunning);
            speedHost.setAttribute('data-theme', dark ? 'dark' : 'light');
            speedHost.setAttribute('data-running', String(isRunning));
            speedHost.setAttribute('data-has-speed', String(speedView.hasMetrics));
            const speedMainEl = speedRoot.getElementById('speed-main');
            const speedSepEl = speedRoot.getElementById('speed-sep');
            const speedSubEl = speedRoot.getElementById('speed-sub');
            const speedBtnEl = speedRoot.getElementById('speed-trigger');
            speedMainEl.textContent = speedView.mainText;
            speedSubEl.textContent = speedView.subText;
            speedSepEl.hidden = !speedView.subText;
            speedSubEl.hidden = !speedView.subText;
            speedBtnEl.title = speedView.pillTitle;
            speedBtnEl.setAttribute('aria-label', speedView.pillTitle);

            fitInstanceLayout(inst);
            if (inst === activeInst && (pinnedOpen || hoverOpen)) {
                renderPortalCard(inst);
                positionCard();
            }
        }

        async function refreshInstance(inst, force = false) {
            if (inst.isFetching) {
                return;
            }
            const convId = inst.conversationId;
            const myEpoch = inst.fetchEpoch;
            if (!convId) {
                inst.lastFetchAt = Date.now();
                const alreadyNew = inst.latestPayload && inst.latestPayload.status === 'new' && inst.latestPayload.conversationId === null;
                if (!alreadyNew) {
                    inst.latestPayload = { status: 'new', running: false, conversationId: null, context: null, cache: null, speed: null, breakdown: null };
                    renderInstance(inst);
                }
                return;
            }
            inst.isFetching = true;
            inst.lastFetchAt = Date.now();
            try {
                const res = await window.__agCtxBridge.getMetrics(convId, force);
                if (myEpoch !== inst.fetchEpoch || convId !== inst.conversationId) return;
                inst.latestPayload = res || { status: 'error', running: false, conversationId: convId, context: null, cache: null, speed: null, breakdown: null };
                renderInstance(inst);
            } catch {
                // 保持已有显示，待下一轮自动重连
            } finally {
                if (myEpoch === inst.fetchEpoch) {
                    inst.isFetching = false;
                }
            }
        }

        function sync() {
            const comps = findAllComposers();
            const seen = new Set(comps.map((c) => c.box));

            for (const [box, inst] of instances.entries()) {
                if (seen.has(box)) continue;
                if (inst.resizeObserver) inst.resizeObserver.disconnect();
                if (inst.host.isConnected) inst.host.remove();
                if (inst.speedHost.isConnected) inst.speedHost.remove();
                instances.delete(box);
                if (activeInst === inst) {
                    activeInst = null;
                    closeCard();
                }
            }

            if (!comps.length) return;
            ensureCardPortal();

            for (const comp of comps) {
                let inst = instances.get(comp.box);
                const isNew = !inst;
                if (isNew) {
                    inst = createInstance(comp);
                    instances.set(comp.box, inst);
                }
                const moved = ensureInstanceUi(inst, comp);
                const nextId = resolveConversationId(comp);
                if (isNew || nextId !== inst.conversationId) {
                    inst.conversationId = nextId;
                    inst.fetchEpoch++;
                    inst.latestPayload = null;
                    inst.lastFetchAt = 0;
                    inst.lastToolbarWidth = -1;
                    inst.isFetching = false;
                    renderInstance(inst);
                    void refreshInstance(inst, true);
                } else if (moved || (comp.toolbar && comp.toolbar.clientWidth !== inst.lastToolbarWidth)) {
                    fitInstanceLayout(inst);
                }
            }
        }

        function scheduleSync() {
            if (layoutScheduled) return;
            layoutScheduled = true;
            requestAnimationFrame(() => {
                layoutScheduled = false;
                sync();
            });
        }

        function isOwnUiTarget(target) {
            if (cardPortal && (target === cardPortal || cardPortal.contains(target))) return true;
            for (const inst of instances.values()) {
                if (target === inst.host || inst.host.contains(target)) return true;
                if (target === inst.speedHost || inst.speedHost.contains(target)) return true;
            }
            return false;
        }

        const domObserver = new MutationObserver((records) => {
            if (records.some((r) => !isOwnUiTarget(r.target))) {
                scheduleSync();
            }
        });
        domObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'inert', 'data-cascade-id', 'data-testid'],
        });

        document.addEventListener('pointerdown', () => {
            if (pinnedOpen || hoverOpen) closeCard();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && (pinnedOpen || hoverOpen)) closeCard();
        });
        document.addEventListener('focusin', scheduleSync);
        window.addEventListener('resize', () => {
            for (const inst of instances.values()) {
                fitInstanceLayout(inst);
            }
            positionCard();
        });

        setInterval(() => {
            sync();
            const now = Date.now();
            for (const inst of instances.values()) {
                const interval = document.hidden ? 10000 : (inst.latestPayload && inst.latestPayload.running ? 1100 : 2200);
                if (now - inst.lastFetchAt >= interval) {
                    void refreshInstance(inst, false);
                }
            }
        }, 1000);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', sync, { once: true });
        } else {
            sync();
        }
    }

    const RENDERER_INJECT_SOURCE = `'use strict';(${rendererBootstrap.toString()})();`;

    function isTargetHubWebContents(wc) {
        if (!wc || wc.isDestroyed()) return false;
        const wcType = typeof wc.getType === 'function' ? wc.getType() : '';
        if (wcType === 'webview' || wcType === 'devtools' || wcType === 'remote' || wcType === 'offscreen' || wcType === 'backgroundPage') {
            return false;
        }
        if (hubUtils && typeof hubUtils.getLocalHubWindows === 'function' && typeof hubUtils.getHubWebContents === 'function') {
            try {
                const hubWins = hubUtils.getLocalHubWindows();
                if (Array.isArray(hubWins) && hubWins.length > 0) {
                    return hubWins.some((w) => hubUtils.getHubWebContents(w) === wc);
                }
            } catch {}
        }
        return true;
    }

    function injectIntoWebContents(wc) {
        if (!isTargetHubWebContents(wc)) return;
        const url = typeof wc.getURL === 'function' ? wc.getURL() : '';
        if (!LOCAL_ORIGIN_RE.test(url)) return;
        Promise.resolve(wc.executeJavaScript(RENDERER_INJECT_SOURCE, false)).catch((err) => {
            if (err && err.message) {
                console.warn('[ag-ctx-monitor] renderer inject failed:', err.message);
            }
        });
    }

    app.on('web-contents-created', (_event, wc) => {
        wc.on('dom-ready', () => injectIntoWebContents(wc));
        wc.on('did-finish-load', () => injectIntoWebContents(wc));
    });

    try {
        const list = typeof webContents?.getAllWebContents === 'function'
            ? webContents.getAllWebContents()
            : BrowserWindow.getAllWindows().map((w) => !w.isDestroyed() && w.webContents).filter(Boolean);
        for (const wc of list) {
            injectIntoWebContents(wc);
        }
    } catch {}
})();

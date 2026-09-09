const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

if (process.platform === 'win32') {
    const defaultNodePaths = [
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'node'),
        path.join(process.env.APPDATA || '', 'npm')
    ];
    for (const nodePath of defaultNodePaths) {
        if (fs.existsSync(nodePath)) {
            if (!process.env.PATH.includes(nodePath)) {
                process.env.PATH = `${nodePath};${process.env.PATH}`;
            }
        }
    }
}

const DICTS_FOLDER = 'dicts';
const BRAND_TITLE_ALIASES = {
    english: 'english',
    en: 'english',
    default: 'english',
    hidden: 'hidden',
    hide: 'hidden',
    none: 'hidden',
    translated: 'translated',
    chinese: 'translated',
    cn: 'translated',
    zh: 'translated'
};

function getOptionValue(name, defaultValue) {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === name) {
            return args[i + 1] || defaultValue;
        }
        if (args[i].startsWith(name + '=')) {
            return args[i].slice(name.length + 1);
        }
    }
    return defaultValue;
}

const BRAND_TITLE_MODE = BRAND_TITLE_ALIASES[String(getOptionValue('--brand-title', 'english')).toLowerCase()] || 'english';

const SIGNATURE_START = "'__ANTIGRAVITY_CHINESE_LOCALIZATION_START__';";
const SIGNATURE_END = "'__ANTIGRAVITY_CHINESE_LOCALIZATION_END__';";
const MENU_SIGNATURE_START = "'__ANTIGRAVITY_NATIVE_MENU_TRANSLATION_START__';";
const MENU_SIGNATURE_END = "'__ANTIGRAVITY_NATIVE_MENU_TRANSLATION_END__';";
const TRAY_SIGNATURE_START = "'__ANTIGRAVITY_TRAY_TRANSLATION_START__';";
const TRAY_SIGNATURE_END = "'__ANTIGRAVITY_TRAY_TRANSLATION_END__';";
const LEGACY_SIGNATURE_START = ['/', '* --- ANTIGRAVITY CHINESE LOCALIZATION START --- *', '/'].join('');
const LEGACY_SIGNATURE_END = ['/', '* --- ANTIGRAVITY CHINESE LOCALIZATION END --- *', '/'].join('');
const LEGACY_MENU_SIGNATURE_START = ['/', '/ =========================================='].join('');
const LEGACY_MENU_SIGNATURE_END = 'translateMenu(menu.items);';
const LEGACY_TRAY_SIGNATURE_START = ['/', '* --- TRAY TRANSLATION START --- *', '/'].join('');
const LEGACY_TRAY_SIGNATURE_END = ['/', '* --- TRAY TRANSLATION END --- *', '/'].join('');

function normalizeText(text) {
    if (!text) return "";
    return text.replace(/\s+/g, ' ')
               .trim()
               .replace(/’/g, "'")
               .replace(/‘/g, "'")
               .replace(/“/g, '"')
               .replace(/”/g, '"');
}

function loadDictionary() {
    const totalMap = {};
    const dictsDir = path.join(__dirname, DICTS_FOLDER);
    if (fs.existsSync(dictsDir)) {
        const files = fs.readdirSync(dictsDir).filter(file => file.endsWith('.json')).sort();
        for (const file of files) {
            try {
                const filePath = path.join(dictsDir, file);
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(fileContent);
                for (const [k, v] of Object.entries(data)) {
                    const normK = normalizeText(k);
                    if (normK) totalMap[normK] = v;
                }
            } catch (e) {
            }
        }
    }
    if (BRAND_TITLE_MODE === 'english') {
        delete totalMap[normalizeText('Antigravity')];
    } else if (BRAND_TITLE_MODE === 'hidden') {
        totalMap[normalizeText('Antigravity')] = '';
    }
    return totalMap;
}

function generateJs() {
    const fullDict = loadDictionary();
    const longEntries = Object.entries(fullDict).sort((a, b) => b[0].length - a[0].length);

    const dictJson = JSON.stringify(fullDict, null, 4);
    const entriesJson = JSON.stringify(longEntries);

    const jsSource = `${SIGNATURE_START}
(() => {
    const map = new Map(Object.entries(DICT_PLACEHOLDER));
    const lowerMap = new Map();
    for (const [k, v] of map.entries()) lowerMap.set(k.toLowerCase(), v);

    const longEntries = REPLACEMENT_ENTRIES_PLACEHOLDER;
    const translatedValues = new WeakMap();

    const BLOCKED_CLASSES = ['monaco-editor', 'editor-container', 'terminal', 'output-view', 'debug-console', 'code-view', 'artifact-container', 'suggest-widget'];
    const BLOCKED_TAGS = ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'INPUT', 'TEXTAREA', 'SVG', 'CANVAS', 'SYMBOL', 'PATH'];
    const AUTO_TRANSLATE_PROTECTED_TAGS = new Set(['CODE', 'PRE', 'INPUT', 'TEXTAREA']);
    const BLOCKED_TEST_IDS = new Set(['user-input-step']);
    const SKIP_TRANSLATION_ATTR = 'data-ag-localization-skip';

    function norm(s) {
        if (!s) return '';
        return s.replace(/\\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
    }

    // Long dictionary entries may be replaced inside surrounding UI text, but
    // they must not match inside a larger English identifier or word.
    function replaceLongDictionaryEntry(value, key, translated) {
        if (!value || !key || !value.includes(key)) return value;

        const asciiWord = /[A-Za-z0-9_]/;
        const needsLeftBoundary = asciiWord.test(key[0]);
        const needsRightBoundary = asciiWord.test(key[key.length - 1]);
        let searchFrom = 0;
        let result = '';
        let changed = false;

        while (searchFrom < value.length) {
            const index = value.indexOf(key, searchFrom);
            if (index === -1) break;

            const end = index + key.length;
            const hasLeftBoundary = !needsLeftBoundary || index === 0 || !asciiWord.test(value[index - 1]);
            const hasRightBoundary = !needsRightBoundary || end === value.length || !asciiWord.test(value[end]);
            if (hasLeftBoundary && hasRightBoundary) {
                result += value.slice(searchFrom, index) + translated;
                searchFrom = end;
                changed = true;
            } else {
                result += value.slice(searchFrom, index + 1);
                searchFrom = index + 1;
            }
        }

        return changed ? result + value.slice(searchFrom) : value;
    }

    function translateWithShortcut(val) {
        if (!val) return null;
        const match = val.match(/^(.+?)\\s*\\((Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧|⌃)\\+?([^)]*)\\)$/i);
        if (match) {
            const prefix = match[1].trim();
            const normPref = norm(prefix);
            const lowerPref = normPref.toLowerCase();
            let transPref = null;
            if (map.has(normPref)) {
                transPref = map.get(normPref);
            } else if (lowerMap.has(lowerPref)) {
                transPref = lowerMap.get(lowerPref);
            }
            if (transPref) {
                return transPref + " (" + match[2] + (match[3] ? "+" + match[3] : "") + ")";
            }
        }
        return null;
    }

    // Git refs are runtime identifiers, so translate only the bounded UI
    // sentence around them and preserve the ref or remote name verbatim.
    function getCommitSummaryParts(value) {
        const normalized = norm(value);
        const match = normalized.match(/^(?:Commit|提交)\\s*(\\d+)\\s*(?:files?|个文件)\\s*(?:changes?|更改)\\s*to\\s*((?:↗\\s*)?\\S+)$/i);
        return match ? { count: match[1], target: match[2] } : null;
    }

    function getVersionControlUiTranslation(value) {
        const normalized = norm(value);
        if (/^All changes since the branch point$/i.test(normalized)) {
            return "自分支点以来的所有更改";
        }

        let match = normalized.match(/^All changes since (\\S+)$/i);
        if (match) return "自 " + match[1] + " 以来的所有更改";

        match = normalized.match(/^Publish (\\S+) to origin$/i);
        if (match) return "将 " + match[1] + " 发布到 origin";

        match = normalized.match(/^Push\\s+(\\d+)\\s+commits?\\s+to\\s+((?:↗\\s*)?\\S+)$/i);
        if (match) return "将 " + match[1] + " 个提交推送到 " + match[2];

        match = normalized.match(/^Pushed\\s+(\\d+)\\s+commits?\\s+to\\s+((?:↗\\s*)?\\S+)\\.$/i);
        if (match) return "已将 " + match[1] + " 个提交推送到 " + match[2] + "。";

        match = normalized.match(/^Committed\\s+to\\s+((?:↗\\s*)?\\S+)\\.$/i);
        if (match) return "已提交到 " + match[1] + "。";

        const commitSummary = getCommitSummaryParts(normalized);
        if (commitSummary) {
            return "将 " + commitSummary.count + " 个文件的更改提交到 " + commitSummary.target;
        }

        if (map.has(normalized)) return map.get(normalized);
        if (lowerMap.has(normalized.toLowerCase())) return lowerMap.get(normalized.toLowerCase());

        const fileStatusMatch = normalized.match(/^(.+?)\\s*\\((uncommitted|unstaged|staged|untracked|modified|deleted|added|all agent edits|agent edits)\\)$/i);
        if (fileStatusMatch) {
            const rawPrefix = fileStatusMatch[1].trim();
            if (/^(?:git|npm|pnpm|yarn|bun|node|cargo|go|python|bash|sh|zsh)\\s/i.test(rawPrefix)) return null;
            if (/["'<>|?*]/.test(rawPrefix)) return null;
            if (/\\s-[a-zA-Z]/.test(rawPrefix)) return null;
            const isCategory = /^(?:All files|Added|Deleted|Modified|Untracked)$/i.test(rawPrefix);
            const hasExtension = /\\.[a-zA-Z0-9_-]{1,12}$/i.test(rawPrefix);
            const hasPathSep = /[\\/\\\\]/.test(rawPrefix);
            if (isCategory || hasExtension || hasPathSep) {
                const tag = fileStatusMatch[2].toLowerCase();
                const tagMap = {
                    'uncommitted': '(未提交)',
                    'unstaged': '(未暂存)',
                    'staged': '(已暂存)',
                    'untracked': '(未跟踪)',
                    'modified': '(已修改)',
                    'deleted': '(已删除)',
                    'added': '(已添加)',
                    'all agent edits': '(智能体的所有修改)',
                    'agent edits': '(智能体修改)'
                };
                if (tagMap[tag]) {
                    const translatedPrefix = map.get(rawPrefix)
                        || lowerMap.get(rawPrefix.toLowerCase())
                        || rawPrefix;
                    return translatedPrefix + " " + tagMap[tag];
                }
            }
        }
        return null;
    }

    function getRelativeTimeTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^(\\d+)\\s*(s|m|h|d|w|mo|yr)$/i);
        if (match) {
            const compactUnits = {
                s: "秒前",
                m: "分钟前",
                h: "小时前",
                d: "天前",
                w: "周前",
                mo: "个月前",
                yr: "年前"
            };
            return match[1] + compactUnits[match[2].toLowerCase()];
        }

        match = normalized.match(/^(\\d+)\\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|wk|wks|week|weeks|mo|mos|month|months|yr|yrs|year|years)\\s+ago$/i);
        if (!match) return null;

        const unit = match[2].toLowerCase();
        let translatedUnit = "";
        if (/^sec/.test(unit)) translatedUnit = "秒前";
        else if (/^min/.test(unit)) translatedUnit = "分钟前";
        else if (/^(?:hr|hour)/.test(unit)) translatedUnit = "小时前";
        else if (/^day/.test(unit)) translatedUnit = "天前";
        else if (/^(?:wk|week)/.test(unit)) translatedUnit = "周前";
        else if (/^mo/.test(unit)) translatedUnit = "个月前";
        else if (/^(?:yr|year)/.test(unit)) translatedUnit = "年前";
        return translatedUnit ? match[1] + translatedUnit : null;
    }

    function getArtifactTimestampTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^(.*?)\\s*\\((Today|Yesterday)\\s+(\\d{1,2}):(\\d{2})\\s+(AM|PM)\\)$/i);
        if (match) {
            const prefix = match[1].trim();
            const day = match[2].toLowerCase() === 'today' ? "今天" : "昨天";
            const period = match[5].toUpperCase() === 'AM' ? "上午" : "下午";
            const timestamp = "（" + day + " " + period + match[3] + ":" + match[4] + "）";
            return prefix ? prefix + " " + timestamp : timestamp;
        }

        match = normalized.match(/^(.*?)\\s*\\((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s+(\\d{1,2}):(\\d{2})\\s+(AM|PM)\\)$/i);
        if (!match) return null;

        const monthMap = {
            jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
            jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
        };
        const prefix = match[1].trim();
        const month = monthMap[match[2].toLowerCase()];
        const year = match[4] ? match[4] + "年" : "";
        const period = match[7].toUpperCase() === 'AM' ? "上午" : "下午";
        const timestamp = "（" + year + month + "月" + match[3] + "日 " + period + match[5] + ":" + match[6] + "）";
        return prefix ? prefix + " " + timestamp : timestamp;
    }

    function getCompactCountLabelTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^(\\d+)\\s*(?:results?|个结果s?)$/i);
        if (match) return match[1] + " 个结果";

        match = normalized.match(/^(?:Comments?|评论)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
        if (match) return "评论（" + match[1] + "）";

        match = normalized.match(/^(?:Listed|列出了)\\s*(\\d+)\\s*(?:tasks?|个任务\\s*s?)(?:\\s*([>v›❯〉→∨˅⌄▼▽⋁↓]))?$/i);
        if (match) return "列出了 " + match[1] + " 个任务" + (match[2] ? " " + match[2] : "");

        match = normalized.match(/^[（(]\\s*(\\d+)\\s*(?:subagents?|个?\\s*子智能体s?)\\s*[)）]$/i);
        if (match) return "（" + match[1] + " 个子智能体）";
        return null;
    }

    function getWorkingStatusTranslation(value) {
        const normalized = norm(value).replace(/[\\u200B-\\u200D\\uFEFF]/g, '');
        if (/^Working(?:\\s*\\.){3}$/i.test(normalized) || /^Working\\s*…$/i.test(normalized)) {
            return "工作中...";
        }
        if (/^(?:处理中|工作中)(?:(?:\\s*\\.)|(?:\\s*…))+$/i.test(normalized)) {
            return "工作中...";
        }
        return null;
    }

    function getSearchingStatusTranslation(value) {
        if (!value) return null;
        const normalized = norm(value).replace(/[\\u200B-\\u200D\\uFEFF]/g, '');
        if (/^Searching(?:\\s*\\.){1,3}$/i.test(normalized) || /^Searching\\s*…$/i.test(normalized) || /^Searching\\s*\\.{3,}$/i.test(normalized) || /^Searching$/i.test(normalized)) {
            return "正在搜索...";
        }
        if (/^No\\s+suggestions(?:\\.|\\b)/i.test(normalized)) {
            return "无建议。";
        }
        return null;
    }

    function getQuotaDurationTranslation(value) {
        const normalized = norm(value);
        if (/^less than a minute$/i.test(normalized)) return "不到 1 分钟";

        const parts = normalized.split(/\\s*,\\s*/);
        if (parts.length < 1 || parts.length > 2) return null;
        const translated = [];
        for (const part of parts) {
            const match = part.match(/^(\\d+)\\s+(days?|hours?|minutes?)$/i);
            if (!match) return null;
            const unit = /^day/i.test(match[2]) ? "天" : /^hour/i.test(match[2]) ? "小时" : "分钟";
            translated.push(match[1] + " " + unit);
        }
        return translated.join(" ");
    }

    function getQuotaNoticeTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^You have hit your weekly limit, it refreshes in (.+?)\\. If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier\\.$/i);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，将在 " + duration + "后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度，或升级到更高等级的套餐。";
            }
        }

        match = normalized.match(/^You have hit your weekly limit, the 5-hour limit does not currently apply\\. Your weekly limit will fully refresh in (.+?)\\.$/i);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，因此当前不适用 5 小时配额限制。您的每周配额将在 " + duration + "后完全刷新。";
            }
        }

        match = normalized.match(/^您已达到每周配额限制，将在 (.+?)后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度，或升级到更高等级的套餐。$/);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，将在 " + duration + "后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度，或升级到更高等级的套餐。";
            }
        }

        match = normalized.match(/^您已达到每周配额限制，因此当前不适用 5 小时配额限制。您的每周配额将在 (.+?)后完全刷新。$/);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，因此当前不适用 5 小时配额限制。您的每周配额将在 " + duration + "后完全刷新。";
            }
        }
        return null;
    }

    function isInBlockedZone(node) {
        let curr = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        while (curr) {
            if (curr.nodeType === Node.ELEMENT_NODE) {
                if (curr.hasAttribute(SKIP_TRANSLATION_ATTR)) return true;
                if (BLOCKED_TEST_IDS.has(curr.getAttribute('data-testid'))) return true;

                const tag = curr.tagName.toUpperCase();
                if (BLOCKED_TAGS.includes(tag)) return true;
                if (curr.getAttribute('contenteditable') === 'true') return true;

                const className = curr.className || '';
                if (typeof className === 'string') {
                    if (BLOCKED_CLASSES.some(cls => className.includes(cls))) return true;
                }
            }
            curr = curr.parentElement || (curr.parentNode && curr.parentNode.host);
        }
        return false;
    }

    // The product-owned attachment label is rendered inside the protected
    // user-input container. Match its exact source structure so user text,
    // comment bodies, file names, and other descendants remain untouched.
    function getProtectedProductUiTranslation(node, value) {
        const normalized = norm(value);
        const lower = normalized.toLowerCase();

        if (lower === 'commented on:') {
            const label = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            if (!label || label.tagName?.toUpperCase() !== 'SPAN') return null;

            const labelClass = typeof label.className === 'string' ? label.className : '';
            if (!labelClass.includes('text-sm') || !labelClass.includes('text-secondary-foreground')) return null;

            const row = label.parentElement;
            const rowClass = typeof row?.className === 'string' ? row.className : '';
            if (!rowClass.includes('items-center') || !rowClass.includes('flex-wrap')) return null;

            let current = row;
            let userInput = null;
            while (current) {
                if (current.getAttribute?.('data-testid') === 'user-input-step') {
                    userInput = current;
                    break;
                }
                current = current.parentElement || (current.getRootNode?.().host ?? null);
            }
            if (!userInput) return null;

            if (map.has(normalized)) return map.get(normalized);
            return lowerMap.get(lower) ?? null;
        }

        let searchingContainer = null;
        let p = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; p && depth < 4; depth++) {
            const pText = norm(p.textContent);
            if (/^Searching(?:\\s*\\.){1,3}$/i.test(pText) || /^Searching\\s*…$/i.test(pText)) {
                searchingContainer = p;
                break;
            }
            if (!searchingContainer && getSearchingStatusTranslation(pText)) {
                searchingContainer = p;
            }
            p = p.parentElement || (p.parentNode && p.parentNode.host);
        }

        const searchingTrans = (searchingContainer ? getSearchingStatusTranslation(searchingContainer.textContent) : null)
            || getSearchingStatusTranslation(value);
        if (searchingTrans) {
            let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            let inTerminal = false;
            let inCodeLine = false;
            let inPreOrCode = false;

            while (current) {
                if (current.nodeType === Node.ELEMENT_NODE) {
                    const tag = current.tagName?.toUpperCase();
                    if (tag === 'CODE' || tag === 'PRE') inPreOrCode = true;
                    const className = typeof current.className === 'string' ? current.className : '';
                    if (className.includes('terminal') || className.includes('xterm') || className.includes('output-view') || className.includes('debug-console')) inTerminal = true;
                    if (className.includes('view-line')) inCodeLine = true;
                }
                current = current.parentElement || (current.parentNode && current.parentNode.host);
            }

            if (!inTerminal && !inCodeLine && !inPreOrCode) {
                const targetContainer = searchingContainer || node.parentElement;
                if (targetContainer && norm(targetContainer.textContent) !== norm(value)) {
                    const siblings = collectTextNodes(targetContainer);
                    const searchingIdx = siblings.findIndex(t => /Searching|正在搜索/i.test(norm(t.nodeValue)));
                    if (searchingIdx >= 0) {
                        for (let i = 0; i < siblings.length; i++) {
                            if (siblings[i] !== node) {
                                replaceTextNode(siblings[i], i === searchingIdx ? searchingTrans : '');
                            }
                        }
                    }
                }
                return searchingTrans;
            }
        }

        return null;
    }

    function isInCommentContext(node) {
        let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; current && depth < 10; depth++) {
            if (current === document.body || current === document.documentElement) break;
            const text = norm(current.textContent);
            if (text.length <= 6000 && /(?:Comments?|评论)\\s*[（(]\\s*\\d+\\s*[)）]/i.test(text)) return true;
            if (text.length <= 2000 && /(?:Save Comment|保存评论|Submit comment|提交评论|Add Comment|添加评论)/i.test(text)) return true;
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        return false;
    }

    function hasRelativeTimeDescendant(element) {
        const pending = Array.from(element?.childNodes || []);
        while (pending.length > 0) {
            const current = pending.pop();
            if (current.nodeType === Node.TEXT_NODE) {
                const text = norm(current.nodeValue);
                if (/^(?:\\d+\\s*(?:s|m|h|d|w|mo|yr)|\\d+\\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|wks?|weeks?|mos?|months?|yrs?|years?)\\s+ago|\\d+\\s*(?:秒|分钟|小时|天|周|个月|年)前)$/i.test(text)) {
                    return true;
                }
                continue;
            }
            if (current.childNodes) pending.push(...current.childNodes);
        }
        return false;
    }

    function isInConversationTimestampContext(node) {
        let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; current && depth < 10; depth++) {
            if (current === document.body || current === document.documentElement) break;

            const metadata = [
                current.className,
                current.getAttribute?.('id'),
                current.getAttribute?.('data-testid'),
                current.getAttribute?.('aria-label'),
                current.getAttribute?.('title')
            ].filter(valuePart => typeof valuePart === 'string').join(' ');
            if (/(?:^|[-_\\s])(?:conversation|cascade)(?:[-_\\s]|$)/i.test(metadata)) return true;

            const text = norm(current.textContent);
            if (text.length <= 20000) {
                const hasConversationSections =
                    /(?:Other Conversations|其他会话)/i.test(text) &&
                    /(?:Current|当前|Search all conversations|搜索所有会话)/i.test(text);
                if (hasConversationSections) return true;

                if (hasRelativeTimeDescendant(current)) return true;
            }
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        return false;
    }

    function getTimestampNowTranslation(node, value) {
        const normalized = norm(value);
        if (!/^now$/i.test(normalized)) return null;

        let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        let timestampLike = false;
        let explicitTimestamp = false;
        let timestampElement = null;
        let compactRow = null;
        for (let depth = 0; current && depth < 3 && norm(current.textContent) === normalized; depth++) {
            const tag = current.tagName?.toUpperCase();
            const metadata = [
                current.className,
                current.getAttribute?.('data-testid'),
                current.getAttribute?.('aria-label'),
                current.getAttribute?.('title')
            ].filter(valuePart => typeof valuePart === 'string').join(' ');
            if (tag === 'TIME' || current.hasAttribute?.('datetime') || /(?:^|[-_\\s])(?:time|timestamp|date|muted|secondary|caption)(?:[-_\\s]|$)|(?:^|\\s)text-xs(?:\\s|$)/i.test(metadata)) {
                timestampLike = true;
                explicitTimestamp = tag === 'TIME' || current.hasAttribute?.('datetime') || /(?:^|[-_\\s])(?:time|timestamp|date)(?:[-_\\s]|$)/i.test(metadata);
                timestampElement = current;
                break;
            }
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        if (timestampLike && (explicitTimestamp || isInCommentContext(node))) return "刚刚";

        current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; current && depth < 5; depth++) {
            const text = norm(current.textContent);
            if (text !== normalized) {
                if (text.length <= 240) compactRow = current;
                break;
            }
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }

        // Conversation rows render the title and a muted relative timestamp as
        // siblings or nested cells. Require both that compact row and a nearby
        // conversation-list signal so ordinary standalone "now" stays intact.
        if (!compactRow || !isInConversationTimestampContext(node)) return null;
        if (timestampLike && timestampElement?.parentElement === compactRow) return "刚刚";
        return norm(compactRow.textContent) !== normalized ? "刚刚" : null;
    }

    function getRecentProjectSectionTranslation(node, value) {
        const normalized = norm(value);
        const match = normalized.match(/^Recent in\\s+(.+)$/i);
        if (!match || match[1].length > 160 || !isInConversationTimestampContext(node)) return null;
        return match[1] + " 中的近期会话";
    }

    function isInDeleteTaskDialogContext(node) {
        let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; current && depth < 10; depth++) {
            if (current === document.body || current === document.documentElement) break;
            const text = norm(current.textContent);
            const hasTitle = /(?:Delete Task|删除任务)/i.test(text);
            const hasConfirmation = /Are you sure you want to delete|This action cannot be undone|您确定要删除(?:计划)?任务|此操作无法撤销/i.test(text);
            if (text.length <= 1600 && hasTitle && hasConfirmation) return true;
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        return false;
    }

    function getDeleteTaskConfirmationTranslation(node, value) {
        const normalized = norm(value);
        if (!/^Are you sure you want to delete/i.test(normalized) && !/^\\?/i.test(normalized)) return null;
        if (!isInDeleteTaskDialogContext(node)) return null;

        let match = normalized.match(/^Are you sure you want to delete(?:\\s+the scheduled task)?\\s+(.+?)\\?\\s*(?:This action cannot be undone\\.?|此操作无法撤销。)$/i);
        if (match) return "您确定要删除任务 " + match[1] + " 吗？此操作无法撤销。";

        match = normalized.match(/^Are you sure you want to delete(?:\\s+the scheduled task)?(?:\\s+(.+))?$/i);
        if (match) return "您确定要删除任务" + (match[1] ? " " + match[1] : " ");

        if (/^\\?\\s*(?:This action cannot be undone\\.?|此操作无法撤销。)?$/i.test(normalized)) {
            return /(?:This action cannot be undone|此操作无法撤销)/i.test(normalized)
                ? " 吗？此操作无法撤销。"
                : " 吗？";
        }
        return null;
    }

    function findLastTextNode(node) {
        if (!node) return null;
        if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue && node.nodeValue.trim() ? node : null;
        }
        if (!node.childNodes) return null;
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
            const found = findLastTextNode(node.childNodes[i]);
            if (found) return found;
        }
        return null;
    }

    function findPreviousTextNode(node) {
        let current = node;
        while (current) {
            if (current === document.body || current === document.documentElement) break;
            let sibling = current.previousSibling;
            while (sibling) {
                const found = findLastTextNode(sibling);
                if (found) return found;
                sibling = sibling.previousSibling;
            }
            current = current.parentNode || current.host || null;
        }
        return null;
    }

    function replaceTextNode(node, value) {
        if (!node) return false;
        translatedValues.set(node, value);
        if (node.nodeValue === value) return false;
        node.nodeValue = value;
        return true;
    }

    const EXPLORED_STATUS_SUFFIX = '[>v›∨˅⌄▼▽⋁\\u2228\\u02c5\\u2304\\u25bc\\u25bd\\u276f\\u2193]';

    function getExploredStatusUnit(type) {
        const normalizedType = String(type || '').toLowerCase();
        if (/^files?$/.test(normalizedType)) return "个文件";
        if (/^folders?$/.test(normalizedType)) return "个文件夹";
        if (/^pages?$/.test(normalizedType)) return "个页面";
        if (/^search(?:es)?$/.test(normalizedType)) return "次搜索";
        if (/^tasks?$/.test(normalizedType)) return "个任务";
        if (/^commands?$/.test(normalizedType)) return "条命令";
        if (/^tools?$/.test(normalizedType)) return "个工具";
        if (/^rules?$/.test(normalizedType)) return "条规则";
        if (/^repos(?:itories)?$/.test(normalizedType)) return "个仓库";
        if (/^images?$/.test(normalizedType)) return "张图片";
        return null;
    }

    function translateExploredStatus(str) {
        if (!str || typeof str !== 'string') return null;
        const trimmed = str.trim();
        const match = trimmed.match(new RegExp('^(?:(Explored)\\\\s+)?(.+?)(\\\\s*' + EXPLORED_STATUS_SUFFIX + ')?\\\\s*$', 'i'));
        if (!match) return null;

        const items = match[2].trim().split(/\\s*,\\s*/);
        const translatedItems = [];
        for (const item of items) {
            const itemMatch = item.trim().match(/^(\\d+)\\s+(files?|folders?|pages?|search(?:es)?|tasks?|commands?|tools?|rules?|repos(?:itories)?|images?)$/i);
            if (!itemMatch) return null;
            const unit = getExploredStatusUnit(itemMatch[2]);
            if (!unit) return null;
            translatedItems.push(itemMatch[1] + " " + unit);
        }

        return (match[1] ? "探索了 " : "") + translatedItems.join("、") + (match[3] || "");
    }

    function collectTextNodes(element) {
        const nodes = [];
        if (!element || !element.childNodes) return nodes;
        const visit = current => {
            if (current.nodeType === Node.TEXT_NODE) {
                nodes.push(current);
                return;
            }
            if (!current.childNodes) return;
            for (const child of current.childNodes) visit(child);
        };
        visit(element);
        return nodes;
    }

    // The commit-dialog summary is split around its file count, arrow icon,
    // and branch name. Reorder only the text nodes in that bounded row; keep
    // the icon and runtime Git ref nodes intact.
    function translateCommitSummaryContainer(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        if ((element.textContent || '').length > 240) return false;

        const isElementBlocked = isInBlockedZone(element);
        const textNodes = collectTextNodes(element);
        if (textNodes.length < 2) return false;

        const isBlocked = isElementBlocked || textNodes.some(textNode => isInBlockedZone(textNode));
        let parts = getCommitSummaryParts(textNodes.map(textNode => textNode.nodeValue || '').join(''));

        const nonEmptyIndexes = textNodes
            .map((textNode, index) => norm(textNode.nodeValue) ? index : -1)
            .filter(index => index >= 0);
        if (nonEmptyIndexes.length < 2) return false;

        const lastNonEmptyVal = norm(textNodes[nonEmptyIndexes[nonEmptyIndexes.length - 1]].nodeValue);
        if (/^(?:to|changes?|更改|files?|个文件)$/i.test(lastNonEmptyVal)) {
            return false;
        }

        // React may update only the count or restore one English fragment
        // after this row was translated. Recover the current count from that
        // bounded intermediate node, then clear only known source fragments.
        if (!parts) {
            const prefixIndex = nonEmptyIndexes[0];
            const targetIndex = nonEmptyIndexes[nonEmptyIndexes.length - 1];
            const prefixMatch = norm(textNodes[prefixIndex].nodeValue)
                .match(/^将\\s*(\\d+)\\s*个文件的更改提交到$/);
            const intermediateNodes = textNodes.slice(prefixIndex + 1, targetIndex);
            const hasOnlyCommitFragments = intermediateNodes.every(textNode => {
                const text = norm(textNode.nodeValue);
                return !text || /^(?:\\d+|to|changes?|更改|files?|个文件|↗|↑)$/i.test(text);
            });
            if (prefixMatch && hasOnlyCommitFragments) {
                const refreshedCount = intermediateNodes
                    .map(textNode => norm(textNode.nodeValue))
                    .find(text => /^\\d+$/.test(text));
                parts = {
                    count: refreshedCount || prefixMatch[1],
                    target: norm(textNodes[targetIndex].nodeValue)
                };
            }
        }
        if (!parts) return false;

        if (isBlocked) {
            return 'skipped';
        }

        // Prefer the smallest matching container so sibling rows cannot be
        // combined when their parent happens to have no additional text.
        if (Array.from(element.children || []).some(child => {
            const childNodes = collectTextNodes(child);
            return childNodes.length > 1 &&
                !childNodes.some(textNode => isInBlockedZone(textNode)) &&
                !!getCommitSummaryParts(childNodes.map(textNode => textNode.nodeValue || '').join(''));
        })) return false;

        const prefixIndex = nonEmptyIndexes[0];
        const targetIndex = nonEmptyIndexes[nonEmptyIndexes.length - 1];
        let changed = replaceTextNode(textNodes[prefixIndex], "将 " + parts.count + " 个文件的更改提交到 ");
        for (let index = prefixIndex + 1; index < targetIndex; index++) {
            // Some builds render the outbound-arrow glyph as text rather than
            // SVG. It is product UI, so preserve it just like the icon form.
            if (/^[↗↑]$/.test(norm(textNodes[index].nodeValue))) continue;
            changed = replaceTextNode(textNodes[index], '') || changed;
        }
        return true;
    }

    function translateCommitSummaryTextNode(node, value) {
        const normalized = norm(value);
        if (!/^(?:Commit|提交|to|changes?|更改|files?|个文件|\\d+)$/i.test(normalized)) return false;

        if (/^\\d+$/.test(normalized)) {
            let countContext = node.parentElement;
            let hasCommitContext = false;
            for (let depth = 0; countContext && depth < 5; depth++) {
                if (countContext === document.body || countContext === document.documentElement) break;
                if ((countContext.childNodes?.length || 0) > 24) break;
                const contextText = norm(countContext.textContent);
                if (contextText.length <= 240 &&
                    /^(?:Commit|提交|将\\s*\\d+\\s*个文件的更改提交到)/i.test(contextText) &&
                    /(?:files?\\s*changes?|个文件.*更改)/i.test(contextText)) {
                    hasCommitContext = true;
                    break;
                }
                countContext = countContext.parentElement || (countContext.getRootNode?.().host ?? null);
            }
            if (!hasCommitContext) return false;
        }

        let current = node.parentElement;
        for (let depth = 0; current && depth < 5; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if ((current.childNodes?.length || 0) > 24) break;
            const res = translateCommitSummaryContainer(current);
            if (res) return true;
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        return false;
    }

    const SKILL_PICKER_DISPLAY_ENTRIES = [
        {
            source: 'btw',
            display: "快速提问",
            descriptions: [
                'Ask a quick question without interrupting the main conversation.',
                "在不中断主会话的情况下快速提问。"
            ]
        },
        {
            source: 'grill-me',
            display: "方案访谈",
            descriptions: [
                'Interview me to align on a plan',
                'Interview me to align on a plan.',
                "通过访谈与我对齐方案",
                "通过访谈与我对齐方案.",
                "通过访谈与我对齐方案。"
            ]
        },
        {
            source: 'teamwork-preview',
            display: "团队协作（预览）",
            descriptions: [
                'Invoke a team of agents to autonomously tackle large projects',
                'Invoke a team of agents to autonomously tackle large projects.',
                "调用智能体团队自主应对大型项目",
                "调用智能体团队自主应对大型项目.",
                "调用智能体团队自主应对大型项目。"
            ]
        },
        {
            source: 'learn',
            display: "复盘学习",
            descriptions: [
                'Reflect on recent successes or corrections to capture reusable skills or rules.',
                "反思最近的成功或改进，以捕获可复用的技能或规则。"
            ]
        },
        {
            source: 'boost',
            display: "多智能体编排",
            descriptions: [
                'Invoke the Boost multi-agent orchestrator for complex tasks',
                'Invoke the Boost multi-agent orchestrator for complex tasks.',
                "调用 Boost 多智能体编排器处理复杂任务",
                "调用 Boost 多智能体编排器处理复杂任务.",
                "调用 Boost 多智能体编排器处理复杂任务。"
            ]
        },
        {
            source: 'agy-customizations',
            display: "Antigravity 个性化定制",
            descriptions: [
                'Comprehensive guide and reference for the Antigravity Customization System.',
                "Antigravity 个性化定制系统的综合指南与参考资料。"
            ]
        },
        {
            source: 'antigravity-guide',
            display: "Antigravity 使用指南",
            descriptions: [
                'Provides a comprehensive guide, quick reference, and sitemap for Google Antigravity (AGY), including the Antigravity CLI (agy), Antigravity 2.0, Antigravity IDE, Python SDK, slash commands, keybindings, and customizations (skills, rules, MCP, sidecars).',
                "为 Google Antigravity（AGY）提供全面指南、快速参考和网站地图，涵盖 Antigravity CLI（agy）、Antigravity 2.0、Antigravity IDE、Python SDK、斜杠命令、快捷键及个性化定制（技能、规则、MCP 和 Sidecar）。"
            ]
        },
        {
            source: 'generative_ui',
            display: "生成式界面",
            descriptions: [
                'How to render rich interactive HTML widgets inline in the chat or as standalone artifacts. Use this skill when you want to show the user diagrams, data visualizations, interactive controls, educational walkthroughs, or any rich visual content beyond plain text and markdown.',
                "介绍如何在会话中以内嵌方式呈现丰富的交互式 HTML 小组件，或将其作为独立交付件呈现。当您需要向用户展示图示、数据可视化、交互控件、教学演示，或任何超出纯文本和 Markdown 范畴的丰富可视化内容时，请使用此技能。"
            ]
        },
        {
            source: 'migrate-workflows',
            display: "迁移工作流",
            descriptions: [
                'Automatically migrate legacy workflows to modern skills across global and workspace configurations. Scans for existing workflows, creates target SKILL.md files, and safely archives old workflow files.',
                'Automatically migrate legacy workflows to modern skills across global and workspace configurations.',
                "自动跨全局和工作区配置将旧版工作流迁移至现代技能。扫描现有工作流，创建目标 SKILL.md 文件，并安全归档旧工作流文件。",
                "自动跨全局和工作区配置将旧版工作流迁移至现代技能。"
            ]
        },
        {
            source: 'permissioned-github',
            display: "GitHub 权限规范",
            descriptions: [
                'Guidelines for interacting with GitHub and request permissions from the user when commands fail due to restrictions in the agent environment.',
                'Guidelines for interacting with GitHub and request permissions from the user when commands fail due to restrictions in the agent environment',
                "与 GitHub 交互的操作准则，并在命令因智能体环境限制而失败时向用户申请权限。",
                "与 GitHub 交互的操作准则，并在命令因智能体环境限制而失败时向用户申请权限"
            ]
        }
    ];

    function getSkillPickerDisplayEntry(textNodes) {
        const values = textNodes.map(textNode => norm(textNode.nodeValue));
        return SKILL_PICKER_DISPLAY_ENTRIES.find(entry => {
            const hasName = values.includes(entry.source) || values.includes(entry.display);
            const hasDescription = entry.descriptions.some(description => {
                return values.some(value => value === description || value.includes(description));
            });
            return hasName && hasDescription;
        }) || null;
    }

    function translateSkillPickerEntry(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length < 2 || textNodes.some(textNode => isInBlockedZone(textNode))) return false;
        const entry = getSkillPickerDisplayEntry(textNodes);
        if (!entry) return false;

        if (Array.from(element.children || []).some(child => {
            return !!getSkillPickerDisplayEntry(collectTextNodes(child));
        })) return false;

        const nameNode = textNodes.find(textNode => norm(textNode.nodeValue) === entry.source);
        return nameNode ? replaceTextNode(nameNode, entry.display) : false;
    }

    function translateSkillPickerNameTextNode(node, value) {
        const normalized = norm(value);
        if (!SKILL_PICKER_DISPLAY_ENTRIES.some(entry => entry.source === normalized)) return false;

        // React can replace only the skill-name text node after the row was
        // translated. The exact-name prefilter keeps this ancestor walk narrow.
        let current = node.parentElement;
        for (let depth = 0; current && depth < 4; depth++) {
            if (translateSkillPickerEntry(current)) return true;
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        return false;
    }

    function translateAgentLoadingStatus(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        if (element.getAttribute('data-testid') !== 'agent-loading') return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0 || textNodes.some(textNode => isInBlockedZone(textNode))) return false;
        const prefixNode = textNodes.find(textNode => /^(?:Working|处理中|工作中)$/i.test(norm(textNode.nodeValue)));
        if (!prefixNode || norm(prefixNode.nodeValue) === "工作中") return false;
        return replaceTextNode(prefixNode, (prefixNode.nodeValue || '').replace(/Working|处理中/i, "工作中"));
    }

    function translateWorkingStatusContainer(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        if (element.getAttribute('data-testid') === 'agent-loading') return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0 || textNodes.some(textNode => isInBlockedZone(textNode))) return false;
        const original = textNodes.map(textNode => textNode.nodeValue || '').join('');
        const translated = getWorkingStatusTranslation(original);
        if (!translated || norm(original) === translated) return false;

        if (Array.from(element.children || []).some(child => {
            return !!getWorkingStatusTranslation(child.textContent || '');
        })) return false;

        const workingIndex = textNodes.findIndex(textNode => /Working|处理中|工作中/i.test(textNode.nodeValue || ''));
        if (workingIndex < 0) return false;
        for (let i = 0; i < textNodes.length; i++) {
            replaceTextNode(textNodes[i], i === workingIndex ? translated : '');
        }
        return true;
    }

    function translateCompactCountLabelContainer(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0 || textNodes.some(textNode => isInBlockedZone(textNode))) return false;
        const original = norm(textNodes.map(textNode => textNode.nodeValue || '').join(''));
        const translated = getCompactCountLabelTranslation(original);
        if (!translated || translated === original) return false;

        if (Array.from(element.children || []).some(child => {
            return !!getCompactCountLabelTranslation(child.textContent || '');
        })) return false;

        if (textNodes.length === 1) return replaceTextNode(textNodes[0], translated);

        const countIndex = textNodes.findIndex(textNode => /^\\s*\\d+\\s*$/.test(textNode.nodeValue || ''));
        if (countIndex < 0) {
            if (/^(?:Listed|列出了)\\s*\\d+/i.test(original)) {
                const countedTaskIndex = textNodes.findIndex(textNode => {
                    return /^(\\d+)\\s*(?:tasks?|个任务\\s*s?)(?:\\s*[>v›❯〉→∨˅⌄▼▽⋁↓])?$/i.test(norm(textNode.nodeValue));
                });
                if (countedTaskIndex > 0) {
                    const countedTaskMatch = norm(textNodes[countedTaskIndex].nodeValue).match(/^(\\d+)\\s*(?:tasks?|个任务\\s*s?)(?:\\s*([>v›❯〉→∨˅⌄▼▽⋁↓]))?$/i);
                    for (let i = 0; i < countedTaskIndex; i++) {
                        replaceTextNode(textNodes[i], i === countedTaskIndex - 1 ? "列出了 " : '');
                    }
                    replaceTextNode(textNodes[countedTaskIndex], countedTaskMatch[1] + " 个任务" + (countedTaskMatch[2] ? " " + countedTaskMatch[2] : ""));
                    for (let i = countedTaskIndex + 1; i < textNodes.length; i++) {
                        const trailingArrow = norm(textNodes[i].nodeValue).match(/^[>v›❯〉→∨˅⌄▼▽⋁↓]$/);
                        replaceTextNode(textNodes[i], trailingArrow ? textNodes[i].nodeValue : '');
                    }
                    return true;
                }
            }
            return false;
        }

        const count = (textNodes[countIndex].nodeValue || '').trim();
        const translatedCountIndex = translated.indexOf(count);
        if (translatedCountIndex < 0) return false;
        const prefix = translated.slice(0, translatedCountIndex);
        let suffix = translated.slice(translatedCountIndex + count.length);
        let trailingMarker = '';
        if (textNodes.length > countIndex + 2) {
            const markerMatch = suffix.match(/^(.*?)([）>v›❯〉→∨˅⌄▼▽⋁↓])$/);
            if (markerMatch) {
                suffix = markerMatch[1];
                trailingMarker = markerMatch[2];
            }
        }

        for (let i = 0; i < countIndex; i++) {
            replaceTextNode(textNodes[i], i === countIndex - 1 ? prefix : '');
        }
        replaceTextNode(textNodes[countIndex], count);
        for (let i = countIndex + 1; i < textNodes.length; i++) {
            let value = i === countIndex + 1 ? suffix : '';
            if (trailingMarker && i === textNodes.length - 1) value = trailingMarker;
            replaceTextNode(textNodes[i], value);
        }
        return true;
    }

    function translateQuotaNoticeContainer(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0 || textNodes.some(textNode => isInBlockedZone(textNode))) return false;
        const original = norm(textNodes.map(textNode => textNode.nodeValue || '').join(''));
        const translated = getQuotaNoticeTranslation(original);
        if (!translated || translated === original) return false;

        if (Array.from(element.children || []).some(child => {
            return !!getQuotaNoticeTranslation(child.textContent || '');
        })) return false;

        if (textNodes.length === 1) return replaceTextNode(textNodes[0], translated);

        const durationIndex = textNodes.findIndex(textNode => {
            return !!getQuotaDurationTranslation(textNode.nodeValue || '');
        });
        if (durationIndex < 0) return false;

        const translatedDuration = getQuotaDurationTranslation(textNodes[durationIndex].nodeValue || '');
        const translatedDurationIndex = translated.indexOf(translatedDuration);
        if (translatedDurationIndex < 0) return false;
        const prefix = translated.slice(0, translatedDurationIndex);
        const suffix = translated.slice(translatedDurationIndex + translatedDuration.length);

        for (let i = 0; i < durationIndex; i++) {
            replaceTextNode(textNodes[i], i === durationIndex - 1 ? prefix : '');
        }
        replaceTextNode(textNodes[durationIndex], translatedDuration);
        for (let i = durationIndex + 1; i < textNodes.length; i++) {
            replaceTextNode(textNodes[i], i === durationIndex + 1 ? suffix : '');
        }
        return true;
    }

    function getArchivedConversationNoticeTranslation(value) {
        const noticePattern = /^(?:View|视图|查看)\\s*(?:an\\s+archived\\s+conversation|(?:an\\s+)?个?\\s*已归档(?:的)?(?:会话|对话))\\s*(?:in|，?请前往)\\s*(?:History|历史记录)[.。]?$/i;
        return noticePattern.test(norm(value)) ? "可在“历史记录”中查看已归档的会话。" : null;
    }

    function translateArchivedConversationNotice(element) {
        if (!element) return false;
        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;

        for (let depth = 0; current && depth < 7; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(current) || !getArchivedConversationNoticeTranslation(current.textContent)) {
                current = current.parentElement || (current.parentNode && current.parentNode.host);
                continue;
            }

            const historyElement = Array.from(current.querySelectorAll('*')).find(candidate => {
                return !isInBlockedZone(candidate) && /^(?:History|历史记录)[.。]?$/i.test(norm(candidate.textContent));
            });
            if (!historyElement) return false;

            const textNodes = collectTextNodes(current);
            const historyTextNodes = collectTextNodes(historyElement);
            if (textNodes.length === 0 || historyTextNodes.length === 0 || textNodes.some(textNode => isInBlockedZone(textNode))) return false;

            const firstHistoryIndex = textNodes.indexOf(historyTextNodes[0]);
            const lastHistoryIndex = textNodes.indexOf(historyTextNodes[historyTextNodes.length - 1]);
            if (firstHistoryIndex <= 0 || lastHistoryIndex < firstHistoryIndex) return false;

            const prefixNodes = textNodes.slice(0, firstHistoryIndex);
            const suffixNodes = textNodes.slice(lastHistoryIndex + 1);
            replaceTextNode(prefixNodes[0], "可在");
            for (let i = 1; i < prefixNodes.length; i++) replaceTextNode(prefixNodes[i], '');
            replaceTextNode(historyTextNodes[0], "历史记录");
            for (let i = 1; i < historyTextNodes.length; i++) replaceTextNode(historyTextNodes[i], '');

            if (suffixNodes.length > 0) {
                replaceTextNode(suffixNodes[0], "中查看已归档的会话。");
                for (let i = 1; i < suffixNodes.length; i++) replaceTextNode(suffixNodes[i], '');
            } else {
                historyElement.parentNode.insertBefore(document.createTextNode("中查看已归档的会话。"), historyElement.nextSibling);
            }
            return true;
        }
        return false;
    }

    function translateInputDisabledNotice(element) {
        if (!element) return false;
        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;

        for (let depth = 0; current && depth < 7; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(current)) {
                current = current.parentElement || (current.parentNode && current.parentNode.host);
                continue;
            }

            const rawText = norm(current.textContent);
            if (!/(?:Input disabled because|输入已禁用[，,]因为)/i.test(rawText) ||
                !/(?:does not exist|Create the folder in this|不存在.*在此)/i.test(rawText)) {
                current = current.parentElement || (current.parentNode && current.parentNode.host);
                continue;
            }

            if (rawText.includes("输入已禁用，因为") && rawText.includes("中创建该文件夹")) {
                return true;
            }

            const projectElement = Array.from(current.querySelectorAll('*')).find(candidate => {
                return !isInBlockedZone(candidate) && /^(?:project|项目)[.。]?$/i.test(norm(candidate.textContent));
            });
            if (!projectElement) {
                current = current.parentElement || (current.parentNode && current.parentNode.host);
                continue;
            }

            const textNodes = collectTextNodes(current);
            const projectTextNodes = collectTextNodes(projectElement);
            if (textNodes.length === 0 || projectTextNodes.length === 0 || textNodes.some(tn => isInBlockedZone(tn))) {
                return false;
            }

            const firstProjectIndex = textNodes.indexOf(projectTextNodes[0]);
            const lastProjectIndex = textNodes.indexOf(projectTextNodes[projectTextNodes.length - 1]);
            if (firstProjectIndex <= 0 || lastProjectIndex < firstProjectIndex) {
                return false;
            }

            const prefixIndex = textNodes.findIndex((tn, idx) => {
                return idx < firstProjectIndex && /(?:Input disabled because|输入已禁用[，,]因为)/i.test(tn.nodeValue || '');
            });
            if (prefixIndex < 0) {
                current = current.parentElement || (current.parentNode && current.parentNode.host);
                continue;
            }

            const middleNodes = [];
            for (let i = prefixIndex + 1; i < firstProjectIndex; i++) {
                const val = textNodes[i].nodeValue || '';
                if (/(?:does not exist|Create the folder in this|不存在|请在此)/i.test(val)) {
                    middleNodes.push(textNodes[i]);
                }
            }
            if (middleNodes.length === 0) {
                current = current.parentElement || (current.parentNode && current.parentNode.host);
                continue;
            }

            replaceTextNode(textNodes[prefixIndex], "输入已禁用，因为 ");

            replaceTextNode(middleNodes[0], " 不存在。请在此");
            for (let i = 1; i < middleNodes.length; i++) {
                replaceTextNode(middleNodes[i], '');
            }

            replaceTextNode(projectTextNodes[0], "项目");
            for (let i = 1; i < projectTextNodes.length; i++) {
                replaceTextNode(projectTextNodes[i], '');
            }

            const suffixNodes = textNodes.slice(lastProjectIndex + 1);
            if (suffixNodes.length > 0) {
                replaceTextNode(suffixNodes[0], "中创建该文件夹");
                for (let i = 1; i < suffixNodes.length; i++) {
                    replaceTextNode(suffixNodes[i], '');
                }
            } else {
                const suffixNode = document.createTextNode("中创建该文件夹");
                translatedValues.set(suffixNode, "中创建该文件夹");
                projectElement.parentNode.insertBefore(suffixNode, projectElement.nextSibling);
            }
            return true;
        }
        return false;
    }

    function translateShowMoreStatus(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        const match = norm(element.textContent).match(/^Show\\s+(\\d+)\\s+more(?:\\.\\.\\.|…)?$/i);
        if (!match) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0) return false;
        replaceTextNode(textNodes[0], "显示另外 " + match[1] + " 个...");
        for (let i = 1; i < textNodes.length; i++) replaceTextNode(textNodes[i], '');
        return true;
    }

    function getBaselineQuotaRefreshTranslation(value) {
        const match = norm(value).match(/^Your plan(?:'s|’s) baseline quota will refresh on\\s+(.+?)[.。]$/i);
        if (!match) return null;

        let refreshTime = match[1].trim();
        if (/^\\d+$/.test(refreshTime)) return null;
        const strayPrefix = refreshTime.match(/^\\d+\\.\\s+(\\d{2}\\/\\d{1,2}\\/\\d{1,2}\\s+\\d{1,2}:\\d{2}:\\d{2})$/);
        if (strayPrefix) refreshTime = strayPrefix[1];

        return "您当前计划的基础配额将于 " + refreshTime + " 刷新。";
    }

    function replaceTextRange(textNodes, start, end, value) {
        let offset = 0;
        let replaced = false;
        for (const textNode of textNodes) {
            const original = textNode.nodeValue || '';
            const nodeStart = offset;
            const nodeEnd = nodeStart + original.length;
            offset = nodeEnd;

            if (nodeEnd <= start || nodeStart >= end) continue;

            const before = start > nodeStart ? original.slice(0, start - nodeStart) : '';
            const after = end < nodeEnd ? original.slice(end - nodeStart) : '';
            if (!replaced) {
                replaceTextNode(textNode, before + value);
                replaced = true;
                if (after && textNode.parentNode) {
                    textNode.parentNode.insertBefore(document.createTextNode(after), textNode.nextSibling);
                }
            } else {
                if (after) {
                    translatedValues.delete(textNode);
                    textNode.nodeValue = after;
                } else {
                    replaceTextNode(textNode, '');
                }
            }
        }
        return replaced;
    }

    function translateBaselineQuotaNotice(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        if (Array.from(element.children || []).some(child => /Your plan(?:'s|’s) baseline quota will refresh on/i.test(child.textContent || ''))) {
            return false;
        }
        const textNodes = collectTextNodes(element).filter(textNode => !isInBlockedZone(textNode));
        if (textNodes.length === 0) return false;

        const text = textNodes.map(textNode => textNode.nodeValue || '').join('');
        const match = text.match(/Your plan(?:'s|’s) baseline quota will refresh on\\s+(.+?)\\.(?=\\s*(?:To continue using this model now, enable AI Credit overages\\.|You can upgrade to a Google AI Ultra plan to receive higher rate limits\\.|View plans?\\.?|$))/i);
        if (!match || typeof match.index !== 'number') return false;

        const translated = getBaselineQuotaRefreshTranslation(match[0]);
        if (!translated) return false;
        return replaceTextRange(textNodes, match.index, match.index + match[0].length, translated);
    }

    function getAgentSourceDisplayName(value) {
        const normalized = norm(value);
        if (/^browser$/i.test(normalized)) return "浏览器";
        if (/^(?:Root|Main)\\s+Agent$/i.test(normalized)) return "主智能体";
        return normalized;
    }

    function getDynamicSubagentStatusTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^Found\\s+(\\d+)\\s+subagents?(?:\\s*([>›❯〉→]))?$/i);
        if (match) return "找到 " + match[1] + " 个子智能体" + (match[2] ? " " + match[2] : "");

        match = normalized.match(/^Found\\s+(?:Subagents?|子智能体)$/i);
        if (match) return "已找到子智能体";

        match = normalized.match(/^Found\\s+(?:Browsers?|浏览器)(?:\\s*([>›❯〉→]))?$/i);
        if (match) return "已找到浏览器" + (match[1] ? " " + match[1] : "");

        match = normalized.match(/^(?:Killed|已中止)\\s+(\\d+)\\s+subagents?(?:\\s*([>›❯〉→]))?$/i);
        if (match) return "已中止 " + match[1] + " 个子智能体" + (match[2] ? " " + match[2] : "");

        match = normalized.match(/^Message\\s+from\\s+(?:Root\\s+Agent|主智能体)(?:\\s*([>›❯〉→]))?$/i);
        if (match) return "来自主智能体的消息" + (match[1] ? " " + match[1] : "");

        match = normalized.match(/^Error\\s+from\\s+(.+?)\\s+\\(([^()]+)\\)(?:\\s*([>›❯〉→]))?$/i);
        if (match) return "来自" + getAgentSourceDisplayName(match[1]) + "（" + match[2] + "）的错误" + (match[3] ? " " + match[3] : "");

        match = normalized.match(/^Error\\s+from\\s+\\(([^()]+)\\)(?:\\s*([>›❯〉→]))?$/i);
        if (match) {
            const displayName = getAgentSourceDisplayName(match[1]);
            const source = displayName === match[1] ? " " + match[1] + " " : displayName + "（" + match[1] + "）";
            return "来自" + source + "的错误" + (match[2] ? " " + match[2] : "");
        }

        match = normalized.match(/^Timed\\s+(\\d+)\\s+(seconds?|minutes?|hours?)(?:\\s*([>›❯〉→]))?$/i);
        if (match) {
            const unit = /^second/i.test(match[2]) ? "秒" : /^minute/i.test(match[2]) ? "分钟" : "小时";
            return "耗时 " + match[1] + " " + unit + (match[3] ? " " + match[3] : "");
        }

        match = normalized.match(/^Messaged\\s+Root\\s+Agent(?:\\s*([>›❯〉→]))?$/i);
        if (match) return "已向主智能体发送消息" + (match[1] ? " " + match[1] : "");

        match = normalized.match(/^(\\d+)\\s+tasks?\\s+running,\\s*(\\d+)\\s+active\\s+goals?$/i);
        if (match) return match[1] + " 个任务正在运行，" + match[2] + " 个活跃目标";

        match = normalized.match(/^(\\d+)\\s+subagents?\\s*\\/\\s*tasks?\\s+running$/i);
        if (match) return match[1] + " 个子智能体/任务正在运行";

        match = normalized.match(/^(\\d+)\\s+active\\s+goals?$/i);
        if (match) return match[1] + " 个活跃目标";

        match = normalized.match(/^Goals?\\s+(\\d+)$/i);
        if (match) return "目标 " + match[1];

        match = normalized.match(/^(\\d+)\\s+questions?$/i);
        if (match) return match[1] + " 个问题";

        match = normalized.match(/^(\\d+)\\s+subagents?\\s+(running|blocked|completed|failed)$/i);
        if (match) {
            const stateMap = {
                running: "正在运行",
                blocked: "已阻塞",
                completed: "已完成",
                failed: "已失败"
            };
            return match[1] + " 个子智能体" + stateMap[match[2].toLowerCase()];
        }
        return null;
    }

    function getBracketedTaskStatusTranslation(value) {
        const normalized = norm(value);
        const match = normalized.match(/^\\[(Completed|Blocked|Running|Failed|Stopped|In Progress|Cancelled|Canceled)\\](?:\\s+(.+))?$/i);
        if (!match) return null;

        const sourceStatus = match[1];
        const translatedStatus = map.get(sourceStatus)
            || lowerMap.get(sourceStatus.toLowerCase());
        if (!translatedStatus) return null;
        return "[" + translatedStatus + "]" + (match[2] ? " " + match[2] : "");
    }

    function getDynamicProductUiTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^When toggled on,\\s+(.+?)\\s+collects usage data to help Google enhance performance and features\\.$/i);
        if (match) return "启用后，" + match[1] + " 会收集使用数据，以帮助 Google 改进性能和功能。";

        match = normalized.match(/^Receive product updates, tips, and promotions from Google\\s+(.+?)\\s+via email\\.$/i);
        if (match) return "通过电子邮件接收 Google " + match[1] + " 的产品更新、使用技巧和推广信息。";

        match = normalized.match(/^When toggled on,\\s+(.+?)\\s+will use your AI credits to fulfill model requests once you're out of model quota\\.\\s+\\1\\s+will always use your model quota first before using AI credits\\.$/i);
        if (match) return "启用后，当模型配额用尽时，" + match[1] + " 将使用您的 AI 额度处理模型请求。系统会优先使用模型配额，之后才使用 AI 额度。";

        match = normalized.match(/^Build with\\s+(.+?)\\s+Plugins$/i);
        if (match) return "使用 " + match[1] + " 插件构建";

        match = normalized.match(/^Plugins are packaged collections of skills and MCPs to help the Agent in\\s+(.+?)\\s+work with Google developer products\\. You can always change your choices in Settings\\.$/i);
        if (match) return "插件是打包的技能与 MCP 集合，用于帮助 " + match[1] + " 中的智能体使用 Google 开发者产品。您随时可以在设置中更改选择。";

        match = normalized.match(/^Manage\\s+(project|workspace)\\s+folders, agent settings, and permissions\\.$/i);
        if (match) {
            const scope = match[1].toLowerCase() === "project" ? "项目" : "工作区";
            return "管理" + scope + "文件夹、智能体设置和权限。";
        }

        match = normalized.match(/^Agent settings and permissions for conversations outside of\\s+(projects|workspaces)\\.$/i);
        if (match) {
            const scope = match[1].toLowerCase() === "projects" ? "项目" : "工作区";
            return "用于不属于任何" + scope + "的会话的智能体设置和权限。";
        }
        return null;
    }

    function getProjectConversationCountTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^(\\d+)\\s+(?:active conversations?|个活跃会话)(?:\\s*(?:and|及)\\s*(\\d+)\\s+(?:archived conversations?|个已归档会话))?$/i);
        if (match) {
            let result = match[1] + " 个活跃会话";
            if (match[2]) result += "及 " + match[2] + " 个已归档会话";
            return result;
        }

        match = normalized.match(/^(\\d+)\\s+(?:archived conversations?|个已归档会话)$/i);
        return match ? match[1] + " 个已归档会话" : null;
    }

    function getProjectDeleteSummaryTranslation(value) {
        const normalized = norm(value);
        const match = normalized.match(/^(?:Permanently delete|永久删除)\\s+(.{1,200}?)\\s*(?:including|，?包含)\\s+((?:\\d+\\s+(?:active conversations?|个活跃会话)(?:\\s*(?:and|及)\\s*\\d+\\s+(?:archived conversations?|个已归档会话))?)|(?:\\d+\\s+(?:archived conversations?|个已归档会话)))[.。]?$/i);
        if (!match) return null;

        const countTranslation = getProjectConversationCountTranslation(match[2]);
        return countTranslation ? "永久删除 " + match[1] + "，包含 " + countTranslation + "。" : null;
    }

    function translateProjectDeleteSummary(element) {
        if (!element) return false;

        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
        for (let depth = 0; current && depth < 6; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType === Node.ELEMENT_NODE &&
                current.tagName?.toUpperCase() === 'SPAN' &&
                !isInBlockedZone(current)) {
                const textNodes = collectTextNodes(current).filter(textNode => !isInBlockedZone(textNode));
                const wholeTranslation = getProjectDeleteSummaryTranslation(
                    textNodes.map(textNode => textNode.nodeValue || '').join('')
                );
                if (wholeTranslation) {
                    const prefixIndex = textNodes.findIndex(textNode => /^(?:Permanently delete|永久删除)$/i.test(norm(textNode.nodeValue)));
                    const includingIndex = textNodes.findIndex((textNode, index) => {
                        return index > prefixIndex && /^(?:including|，?包含)$/i.test(norm(textNode.nodeValue));
                    });
                    const countIndex = textNodes.findIndex((textNode, index) => {
                        return index > includingIndex && !!getProjectConversationCountTranslation(textNode.nodeValue);
                    });
                    if (prefixIndex < 0 || includingIndex < 0 || countIndex < 0) return false;

                    const hasProjectName = textNodes.slice(prefixIndex + 1, includingIndex)
                        .some(textNode => norm(textNode.nodeValue));
                    if (!hasProjectName) return false;

                    replaceTextNode(textNodes[prefixIndex], "永久删除");
                    replaceTextNode(textNodes[includingIndex], "，包含 ");
                    replaceTextNode(textNodes[countIndex], getProjectConversationCountTranslation(textNodes[countIndex].nodeValue));

                    const punctuationNode = textNodes.slice(countIndex + 1)
                        .find(textNode => /^[.。]$/.test(norm(textNode.nodeValue)));
                    if (punctuationNode) replaceTextNode(punctuationNode, "。");
                    return true;
                }
            }
            current = current.parentElement || (current.parentNode && current.parentNode.host);
        }
        return false;
    }

    function getCustomizationBudgetTranslation(value) {
        const match = norm(value).match(/^(\\d+(?:\\.\\d+)?)%\\s+of the customization budget is available\\.$/i);
        return match ? match[1] + "% 的个性化定制预算可用。" : null;
    }

    function getArtifactFileCountTranslation(value) {
        const match = norm(value).match(/^Artifacts\\s*\\((\\d+)\\s+Files?\\s+for\\s+Conversation\\)$/i);
        return match ? "交付件（本会话有 " + match[1] + " 个文件）" : null;
    }

    function getCommandInputStatusTranslation(value) {
        const match = norm(value).match(/^(Rejected sending|Sent|Suggested sending|Error sending|Sending)\\s+(termination request|input)\\s+to command$/i);
        if (!match) return null;

        const item = match[2].toLowerCase() === "termination request" ? "终止请求" : "输入";
        switch (match[1].toLowerCase()) {
            case "rejected sending": return "已拒绝向命令发送" + item;
            case "sent": return "已向命令发送" + item;
            case "suggested sending": return "建议向命令发送" + item;
            case "error sending": return "向命令发送" + item + "时出错";
            case "sending": return "正在向命令发送" + item;
            default: return null;
        }
    }

    function translateDynamicSubagentStatusContainer(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0 || textNodes.some(textNode => isInBlockedZone(textNode))) return false;
        const original = textNodes.map(textNode => textNode.nodeValue || '').join('');
        const translated = getDynamicSubagentStatusTranslation(original);
        if (!translated || norm(original) === translated) return false;

        if (Array.from(element.children || []).some(child => {
            return !!getDynamicSubagentStatusTranslation(child.textContent || '');
        })) return false;

        const killedMatch = norm(original).match(/^(?:Killed|已中止)\\s+(\\d+)\\s+subagents?(?:\\s*([>›❯〉→]))?$/i);
        if (killedMatch && textNodes.length > 1) {
            const countIndex = textNodes.findIndex(textNode => /^\\s*\\d+\\s*$/.test(textNode.nodeValue || ''));
            if (countIndex > 0) {
                const prefixIndex = textNodes.findIndex((textNode, index) => {
                    return index < countIndex && /^(?:Killed|已中止)$/i.test(norm(textNode.nodeValue || ''));
                });
                const suffixIndex = textNodes.findIndex((textNode, index) => {
                    return index > countIndex && /^subagents?(?:\\s*[>›❯〉→])?$/i.test(norm(textNode.nodeValue || ''));
                });
                if (prefixIndex >= 0 && suffixIndex >= 0) {
                    const hasSeparateMarker = textNodes.some((textNode, index) => {
                        return index > suffixIndex && /^[>›❯〉→]$/.test(norm(textNode.nodeValue || ''));
                    });
                    for (let i = 0; i < textNodes.length; i++) {
                        const nodeText = norm(textNodes[i].nodeValue || '');
                        if (i === prefixIndex) replaceTextNode(textNodes[i], "已中止 ");
                        else if (i === countIndex) replaceTextNode(textNodes[i], killedMatch[1]);
                        else if (i === suffixIndex) replaceTextNode(textNodes[i], " 个子智能体" + (killedMatch[2] && !hasSeparateMarker ? " " + killedMatch[2] : ""));
                        else if (/^[>›❯〉→]$/.test(nodeText)) replaceTextNode(textNodes[i], " " + nodeText);
                        else replaceTextNode(textNodes[i], '');
                    }
                    return true;
                }
            }

            const countWithUnitIndex = textNodes.findIndex(textNode => /^\\s*\\d+\\s+subagents?(?:\\s*[>›❯〉→])?\\s*$/i.test(textNode.nodeValue || ''));
            if (countWithUnitIndex > 0) {
                const prefixIndex = textNodes.findIndex((textNode, index) => {
                    return index < countWithUnitIndex && /^(?:Killed|已中止)$/i.test(norm(textNode.nodeValue || ''));
                });
                if (prefixIndex >= 0) {
                    const hasSeparateMarker = textNodes.some((textNode, index) => {
                        return index > countWithUnitIndex && /^[>›❯〉→]$/.test(norm(textNode.nodeValue || ''));
                    });
                    for (let i = 0; i < textNodes.length; i++) {
                        const nodeText = norm(textNodes[i].nodeValue || '');
                        if (i === prefixIndex) replaceTextNode(textNodes[i], "已中止");
                        else if (i === countWithUnitIndex) replaceTextNode(textNodes[i], " " + killedMatch[1] + " 个子智能体" + (killedMatch[2] && !hasSeparateMarker ? " " + killedMatch[2] : ""));
                        else if (/^[>›❯〉→]$/.test(nodeText)) replaceTextNode(textNodes[i], " " + nodeText);
                        else replaceTextNode(textNodes[i], '');
                    }
                    return true;
                }
            }
        }

        const combinedRunMatch = norm(original).match(/^(\\d+)\\s+subagents?\\s*\\/\\s*tasks?\\s+running$/i);
        const countIndex = combinedRunMatch
            ? textNodes.findIndex(textNode => /^\\s*\\d+\\s*$/.test(textNode.nodeValue || ''))
            : -1;
        if (countIndex >= 0 && textNodes.length > 1) {
            const suffixIndex = textNodes.findIndex((textNode, index) => {
                return index > countIndex && norm(textNode.nodeValue || '');
            });
            if (suffixIndex >= 0) {
                for (let i = 0; i < textNodes.length; i++) {
                    if (i === countIndex) replaceTextNode(textNodes[i], combinedRunMatch[1]);
                    else if (i === suffixIndex) replaceTextNode(textNodes[i], " 个子智能体/任务正在运行");
                    else replaceTextNode(textNodes[i], '');
                }
                return true;
            }
        }

        replaceTextNode(textNodes[0], translated);
        for (let i = 1; i < textNodes.length; i++) replaceTextNode(textNodes[i], '');
        return true;
    }

    function translateBusinessSsoOrDivider(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        if (element.tagName.toUpperCase() !== 'SPAN' || norm(element.textContent) !== 'OR') return false;

        const className = typeof element.className === 'string' ? element.className : '';
        const hasClass = (classes, classToken) => new RegExp('(?:^|\\\\s)' + classToken + '(?:\\\\s|$)').test(classes);
        if (!hasClass(className, 'uppercase') || !hasClass(className, 'select-none')) return false;

        const parent = element.parentElement;
        if (!parent) return false;
        const dividerCount = Array.from(parent.children || []).filter(sibling => {
            if (!sibling || sibling === element || sibling.tagName?.toUpperCase() !== 'DIV') return false;
            const siblingClasses = typeof sibling.className === 'string' ? sibling.className : '';
            return hasClass(siblingClasses, 'flex-1') && hasClass(siblingClasses, 'h-px');
        }).length;
        if (dividerCount !== 2) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length !== 1) return false;
        replaceTextNode(textNodes[0], '或');
        return true;
    }

    function translateSettingOverrides(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        const rawText = element.textContent || '';
        if (!/(?:Modified\\s+in|Also\\s+modified\\s+in|修改于|也修改于)/i.test(rawText)) return false;

        let targetContainer = null;
        let current = element;
        for (let depth = 0; current && depth < 4; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType === Node.ELEMENT_NODE &&
                /(?:^|\\s)inline-block(?:\\s|$)/.test(current.className || '') &&
                /(?:Modified\\s+in|Also\\s+modified\\s+in|修改于|也修改于)/i.test(current.textContent || '')) {
                targetContainer = current;
                break;
            }
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        if (!targetContainer) {
            targetContainer = element;
        }

        const textNodes = collectTextNodes(targetContainer);
        if (textNodes.length === 0) return false;

        const prefixIndex = textNodes.findIndex(node => /^(?:Also\\s+modified|Modified)\\s+in$/i.test(norm(node.nodeValue)));
        const alreadyPrefixIndex = prefixIndex >= 0 ? prefixIndex : textNodes.findIndex(node => /^(?:也修改于|修改于)$/i.test(norm(node.nodeValue)));
        const activePrefixIndex = prefixIndex >= 0 ? prefixIndex : alreadyPrefixIndex;
        if (activePrefixIndex < 0) return false;

        let isAlso = false;
        const prefixVal = norm(textNodes[activePrefixIndex].nodeValue);
        if (/^Also/i.test(prefixVal) || /^也修改于$/i.test(prefixVal)) {
            isAlso = true;
        }

        let translated = false;
        const targetPrefix = (isAlso ? "也修改于" : "修改于") + " ";
        if (textNodes[activePrefixIndex].nodeValue !== targetPrefix) {
            replaceTextNode(textNodes[activePrefixIndex], targetPrefix);
            translated = true;
        }

        for (let i = activePrefixIndex + 1; i < textNodes.length; i++) {
            const tNode = textNodes[i];
            const val = norm(tNode.nodeValue);
            if (!val) continue;

            const countMatch = val.match(/^(\\d+)\\s*(?:projects?|个?项目|workspaces?|个?工作区)\\s*$/i);
            if (countMatch) {
                const countTrans = countMatch[1] + " 个项目";
                if (tNode.nodeValue !== countTrans) {
                    replaceTextNode(tNode, countTrans);
                    translated = true;
                }
                if (i + 1 < textNodes.length) {
                    const nextVal = norm(textNodes[i + 1].nodeValue);
                    if (/^(?:projects?|个?项目|workspaces?|个?工作区)$/i.test(nextVal)) {
                        replaceTextNode(textNodes[i + 1], '');
                        translated = true;
                    }
                }
                break;
            }

            if (/^\\d+$/.test(val) && i + 1 < textNodes.length) {
                const nextVal = norm(textNodes[i + 1].nodeValue);
                if (/^(?:projects?|个?项目|workspaces?|个?工作区)$/i.test(nextVal)) {
                    const countTrans = val + " 个项目";
                    replaceTextNode(tNode, countTrans);
                    replaceTextNode(textNodes[i + 1], '');
                    translated = true;
                    break;
                }
            }

            if (/^untitled\\s+project$/i.test(val)) {
                if (tNode.nodeValue !== '无标题项目') {
                    replaceTextNode(tNode, '无标题项目');
                    translated = true;
                }
                break;
            }

            if (/^outside\\s+of\\s+project$/i.test(val)) {
                if (tNode.nodeValue !== '项目外部') {
                    replaceTextNode(tNode, '项目外部');
                    translated = true;
                }
                break;
            }
        }

        return translated;
    }

    function translateSpecialContainers(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        if (!element.childNodes || element.childNodes.length === 0) return false;

        const rawText = element.textContent || '';
        const textLength = rawText.length;
        let translated = false;

        if (textLength <= 160 && /(?:(?:Also\\s+modified|Modified)\\s+in|修改于|也修改于)/i.test(rawText)) {
            translated = translateSettingOverrides(element) || translated;
        }

        if (textLength <= 300 && /(?:archived conversations?|已归档.*(?:会话|对话)|^(?:History|历史记录)[.。]?$)/i.test(rawText.trim())) {
            translated = translateArchivedConversationNotice(element) || translated;
        }
        if (textLength <= 320 && /(?:Input disabled because|输入已禁用[，,]因为|does not exist|Create the folder in this)/i.test(rawText)) {
            translated = translateInputDisabledNotice(element) || translated;
        }
        if (textLength <= 80 && /(?:Show\\s+\\d+\\s+more|显示另外\\s+\\d+\\s+个)/i.test(rawText)) {
            translated = translateShowMoreStatus(element) || translated;
        }
        if (textLength <= 1600 && /(?:baseline quota|基础配额)/i.test(rawText)) {
            translated = translateBaselineQuotaNotice(element) || translated;
        }
        if (textLength <= 800 && /(?:weekly limit|每周配额)/i.test(rawText)) {
            translated = translateQuotaNoticeContainer(element) || translated;
        }
        if (textLength <= 900 && /(?:quick question without interrupting|align on a plan|team of agents to autonomously|recent successes or corrections|Boost multi-agent orchestrator|Antigravity Customization System|comprehensive guide, quick reference, and sitemap|render rich interactive HTML widgets|不中断主会话|通过访谈与我对齐|智能体团队自主应对|反思最近的成功或改进|Boost 多智能体编排器|个性化定制系统的综合指南|全面指南、快速参考和网站地图|交互式 HTML 小组件)/i.test(rawText)) {
            translated = translateSkillPickerEntry(element) || translated;
        }
        if (textLength <= 240 &&
            /(?:\\bCommit\\b|提交)/i.test(rawText) &&
            /(?:files?\\s*changes?|个文件.*更改)/i.test(rawText) &&
            /(?:\\bto\\b|提交到)/i.test(rawText)) {
            translated = (translateCommitSummaryContainer(element) === true) || translated;
        }
        if (textLength <= 80 && /(?:Working|处理中|工作中)/i.test(rawText)) {
            translated = translateAgentLoadingStatus(element) || translated;
            translated = translateWorkingStatusContainer(element) || translated;
        }
        if (textLength <= 120 && /(?:\\bresults?\\b|个结果|(?:Comments?|评论)\\s*[（(]\\s*\\d+|Listed|列出了|\\bsubagents?\\b|子智能体)/i.test(rawText)) {
            translated = translateCompactCountLabelContainer(element) || translated;
        }
        if (textLength <= 240 &&
            /(?:\\bsubagents?\\b|子智能体|^Found\\s+(?:\\d+|Browsers?|浏览器)|^Timed\\s+\\d+|Messaged\\s+Root\\s+Agent|^Message\\s+from\\s+(?:Root\\s+Agent|主智能体)|^Error\\s+from\\s+|\\btasks?\\s+running\\b|\\bactive\\s+goals?\\b|^Goals?\\s+\\d+|\\bquestions?\\b)/i.test(rawText.trim())) {
            translated = translateDynamicSubagentStatusContainer(element) || translated;
        }
        if (textLength <= 600 &&
            /(?:Permanently delete|\\bincluding\\b|\\bactive conversations?\\b|\\barchived conversations?\\b|永久删除|，包含)/i.test(rawText)) {
            translated = translateProjectDeleteSummary(element) || translated;
        }
        if (textLength <= 8 && element.tagName?.toUpperCase() === 'SPAN' && /^OR$/i.test(rawText.trim())) {
            translated = translateBusinessSsoOrDivider(element) || translated;
        }
        return translated;
    }

    function getCombinedStatusTranslation(value) {
        const normalized = norm(value);
        if (!normalized) return null;
        if (map.has(normalized)) return map.get(normalized);
        if (lowerMap.has(normalized.toLowerCase())) return lowerMap.get(normalized.toLowerCase());

        const versionControlTranslation = getVersionControlUiTranslation(normalized);
        if (versionControlTranslation) return versionControlTranslation;

        const workingStatusTranslation = getWorkingStatusTranslation(normalized);
        if (workingStatusTranslation) return workingStatusTranslation;

        const compactCountLabelTranslation = getCompactCountLabelTranslation(normalized);
        if (compactCountLabelTranslation) return compactCountLabelTranslation;

        const artifactTimestampTranslation = getArtifactTimestampTranslation(normalized);
        if (artifactTimestampTranslation) return artifactTimestampTranslation;

        const quotaNoticeTranslation = getQuotaNoticeTranslation(normalized);
        if (quotaNoticeTranslation) return quotaNoticeTranslation;

        const archivedConversationNoticeTranslation = getArchivedConversationNoticeTranslation(normalized);
        if (archivedConversationNoticeTranslation) return archivedConversationNoticeTranslation;

        const baselineQuotaTranslation = getBaselineQuotaRefreshTranslation(normalized);
        if (baselineQuotaTranslation) return baselineQuotaTranslation;

        const subagentStatusTranslation = getDynamicSubagentStatusTranslation(normalized);
        if (subagentStatusTranslation) return subagentStatusTranslation;

        const bracketedTaskStatusTranslation = getBracketedTaskStatusTranslation(normalized);
        if (bracketedTaskStatusTranslation) return bracketedTaskStatusTranslation;

        const productUiTranslation = getDynamicProductUiTranslation(normalized);
        if (productUiTranslation) return productUiTranslation;

        const projectDeleteSummaryTranslation = getProjectDeleteSummaryTranslation(normalized);
        if (projectDeleteSummaryTranslation) return projectDeleteSummaryTranslation;

        const customizationBudgetTranslation = getCustomizationBudgetTranslation(normalized);
        if (customizationBudgetTranslation) return customizationBudgetTranslation;

        const artifactFileCountTranslation = getArtifactFileCountTranslation(normalized);
        if (artifactFileCountTranslation) return artifactFileCountTranslation;

        const commandInputStatusTranslation = getCommandInputStatusTranslation(normalized);
        if (commandInputStatusTranslation) return commandInputStatusTranslation;

        const relativeTimeTranslation = getRelativeTimeTranslation(normalized);
        if (relativeTimeTranslation) return relativeTimeTranslation;

        const showMoreMatch = normalized.match(/^Show\\s+(\\d+)\\s+more(?:\\.\\.\\.|…)?$/i);
        if (showMoreMatch) return "显示另外 " + showMoreMatch[1] + " 个...";

        const geminiAvailableMatch = normalized.match(/^Gemini\\s+(.+?)\\s+is now available$/i);
        if (geminiAvailableMatch) return "Gemini " + geminiAvailableMatch[1] + " 现已可用";

        const exploredTrans = translateExploredStatus(normalized);
        if (exploredTrans) return exploredTrans;

        const toolMatch = normalized.match(/^(\\d+)\\s+tools?\\s+enabled$/i);
        if (toolMatch) return toolMatch[1] + " 个工具已启用";

        const scheduleMatch = normalized.match(/^All scheduled tasks run as\\s+(.+)$/i);
        if (scheduleMatch) {
            const model = scheduleMatch[1].replace(/[.。]+$/, '').trim();
            if (model) return "所有计划任务均以 " + model + " 模型运行。";
        }
        const viewArchivedHistMatch = normalized.match(/^View(?:\\s+(\\d+))?\\s+archived conversations?\\s+in\\s+History\\.?$/i);
        if (viewArchivedHistMatch) {
            return viewArchivedHistMatch[1]
                ? "在“历史记录”中查看 " + viewArchivedHistMatch[1] + " 个已归档会话。"
                : "可在“历史记录”中查看已归档的会话。";
        }
        const viewArchivedMatch = normalized.match(/^View(?:\\s+(\\d+))?\\s+archived conversations?(?:\\s+in)?$/i);
        if (viewArchivedMatch) {
            const countText = viewArchivedMatch[1] ? " " + viewArchivedMatch[1] + " 个" : "";
            return "查看" + countText + "已归档会话" + (/in$/i.test(normalized) ? "，请前往 " : "");
        }

        return null;
    }

    function translateCombinedTextChildren(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) {
            return false;
        }

        if (getCompactCountLabelTranslation(element.textContent || '')) return false;

        let textRun = [];
        const translateRun = () => {
            if (textRun.length < 2) return false;
            const original = textRun.map(textNode => textNode.nodeValue || '').join('');
            const translated = getCombinedStatusTranslation(original);
            if (!translated || translated === original) return false;
            replaceTextNode(textRun[0], translated);
            for (let i = 1; i < textRun.length; i++) replaceTextNode(textRun[i], '');
            return true;
        };

        for (const child of element.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                textRun.push(child);
                continue;
            }
            if (translateRun()) return true;
            textRun = [];
        }
        return translateRun();
    }

    function translateQuestionnaireOptionLabel(node, value) {
        const normalized = norm(value);
        const bilingualMatch = normalized.match(/^(.+?[\\u3400-\\u9fff].*?)\\s*[（(]([A-Za-z][A-Za-z0-9 .,'’/&+:#-]*)[)）]$/);
        if (!bilingualMatch) return null;

        let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        let optionRow = null;
        for (let depth = 0; current && depth < 6; depth++) {
            const rowText = norm(current.textContent);
            const isCompactLabelRow = rowText.endsWith(normalized)
                && rowText.length <= normalized.length + 32;
            const isInteractive = isCompactLabelRow
                && current.matches?.('button, [role="button"], [role="option"], [role="radio"], [role="checkbox"], [tabindex]');
            const isNumberedRow = isCompactLabelRow && /^\\d+\\s*/.test(rowText);
            if (isInteractive || isNumberedRow) {
                optionRow = current;
                break;
            }
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        if (!optionRow) return null;

        current = optionRow.parentElement || (optionRow.getRootNode?.().host ?? null);
        for (let depth = 0; current && depth < 10; depth++) {
            if (current === document.body || current === document.documentElement) break;
            const cardText = norm(current.textContent);
            const hasProgress = /\\b\\d+\\s+of\\s+\\d+\\b/i.test(cardText);
            const hasActions = /(?:Skip|跳过)/i.test(cardText) && /(?:Continue|继续)/i.test(cardText);
            if (cardText.length <= 4000 && hasProgress && hasActions) return bilingualMatch[1].trim();
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        return null;
    }

    function translateFragmentedStatus(node, originalVal) {
        const currentText = norm(originalVal);
        const previous = findPreviousTextNode(node);
        const previousText = previous ? norm(previous.nodeValue) : '';

        const commentCountMatch = currentText.match(/^[（(]\\s*(\\d+)\\s*[)）]$/);
        if (commentCountMatch && /^(?:Comments?|评论)$/i.test(previousText)) {
            replaceTextNode(previous, "评论");
            return "（" + commentCountMatch[1] + "）";
        }

        const statusItemMatch = currentText.match(new RegExp('^(files?|folders?|pages?|search(?:es)?|tasks?|commands?|tools?|rules?|repos(?:itories)?|images?)(\\s*,\\s*|\\s*' + EXPLORED_STATUS_SUFFIX + ')?$', 'i'));
        if (statusItemMatch && previous) {
            const unit = getExploredStatusUnit(statusItemMatch[1]);
            const tail = statusItemMatch[2] || '';
            const translatedTail = /,/.test(tail) ? '、' : tail;
            const prefixedCount = previousText.match(/^(?:Explored|探索了)\\s+(\\d+)$/i);
            if (prefixedCount) {
                replaceTextNode(previous, "探索了 " + prefixedCount[1]);
                return " " + unit + translatedTail;
            }
            if (/^\\d+$/.test(previousText)) return " " + unit + translatedTail;
        }

        let statusMatch = currentText.match(/^(?:subagents?|子智能体)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Found$/i.test(previousText)) {
            replaceTextNode(previous, "已找到");
            return "子智能体" + (statusMatch[1] ? " " + statusMatch[1] : "");
        }

        statusMatch = currentText.match(/^(?:Browsers?|浏览器)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Found$/i.test(previousText)) {
            replaceTextNode(previous, "已找到");
            return "浏览器" + (statusMatch[1] ? " " + statusMatch[1] : "");
        }

        statusMatch = currentText.match(/^(\\d+)\\s+subagents?(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Found$/i.test(previousText)) {
            replaceTextNode(previous, "找到");
            return " " + statusMatch[1] + " 个子智能体" + (statusMatch[2] ? " " + statusMatch[2] : "");
        }
        if (statusMatch && /^(?:Killed|已中止)$/i.test(previousText)) {
            replaceTextNode(previous, "已中止");
            return " " + statusMatch[1] + " 个子智能体" + (statusMatch[2] ? " " + statusMatch[2] : "");
        }
        statusMatch = currentText.match(/^subagents?(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^\\d+$/.test(previousText)) {
            const foundNode = findPreviousTextNode(previous);
            if (foundNode && /^Found$/i.test(norm(foundNode.nodeValue))) {
                replaceTextNode(foundNode, "找到 ");
                return " 个子智能体" + (statusMatch[1] ? " " + statusMatch[1] : "");
            }
            if (foundNode && /^(?:Killed|已中止)$/i.test(norm(foundNode.nodeValue))) {
                replaceTextNode(foundNode, "已中止 ");
                return " 个子智能体" + (statusMatch[1] ? " " + statusMatch[1] : "");
            }
        }

        statusMatch = currentText.match(/^(\\d+)\\s+(seconds?|minutes?|hours?)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Timed$/i.test(previousText)) {
            const unit = /^second/i.test(statusMatch[2]) ? "秒" : /^minute/i.test(statusMatch[2]) ? "分钟" : "小时";
            replaceTextNode(previous, "耗时");
            return " " + statusMatch[1] + " " + unit + (statusMatch[3] ? " " + statusMatch[3] : "");
        }
        statusMatch = currentText.match(/^(seconds?|minutes?|hours?)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^\\d+$/.test(previousText)) {
            const timedNode = findPreviousTextNode(previous);
            if (timedNode && /^Timed$/i.test(norm(timedNode.nodeValue))) {
                const unit = /^second/i.test(statusMatch[1]) ? "秒" : /^minute/i.test(statusMatch[1]) ? "分钟" : "小时";
                replaceTextNode(timedNode, "耗时 ");
                return " " + unit + (statusMatch[2] ? " " + statusMatch[2] : "");
            }
        }

        statusMatch = currentText.match(/^Root\\s+Agent(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Messaged$/i.test(previousText)) {
            replaceTextNode(previous, "已向");
            return "主智能体发送消息" + (statusMatch[1] ? " " + statusMatch[1] : "");
        }

        statusMatch = currentText.match(/^(\\d+)\\s+active\\s+goals?$/i);
        if (statusMatch && /^(\\d+)\\s+tasks?\\s+running,?$/i.test(previousText)) {
            const taskCount = previousText.match(/^(\\d+)/)[1];
            replaceTextNode(previous, taskCount + " 个任务正在运行，");
            return statusMatch[1] + " 个活跃目标";
        }
        if (/^active\\s+goals?$/i.test(currentText) && /^\\d+$/.test(previousText)) {
            return " 个活跃目标";
        }

        if (/^found$/i.test(currentText) && previousText === "项目") {
            const noNode = findPreviousTextNode(previous);
            if (noNode && /^No$/i.test(norm(noNode.nodeValue))) {
                replaceTextNode(noNode, '');
                replaceTextNode(previous, "未找到项目");
                return '';
            }
        }

        if (/^when not in a project$/i.test(currentText) && previousText === "是，且始终允许") {
            replaceTextNode(previous, "是，且在不属于任何项目时始终允许");
            return '';
        }

        if (/^in this project$/i.test(currentText) && previousText === "是，且始终允许") {
            replaceTextNode(previous, "是，且在此项目中始终允许");
            return '';
        }

        if (/^s\\s+enabled$/i.test(currentText) && previous) {
            const countAndTool = previousText.match(/^(\\d+)\\s+tools?$/i);
            if (countAndTool) {
                replaceTextNode(previous, countAndTool[1] + " 个工具已启用");
                return '';
            }
        }

        const isEnabledSuffix = /^s\\s+enabled$/i.test(currentText) || /^enabled$/i.test(currentText);
        if (isEnabledSuffix && previous) {
            let toolNode = previous;
            let toolText = previousText;

            if (/^s$/i.test(toolText) && /^enabled$/i.test(currentText)) {
                toolNode = findPreviousTextNode(previous);
                toolText = toolNode ? norm(toolNode.nodeValue) : '';
                replaceTextNode(previous, '');
            }

            const countNode = toolNode ? findPreviousTextNode(toolNode) : null;
            const countText = countNode ? norm(countNode.nodeValue) : '';
            if (/^(?:tool|tools|工具)$/i.test(toolText) && /^\\d+$/.test(countText)) {
                replaceTextNode(toolNode, '');
                return " 个工具已启用";
            }
        }

        if (previousText === "所有计划任务均以" && currentText && !/[\\u4e00-\\u9fff]/.test(currentText)) {
            const model = currentText.replace(/[.。]+$/, '').trim();
            if (model) return model + " 模型运行。";
        }

        if (/^[.。]$/.test(currentText) && /模型运行。$/.test(previousText)) {
            return '';
        }

        if (/^\\?\\s*(?:This action cannot be undone\\.?)?$/i.test(currentText) && previous) {
            let candidate = previous;
            for (let i = 0; i < 6 && candidate; i++) {
                if (/^您确定要删除(?:计划)?任务$/.test(norm(candidate.nodeValue))) {
                    return /This action cannot be undone/i.test(currentText)
                        ? " 吗？此操作无法撤销。"
                        : " 吗？";
                }
                candidate = findPreviousTextNode(candidate);
            }
        }

        if (currentText === '?' && previous) {
            let candidate = previous;
            let hasProjectScope = false;
            for (let i = 0; i < 8 && candidate; i++) {
                const candidateText = norm(candidate.nodeValue);
                if (/^(?:project|workspace|项目|工作区)$/i.test(candidateText)) {
                    hasProjectScope = true;
                } else if (candidateText === "您确定要删除" && hasProjectScope) {
                    return " 吗？";
                }
                candidate = findPreviousTextNode(candidate);
            }
        }

        if (/^in$/i.test(currentText) && (previousText === "个已归档会话" || previousText === "已归档会话" || previousText === "个已归档对话" || previousText === "已归档对话" || previousText === "archived conversation" || previousText === "archived conversations")) {
            let viewNode = findPreviousTextNode(previous);
            let hasNumber = false;
            if (viewNode && /^\\d+$/.test(norm(viewNode.nodeValue))) {
                hasNumber = true;
                viewNode = findPreviousTextNode(viewNode);
            }
            const articleNodes = [];
            while (viewNode && /^(?:a|an|个)$/i.test(norm(viewNode.nodeValue))) {
                articleNodes.push(viewNode);
                viewNode = findPreviousTextNode(viewNode);
            }
            if (viewNode && /^(?:View|视图|查看)$/i.test(norm(viewNode.nodeValue))) {
                for (const articleNode of articleNodes) replaceTextNode(articleNode, '');
                replaceTextNode(viewNode, "查看");
                if (!hasNumber) {
                    replaceTextNode(previous, "已归档的会话");
                }
                return "，请前往 ";
            }
        }

        return null;
    }

    function translateNode(node, parentContainersScanned = false) {
        try {
            if (!node) return;

            if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                for (const child of node.childNodes) translateNode(child);
                return;
            }

            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toUpperCase();

                let isBlocked = BLOCKED_TAGS.includes(tag);
                if (!isBlocked) {
                    const className = node.className || '';
                    if (typeof className === 'string') {
                        if (BLOCKED_CLASSES.some(cls => className.includes(cls))) {
                            isBlocked = true;
                        }
                    }
                }
                if (node.getAttribute('contenteditable') === 'true') {
                    isBlocked = true;

                    for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'aria-label', 'title']) {
                        const value = node.getAttribute(attr);
                        if (!value) continue;
                        const normalizedValue = norm(value);
                        const shortcutTranslation = translateWithShortcut(normalizedValue);
                        const versionControlTranslation = getVersionControlUiTranslation(normalizedValue);
                        let target = null;
                        if (versionControlTranslation) target = versionControlTranslation;
                        else if (shortcutTranslation) target = shortcutTranslation;
                        else if (map.has(normalizedValue)) target = map.get(normalizedValue);
                        else if (lowerMap.has(normalizedValue.toLowerCase())) target = lowerMap.get(normalizedValue.toLowerCase());
                        if (target && target !== value) node.setAttribute(attr, target);
                    }
                }

                const shouldMarkBlocked = isBlocked &&
                    (!BLOCKED_TAGS.includes(tag) || AUTO_TRANSLATE_PROTECTED_TAGS.has(tag));
                if (shouldMarkBlocked) {
                    if (node.getAttribute('translate') !== 'no') {
                        node.setAttribute('translate', 'no');
                    }
                    try {
                        if (!node.classList.contains('notranslate')) {
                            node.classList.add('notranslate');
                        }
                    } catch (e) {}
                }

                if (BLOCKED_TAGS.includes(tag)) {
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SVG') {
                        for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'aria-label']) {
                            const v = node.getAttribute(attr);
                            if (v) {
                                const searchingTrans = getSearchingStatusTranslation(v);
                                if (searchingTrans && searchingTrans !== v) {
                                    node.setAttribute(attr, searchingTrans);
                                } else if (!isInBlockedZone(node.parentElement)) {
                                    const t = norm(v);
                                    const shortcutTrans = translateWithShortcut(t);
                                    const versionControlTrans = getVersionControlUiTranslation(t);
                                    let target = null;
                                    if (versionControlTrans) target = versionControlTrans;
                                    else if (shortcutTrans) target = shortcutTrans;
                                    else if (map.has(t)) target = map.get(t);
                                    else if (lowerMap.has(t.toLowerCase())) target = lowerMap.get(t.toLowerCase());
                                    if (target && target !== v) node.setAttribute(attr, target);
                                }
                            }
                        }
                    }
                    return;
                }

                if (!isInBlockedZone(node)) {
                    translateSpecialContainers(node);
                    translateCombinedTextChildren(node);
                    for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'aria-label']) {
                        const v = node.getAttribute(attr);
                        if (v) {
                            const searchingTrans = getSearchingStatusTranslation(v);
                            if (searchingTrans && searchingTrans !== v) {
                                node.setAttribute(attr, searchingTrans);
                            } else {
                                const t = norm(v);
                                const shortcutTrans = translateWithShortcut(t);
                                const versionControlTrans = getVersionControlUiTranslation(t);
                                let target = null;
                                if (versionControlTrans) target = versionControlTrans;
                                else if (shortcutTrans) target = shortcutTrans;
                                else if (map.has(t)) target = map.get(t);
                                else if (lowerMap.has(t.toLowerCase())) target = lowerMap.get(t.toLowerCase());
                                if (target && target !== v) node.setAttribute(attr, target);
                            }
                        }
                    }
                } else {
                    for (const attr of ['aria-label', 'title', 'placeholder']) {
                        const v = node.getAttribute(attr);
                        if (v) {
                            const searchingTrans = getSearchingStatusTranslation(v);
                            if (searchingTrans && searchingTrans !== v) {
                                node.setAttribute(attr, searchingTrans);
                            }
                        }
                    }
                }

                if (node.shadowRoot) translateNode(node.shadowRoot);
                for (const child of node.childNodes) translateNode(child, true);

            } else if (node.nodeType === Node.TEXT_NODE) {
                let originalVal = node.nodeValue;
                if (!originalVal || originalVal.trim().length < 1) return;
                if (translatedValues.get(node) === originalVal) return;

                if (originalVal.toLowerCase().includes('pack.info')) {
                    const parent = node.parentElement;
                    if (parent) {
                        if (parent.getAttribute('translate') !== 'no') {
                            parent.setAttribute('translate', 'no');
                        }
                        try {
                            if (!parent.classList.contains('notranslate')) {
                                parent.classList.add('notranslate');
                            }
                        } catch (e) {}
                    }
                    return;
                }

                if (isInBlockedZone(node)) {
                    const protectedProductUiTranslation = getProtectedProductUiTranslation(node, originalVal);
                    if (protectedProductUiTranslation) {
                        replaceTextNode(node, protectedProductUiTranslation);
                    }
                    return;
                }

                if (translateSkillPickerNameTextNode(node, originalVal)) return;
                if (translateCommitSummaryTextNode(node, originalVal)) return;
                if (!parentContainersScanned && translateSpecialContainers(node.parentElement)) return;
                if (translateCombinedTextChildren(node.parentElement)) return;

                let newVal = originalVal;
                const hasRecommended = /^\\(Recommended\\)(?:\\s+|$)/i.test(newVal);
                if (hasRecommended) {
                    newVal = newVal.replace(/^\\(Recommended\\)(?:\\s+|$)/i, '');
                }
                const valNorm = norm(newVal);
                const valLower = valNorm.toLowerCase();

                const shortcutTrans = translateWithShortcut(valNorm);
                const versionControlUiTrans = getVersionControlUiTranslation(valNorm);
                const fragmentedStatusTrans = translateFragmentedStatus(node, originalVal);
                const questionnaireOptionTrans = translateQuestionnaireOptionLabel(node, valNorm);
                const timestampNowTrans = getTimestampNowTranslation(node, valNorm);
                const recentProjectSectionTrans = getRecentProjectSectionTranslation(node, valNorm);
                const deleteTaskConfirmationTrans = getDeleteTaskConfirmationTranslation(node, valNorm);
                const exploredTrans = translateExploredStatus(valNorm);
                const baselineQuotaRefreshTrans = getBaselineQuotaRefreshTranslation(valNorm);
                const subagentStatusTrans = getDynamicSubagentStatusTranslation(valNorm);
                const bracketedTaskStatusTrans = getBracketedTaskStatusTranslation(valNorm);
                const productUiTrans = getDynamicProductUiTranslation(valNorm);
                const projectDeleteSummaryTrans = getProjectDeleteSummaryTranslation(valNorm);
                const customizationBudgetTrans = getCustomizationBudgetTranslation(valNorm);
                const artifactFileCountTrans = getArtifactFileCountTranslation(valNorm);
                const commandInputStatusTrans = getCommandInputStatusTranslation(valNorm);
                const relativeTimeTrans = getRelativeTimeTranslation(valNorm);
                const workingStatusTrans = getWorkingStatusTranslation(valNorm);
                const searchingStatusTrans = getSearchingStatusTranslation(valNorm);
                const compactCountLabelTrans = getCompactCountLabelTranslation(valNorm);
                const artifactTimestampTrans = getArtifactTimestampTranslation(valNorm);
                const quotaNoticeTrans = getQuotaNoticeTranslation(valNorm);
                const archivedConversationNoticeTrans = getArchivedConversationNoticeTranslation(valNorm);
                if (fragmentedStatusTrans !== null) {
                    newVal = fragmentedStatusTrans;
                } else if (questionnaireOptionTrans) {
                    newVal = questionnaireOptionTrans;
                } else if (timestampNowTrans) {
                    newVal = timestampNowTrans;
                } else if (recentProjectSectionTrans) {
                    newVal = recentProjectSectionTrans;
                } else if (deleteTaskConfirmationTrans) {
                    newVal = deleteTaskConfirmationTrans;
                } else if (shortcutTrans) {
                    newVal = shortcutTrans;
                } else if (versionControlUiTrans) {
                    newVal = versionControlUiTrans;
                } else if (exploredTrans) {
                    newVal = exploredTrans;
                } else if (baselineQuotaRefreshTrans) {
                    newVal = baselineQuotaRefreshTrans;
                } else if (subagentStatusTrans) {
                    newVal = subagentStatusTrans;
                } else if (bracketedTaskStatusTrans) {
                    newVal = bracketedTaskStatusTrans;
                } else if (productUiTrans) {
                    newVal = productUiTrans;
                } else if (projectDeleteSummaryTrans) {
                    newVal = projectDeleteSummaryTrans;
                } else if (customizationBudgetTrans) {
                    newVal = customizationBudgetTrans;
                } else if (artifactFileCountTrans) {
                    newVal = artifactFileCountTrans;
                } else if (commandInputStatusTrans) {
                    newVal = commandInputStatusTrans;
                } else if (relativeTimeTrans) {
                    newVal = relativeTimeTrans;
                } else if (workingStatusTrans) {
                    newVal = workingStatusTrans;
                } else if (searchingStatusTrans) {
                    newVal = searchingStatusTrans;
                } else if (compactCountLabelTrans) {
                    newVal = compactCountLabelTrans;
                } else if (artifactTimestampTrans) {
                    newVal = artifactTimestampTrans;
                } else if (quotaNoticeTrans) {
                    newVal = quotaNoticeTrans;
                } else if (archivedConversationNoticeTrans) {
                    newVal = archivedConversationNoticeTrans;
                } else if (map.has(valNorm)) {
                    newVal = map.get(valNorm);
                    if ((valNorm === 'Modified in' || valNorm === 'Also modified in') && /\\s$/.test(originalVal)) {
                        newVal += ' ';
                    }
                } else if (/^(?:Also\\s+modified|Modified)\\s+in\\s+(\\d+)\\s*(?:projects?|个?项目)$/i.test(valNorm)) {
                    const isAlso = /^Also/i.test(valNorm);
                    newVal = valNorm.replace(/^(?:Also\\s+modified|Modified)\\s+in\\s+(\\d+)\\s*(?:projects?|个?项目)$/i, (m, count) => (isAlso ? "也修改于 " : "修改于 ") + count + " 个项目");
                } else if (/^(?:Also\\s+modified|Modified)\\s+in\\s+(.+)$/i.test(valNorm)) {
                    const isAlso = /^Also/i.test(valNorm);
                    newVal = valNorm.replace(/^(?:Also\\s+modified|Modified)\\s+in\\s+(.+)$/i, (m, target) => {
                        const targetNorm = norm(target);
                        let translatedTarget = target;
                        if (/^untitled\\s+project$/i.test(targetNorm)) {
                            translatedTarget = "无标题项目";
                        } else if (/^outside\\s+of\\s+project$/i.test(targetNorm)) {
                            translatedTarget = "项目外部";
                        }
                        return (isAlso ? "也修改于 " : "修改于 ") + translatedTarget;
                    });
                } else if (/^Gemini\\s+(.+?)\\s+is now available$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Gemini\\s+(.+?)\\s+is now available$/i, (m, model) => "Gemini " + model + " 现已可用");
                } else if (lowerMap.has(valLower)) {
                    newVal = lowerMap.get(valLower);
                } else if (/^Refreshes in (\\d+) days?, (\\d+) hours?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Refreshes in (\\d+) days?, (\\d+) hours?$/i, (match, d, h) => {
                        return d + " 天 " + h + " 小时后刷新";
                    });
                } else if (/^Refreshes in (\\d+) hours?, (\\d+) minutes?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Refreshes in (\\d+) hours?, (\\d+) minutes?$/i, (match, h, m) => {
                        return h + " 小时 " + m + " 分钟后刷新";
                    });
                } else if (/^Refreshes in (\\d+) days?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Refreshes in (\\d+) days?$/i, (match, d) => {
                        return d + " 天后刷新";
                    });
                } else if (/^Refreshes in (\\d+) hours?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Refreshes in (\\d+) hours?$/i, (match, h) => {
                        return h + " 小时后刷新";
                    });
                } else if (/^Refreshes in (\\d+) minutes?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Refreshes in (\\d+) minutes?$/i, (match, m) => {
                        return m + " 分钟后刷新";
                    });
                } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i, (match, d, h) => {
                        return "您已使用部分每周配额，将在 " + d + " 天 " + h + " 小时后完全刷新。";
                    });
                } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => {
                        return "您已使用部分每周配额，将在 " + h + " 小时 " + m + " 分钟后完全刷新。";
                    });
                } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?\\.$/i, (match, d) => {
                        return "您已使用部分每周配额，将在 " + d + " 天后完全刷新。";
                    });
                } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i, (match, h) => {
                        return "您已使用部分每周配额，将在 " + h + " 小时后完全刷新。";
                    });
                } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i, (match, m) => {
                        return "您已使用部分每周配额，将在 " + m + " 分钟后完全刷新。";
                    });
                } else if (/^You have used some of your weekly limit, it will fully refresh in less than a minute\\.$/i.test(valNorm)) {
                    newVal = "您已使用部分每周配额，将在不到 1 分钟后完全刷新。";
                } else if (/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => {
                        return "您已使用部分 5 小时配额，将在 " + h + " 小时 " + m + " 分钟后完全刷新。";
                    });
                } else if (/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?\\.$/i, (match, h) => {
                        return "您已使用部分 5 小时配额，将在 " + h + " 小时后完全刷新。";
                    });
                } else if (/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) minutes?\\.$/i, (match, m) => {
                        return "您已使用部分 5 小时配额，将在 " + m + " 分钟后完全刷新。";
                    });
                } else if (/^You have used some of your 5-hour limit, it will fully refresh in less than a minute\\.$/i.test(valNorm)) {
                    newVal = "您已使用部分 5 小时配额，将在不到 1 分钟后完全刷新。";
                } else if (/^Your 5-hour limit will refresh in (\\d+) days?, (\\d+) hours?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) days?, (\\d+) hours?\\.$/i, (match, d, h) => {
                        return "您的 5 小时配额将在 " + d + " 天 " + h + " 小时后刷新。";
                    });
                } else if (/^Your 5-hour limit will refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => {
                        return "您的 5 小时配额将在 " + h + " 小时 " + m + " 分钟后刷新。";
                    });
                } else if (/^Your 5-hour limit will refresh in (\\d+) days?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) days?\\.$/i, (match, d) => {
                        return "您的 5 小时配额将在 " + d + " 天后刷新。";
                    });
                } else if (/^Your 5-hour limit will refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) hours?\\.$/i, (match, h) => {
                        return "您的 5 小时配额将在 " + h + " 小时后刷新。";
                    });
                } else if (/^Your 5-hour limit will refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) minutes?\\.$/i, (match, m) => {
                        return "您的 5 小时配额将在 " + m + " 分钟后刷新。";
                    });
                } else if (/^Your 5-hour limit will refresh in less than a minute\\.$/i.test(valNorm)) {
                    newVal = "您的 5 小时配额将在不到 1 分钟后刷新。";
                } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) days?, (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) days?, (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, d, h) => {
                        return "您已达到 5 小时配额限制，将在 " + d + " 天 " + h + " 小时后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?, (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?, (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, h, m) => {
                        return "您已达到 5 小时配额限制，将在 " + h + " 小时 " + m + " 分钟后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                } else if (/^Error ID:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Error ID:\\s*(.+)$/i, (match, id) => {
                        return "错误 ID: " + id;
                    });
                } else if (/^Models within this group:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Models within this group:\\s*(.+)$/i, (match, models) => {
                        return "此组内的模型: " + models;
                    });
                } else if (/^Executor is not currently running \\(error ID:\\s*(.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Executor is not currently running \\(error ID:\\s*(.+)\\)$/i, (match, id) => {
                        return "执行器当前未运行 (错误 ID: " + id + ")";
                    });
                } else if (/^Thought for ([\\d\\.]+)(s|ms|m|min)(?:\\s*>)?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Thought for ([\\d\\.]+)(s|ms|m|min)(?:\\s*>)?$/i, (match, val, unit) => {
                        let unitStr = "秒";
                        if (unit.toLowerCase() === 'ms') unitStr = "毫秒";
                        else if (unit.toLowerCase() === 'm' || unit.toLowerCase() === 'min') unitStr = "分钟";
                        return "思考了 " + val + " " + unitStr;
                    });
                } else if (/^Worked for ([\\d\\.]+)(s|ms|m|min)(?:\\s*>)?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Worked for ([\\d\\.]+)(s|ms|m|min)(?:\\s*>)?$/i, (match, val, unit) => {
                        let unitStr = "秒";
                        if (unit.toLowerCase() === 'ms') unitStr = "毫秒";
                        else if (unit.toLowerCase() === 'm' || unit.toLowerCase() === 'min') unitStr = "分钟";
                        return "工作了 " + val + " " + unitStr;
                    });
                } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) days?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) days?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, d) => {
                        return "您已达到 5 小时配额限制，将在 " + d + " 天后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, h) => {
                        return "您已达到 5 小时配额限制，将在 " + h + " 小时后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, m) => {
                        return "您已达到 5 小时配额限制，将在 " + m + " 分钟后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                } else if (/^You have hit your 5-hour limit, it will refresh in less than a minute\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                    newVal = "您已达到 5 小时配额限制，将在不到 1 分钟后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i, (match, d, h) => {
                        return "您已达到每周配额限制，将在 " + d + " 天 " + h + " 小时后完全刷新。";
                    });
                } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => {
                        return "您已达到每周配额限制，将在 " + h + " 小时 " + m + " 分钟后完全刷新。";
                    });
                } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) days?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) days?\\.$/i, (match, d) => {
                        return "您已达到每周配额限制，将在 " + d + " 天后完全刷新。";
                    });
                } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i, (match, h) => {
                        return "您已达到每周配额限制，将在 " + h + " 小时后完全刷新。";
                    });
                } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i, (match, m) => {
                        return "您已达到每周配额限制，将在 " + m + " 分钟后完全刷新。";
                    });
                } else if (/^You have hit your weekly limit, it will fully refresh in less than a minute\\.$/i.test(valNorm)) {
                    newVal = "您已达到每周配额限制，将在不到 1 分钟后完全刷新。";
                } else if (/^Match case \\((.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Match case \\((.+)\\)$/i, (m, k) => "区分大小写 (" + k + ")");
                } else if (/^Match whole word \\((.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Match whole word \\((.+)\\)$/i, (m, k) => "全字匹配 (" + k + ")");
                } else if (/^Use regular expression \\((.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Use regular expression \\((.+)\\)$/i, (m, k) => "使用正则表达式 (" + k + ")");
                } else if (/^Previous match \\((.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Previous match \\((.+)\\)$/i, (m, k) => "上一个匹配项 (" + k + ")");
                } else if (/^Next match \\((.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Next match \\((.+)\\)$/i, (m, k) => "下一个匹配项 (" + k + ")");
                } else if (/^Close \\((.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Close \\((.+)\\)$/i, (m, k) => "关闭 (" + k + ")");
                } else if (/^Learn more about (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Learn more about (.+)$/i, (match, p) => {
                        let translatedPreset = p;
                        if (p.toLowerCase() === 'default') translatedPreset = "默认 (Default)";
                        else if (p.toLowerCase() === 'full machine') translatedPreset = "全机访问 (Full Machine)";
                        else if (p.toLowerCase() === 'turbo mode') translatedPreset = "极速模式 (Turbo Mode)";
                        else if (p.toLowerCase() === 'custom') translatedPreset = "自定义 (Custom)";
                        return "了解更多关于 " + translatedPreset + " 的信息";
                    });
                } else if (/^Yes, and always allow '(.+)' in this project$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, and always allow '(.+)' in this project$/i, (match, cmd) => {
                        return "是，且在此项目中始终允许运行 '" + cmd + "'";
                      });
                } else if (/^Yes, and always allow '(.+)'$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Yes, and always allow '(.+)'$/i, (match, cmd) => {
                        return "是, 且始终允许运行 '" + cmd + "'";
                    });
                } else if (/^(\\d+) tools? enabled$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+) tools? enabled$/i, (match, num) => {
                        return num + " 个工具已启用";
                    });
                } else if (/^(\\d+) active conversations?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+) active conversations?$/i, (match, num) => {
                        return num + " 个活跃会话";
                    });
                } else if (/^(\\d+) archived conversations?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+) archived conversations?$/i, (match, num) => {
                        return num + " 个已归档会话";
                    });
                } else if (/^(\\d+) tasks? running$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+) tasks? running$/i, (match, num) => {
                        return num + " 个任务正在运行";
                    });
                } else if (/^(\\d+) files? changed$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+) files? changed$/i, (match, num) => {
                        return num + " 个文件已更改";
                    });
                } else if (/^Show (\\d+) more(\\.\\.\\.|…)?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Show (\\d+) more(\\.\\.\\.|…)?$/i, (match, num) => {
                        return "显示另外 " + num + " 个...";
                    });
                } else if (/^Show (\\d+) breakdowns?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Show (\\d+) breakdowns?$/i, (match, num) => {
                        return "显示 " + num + " 项明细";
                    });
                } else if (/^See all \\((\\d+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^See all \\((\\d+)\\)$/i, (match, num) => {
                        return "显示全部 (" + num + ")";
                    });
                } else if (/^Available AI Credits: (\\d+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Available AI Credits: (\\d+)$/i, (match, num) => {
                        return "可用 AI 额度: " + num;
                    });
                } else if (/^Send feedback as\\s+(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Send feedback as\\s+(.+)$/i, (match, email) => {
                        return "发送反馈身份为 " + email;
                    });
                } else if (/^Media\\s*\\((.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Media\\s*\\((.+)\\)$/i, (match, timeStr) => {
                        let t = timeStr.replace(/Today/i, '今天').replace(/Yesterday/i, '昨天');
                        return "媒体 (" + t + ")";
                    });
                } else if (/^Updated\\s+(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Updated\\s+(.+)$/i, (match, rest) => {
                        return "更新于 " + rest;
                    });
                } else if (/^All scheduled tasks run as (.+?)[\\.\\s]*$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^All scheduled tasks run as (.+?)[\\.\\s]*$/i, (match, model) => {
                        return "所有计划任务均以 " + model + " 模型运行。";
                    });
                } else if (/^Individual quota reached\\. Please upgrade your subscription to increase your limits\\. Resets in (.+?)\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Individual quota reached\\. Please upgrade your subscription to increase your limits\\. Resets in (.+?)\\.?$/i, (match, t) => {
                        return "个人配额已达上限。请升级订阅以提高限额。将于 " + t + " 后重置。";
                    });
                } else if (/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+read$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+read$/i, (match, num) => {
                        return "将 " + num + " 个会话标记为已读";
                    });
                } else if (/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+unread$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+unread$/i, (match, num) => {
                        return "将 " + num + " 个会话标记为未读";
                    });
                } else if (/^Mark\\s+all\\s+(?:conversations?\\s+)?as\\s+read$/i.test(valNorm)) {
                    newVal = "将所有会话标记为已读";
                } else if (/^Mark\\s+all\\s+(?:conversations?\\s+)?as\\s+unread$/i.test(valNorm)) {
                    newVal = "将所有会话标记为未读";
                } else if (/^Version\\s+([\\d\\.]+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Version\\s+([\\d\\.]+)$/i, (match, v) => {
                        return "版本 " + v;
                    });
                } else if (/^(\\d+)\\s+subagents?\\s+(running|blocked|completed|failed)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+)\\s+subagents?\\s+(running|blocked|completed|failed)$/i, (match, num, state) => {
                        const stateLower = state.toLowerCase();
                        let stateStr = "";
                        if (stateLower === "running") stateStr = "正在运行";
                        else if (stateLower === "blocked") stateStr = "已阻塞";
                        else if (stateLower === "completed") stateStr = "已完成";
                        else if (stateLower === "failed") stateStr = "已失败";
                        return num + " 个子智能体" + stateStr;
                    });
                } else if (/^(\\d+)\\s+questions?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(\\d+)\\s+questions?$/i, (match, num) => {
                        return num + " 个问题";
                    });
                } else if (/^Asking\\s+(\\d+)\\s+questions?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Asking\\s+(\\d+)\\s+questions?$/i, (match, num) => {
                        return "正在询问 " + num + " 个问题";
                    });
                } else if (/^This will permanently delete (\\d+) active (?:conversations?|chats?)(?: and (\\d+) archived (?:conversations?|chats?))? within it\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^This will permanently delete (\\d+) active (?:conversations?|chats?)(?: and (\\d+) archived (?:conversations?|chats?))? within it\\.?$/i, (match, active, archived) => {
                        if (archived) {
                            return "这将永久删除 " + active + " 个活跃会话及 " + archived + " 个已归档会话。";
                        }
                        return "这将永久删除 " + active + " 个活跃会话。";
                    });
                } else if (/^(.+?): context deadline exceeded$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): context deadline exceeded$/i, (match, prefix) => {
                        return prefix + ": 请求超时 (context deadline exceeded)";
                    });
                } else if (/^(.+?): i\\/o timeout$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): i\\/o timeout$/i, (match, prefix) => {
                        return prefix + ": I/O 超时 (i/o timeout)";
                    });
                } else if (/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Are you sure you want to delete (the |this )?project (.+?)\\??$/i, (match, article, name) => {
                        return "您确定要删除项目 " + name + " 吗？";
                    });
                } else if (/^Permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?\\.?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?\\.?$/i, (match, name, active, archived) => {
                        return "永久删除 " + name + "，包含 " + active + " 个活跃会话及 " + archived + " 个已归档会话。";
                    });
                } else if (/^This will permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?(?:\\. This action cannot be undone\\.)?$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^This will permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?(?:\\. This action cannot be undone\\.)?$/i, (match, name, active, archived) => {
                        return "这将永久删除 " + name + "，包含 " + active + " 个活跃会话及 " + archived + " 个已归档会话。此操作无法撤销。";
                    });
                } else {
                    if (valNorm.length > 20) {
                        for (const [key, translated] of longEntries) {
                            if (key.length > 20 && key.length <= valNorm.length && valNorm.includes(key)) {
                                newVal = replaceLongDictionaryEntry(newVal, key, translated);
                            }
                        }
                    }

                    newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) days?, (\\d+) hours?\\./gi, (match, d, h) => {
                        return "您的 5 小时配额将在 " + d + " 天 " + h + " 小时后刷新。";
                    });
                    newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) hours?, (\\d+) minutes?\\./gi, (match, h, m) => {
                        return "您的 5 小时配额将在 " + h + " 小时 " + m + " 分钟后刷新。";
                    });
                    newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) days?\\./gi, (match, d) => {
                        return "您的 5 小时配额将在 " + d + " 天后刷新。";
                    });
                    newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) hours?\\./gi, (match, h) => {
                        return "您的 5 小时配额将在 " + h + " 小时后刷新。";
                    });
                    newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) minutes?\\./gi, (match, m) => {
                        return "您的 5 小时配额将在 " + m + " 分钟后刷新。";
                    });
                    newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) days?, (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, d, h) => {
                        return "您已达到 5 小时配额限制，将在 " + d + " 天 " + h + " 小时后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                    newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) hours?, (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, h, m) => {
                        return "您已达到 5 小时配额限制，将在 " + h + " 小时 " + m + " 分钟后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                    newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) days?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, d) => {
                        return "您已达到 5 小时配额限制，将在 " + d + " 天后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                    newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, h) => {
                        return "您已达到 5 小时配额限制，将在 " + h + " 小时后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                    newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, m) => {
                        return "您已达到 5 小时配额限制，将在 " + m + " 分钟后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。";
                    });
                    newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\./gi, (match, d, h) => {
                        return "您已使用部分每周配额，将在 " + d + " 天 " + h + " 小时后完全刷新。";
                    });
                    newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\./gi, (match, h, m) => {
                        return "您已使用部分每周配额，将在 " + h + " 小时 " + m + " 分钟后完全刷新。";
                    });
                    newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) days?\\./gi, (match, d) => {
                        return "您已使用部分每周配额，将在 " + d + " 天后完全刷新。";
                    });
                    newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) hours?\\./gi, (match, h) => {
                        return "您已使用部分每周配额，将在 " + h + " 小时后完全刷新。";
                    });
                    newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) minutes?\\./gi, (match, m) => {
                        return "您已使用部分每周配额，将在 " + m + " 分钟后完全刷新。";
                    });
                    newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\./gi, (match, d, h) => {
                        return "您已达到每周配额限制，将在 " + d + " 天 " + h + " 小时后完全刷新。";
                    });
                    newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\./gi, (match, h, m) => {
                        return "您已达到每周配额限制，将在 " + h + " 小时 " + m + " 分钟后完全刷新。";
                    });
                    newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) days?\\./gi, (match, d) => {
                        return "您已达到每周配额限制，将在 " + d + " 天后完全刷新。";
                    });
                    newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) hours?\\./gi, (match, h) => {
                        return "您已达到每周配额限制，将在 " + h + " 小时后完全刷新。";
                    });
                    newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) minutes?\\./gi, (match, m) => {
                        return "您已达到每周配额限制，将在 " + m + " 分钟后完全刷新。";
                    });
                    newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in less than a minute\\./gi, "您已使用部分每周配额，将在不到 1 分钟后完全刷新。");
                    newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in less than a minute\\./gi, "您已达到每周配额限制，将在不到 1 分钟后完全刷新。");
                    newVal = newVal.replace(/Your 5-hour limit will refresh in less than a minute\\./gi, "您的 5 小时配额将在不到 1 分钟后刷新。");
                    newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in less than a minute\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, "您已达到 5 小时配额限制，将在不到 1 分钟后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度。");
                    newVal = newVal.replace(/Match case \\((.+)\\)/gi, (m, k) => "区分大小写 (" + k + ")");
                    newVal = newVal.replace(/Match whole word \\((.+)\\)/gi, (m, k) => "全字匹配 (" + k + ")");
                    newVal = newVal.replace(/Use regular expression \\((.+)\\)/gi, (m, k) => "使用正则表达式 (" + k + ")");
                    newVal = newVal.replace(/Previous match \\((.+)\\)/gi, (m, k) => "上一个匹配项 (" + k + ")");
                    newVal = newVal.replace(/Next match \\((.+)\\)/gi, (m, k) => "下一个匹配项 (" + k + ")");
                    newVal = newVal.replace(/Close \\((.+)\\)/gi, (m, k) => "关闭 (" + k + ")");
                    const exploredSec3 = translateExploredStatus(newVal);
                    if (exploredSec3) {
                        newVal = exploredSec3;
                    }
                    newVal = newVal.replace(/^(\\d+)\\s+searches?\\s*>?\\s*$/i, (m, n) => n + " 次搜索");
                    newVal = newVal.replace(/^searches?\\s*>?\\s*$/i, () => "次搜索");
                    newVal = newVal.replace(/^files?\\s*>?\\s*$/i, () => "个文件");
                    newVal = newVal.replace(/^(\\d+)\\s+pages?(\\s*[>›]?)\\s*$/i, (m, n, suffix) => n + " 个页面" + suffix);
                }
                if (hasRecommended) {
                    newVal = '（推荐）' + newVal;
                }
                if (newVal !== originalVal) {
                    translatedValues.set(node, newVal);
                    node.nodeValue = newVal;
                }
            }
        } catch (e) {}
    }

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) translateNode(n);
            } else if (m.type === 'characterData') {
                translateNode(m.target);
            } else if (m.type === 'attributes') {
                translateNode(m.target);
            }
        }
    });

    const obsOpts = {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'aria-label']
    };

    let engineStarted = false;
    const startEngine = () => {
        const target = document.body || document.documentElement;
        if (!target || engineStarted) return;

        engineStarted = true;
        try {
            translateNode(target);
            observer.observe(target, obsOpts);
        } catch (e) {}
    };

    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function() {
        const sr = origAttachShadow.apply(this, arguments);
        try { observer.observe(sr, obsOpts); } catch(e) {}
        return sr;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startEngine);
    } else {
        startEngine();
    }
    window.addEventListener('load', startEngine);
})();
${SIGNATURE_END}`;

    return jsSource.replace("DICT_PLACEHOLDER", dictJson).replace("REPLACEMENT_ENTRIES_PLACEHOLDER", entriesJson);
}

function removeMarkedBlocks(content, startMark, endMark) {
    let cleaned = content;
    let startIdx = cleaned.indexOf(startMark);
    while (startIdx !== -1) {
        const endIdx = cleaned.indexOf(endMark, startIdx + startMark.length);
        if (endIdx === -1) break;
        cleaned = cleaned.substring(0, startIdx) + cleaned.substring(endIdx + endMark.length);
        startIdx = cleaned.indexOf(startMark);
    }
    return cleaned;
}

function cleanJsContent(content) {
    const withoutLegacy = removeMarkedBlocks(content, LEGACY_SIGNATURE_START, LEGACY_SIGNATURE_END);
    return removeMarkedBlocks(withoutLegacy, SIGNATURE_START, SIGNATURE_END);
}

function cleanMenuJsContent(content) {
    const withoutLegacy = removeMarkedBlocks(content, LEGACY_MENU_SIGNATURE_START, LEGACY_MENU_SIGNATURE_END);
    return removeMarkedBlocks(withoutLegacy, MENU_SIGNATURE_START, MENU_SIGNATURE_END);
}

function cleanTrayJsContent(content) {
    const withoutLegacy = removeMarkedBlocks(content, LEGACY_TRAY_SIGNATURE_START, LEGACY_TRAY_SIGNATURE_END);
    return removeMarkedBlocks(withoutLegacy, TRAY_SIGNATURE_START, TRAY_SIGNATURE_END);
}

let wasAppRunning = false;

function getLinuxTargetUid() {
    const sudoUidText = String(process.env.SUDO_UID || '');
    if (/^\d+$/.test(sudoUidText)) return Number(sudoUidText);
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function getLinuxProcessTable() {
    try {
        const stdout = child_process.execFileSync(
            'ps',
            ['-eo', 'pid=,ppid=,uid=,stat=,comm=,args='],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return stdout.split(/\r?\n/).map(line => {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
            if (!match) return null;
            return {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                uid: Number(match[3]),
                stat: match[4],
                comm: match[5],
                args: match[6] || ''
            };
        }).filter(Boolean);
    } catch (e) {
        return [];
    }
}

function getLinuxAntigravityMainProcesses(processTable = getLinuxProcessTable()) {
    const targetUid = getLinuxTargetUid();
    return processTable.filter(entry => {
        if (targetUid !== null && entry.uid !== targetUid) return false;
        if (entry.comm.toLowerCase() !== 'antigravity') return false;
        return !/(?:^|\s)--type(?:=|\s)/i.test(entry.args);
    });
}

function collectLinuxProcessTreePids(processTable, rootPids) {
    const collected = new Set(rootPids);
    let changed = true;
    while (changed) {
        changed = false;
        for (const entry of processTable) {
            if (!collected.has(entry.ppid) || collected.has(entry.pid)) continue;
            collected.add(entry.pid);
            changed = true;
        }
    }
    return collected;
}

function refreshLinuxProcessTree(trackedPids) {
    const processTable = getLinuxProcessTable();
    const expanded = collectLinuxProcessTreePids(processTable, trackedPids);
    for (const pid of expanded) trackedPids.add(pid);
    return processTable.filter(entry => {
        return trackedPids.has(entry.pid) && !entry.stat.toUpperCase().startsWith('Z');
    });
}

function sleepSync(milliseconds) {
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitArray, 0, 0, milliseconds);
}

function signalLinuxProcesses(processEntries, signal) {
    for (const entry of processEntries) {
        try {
            process.kill(entry.pid, signal);
        } catch (e) {
            if (e.code !== 'ESRCH') {
                console.warn("[警告] 无法向进程 " + entry.pid + " (" + entry.comm + ") 发送 " + signal + ": " + e.message);
            }
        }
    }
}

function waitForLinuxProcessTreeExit(trackedPids, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let remaining = refreshLinuxProcessTree(trackedPids);
    while (remaining.length > 0 && Date.now() < deadline) {
        sleepSync(100);
        remaining = refreshLinuxProcessTree(trackedPids);
    }
    return remaining;
}

function checkIfAppIsRunning() {
    try {
        if (process.platform === 'win32') {
            const stdout = child_process.execSync('tasklist /fi "imagename eq Antigravity.exe" /nh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return stdout.toLowerCase().includes('antigravity.exe');
        } else {
            const processTable = getLinuxProcessTable();
            if (processTable.length === 0) return true;
            return getLinuxAntigravityMainProcesses(processTable).length > 0;
        }
    } catch (e) {
    }
    return false;
}

function closeAntigravityProcesses() {
    console.log("[1] 检测到 Antigravity 客户端正在运行，正在等待客户端完整退出...");
    try {
        if (process.platform === 'win32') {
            child_process.execSync('taskkill /f /im Antigravity.exe /t >nul 2>nul');
            sleepSync(1500);
            return true;
        }
    } catch (e) {
        console.error("[错误] 关闭 Antigravity 失败: " + e.message);
        return false;
    }

    const processTable = getLinuxProcessTable();
    if (processTable.length === 0) {
        console.error("[错误] 无法读取 Linux 进程列表，已停止汉化以避免覆盖运行中的客户端文件。");
        return false;
    }
    const mainProcesses = getLinuxAntigravityMainProcesses(processTable);
    if (mainProcesses.length === 0) return true;

    const trackedPids = collectLinuxProcessTreePids(
        processTable,
        mainProcesses.map(entry => entry.pid)
    );
    const mainPids = new Set(mainProcesses.map(entry => entry.pid));

    signalLinuxProcesses(mainProcesses, 'SIGTERM');
    let remaining = waitForLinuxProcessTreeExit(trackedPids, 10000);

    if (remaining.length > 0) {
        const remainingMainProcesses = remaining.filter(entry => mainPids.has(entry.pid));
        if (remainingMainProcesses.length > 0) {
            console.log("[等待] Antigravity 主进程仍在关闭，正在再次请求正常退出...");
            signalLinuxProcesses(remainingMainProcesses, 'SIGTERM');
            remaining = waitForLinuxProcessTreeExit(trackedPids, 5000);
        }
    }

    if (remaining.length > 0 && !remaining.some(entry => mainPids.has(entry.pid))) {
        console.log("[等待] 主程序已退出，正在关闭 " + remaining.length + " 个遗留后台进程...");
        signalLinuxProcesses(remaining, 'SIGTERM');
        remaining = waitForLinuxProcessTreeExit(trackedPids, 5000);
    }

    if (remaining.length > 0) {
        const summary = remaining
            .slice(0, 8)
            .map(entry => entry.pid + " (" + entry.comm + ")")
            .join(', ');
        console.error("[错误] Antigravity 未能完整退出，已停止汉化以保护正在运行的客户端。");
        console.error("[错误] 仍在运行: " + summary + (remaining.length > 8 ? ' ...' : ''));
        console.error("[提示] 请确认客户端和相关后台任务已结束后重新运行安装脚本。");
        return false;
    }

    console.log("[√] Antigravity 主程序及后台进程已完整退出。");
    return true;
}

function detectInstallationDir(manualDir, options = {}) {
    const quiet = Boolean(options && options.quiet);
    const hasAntigravityResources = (candidate) => {
        return fs.existsSync(path.join(candidate, "resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "app.asar")) ||
            fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "resources", "app", "product.json"));
    };

    if (manualDir) {
        if (fs.existsSync(manualDir)) {
            let resolved = path.resolve(manualDir);
            if (fs.statSync(resolved).isFile() && resolved.endsWith('app.asar')) {
                resolved = path.dirname(resolved);
            }
            if (!hasAntigravityResources(resolved) && fs.statSync(resolved).isDirectory()) {
                try {
                    const subItems = fs.readdirSync(resolved);
                    for (const sub of subItems) {
                        const subPath = path.join(resolved, sub);
                        if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory() && hasAntigravityResources(subPath)) {
                            return path.resolve(subPath);
                        }
                    }
                } catch (e) {}
            }
            return resolved;
        } else {
            if (quiet) return null;
            console.error(`[错误] 手动指定的路径不存在: ${manualDir}`);
            process.exit(1);
        }
    }

    const candidates = [];
    const seenCandidates = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const normalized = path.resolve(candidate);
        const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        if (!seenCandidates.has(key)) {
            candidates.push(normalized);
            seenCandidates.add(key);
        }
    };

    addCandidate(process.env.ANTIGRAVITY_INSTALL_DIR);
    addCandidate(process.env.ANTIGRAVITY_HOME);

    if (process.platform === 'win32') {
        const registryRoots = [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];
        for (const root of registryRoots) {
            try {
                const output = child_process.execSync(`reg query "${root}" /s /f Antigravity /d`, { encoding: 'utf-8', stdio: 'pipe' });
                for (const line of output.split(/\r?\n/)) {
                    const match = line.match(/^\s*(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
                    if (!match) continue;
                    let value = match[2].trim().replace(/^"|"$/g, '');
                    if (/Antigravity\.exe/i.test(value)) {
                        value = path.dirname(value);
                    }
                    addCandidate(value);
                }
            } catch (e) {
            }
        }
        const driveLetters = ['C', 'D', 'E', 'F'];
        for (const drive of driveLetters) {
            addCandidate(`${drive}:\\Programs\\Antigravity`);
            addCandidate(`${drive}:\\Antigravity`);
        }
        addCandidate("C:\\Program Files\\Antigravity");
        addCandidate("C:\\Program Files (x86)\\Antigravity");
        const localAppdata = process.env.LOCALAPPDATA;
        if (localAppdata) {
            addCandidate(path.join(localAppdata, 'antigravity'));
            addCandidate(path.join(localAppdata, 'Programs', 'antigravity'));
        }
    } else {
        const homeDirs = [];
        if (process.env.HOME) homeDirs.push(process.env.HOME);
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
            let sudoHome = '';
            try {
                const getent = child_process.execSync(`getent passwd "${process.env.SUDO_USER}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
                if (getent) {
                    const parts = getent.split(':');
                    if (parts.length >= 6 && parts[5]) {
                        sudoHome = parts[5];
                    }
                }
            } catch (e) {}
            if (!sudoHome) {
                sudoHome = path.join('/home', process.env.SUDO_USER);
            }
            if (fs.existsSync(sudoHome) && !homeDirs.includes(sudoHome)) {
                homeDirs.push(sudoHome);
            }
        }

        const isRunningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

        const addHomeCandidates = () => {
            for (const homeDir of homeDirs) {
                addCandidate(path.join(homeDir, '.local', 'share', 'antigravity'));
                addCandidate(path.join(homeDir, '.local', 'share', 'Antigravity'));
                addCandidate(path.join(homeDir, 'antigravity'));
                addCandidate(path.join(homeDir, 'Antigravity'));
                addCandidate(path.join(homeDir, '.local', 'share', 'flatpak', 'app', 'com.antigravity', 'current', 'active', 'files', 'share', 'antigravity'));
            }
            for (const homeDir of homeDirs) {
                const userDesktopFiles = [
                    path.join(homeDir, '.local', 'share', 'applications', 'antigravity.desktop'),
                    path.join(homeDir, '.local', 'share', 'applications', 'Antigravity.desktop')
                ];
                for (const df of userDesktopFiles) {
                    if (fs.existsSync(df)) {
                        try {
                            const content = fs.readFileSync(df, 'utf-8');
                            const execMatch = content.match(/^Exec=(.*)$/m);
                            if (execMatch && execMatch[1]) {
                                let execPath = execMatch[1].trim().split(/\s+/)[0].replace(/^"|"$/g, '');
                                if (fs.existsSync(execPath)) {
                                    try { execPath = fs.realpathSync(execPath); } catch (e) {}
                                    addCandidate(path.dirname(execPath));
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        };

        const addSystemCandidates = () => {
            try {
                const whichOut = child_process.execSync(
                    'command -v antigravity 2>/dev/null || which antigravity 2>/dev/null || command -v agy 2>/dev/null || which agy 2>/dev/null || command -v Antigravity 2>/dev/null || which Antigravity 2>/dev/null',
                    { encoding: 'utf-8' }
                ).trim();
                if (whichOut && fs.existsSync(whichOut)) {
                    let realP = whichOut;
                    try { realP = fs.realpathSync(whichOut); } catch (e) {}
                    addCandidate(path.dirname(realP));
                    try {
                        const fileContent = fs.readFileSync(realP, 'utf-8');
                        const scriptMatch = fileContent.match(/(?:\/opt|\/usr|\/home\/[^\s'"]+)\/[^\s'"]*antigravity[^\s'"]*/i);
                        if (scriptMatch && fs.existsSync(scriptMatch[0])) {
                            let target = scriptMatch[0];
                            try { target = fs.realpathSync(target); } catch (e) {}
                            addCandidate(fs.statSync(target).isDirectory() ? target : path.dirname(target));
                        }
                    } catch (e) {}
                }
            } catch (e) {}

            const desktopFiles = [
                '/usr/share/applications/antigravity.desktop',
                '/usr/share/applications/Antigravity.desktop',
                '/usr/local/share/applications/antigravity.desktop',
                '/usr/local/share/applications/Antigravity.desktop'
            ];
            for (const df of desktopFiles) {
                if (fs.existsSync(df)) {
                    try {
                        const content = fs.readFileSync(df, 'utf-8');
                        const execMatch = content.match(/^Exec=(.*)$/m);
                        if (execMatch && execMatch[1]) {
                            let execPath = execMatch[1].trim().split(/\s+/)[0].replace(/^"|"$/g, '');
                            if (fs.existsSync(execPath)) {
                                try { execPath = fs.realpathSync(execPath); } catch (e) {}
                                addCandidate(path.dirname(execPath));
                            }
                        }
                    } catch (e) {}
                }
            }

            addCandidate('/opt/antigravity/Antigravity-x64');
            addCandidate('/opt/antigravity/antigravity-x64');
            addCandidate('/opt/Antigravity/Antigravity-x64');
            addCandidate('/opt/antigravity');
            addCandidate('/opt/Antigravity');
            addCandidate('/usr/local/share/antigravity');
            addCandidate('/usr/local/share/Antigravity');
            addCandidate('/usr/share/antigravity');
            addCandidate('/usr/share/Antigravity');
            addCandidate('/usr/lib/antigravity');
            addCandidate('/usr/lib/Antigravity');
            addCandidate('/snap/antigravity/current');
            addCandidate('/snap/antigravity/current/usr/share/antigravity');
            addCandidate('/var/lib/flatpak/app/com.antigravity/current/active/files/share/antigravity');
        };

        if (isRunningAsRoot) {
            addSystemCandidates();
            addHomeCandidates();
        } else {
            addHomeCandidates();
            addSystemCandidates();
        }
    }

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            if (hasAntigravityResources(p)) {
                if (!quiet) console.log(`[探测] 成功自动识别到 Antigravity 安装目录: ${p}`);
                return path.resolve(p);
            }
            try {
                if (fs.statSync(p).isDirectory()) {
                    const subItems = fs.readdirSync(p);
                    for (const sub of subItems) {
                        const subPath = path.join(p, sub);
                        if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory() && hasAntigravityResources(subPath)) {
                            if (!quiet) console.log(`[探测] 成功自动识别到 Antigravity 安装目录: ${subPath}`);
                            return path.resolve(subPath);
                        }
                    }
                }
            } catch (e) {}
        }
    }

    if (quiet) return null;
    console.error("[错误] 未找到默认安装目录，请使用 --install-dir 手动指定您的安装路径！");
    process.exit(1);
}

function runCommandSync(cmd) {
    try {
        const out = child_process.execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
        return { success: true, stdout: out, stderr: '' };
    } catch (e) {
        return { success: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
}

function reportWritePermissionError(resourcesDir, error, action, entryScript = 'install.sh') {
    const detail = error && (error.code || error.message);
    console.error(`\n[权限不足] 无法${action} Antigravity 安装目录: ${resourcesDir}`);
    if (detail) console.error(`[详情] ${detail}`);

    if (process.platform === 'win32') {
        console.error("[提示] 请右键安装脚本并选择“以管理员身份运行”，然后重试。");
    } else {
        console.error("[提示] 此安装位于系统目录，需要管理员权限。请完全退出客户端后，在汉化包目录运行：");
        console.error(`  sudo ./${entryScript}`);
    }
}

function canWriteAntigravityResources(resourcesDir, entryScript) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");
    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) return true;

    try {
        fs.accessSync(resourcesDir, fs.constants.W_OK | fs.constants.X_OK);
        if (fs.existsSync(asarPath)) {
            fs.accessSync(asarPath, fs.constants.R_OK | fs.constants.W_OK);
        }
        if (fs.existsSync(bakPath)) {
            fs.accessSync(bakPath, fs.constants.R_OK | fs.constants.W_OK);
        }
        return true;
    } catch (e) {
        reportWritePermissionError(resourcesDir, e, '写入', entryScript);
        return false;
    }
}

function installLocalization(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");

    if (!fs.existsSync(asarPath)) {
        console.error(`[错误] 未在资源目录中找到 app.asar: ${resourcesDir}`);
        return false;
    }

    if (!fs.existsSync(bakPath)) {
        console.log(`[备份] 正在创建官方原始包备份: app.asar.bak ...`);
        try {
            fs.copyFileSync(asarPath, bakPath);
        } catch (e) {
            if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
                reportWritePermissionError(resourcesDir, e, '备份到');
            } else {
                console.error(`[错误] 创建 app.asar.bak 备份失败: ${e.message}`);
            }
            return false;
        }
        console.log(`[备份] 备份成功！`);
    } else {
        try {
            fs.copyFileSync(bakPath, asarPath);
            console.log(`[还原] 已重置当前 app.asar 为官方原始备份包，以进行全新注入...`);
        } catch (e) {
            if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
                reportWritePermissionError(resourcesDir, e, '写入');
                return false;
            }
            console.log(`[提示] 当前 app.asar 被锁定（可能是客户端正在运行），将使用当前包进行增量注入。`);
        }
    }

    const tempDir = path.join(__dirname, "_temp_asar");
    if (fs.existsSync(tempDir)) {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    }

    try {
        console.log(`[解包] 正在使用 npx 提取 app.asar...`);
        const extractRes = runCommandSync(`npx -y @electron/asar extract "${asarPath}" "${tempDir}"`);
        if (!extractRes.success || !fs.existsSync(tempDir)) {
            console.error(`[错误] 解包失败，可能是由于系统未安装 Node.js/npm 或者网络限制。`);
            console.error(`详情: ${extractRes.stderr}\n${extractRes.stdout}`);
            return false;
        }

        const preloadPath = path.join(tempDir, "dist", "preload.js");
        if (!fs.existsSync(preloadPath)) {
            console.error(`[错误] 解压后未能在指定路径找到 preload.js: ${preloadPath}`);
            return false;
        }

    console.log(`[修改] 正在向 preload.js 注入汉化代码...`);
    let content = fs.readFileSync(preloadPath, 'utf-8');

    const cleanedContent = cleanJsContent(content);
    const translationJs = generateJs();
    const newContent = cleanedContent + "\n" + translationJs;

    fs.writeFileSync(preloadPath, newContent, 'utf-8');
    console.log(`[修改] 注入成功！`);

    const menuPath = path.join(tempDir, "dist", "menu.js");
    if (fs.existsSync(menuPath)) {
        console.log(`[修改] 正在向 menu.js 注入菜单汉化代码...`);
        let menuContent = fs.readFileSync(menuPath, 'utf-8');

        const menuCleaned = cleanMenuJsContent(menuContent);

        const menuTranslationJs = `
    ${MENU_SIGNATURE_START}
    const translations = {
        'File': '文件',
        'Edit': '编辑',
        'View': '视图',
        'Window': '窗口',
        'Help': '帮助',
        'New Window': '新建窗口',
        'Create Project': '创建项目',
        'Command Palette': '命令面板',
        'Docs': '文档',
        'Check for Updates': '检查更新',
        'Toggle Developer Tools': '切换开发者工具',
        'Undo': '撤销',
        'Redo': '重做',
        'Cut': '剪切',
        'Copy': '复制',
        'Paste': '粘贴',
        'Select All': '全选',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '关闭',
        'Zoom': '缩放',
        'Reset Zoom': '重置缩放',
        'Zoom In': '放大',
        'Zoom Out': '缩小',
        'Toggle Full Screen': '切换全屏',
        'Version': '版本'
    };
    function translateMenu(items) {
        for (const item of items) {
            let label = item.label || '';
            let mnemonic = '';
            let cleanLabel = label;
            const m = label.match(/&([a-zA-Z])/);
            if (m) {
                mnemonic = "(&" + m[1] + ")";
                cleanLabel = label.replace('&', '');
            }
            if (translations[cleanLabel]) {
                item.label = translations[cleanLabel] + mnemonic;
            } else if (translations[label]) {
                item.label = translations[label];
            } else if (/^Version\\s*([\\d\\.]*)$/i.test(cleanLabel)) {
                item.label = cleanLabel.replace(/^Version\\s*([\\d\\.]*)$/i, (match, v) => v ? "版本 " + v : "版本");
            }
            if (item.submenu && item.submenu.items) {
                translateMenu(item.submenu.items);
            }
        }
    }
    translateMenu(menu.items);
    ${MENU_SIGNATURE_END}
    `;

        const targetStr = "electron_1.Menu.setApplicationMenu(menu);";
        const idx = menuCleaned.indexOf(targetStr);
        if (idx !== -1) {
            const patchedMenuContent = menuCleaned.substring(0, idx) + menuTranslationJs + "\n    " + menuCleaned.substring(idx);
            fs.writeFileSync(menuPath, patchedMenuContent, 'utf-8');
            console.log(`[修改] 菜单汉化注入成功！`);
        } else {
            console.warn(`[警告] 未能在 menu.js 中找到设定的插入点。`);
        }
    }

    const trayPath = path.join(tempDir, "dist", "tray.js");
    if (fs.existsSync(trayPath)) {
        console.log(`[修改] 正在向 tray.js 注入任务栏菜单汉化...`);
        let trayContent = fs.readFileSync(trayPath, 'utf-8');

        let trayCleaned = cleanTrayJsContent(trayContent);

        const targetCreate = "function createTray(actions) {";
        const replacementCreate = `function createTray(actions) {
    ${TRAY_SIGNATURE_START}
    const translations = {
        'No agents running': '无运行中的智能体',
        'Open Antigravity': '打开反重力智能编程',
        'Quit': '退出'
    };
    for (const item of actions) {
        if (translations[item.label]) {
            item.label = translations[item.label];
        }
    }
    ${TRAY_SIGNATURE_END}`;

        let trayPatched = trayCleaned.replace(targetCreate, replacementCreate);

        const countRegex = /countItem\.label\s*=\s*\([\s\S]*?' running';/g;
        const replacementCount = "countItem.label = count > 0 ? `${count} 个智能体运行中` : '无运行中的智能体';";
        trayPatched = trayPatched.replace(countRegex, replacementCount);

        fs.writeFileSync(trayPath, trayPatched, 'utf-8');
        console.log(`[修改] 任务栏菜单汉化注入成功！`);
    }

    const loadingPath = path.join(tempDir, "dist", "loadingOverlay.js");
    if (fs.existsSync(loadingPath)) {
        console.log(`[修改] 正在向 loadingOverlay.js 注入加载页汉化...`);
        let loadingContent = fs.readFileSync(loadingPath, 'utf-8');

        const targetText = '<div class="text">Loading Antigravity</div>';
        const replacementText = '<div class="text">反重力引擎已启动，正在努力摆脱地心引力...</div>';

        loadingContent = loadingContent.replace(targetText, replacementText);

        fs.writeFileSync(loadingPath, loadingContent, 'utf-8');
        console.log(`[修改] 加载页汉化注入成功！`);
    }

    const updaterPath = path.join(tempDir, "dist", "updater.js");
    if (fs.existsSync(updaterPath)) {
        console.log(`[修改] 正在向 updater.js 注入更新弹窗汉化...`);
        let updaterContent = fs.readFileSync(updaterPath, 'utf-8');

        const targetOptions = `                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],`;
        const replacementOptions = `                title: '检查更新',
                message: '暂无可用更新',
                buttons: ['确定'],`;

        updaterContent = updaterContent.replace(targetOptions, replacementOptions);
        fs.writeFileSync(updaterPath, updaterContent, 'utf-8');
        console.log(`[修改] 更新弹窗汉化注入成功！`);
    }

        console.log(`[打包] 正在将修改后的内容打包回 app.asar...`);
        const packRes = runCommandSync(`npx -y @electron/asar pack "${tempDir}" "${asarPath}"`);

        if (!packRes.success) {
            console.error(`[错误] 打包失败。`);
            console.error(`详情: ${packRes.stderr}\n${packRes.stdout}`);
            return false;
        }

        console.log(`[√] Antigravity 汉化部署完成！`);
        return true;
    } finally {
        if (fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {}
        }
    }
}

function restoreLocalization(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");

    if (!fs.existsSync(bakPath)) {
        console.log("[!] 未找到备份文件 app.asar.bak，可能尚未安装过汉化或备份被删除。");
        return false;
    }

    console.log("[还原] 正在用官方备份文件恢复...");
    try {
        fs.copyFileSync(bakPath, asarPath);
        fs.unlinkSync(bakPath);
    } catch (e) {
        if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
            reportWritePermissionError(resourcesDir, e, '还原', 'uninstall.sh');
        } else {
            console.error(`[错误] 还原 app.asar 失败: ${e.message}`);
        }
        return false;
    }
    console.log("[√] 官方 app.asar 已成功恢复！");
    return true;
}

function main() {
    if (process.platform !== 'win32') {
        const shellScripts = ['install.sh', 'uninstall.sh'];
        for (const script of shellScripts) {
            const scriptPath = path.join(__dirname, script);
            if (fs.existsSync(scriptPath)) {
                try {
                    fs.chmodSync(scriptPath, 0o755);
                } catch (e) {}
            }
        }
    }

    let huifu = false;
    let manualDir = "";
    let noKill = false;
    let checkWriteOnly = false;

    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--huifu') {
            huifu = true;
        } else if (args[i] === '--install-dir') {
            manualDir = args[i + 1] || "";
            i++;
        } else if (args[i] === '--no-kill') {
            noKill = true;
        } else if (args[i] === '--brand-title') {
            i++;
        } else if (args[i] === '--check-write') {
            checkWriteOnly = true;
        }
    }

    if (checkWriteOnly) {
        const installDir = detectInstallationDir(manualDir, { quiet: true });
        if (!installDir) {
            process.exit(3);
        }
        let resourcesDir = "";
        if (fs.existsSync(path.join(installDir, "resources"))) {
            resourcesDir = path.join(installDir, "resources");
        } else if (fs.existsSync(path.join(installDir, "Contents", "Resources"))) {
            resourcesDir = path.join(installDir, "Contents", "Resources");
        } else if (installDir.replace(/\/$/, "").toLowerCase().endsWith("/resources")) {
            resourcesDir = installDir;
        } else if (fs.existsSync(path.join(installDir, "app.asar"))) {
            resourcesDir = installDir;
        } else {
            resourcesDir = path.join(installDir, "resources");
        }

        if (!fs.existsSync(resourcesDir)) {
            process.exit(3);
        }

        const asarPath = path.join(resourcesDir, "app.asar");
        const bakPath = path.join(resourcesDir, "app.asar.bak");
        if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) {
            process.exit(3);
        }

        try {
            fs.accessSync(resourcesDir, fs.constants.W_OK | fs.constants.X_OK);
            if (fs.existsSync(asarPath)) {
                fs.accessSync(asarPath, fs.constants.R_OK | fs.constants.W_OK);
            }
            if (fs.existsSync(bakPath)) {
                fs.accessSync(bakPath, fs.constants.R_OK | fs.constants.W_OK);
            }
            process.exit(0);
        } catch (e) {
            process.exit(2);
        }
    }

    const installDir = detectInstallationDir(manualDir);

    let resourcesDir = "";
    if (fs.existsSync(path.join(installDir, "resources"))) {
        resourcesDir = path.join(installDir, "resources");
    } else if (fs.existsSync(path.join(installDir, "Contents", "Resources"))) {
        resourcesDir = path.join(installDir, "Contents", "Resources");
    } else if (installDir.replace(/\/$/, "").toLowerCase().endsWith("/resources")) {
        resourcesDir = installDir;
    } else if (fs.existsSync(path.join(installDir, "app.asar"))) {
        resourcesDir = installDir;
    } else {
        resourcesDir = path.join(installDir, "resources");
    }

    if (!fs.existsSync(resourcesDir)) {
        console.error(`[错误] 无法定位有效的资源(resources)目录: ${resourcesDir}`);
        process.exit(1);
    }

    if (!canWriteAntigravityResources(resourcesDir, huifu ? 'uninstall.sh' : 'install.sh')) {
        process.exit(1);
    }

    wasAppRunning = checkIfAppIsRunning();
    if (noKill) {
        console.log("[跳过] 检测到 --no-kill 参数，跳过关闭 Antigravity 运行进程。");
    } else if (wasAppRunning) {
        if (!closeAntigravityProcesses()) {
            process.exit(1);
        }
    } else {
        console.log("[跳过] Antigravity 客户端当前未运行，无需关闭进程。");
    }

    let success = false;
    if (huifu) {
        console.log("====== 正在卸载中文汉化，恢复官方原版 ======");
        success = restoreLocalization(resourcesDir);
    } else {
        console.log("====== 正在安装 Antigravity 中文汉化 ======");
        success = installLocalization(resourcesDir);
    }

    if (!success) {
        process.exit(1);
    }

    if (success && wasAppRunning && !noKill) {
        console.log("\n[启动] 检测到安装前反重力客户端处于开启状态，正在重新启动客户端...");
        try {
            let launched = false;
            let restartDeferred = false;
            if (process.platform === 'win32') {
                const exePath = path.join(installDir, 'Antigravity.exe');
                if (fs.existsSync(exePath)) {
                    const child = child_process.spawn(exePath, [], { detached: true, stdio: 'ignore' });
                    child.unref();
                    console.log("[启动] 客户端启动成功！");
                    launched = true;
                }
            } else {
                const runningUnderSudo = typeof process.getuid === 'function'
                    && process.getuid() === 0
                    && process.env.SUDO_USER
                    && process.env.SUDO_USER !== 'root';
                if (runningUnderSudo) {
                    console.log("[提示] 当前通过 sudo 安装；为避免以 root 身份启动桌面应用，请手动启动 Antigravity。");
                    restartDeferred = true;
                } else {
                    const exeCandidates = [
                        path.join(installDir, 'antigravity'),
                        path.join(installDir, 'Antigravity'),
                        path.join(installDir, 'bin', 'antigravity'),
                    ];
                    for (const exePath of exeCandidates) {
                        if (fs.existsSync(exePath)) {
                            const child = child_process.spawn(exePath, [], { detached: true, stdio: 'ignore' });
                            child.unref();
                            console.log("[启动] 客户端启动成功！");
                            launched = true;
                            break;
                        }
                    }
                    if (!launched) {
                        try {
                            const whichOut = child_process.execSync('command -v antigravity 2>/dev/null || which antigravity 2>/dev/null || command -v Antigravity 2>/dev/null || which Antigravity 2>/dev/null || command -v agy 2>/dev/null || which agy 2>/dev/null', { encoding: 'utf-8' }).trim();
                            if (whichOut) {
                                const child = child_process.spawn(whichOut, [], { detached: true, stdio: 'ignore' });
                                child.unref();
                                console.log("[启动] 客户端启动成功！");
                                launched = true;
                            }
                        } catch (e) {}
                    }
                }
            }
            if (!launched && !restartDeferred) {
                console.warn("[警告] 未找到客户端可执行文件，请手动启动 Antigravity。");
            }
        } catch (e) {
            console.warn(`[警告] 客户端启动失败: ${e.message}`);
        }
    }
}

main();

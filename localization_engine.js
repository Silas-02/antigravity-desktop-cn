const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const vm = require('vm');

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
    none: 'hidden'
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
const IPC_CONTEXT_MENU_SIGNATURE_START = "'__ANTIGRAVITY_IPC_CONTEXT_MENU_TRANSLATION_START__';";
const IPC_CONTEXT_MENU_SIGNATURE_END = "'__ANTIGRAVITY_IPC_CONTEXT_MENU_TRANSLATION_END__';";
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
                console.error(`[Localization] Failed to parse dictionary file ${file}:`, e.message);
            }
        }
    }
    if (BRAND_TITLE_MODE === 'hidden') {
        totalMap[normalizeText('Antigravity')] = '';
    } else {
        delete totalMap[normalizeText('Antigravity')];
    }
    return totalMap;
}

function generateJs() {
    const fullDict = loadDictionary();
    const longEntries = Object.entries(fullDict).filter(([k]) => k.length > 20).sort((a, b) => b[0].length - a[0].length);

    const dictJson = JSON.stringify(fullDict, null, 4);
    const entriesJson = JSON.stringify(longEntries);

    const jsSource = `${SIGNATURE_START}
(() => {
    const map = new Map(Object.entries(DICT_PLACEHOLDER));
    const lowerMap = new Map();
    for (const [k, v] of map.entries()) lowerMap.set(k.toLowerCase(), v);

    const longEntries = REPLACEMENT_ENTRIES_PLACEHOLDER;
    const translatedValues = new WeakMap();
    const longScannedValues = new WeakMap();
    const unmatchedLongStrings = new Set();
    let blockedCacheVersion = 1;
    const blockedZoneCache = new WeakMap();
    const skillContextCache = new WeakMap();

    const BLOCKED_CLASSES = ['monaco-editor', 'editor-container', 'terminal', 'output-view', 'debug-console', 'code-view', 'artifact-container', 'suggest-widget'];
    const HARD_PRUNED_CLASS_REGEX = /(?:^|\\s)(?:view-lines|view-line|view-overlays|lines-content|margin|margin-view-overlays|minimap|decorationsOverviewRuler|cursors-layer|monaco-tokenized-source|xterm|terminal|output-view|debug-console|material-symbols(?:-[a-z]+)?|material-icons(?:-[a-z]+)?|codicon(?:-[a-z]+)?|google-symbols)(?:\\s|$)/;
    const BLOCKED_TAGS = ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'INPUT', 'TEXTAREA', 'SVG', 'CANVAS', 'SYMBOL', 'PATH'];
    const BLOCKED_TAGS_SET = new Set(BLOCKED_TAGS);
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
        let match = val.match(/^(.+?)\\s*\\((Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧|⌃)\\+?([^)]*)\\)$/i);
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
        match = val.match(/^(.+?)\\s+(Ctrl|Cmd|Alt|Shift|⌘|⌥|⇧|⌃)\\+([A-Za-z0-9;,.\\/-]+)$/i);
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
                return transPref + " " + match[2] + "+" + match[3];
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

        match = normalized.match(/^Pushed\\s+(\\d+)\\s+commits?\\s+to\\s+((?:↗\\s*)?\\S+)[.。]?$/i);
        if (match) return "已将 " + match[1] + " 个提交推送到 " + match[2];

        match = normalized.match(/^Committed\\s+to\\s+((?:↗\\s*)?\\S+)[.。]?$/i);
        if (match) return "已提交到 " + match[1];

        match = normalized.match(/^Amended\\s+commit\\s+on\\s+((?:↗\\s*)?[^\\s.。]+)[.。]?$/i);
        if (match) return "已在 " + match[1] + " 上修补提交";

        const commitSummary = getCommitSummaryParts(normalized);
        if (commitSummary) {
            return "将 " + commitSummary.count + " 个文件的更改提交到 " + commitSummary.target;
        }

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

    function getRelativeTimeTranslation(value, node = null) {
        const normalized = norm(value);
        if (/^just\\s+now$/i.test(normalized)) return "刚刚";

        const triggeredMatch = normalized.match(/^(?:Triggered|已触发)\\s+(.+)$/i);
        if (triggeredMatch) {
            const inner = triggeredMatch[1].trim();
            if (/^(?:刚刚|\\d+\\s*(?:秒|分钟|小时|天|周|个月|年)前)$/.test(inner)) {
                return "已触发 " + inner;
            }
            const rel = getRelativeTimeTranslation(inner, node);
            if (rel) return "已触发 " + rel;
            if (/^\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?$/.test(inner) || /^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test(inner)) {
                return "已触发 " + inner;
            }
            return null;
        }

        let match = normalized.match(/^(\\d+)\\s*(s|m|h|d|w|mo|yr|y)$/);
        if (match) {
            if (node && isContentBodyContainer(node)) {
                return null;
            }
            if (node && isUptimeDurationContext(node)) {
                const durationUnits = {
                    s: "秒",
                    m: "分钟",
                    h: "小时",
                    d: "天",
                    w: "周",
                    mo: "个月",
                    yr: "年",
                    y: "年"
                };
                return match[1] + " " + durationUnits[match[2]];
            }
            const compactUnits = {
                s: "秒前",
                m: "分钟前",
                h: "小时前",
                d: "天前",
                w: "周前",
                mo: "个月前",
                yr: "年前",
                y: "年前"
            };
            return match[1] + compactUnits[match[2]];
        }

        match = normalized.match(/^(\\d+)\\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months|y|yr|yrs|year|years)\\s+ago$/i);
        if (!match) return null;
        if (node && isContentBodyContainer(node)) return null;

        const unit = match[2].toLowerCase();
        let translatedUnit = "";
        if (/^(?:s|sec)/.test(unit)) translatedUnit = "秒前";
        else if (/^(?:m$|min)/.test(unit)) translatedUnit = "分钟前";
        else if (/^(?:h|hr|hour)/.test(unit)) translatedUnit = "小时前";
        else if (/^(?:d|day)/.test(unit)) translatedUnit = "天前";
        else if (/^(?:w|wk|week)/.test(unit)) translatedUnit = "周前";
        else if (/^mo/.test(unit)) translatedUnit = "个月前";
        else if (/^(?:y|yr|year)/.test(unit)) translatedUnit = "年前";
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

    function getAutomationScheduleTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^(Daily|Weekly|Monthly|每[天周月])\\s+(?:around|at|在)\\s+(.+)$/i);
        if (match) {
            const freqMap = {
                daily: "每天",
                weekly: "每周",
                monthly: "每月",
                "每天": "每天",
                "每周": "每周",
                "每月": "每月"
            };
            const freq = freqMap[match[1].toLowerCase()] || match[1];
            return freq + "在 " + match[2];
        }
        match = normalized.match(/^Weekly\\s+on\\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\s+(?:around|at|在)\\s+(.+)$/i);
        if (match) {
            const dayMap = {
                monday: "星期一", tuesday: "星期二", wednesday: "星期三",
                thursday: "星期四", friday: "星期五", saturday: "星期六", sunday: "星期日"
            };
            return "每周" + (dayMap[match[1].toLowerCase()] || match[1]) + "在 " + match[2];
        }
        match = normalized.match(/^(Daily|Weekly|Monthly)\\s+(?:around|at)$/i);
        if (match) {
            const freqMap = {
                daily: "每天",
                weekly: "每周",
                monthly: "每月"
            };
            return freqMap[match[1].toLowerCase()] + "在";
        }
        match = normalized.match(/^Weekly\\s+on\\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\s+(?:around|at)$/i);
        if (match) {
            const dayMap = {
                monday: "星期一", tuesday: "星期二", wednesday: "星期三",
                thursday: "星期四", friday: "星期五", saturday: "星期六", sunday: "星期日"
            };
            return "每周" + (dayMap[match[1].toLowerCase()] || match[1]) + "在";
        }
        return null;
    }

    function getCompactCountLabelTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^(\\d+)\\s*(?:results?|个结果s?)$/i);
        if (match) return match[1] + " 个结果";

        match = normalized.match(/^(?:Comments?|评论)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
        if (match) return "评论（" + match[1] + "）";

        match = normalized.match(/^(?:Side Questions?|侧边提问)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
        if (match) return "侧边提问（" + match[1] + "）";

        match = normalized.match(/^(\\d+)\\s+(?:Side\\s+Questions?|个?侧边提问)(?:\\s*([>v›❯〉→∨˅⌄▼▽⋁↓]))?$/i);
        if (match) return match[1] + " 个侧边提问" + (match[2] ? " " + match[2] : "");

        match = normalized.match(/^View\\s+(\\d+)\\s+side\\s+questions?$/i);
        if (match) return "查看 " + match[1] + " 个侧边提问";

        match = normalized.match(/^[（(]\\s*(\\d+)\\s*(?:subagents?|个?\\s*子智能体s?)\\s*[)）]$/i);
        if (match) return "（" + match[1] + " 个子智能体）";

        match = normalized.match(/^(?:See all|显示全部|查看全部)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
        if (match) return "显示全部 (" + match[1] + ")";

        match = normalized.match(/^(?:Send all|全部发送|发送全部)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
        if (match) return "全部发送 (" + match[1] + ")";

        match = normalized.match(/^See\\s+(\\d+)\\s+more\\s+plugins$/i);
        if (match) return "查看另外 " + match[1] + " 个插件";

        match = normalized.match(/^See\\s+(\\d+)\\s+more$/i);
        if (match) return "查看另外 " + match[1] + " 项";

        match = normalized.match(/^(\\d+)\\s+accounts$/i);
        if (match) return match[1] + " 个账号";

        match = normalized.match(/^(?:Show\\s+submitted|显示已提交)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
        if (match) return "显示已提交 (" + match[1] + ")";

        match = normalized.match(/^(?:Show\\s+more|显示更多)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
        if (match) return "显示更多 (" + match[1] + ")";

        match = normalized.match(/^(\\+)?\\s*(\\d+)\\s+more\\s+lines?$/i);
        if (match) return (match[1] ? match[1] : "") + match[2] + " 行代码";
        return null;
    }

    function getLiveStatusTranslation(value) {
        if (!value) return null;
        const normalized = norm(value).replace(/[\\u200B-\\u200D\\uFEFF]/g, '');
        if (/^Working(?:\\s*\\.){1,3}$/i.test(normalized) || /^Working\\s*…$/i.test(normalized) || /^(?:处理中|工作中)(?:(?:\\s*\\.)|(?:\\s*…))+$/i.test(normalized)) {
            return "工作中...";
        }
        if (/^Working$/i.test(normalized)) {
            return "工作中";
        }
        if (/^Compacting(?:\\s*\\.){1,3}$/i.test(normalized) || /^Compacting\\s*…$/i.test(normalized) || /^(?:压缩中|正在压缩)(?:(?:\\s*\\.)|(?:\\s*…))+$/i.test(normalized)) {
            return "正在压缩...";
        }
        if (/^Compacting$/i.test(normalized)) {
            return "正在压缩";
        }
        return null;
    }

    function getWorkingStatusTranslation(value) {
        return getLiveStatusTranslation(value);
    }

    function getExecutionTimingTranslation(value) {
        if (!value) return null;
        const valNorm = norm(value);
        const durationMatch = valNorm.match(/^(Worked for|Stopped after)\\s+([\\d\\w\\s,.]+?)(?:\\s*[>›])?\\s*$/i);
        if (!durationMatch) return null;

        const action = durationMatch[1].toLowerCase();
        let actionStr = "工作了 ";
        if (action === "stopped after") actionStr = "在 ";

        let durationStr = durationMatch[2]
            .replace(/(\\d+)\\s*d(?:ays?)?/gi, (m, n) => n + " 天 ")
            .replace(/(\\d+)\\s*h(?:ours?)?/gi, (m, n) => n + " 小时 ")
            .replace(/([\\d\\.]+)\\s*ms/gi, (m, n) => n + " 毫秒 ")
            .replace(/(\\d+)\\s*m(?:in(?:ute)?s?)?(?![a-z])/gi, (m, n) => n + " 分钟 ")
            .replace(/([\\d\\.]+)\\s*s(?:ec(?:ond)?s?)?/gi, (m, n) => n + " 秒 ")
            .replace(/,/g, "")
            .replace(/\\s+/g, " ")
            .trim();

        if (action === "stopped after") {
            return "在 " + durationStr + " 后停止";
        } else {
            return actionStr + durationStr;
        }
    }

    function getSearchingStatusTranslation(value) {
        if (!value) return null;
        const normalized = norm(value).replace(/[\\u200B-\\u200D\\uFEFF]/g, '');
        if (/^Searching(?:\\s*\\.){1,3}$/i.test(normalized) || /^Searching\\s*…$/i.test(normalized) || /^Searching\\s*\\.{3,}$/i.test(normalized) || /^Searching$/i.test(normalized)) {
            return "正在搜索...";
        }
        if (/^No\\s+suggestions(?:\\.|\\b)/i.test(normalized)) {
            return "无建议";
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
        let match = normalized.match(/^You have hit your weekly limit, it refreshes in (.+?)\\. If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier\\.?$/i);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，将在 " + duration + "后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度，或升级到更高等级的套餐";
            }
        }

        match = normalized.match(/^You have hit your weekly limit, the 5-hour limit does not currently apply\\. Your weekly limit will fully refresh in (.+?)\\.?$/i);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，因此当前不适用 5 小时配额限制。您的每周配额将在 " + duration + "后完全刷新";
            }
        }

        match = normalized.match(/^您已达到每周配额限制，将在 (.+?)后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度，或升级到更高等级的套餐。?$/);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，将在 " + duration + "后刷新。如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度，或升级到更高等级的套餐";
            }
        }

        match = normalized.match(/^您已达到每周配额限制，因此当前不适用 5 小时配额限制。您的每周配额将在 (.+?)后完全刷新。?$/);
        if (match) {
            const duration = getQuotaDurationTranslation(match[1]);
            if (duration) {
                return "您已达到每周配额限制，因此当前不适用 5 小时配额限制。您的每周配额将在 " + duration + "后完全刷新";
            }
        }
        return null;
    }

    function getBoundedTextContent(element, maxNodes = 32, maxLen = 1600) {
        if (!element) return null;
        let out = '';
        let count = 0;
        const visit = (n) => {
            if (++count > maxNodes) return false;
            if (n.nodeType === Node.TEXT_NODE) {
                out += n.nodeValue || '';
                return out.length <= maxLen;
            }
            const ch = n.childNodes;
            if (ch) {
                for (let i = 0; i < ch.length; i++) {
                    if (!visit(ch[i])) return false;
                }
            }
            return true;
        };
        return visit(element) ? out : null;
    }

    const SKILL_PATH_REGEX = /(?:^|[\\\\s])(?:\\\\.{2,3})?[^\\\\s]+[\\\\/\\\\]skills[\\\\/\\\\][^\\\\s]+/i;

    function hasElementSkillPath(el) {
        let entry = skillContextCache.get(el);
        const childCount = el.childNodes ? el.childNodes.length : 0;
        const firstVal = el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE ? el.firstChild.nodeValue : '';
        if (entry && entry.childCount === childCount && entry.firstVal === firstVal) {
            return entry.result;
        }
        const text = getBoundedTextContent(el, 16, 400);
        const result = text === null
            ? null
            : ((text.includes('skills') || text.includes('Skills')) && SKILL_PATH_REGEX.test(text));
        skillContextCache.set(el, { childCount, firstVal, result });
        return result;
    }

    function isInSkillItemContext(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return false;
        const val = norm(node.nodeValue);
        if (!val || val.length > 40 || /[,.?!:，。？！：]/.test(val)) return false;
        let current = node.parentElement;
        for (let depth = 0; current && depth < 4; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.children && current.children.length > 6) break;
            const res = hasElementSkillPath(current);
            if (res === null) break;
            if (res === true) return true;
            current = current.parentElement || (current.getRootNode?.().host ?? null);
        }
        return false;
    }

    function markThoughtContentSibling(node) {
        if (!node) return;
        try {
            let curr = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            for (let depth = 0; depth < 3 && curr; depth++) {
                if (curr === document.body || curr === document.documentElement) break;
                const tag = curr.tagName ? curr.tagName.toUpperCase() : '';
                if (tag === 'DETAILS') {
                    for (const child of curr.children) {
                        if (child.tagName !== 'SUMMARY') {
                            child.setAttribute(SKIP_TRANSLATION_ATTR, 'true');
                        }
                    }
                    blockedCacheVersion++;
                    return;
                }
                if (depth === 0 || tag === 'SPAN' || tag === 'BUTTON' || tag === 'SUMMARY') {
                    curr.setAttribute('data-ag-thought-header', 'true');
                    blockedCacheVersion++;
                }
                const next = curr.nextElementSibling;
                const prev = curr.previousElementSibling;
                if ((next && next.tagName && next.tagName.toUpperCase() === 'SVG') ||
                    (prev && prev.tagName && prev.tagName.toUpperCase() === 'SVG')) {
                    if (curr.parentElement && curr.parentElement !== document.body) {
                        curr.parentElement.setAttribute('data-ag-thought-header', 'true');
                        blockedCacheVersion++;
                    }
                }
                const parent = curr.parentElement;
                if (next && parent && parent.children.length === 2 && curr === parent.firstElementChild) {
                    const nextTag = next.tagName ? next.tagName.toUpperCase() : '';
                    if (nextTag === 'DIV' || nextTag === 'SECTION') {
                        curr.setAttribute('data-ag-thought-header', 'true');
                        next.setAttribute(SKIP_TRANSLATION_ATTR, 'true');
                        blockedCacheVersion++;
                        return;
                    }
                }
                curr = parent;
            }
        } catch (e) {}
    }

    function isIsolatedUiControlLabel(node, word, originalVal) {
        if (!node) return false;
        if (!/^[a-zA-Z]+$/.test(word)) return true;
        if (typeof originalVal === 'string' && originalVal.trim() !== word) return false;

        let curr = node.parentElement;
        for (let depth = 0; curr && depth < 4; depth++) {
            const testId = curr.getAttribute ? curr.getAttribute('data-testid') : null;
            if (testId === 'user-input-step' || testId === 'agent-message' || testId === 'agent-response') {
                return false;
            }
            const cls = curr.className;
            if (typeof cls === 'string' && cls.length > 0) {
                if (/(?:prose|markdown)/i.test(cls)) {
                    return false;
                }
                if (/(?:badge|pill|tag|chip|status|rounded|border)/i.test(cls)) {
                    return true;
                }
            }
            const tag = curr.tagName ? curr.tagName.toUpperCase() : '';
            if (tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'CODE' || tag === 'ARTICLE') {
                return false;
            }
            if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'OPTION' || tag === 'LABEL' || tag === 'TH') {
                return true;
            }
            const role = curr.getAttribute ? curr.getAttribute('role') : null;
            if (role === 'button' || role === 'tab' || role === 'menuitem' || role === 'switch' || role === 'option') {
                return true;
            }
            if (depth === 0 && curr.childNodes && curr.childNodes.length > 3) {
                return false;
            }
            curr = curr.parentElement;
        }
        return true;
    }

    function isContentBodyContainer(node) {
        if (!node) return false;
        let curr = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; curr && depth < 6; depth++) {
            if (curr === document.body || curr === document.documentElement) break;
            const cls = curr.className;
            if (typeof cls === 'string' && /(?:prose|markdown)/i.test(cls)) {
                return true;
            }
            const testId = curr.getAttribute ? curr.getAttribute('data-testid') : null;
            if (testId === 'user-input-step' || testId === 'agent-message' || testId === 'agent-response') {
                return true;
            }
            const tag = curr.tagName ? curr.tagName.toUpperCase() : '';
            if (tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'CODE' || tag === 'ARTICLE') {
                return true;
            }
            curr = curr.parentElement;
        }
        return false;
    }

    function isUptimeDurationContext(node) {
        if (!node) return false;
        let curr = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; curr && depth < 3; depth++) {
            if (curr === document.body || curr === document.documentElement) break;
            const prev = curr.previousElementSibling;
            if (prev) {
                const prevText = getBoundedTextContent(prev, 8, 80);
                if (prevText && /(?:运行时长|Uptime|时长|Duration)/i.test(prevText)) return true;
            }
            const parent = curr.parentElement;
            if (parent) {
                const text = getBoundedTextContent(parent, 12, 120);
                if (text && /(?:运行时长|Uptime)/i.test(text) && text.length < 80) return true;
            }
            curr = curr.parentElement;
        }
        return false;
    }

    function isTimestampContext(node) {
        if (!node) return false;
        let curr = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; curr && depth < 4; depth++) {
            if (curr === document.body || curr === document.documentElement) break;
            const tag = curr.tagName ? curr.tagName.toUpperCase() : '';
            if (tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'CODE' || tag === 'ARTICLE') return false;
            const cls = curr.className;
            if (typeof cls === 'string' && /(?:prose|markdown)/i.test(cls)) return false;
            if (tag === 'TIME' || curr.hasAttribute?.('datetime')) return true;
            const meta = [curr.className, curr.getAttribute?.('data-testid'), curr.getAttribute?.('aria-label'), curr.getAttribute?.('title')].filter(Boolean).join(' ');
            if (/(?:^|[-_\\s])(?:time|timestamp|date|muted|secondary|caption)(?:[-_\\s]|$)|(?:^|\\s)text-xs(?:\\s|$)/i.test(meta)) return true;
            curr = curr.parentElement;
        }
        return false;
    }

    // 0 = unblocked, 1 = soft-blocked (user-input-step / contenteditable / monaco-editor outer),
    // 2 = hard-blocked (SKIP_TRANSLATION_ATTR / BLOCKED_TAGS / view-lines / terminal: zero subtree work)
    function getElementBlockedState(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return 0;
        const cached = blockedZoneCache.get(el);
        if (cached !== undefined) {
            if (cached === -1) return 2;
            if (cached === blockedCacheVersion) return 0;
            if (cached === -blockedCacheVersion) return 1;
        }

        if (el.hasAttribute(SKIP_TRANSLATION_ATTR)) {
            blockedZoneCache.set(el, -1);
            return 2;
        }
        const role = el.getAttribute('role');
        if (role === 'tree' || role === 'treeitem') {
            blockedZoneCache.set(el, -1);
            return 2;
        }
        const prev = el.previousElementSibling;
        if (prev && prev.hasAttribute('data-ag-thought-header') && el.parentElement && el.parentElement.children.length === 2) {
            el.setAttribute(SKIP_TRANSLATION_ATTR, 'true');
            blockedZoneCache.set(el, -1);
            return 2;
        }

        const tag = el.tagName ? el.tagName.toUpperCase() : '';
        if (tag && BLOCKED_TAGS_SET.has(tag)) {
            blockedZoneCache.set(el, -1);
            return 2;
        }
        if (tag === 'NAV' && el.getAttribute('aria-label') === 'File path breadcrumbs') {
            blockedZoneCache.set(el, -1);
            return 2;
        }

        const testId = el.getAttribute('data-testid');
        const prevTestId = prev ? prev.getAttribute?.('data-testid') : null;
        if (testId === 'file-title-name' || prevTestId === 'file-title-name' || prevTestId === 'file-tree-node-icon') {
            blockedZoneCache.set(el, -1);
            return 2;
        }

        const tabId = el.getAttribute('data-tab-id');
        if (tabId && /^(?:file|directory|artifact|bgtask)__.+/i.test(tabId)) {
            blockedZoneCache.set(el, -1);
            return 2;
        }

        const className = el.className || '';
        if (typeof className === 'string' && className.length > 0) {
            if (HARD_PRUNED_CLASS_REGEX.test(className)) {
                blockedZoneCache.set(el, -1);
                return 2;
            }
            if (className === 'whitespace-nowrap truncate' && prev && prev.className === 'shrink-0 h-4 w-4 flex items-center justify-center') {
                blockedZoneCache.set(el, -1);
                return 2;
            }
        }

        let ownSoftBlocked = false;
        if (BLOCKED_TEST_IDS.has(testId) || el.getAttribute('contenteditable') === 'true') {
            ownSoftBlocked = true;
        } else if (typeof className === 'string' && className.length > 0) {
            for (let i = 0; i < BLOCKED_CLASSES.length; i++) {
                if (className.includes(BLOCKED_CLASSES[i])) {
                    ownSoftBlocked = true;
                    break;
                }
            }
        }

        const parent = el.parentElement || (el.parentNode && el.parentNode.host);
        const parentState = parent ? getElementBlockedState(parent) : 0;
        if (parentState === 2) {
            blockedZoneCache.set(el, -1);
            return 2;
        }
        const finalState = (ownSoftBlocked || parentState === 1) ? 1 : 0;
        blockedZoneCache.set(el, finalState === 1 ? -blockedCacheVersion : blockedCacheVersion);
        return finalState;
    }

    function isInBlockedZone(node) {
        if (!node) return false;
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (getElementBlockedState(el) !== 0) return true;
        if (node.nodeType === Node.TEXT_NODE && isInSkillItemContext(node)) return true;
        return false;
    }

    // Folder is a product label only in the Add Context menu, alongside these
    // fixed actions. Never add this generic word to the global dictionary.
    function translateAttachmentMenuFolder(node, value) {
        if (norm(value) !== 'Folder') return false;
        const label = node.parentElement;
        if (!label || label.tagName !== 'SPAN' || label.childNodes.length !== 1) return false;
        const row = label.parentElement;
        const group = row?.parentElement;
        if (row?.getAttribute('role') !== 'menuitem' || group?.getAttribute('role') !== 'group') return false;
        const menu = group.closest('[role="menu"]');
        if (!menu || isInBlockedZone(menu)) return false;
        const heading = Array.from(group.children).find(element =>
            element.getAttribute('role') !== 'menuitem' && /^(?:Add Context|添加上下文)$/.test(norm(element.textContent)));
        if (!heading) return false;
        const labels = Array.from(group.children)
            .filter(element => element.getAttribute('role') === 'menuitem')
            .flatMap(element => Array.from(element.children)
                .filter(child => child.tagName === 'SPAN' && child.childNodes.length === 1)
                .map(child => norm(child.textContent)));
        if (![['Media', '媒体'], ['Mentions', '提及'], ['Actions', '操作']]
            .every(variants => variants.some(text => labels.includes(text)))) return false;
        replaceTextNode(node, '文件夹');
        return true;
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

        const linesMatch = normalized.match(/^(\\+)?\\s*(\\d+)\\s+more\\s+lines?$/i);
        if (linesMatch) {
            let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            let inTerminal = false;
            let inCodeLine = false;
            while (current) {
                if (current.nodeType === Node.ELEMENT_NODE) {
                    const className = typeof current.className === 'string' ? current.className : '';
                    if (className.includes('terminal') || className.includes('xterm') || className.includes('output-view') || className.includes('debug-console')) inTerminal = true;
                    if (className.includes('view-line')) inCodeLine = true;
                }
                current = current.parentElement || (current.parentNode && current.parentNode.host);
            }
            if (!inTerminal && !inCodeLine) {
                return (linesMatch[1] ? linesMatch[1] : "") + linesMatch[2] + " 行代码";
            }
        }

        if (!/^(?:Searching|No\\b|\\.|…|正在搜索)/i.test(normalized)) return null;

        let searchingContainer = null;
        let p = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        for (let depth = 0; p && depth < 4; depth++) {
            const pRaw = getBoundedTextContent(p, 12, 120);
            if (pRaw === null) break;
            const pText = norm(pRaw);
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
                if (/^(?:just\\s+now|刚刚|\\d+\\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|wks?|weeks?|mos?|months?|yrs?|years?)\\s+ago|\\d+\\s*(?:s|m|h|d|w|mo|yr|y)\\s+ago|\\d+\\s*(?:秒|分钟|小时|天|周|个月|年)前)$/i.test(text) || /^\\d+\\s*(?:s|m|h|d|w|mo|yr|y)$/.test(text)) {
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

        let match = normalized.match(/^Are you sure you want to delete(?:\\s+the scheduled task)?\\s+(.+?)\\?\\s*(?:This action cannot be undone\\.?|此操作无法撤销。?)$/i);
        if (match) return "您确定要删除任务 " + match[1] + " 吗？此操作无法撤销";

        match = normalized.match(/^Are you sure you want to delete(?:\\s+the scheduled task)?(?:\\s+(.+))?$/i);
        if (match) return "您确定要删除任务" + (match[1] ? " " + match[1] : " ");

        if (/^\\?\\s*(?:This action cannot be undone\\.?|此操作无法撤销。?)?$/i.test(normalized)) {
            return /(?:This action cannot be undone|此操作无法撤销)/i.test(normalized)
                ? " 吗？此操作无法撤销"
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
        for (let depth = 0; current && depth < 4; depth++) {
            if (current === document.body || current === document.documentElement) break;
            let sibling = current.previousSibling;
            let steps = 0;
            while (sibling && ++steps <= 8) {
                if (sibling.nodeType !== Node.ELEMENT_NODE || !sibling.children || sibling.children.length <= 6) {
                    const found = findLastTextNode(sibling);
                    if (found) return found;
                }
                sibling = sibling.previousSibling;
            }
            const parent = current.parentNode || current.host || null;
            if (parent && parent.children && parent.children.length > 10) break;
            current = parent;
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
    const EXPLORED_HEADER_REGEX = new RegExp('^(?:(Explored)\\\\s+)?(.+?)(\\\\s*' + EXPLORED_STATUS_SUFFIX + ')?\\\\s*$', 'i');
    const EXPLORED_SUFFIX_REGEX = new RegExp('^(.+?)(\\\\s*' + EXPLORED_STATUS_SUFFIX + ')?\\\\s*$', 'i');
    const STATUS_ITEM_REGEX = new RegExp('^(files?|folders?|pages?|search(?:es)?|tasks?|commands?|tools?|rules?|repos(?:itories)?|images?|actions?)(\\\\s*,\\\\s*|\\\\s*' + EXPLORED_STATUS_SUFFIX + ')?$', 'i');

    function isCollapsibleActivityHeader(str) {
        if (!str || typeof str !== 'string') return false;
        const trimmed = str.trim();
        if (trimmed.length > 160) return false;
        if (!/^(?:Thought|Thinking|Explored|Exploring|Ran|Running|Edited|Editing)\\b/i.test(trimmed)) return false;

        if (/^(?:Thought for|Thinking for)\\s+[\\d\\w\\s,.<]+?(?:\\s*[>v›❯〉→∨˅⌄▼▽⋁↓])?\\s*$/i.test(trimmed)) {
            return true;
        }
        if (/^Thinking(?:(?:\\s*\\.)|(?:\\s*…))*\\s*$/i.test(trimmed)) {
            return true;
        }

        const match = trimmed.match(EXPLORED_HEADER_REGEX);
        if (match) {
            const rawContent = match[2].trim().replace(/,\\s*$/, '');
            const items = rawContent.split(/\\s*,\\s*/);
            let countedValid = true;
            for (const item of items) {
                const itemMatch = item.trim().match(/^(?:(explored|ran|run|executed|edited)\\s+)?(\\d+)\\s+(files?|folders?|pages?|search(?:es)?|tasks?|commands?|tools?|rules?|repos(?:itories)?|images?|actions?|artifacts?)$/i);
                if (!itemMatch) {
                    countedValid = false;
                    break;
                }
            }
            if (countedValid && items.length > 0) return true;
        }

        const suffixMatch = trimmed.match(EXPLORED_SUFFIX_REGEX);
        if (!suffixMatch) return false;
        const clauseSource = suffixMatch[1].trim().replace(/,\\s*$/, '');
        const clauses = clauseSource.split(/\\s*,\\s*/);
        let hasNoun = false;

        for (const clause of clauses) {
            const c = clause.trim();
            let cm = c.match(/^(Exploring|Explored)(?:\\s+(files?|artifacts?))?$/i);
            if (cm) {
                if (cm[2]) hasNoun = true;
                continue;
            }
            cm = c.match(/^(Running|Ran)\\s+(commands?)$/i);
            if (cm) {
                hasNoun = true;
                continue;
            }
            cm = c.match(/^(Editing|Edited)(?:\\s+(files?|artifacts?))?$/i);
            if (cm) {
                if (cm[2]) hasNoun = true;
                continue;
            }
            return false;
        }

        if (clauses.length === 0 || (clauses.length === 1 && !hasNoun && !suffixMatch[2])) {
            return false;
        }
        return true;
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
            source: 'compact',
            display: "压缩会话",
            descriptions: [
                "Compact the conversation now (summarize history to free up the context window).",
                "Compact the conversation now (summarize history to free up the context window)",
                "立即压缩会话（总结历史记录以释放上下文窗口）。",
                "立即压缩会话（总结历史记录以释放上下文窗口）"
            ]
        },
        {
            source: 'btw',
            display: "快速提问",
            descriptions: [
                'Ask a quick question without interrupting the main conversation.',
                "在不中断主会话的情况下快速提问"
            ]
        },
        {
            source: 'grill-me',
            display: "方案访谈",
            descriptions: [
                'Interview me to align on a plan',
                'Interview me to align on a plan.',
                "通过访谈与我对齐方案"
            ]
        },
        {
            source: 'teamwork',
            display: "团队协作",
            descriptions: [
                'Invoke a team of agents to autonomously tackle large projects',
                'Invoke a team of agents to autonomously tackle large projects.',
                "调用智能体团队自主应对大型项目",
                "调用智能体团队自主应对大型项目."
            ]
        },
        {
            source: 'learn',
            display: "复盘学习",
            descriptions: [
                'Reflect on recent successes or corrections to capture reusable skills or rules.',
                "反思最近的成功或改进，以捕获可复用的技能或规则"
            ]
        },
        {
            source: 'boost',
            display: "多智能体编排",
            descriptions: [
                'Invoke the Boost multi-agent orchestrator for complex tasks',
                'Invoke the Boost multi-agent orchestrator for complex tasks.',
                "调用 Boost 多智能体编排器处理复杂任务"
            ]
        },
        {
            source: 'agy-customizations',
            display: "Antigravity 个性化定制",
            descriptions: [
                'Comprehensive guide and reference for the Antigravity Customization System.',
                "Antigravity 个性化定制系统的综合指南与参考资料"
            ]
        },
        {
            source: 'antigravity-guide',
            display: "Antigravity 使用指南",
            descriptions: [
                'Provides a comprehensive guide, quick reference, and sitemap for Google Antigravity (AGY), including the Antigravity CLI (agy), Antigravity 2.0, Antigravity IDE, Python SDK, slash commands, keybindings, and customizations (skills, rules, MCP, sidecars).',
                "为 Google Antigravity（AGY）提供全面指南、快速参考和网站地图，涵盖 Antigravity CLI（agy）、Antigravity 2.0、Antigravity IDE、Python SDK、斜杠命令、快捷键及个性化定制（技能、规则、MCP 和 Sidecar）"
            ]
        },
        {
            source: 'generative_ui',
            display: "生成式界面",
            descriptions: [
                'How to render rich interactive HTML widgets inline in the chat or as standalone artifacts. Use this skill when you want to show the user diagrams, data visualizations, interactive controls, educational walkthroughs, or any rich visual content beyond plain text and markdown.',
                "介绍如何在会话中以内嵌方式呈现丰富的交互式 HTML 小组件，或将其作为独立交付件呈现。当您需要向用户展示图示、数据可视化、交互控件、教学演示，或任何超出纯文本和 Markdown 范畴的丰富可视化内容时，请使用此技能"
            ]
        },
        {
            source: 'migrate-workflows',
            display: "迁移工作流",
            descriptions: [
                'Automatically migrate legacy workflows to modern skills across global and workspace configurations. Scans for existing workflows, creates target SKILL.md files, and safely archives old workflow files.',
                'Automatically migrate legacy workflows to modern skills across global and workspace configurations.',
                "自动跨全局和工作区配置将旧版工作流迁移至现代技能。扫描现有工作流，创建目标 SKILL.md 文件，并安全归档旧工作流文件",
                "自动跨全局和工作区配置将旧版工作流迁移至现代技能"
            ]
        },
        {
            source: 'run-workflow',
            display: "运行工作流",
            descriptions: [
                "How to write and run a dynamic workflow script with the \`run_workflow\` tool: a Python script that orchestrates many agents with \`agent\`, \`parallel\`, \`pipeline\`, and \`phase\`. Use when a task splits into many independent or staged pieces of agent work (fan out over files, modules, bugs, or review angles, then aggregate), or when the user asks for a workflow. Don't use for a single delegated task (use a subagent) or for legacy workflow files (see migrate-workflows).",
                "How to write and run a dynamic workflow script with the run_workflow tool: a Python script that orchestrates many agents with agent, parallel, pipeline, and phase. Use when a task splits into many independent or staged pieces of agent work (fan out over files, modules, bugs, or review angles, then aggregate), or when the user asks for a workflow. Don't use for a single delegated task (use a subagent) or for legacy workflow files (see migrate-workflows).",
                "How to write and run a dynamic workflow script with the \`run_workflow\` tool",
                "How to write and run a dynamic workflow script with the run_workflow tool",
                "如何使用 \`run_workflow\` 工具编写并运行动态工作流脚本: 一个通过 \`agent\`、\`parallel\`、\`pipeline\` 与 \`phase\` 编排多个智能体的 Python 脚本. 当任务拆分为多个独立或分阶段的智能体工作项(跨文件、模块、Bug 或审查视角扇出，随后聚合)，或当用户要求使用工作流时使用. 请勿用于单个委派任务(请使用子智能体)或旧版工作流文件(请参阅 migrate-workflows).",
                "如何使用 \`run_workflow\` 工具编写并运行动态工作流脚本: 一个通过 \`agent\`、\`parallel\`、\`pipeline\` 与 \`phase\` 编排多个智能体的 Python 脚本",
                "如何使用 \`run_workflow\` 工具编写并运行动态工作流脚本"
            ]
        },
        {
            source: 'permissioned-github',
            display: "GitHub 权限规范",
            descriptions: [
                'Guidelines for interacting with GitHub and request permissions from the user when commands fail due to restrictions in the agent environment.',
                'Guidelines for interacting with GitHub and request permissions from the user when commands fail due to restrictions in the agent environment',
                "与 GitHub 交互的操作准则，并在命令因智能体环境限制而失败时向用户申请权限"
            ]
        },
        {
            source: 'automation',
            display: "定时自动化",
            descriptions: [
                'Interactive guide to design and create a scheduled background automation. Use this skill when the user wants to create an automated or recurring scheduled task (e.g. "summarize my emails every morning", "every Monday send me a to-do list"). Also triggered by the /automation slash command.',
                'Interactive guide to design and create a scheduled background automation.',
                'Interactive guide to design and create a scheduled background automation',
                "交互式设计并创建定时后台自动化的指引。当用户希望创建自动化或周期性计划任务（例如“每天早上汇总我的邮件”、“每周一向我发送待办清单”）时使用此技能。亦可通过 /automation 斜杠命令触发",
                "交互式设计并创建定时后台自动化的指引"
            ]
        },
        {
            source: 'plugin',
            display: "插件管理",
            descriptions: [
                "How to manage and create plugins — namespaced bundles of skills, agents, rules, MCP servers and hooks that install, enable and disable as a single unit. Use this skill when the user wants to enable, disable, install or uninstall a plugin, when they want to create a new plugin, or when a new customization should be packaged into a plugin rather than left loose. Also triggered by the /plugin slash command. Don't use for the underlying customization system itself — discovery roots, loading priority, or authoring a standalone skill, agent, rule, hook or MCP server outside a plugin; see the customizations guide skill for those.",
                "How to manage and create plugins — namespaced bundles of skills, agents, rules, MCP servers and hooks that install, enable and disable as a single unit.",
                "How to manage and create plugins -- namespaced bundles of skills, agents, rules, MCP servers and hooks that install, enable and disable as a single unit.",
                "How to manage and create plugins",
                "如何管理和创建插件 —— 作为单一单元进行安装、启用与禁用的命名空间技能、智能体、规则、MCP 服务器与钩子捆绑包。当用户希望启用、禁用、安装或卸载插件，想要创建新插件，或应当将新的个性化定制打包为插件而非单独留存时使用此技能。亦可通过 /plugin 斜杠命令触发。请勿用于底层个性化定制系统本身 —— 发现根目录、加载优先级，或在插件外部编写独立的技能、智能体、规则、钩子或 MCP 服务器；相关内容请参阅个性化定制指南技能",
                "如何管理和创建插件 —— 作为单一单元进行安装、启用与禁用的命名空间技能、智能体、规则、MCP 服务器与钩子捆绑包",
                "如何管理和创建插件"
            ]
        },
        {
            source: 'ui-extension',
            display: "UI 扩展",
            descriptions: [
                "Build, package, run, and debug UI extensions for Antigravity: interactive web panels that render in the side pane, served by a Node.js sidecar using the built-in Sidecar SDK.",
                "构建、打包、运行并调试 Antigravity 的 UI 扩展：在侧边面板中渲染的交互式 Web 面板，由使用内置 Sidecar SDK 的 Node.js Sidecar 提供服务"
            ]
        },
        {
            source: 'ui-plugin-navigation',
            display: "UI 插件导航",
            descriptions: [
                "Discover UI plugin panels relevant to the current task and surface a one-click pill in chat to open (toggle) them in the side pane. Use when a running UI plugin's panel would help with what the user is doing, or right after the user enables a new UI plugin pane and a shortcut to open it is handy.",
                "发现与当前任务相关的 UI 插件面板，并在聊天中提供一键胶囊按钮以便在侧边面板中打开（切换）它们。当运行中的 UI 插件面板对用户正在进行的操作有所帮助，或在用户启用新的 UI 插件面板且需要便捷快捷方式打开它时使用"
            ]
        },
        {
            source: 'sync-marketplace-plugins',
            display: "同步插件市场",
            descriptions: [
                "Sync, audit, and diff official Antigravity Marketplace plugins from the local cache (~/.gemini/antigravity/cache/marketplaces/antigravity-plugins-official/) against dicts/marketplace_plugins.json. Use this skill whenever an Antigravity version upgrade occurs, or when the user requests updating, auditing, or cleaning plugin marketplace translations.",
                "Sync, audit, and diff official Antigravity Marketplace plugins from the local cache",
                "同步、审计并比对官方 Antigravity 插件市场插件与插件市场专用词典。在 Antigravity 版本升级或需要更新、审计及清理插件市场汉化文案时使用此技能。",
                "同步、审计并比对官方 Antigravity 插件市场插件与插件市场专用词典",
                "从本地缓存同步、审计并比对官方 Antigravity 插件市场插件",
                "同步官方 Antigravity 插件市场本地缓存并进行审计与比对",
                "同步、审计并比对官方 Antigravity 插件市场本地缓存"
            ]
        },
        {
            source: 'research',
            display: "调研",
            descriptions: [
                "Research subagent with read-only tools for exploring the codebase, searching the web, and reading files. Delegate to this agent when you need to run a task in a separate conversation context but with the same capabilities as the current agent, when a research task requires many search and file-reading steps that would clutter your context, or when you need a broad survey of the codebase or documentation. Prefer doing research yourself for quick, targeted lookups.",
                "Research subagent with read-only tools for exploring the codebase, searching the web, and reading files.",
                "具备只读工具的调研子智能体，用于探索代码库、搜索网络和阅读文件。当您需要在独立的会话上下文中运行具有与当前智能体相同能力的任务、研究任务需要执行大量会使上下文变得混乱的搜索与文件读取步骤，或需要对代码库或文档进行广泛调研时，请委托给该智能体。对于快速、有针对性的查询，建议由主智能体自行完成",
                "具备只读工具的调研型子智能体，用于探索代码库、搜索网络和阅读文件"
            ]
        },
        {
            source: 'gcalendar',
            display: "Google 日历",
            descriptions: [
                "Read, create, and manage Google Calendar events. Use when the user shares a calendar.google.com URL, asks what is on their schedule, wants an event found, created, updated, deleted, or moved, wants to RSVP, wants free/busy or scheduling conflicts checked before proposing a time, wants focus time or an out-of-office block created, wants an event quick-added from a phrase or imported from an ICS file, or wants to know where someone is working from and which timezone they are in. Don't use for Gmail, Chat, or Tasks.",
                "Check availability, schedule events, and RSVP.",
                "Run your Google Calendar. Find a time that works for everyone, send invites, block focus time, and get briefed on your day with any conflicts flagged.",
                "读取、创建并管理 Google 日历日程. 当用户分享 calendar.google.com 链接、询问日程安排、需要查找、创建、更新、删除或移动日程、回复邀请、在提议时间前检查空闲/忙碌或日程冲突、创建专注时间或不在办公室状态块、通过短语快速添加日程或从 ICS 文件导入，或需要了解某人的工作地点及所在时区时使用. 请勿用于 Gmail、Chat 或 Google 任务.",
                "读取、创建并管理 Google 日历日程。当用户分享 calendar.google.com 链接、询问日程安排、需要查找、创建、更新、删除或移动日程、回复邀请、在提议时间前检查空闲/忙碌或日程冲突、创建专注时间或不在办公室状态块、通过短语快速添加日程或从 ICS 文件导入，或需要了解某人的工作地点及所在时区时使用。请勿用于 Gmail、Chat 或 Google 任务",
                "查看空闲情况、安排活动并回复邀请.",
                "查看空闲状态、安排日程并回复邀请.",
                "运行您的 Google Calendar。找到适合每个人的时间、发送邀请、锁定专注时间，并在标记任何冲突的情况下了解您一天的安排",
                "管理您的 Google Calendar。查找适合所有人的时间、发送邀请、预留专注时间，并获取每日日程简报及冲突提醒"
            ]
        },
        {
            source: 'gdocs',
            display: "Google 文档",
            descriptions: [
                "Read, create, edit, and manage Google Docs. Use when the user shares a docs.google.com URL, asks to summarize or extract content from a doc, wants a doc drafted, edited, formatted, or commented on, wants tables, images, or smart chips inserted, wants markdown imported or synchronized with a doc, or wants a doc exported. Requires a known document ID — to find documents, use the gdrive skill from the Google Drive plugin; if it isn't installed, ask the user for the doc link. Don't use for Google Sheets, Slides, or Drive file management.",
                "Read, draft, and edit docs.",
                "Read and write your Google Docs. Summarize any doc from its link, draft proposals and announcements in a new doc, and reply to and resolve open comments.",
                "读取、创建、编辑并管理 Google 文档. 当用户分享 docs.google.com 链接、要求总结或提取文档内容、起草、编辑、排版或评论文档、插入表格、图片或智能画布卡片、导入或同步 Markdown 到文档，或导出文档时使用. 需要已知的文档 ID —— 如需查找文档，请使用 Google Drive 插件中的 gdrive 技能; 若尚未安装，请向用户索取文档链接. 请勿用于 Google 表格、幻灯片或云端硬盘文件管理.",
                "读取、创建、编辑并管理 Google 文档。当用户分享 docs.google.com 链接、要求总结或提取文档内容、起草、编辑、排版或评论文档、插入表格、图片或智能画布卡片、导入或同步 Markdown 到文档，或导出文档时使用。需要已知的文档 ID —— 如需查找文档，请使用 Google Drive 插件中的 gdrive 技能；若尚未安装，请向用户索取文档链接。请勿用于 Google 表格、幻灯片或云端硬盘文件管理",
                "读取、起草和编辑文档.",
                "阅读、起草和编辑文档.",
                "读写您的 Google Docs. 通过链接总结任意文档，在新文档中起草提案与公告，以及回复并解决未处理的评论.",
                "阅读并编写您的 Google Docs. 通过链接总结任何文档、在新建文档中起草方案和公告，并回复和解决未结评论."
            ]
        },
        {
            source: 'gdrive',
            display: "Google 云端硬盘",
            descriptions: [
                "Browse, search, and manage Google Drive files and folders. Use when the user shares a drive.google.com URL, asks what is in a folder, wants a file found, downloaded, uploaded, updated in place, moved, copied, or renamed, wants a Google file exported to PDF, Markdown, or CSV, wants comments read or added, wants sharing and permissions checked or changed, or wants Drive activity watched. Don't use for editing the contents of a Doc, Sheet, or Slides deck.",
                "Search, upload, download, and share files.",
                "Find and organize your Google Drive. Search across your files, tidy up folders, share them with the right people, and download or export them as PDF, CSV, or Markdown.",
                "浏览、搜索并管理 Google 云端硬盘文件和文件夹. 当用户分享 drive.google.com 链接、询问文件夹中的内容、需要查找、下载、上传、就地更新、移动、复制或重命名文件、将 Google 文件导出为 PDF、Markdown 或 CSV、读取或添加评论、检查或更改共享权限，或监控云端硬盘动态时使用. 请勿用于编辑文档、表格或幻灯片的内容.",
                "浏览、搜索并管理 Google 云端硬盘文件和文件夹。当用户分享 drive.google.com 链接、询问文件夹中的内容、需要查找、下载、上传、就地更新、移动、复制或重命名文件、将 Google 文件导出为 PDF、Markdown 或 CSV、读取或添加评论、检查或更改共享权限，或监控云端硬盘动态时使用。请勿用于编辑文档、表格或幻灯片的内容",
                "搜索、上传、下载和共享文件.",
                "查找并整理您的 Google Drive。跨文件进行搜索、整理文件夹、与合适的人共享，并将其下载或导出为 PDF、CSV 或 Markdown",
                "查找并整理您的 Google Drive。跨文件搜索、整理文件夹、与合适的人员共享，以及将文件下载或导出为 PDF、CSV 或 Markdown"
            ]
        },
        {
            source: 'gsheets',
            display: "Google 表格",
            descriptions: [
                "Read, write, format, and manage Google Sheets. Use when the user shares a sheets.google.com or docs.google.com/spreadsheets URL, asks to read or summarize spreadsheet data, wants cells written, formatted, sorted, merged, or validated, wants rows/columns inserted or deleted, wants charts, pivot tables, or tables added, wants CSV imported, or wants a spreadsheet created, copied, shared, or exported. Don't use for Google Docs, Slides, or Drive file management.",
                "Read, write, and format spreadsheets.",
                "Read, write, and format your Google Sheets. Fill in formulas, sort and clean columns, import CSVs, build charts and pivot tables, and export the result.",
                "读取、编写、格式化并管理 Google 表格. 当用户分享 sheets.google.com 或 docs.google.com/spreadsheets 链接、要求读取或总结电子表格数据、需要写入、格式化、排序、合并或验证单元格、插入或删除行/列、添加图表、数据透视表或表格、导入 CSV，或创建、复制、共享或导出电子表格时使用. 请勿用于 Google 文档、幻灯片或云端硬盘文件管理.",
                "读取、编写、格式化并管理 Google 表格。当用户分享 sheets.google.com 或 docs.google.com/spreadsheets 链接、要求读取或总结电子表格数据、需要写入、格式化、排序、合并或验证单元格、插入或删除行/列、添加图表、数据透视表或表格、导入 CSV，或创建、复制、共享或导出电子表格时使用。请勿用于 Google 文档、幻灯片或云端硬盘文件管理",
                "读取、编写和格式化电子表格.",
                "阅读、编写和格式化电子表格.",
                "读写并格式化您的 Google Sheets。填充公式、排序和清理列、导入 CSV、构建图表与数据透视表，并导出结果",
                "阅读、编写和格式化您的 Google Sheets。填充公式、对列进行排序和清洗、导入 CSV、构建图表和数据透视表，并导出结果"
            ]
        },
        {
            source: 'gslides',
            display: "Google 幻灯片",
            descriptions: [
                "Read, create, and edit Google Slides presentations. Use when creating presentations, when the user shares a slides.google.com URL, asks to summarize or extract content from a deck, wants slides drafted or updated, or wants a presentation exported. Don't use for Google Docs, Sheets, or Drive file management.",
                "Read, edit, and export presentations.",
                "Build and polish your Google Slides. Turn notes into a deck, add slides, images, and speaker notes, and export the result to PDF or PowerPoint.",
                "读取、创建并编辑 Google 幻灯片演示文稿. 在创建演示文稿、用户分享 slides.google.com 链接、要求总结或提取演示文稿内容、起草或更新幻灯片，或导出演示文稿时使用. 请勿用于 Google 文档、表格或云端硬盘文件管理.",
                "读取、创建并编辑 Google 幻灯片演示文稿。在创建演示文稿、用户分享 slides.google.com 链接、要求总结或提取演示文稿内容、起草或更新幻灯片，或导出演示文稿时使用。请勿用于 Google 文档、表格或云端硬盘文件管理",
                "读取、编辑和导出演示文稿.",
                "阅读、编辑和导出演示文稿.",
                "构建并润色您的 Google Slides。将笔记转化为演示文稿，添加幻灯片、图片和演讲者备注，并将结果导出为 PDF 或 PowerPoint",
                "构建并润色您的 Google Slides。将笔记整理成演示文稿、添加幻灯片、图片和演讲者备注，并将结果导出为 PDF 或 PowerPoint"
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
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        if (element.hasAttribute(SKIP_TRANSLATION_ATTR)) return false;
        if (BLOCKED_TEST_IDS.has(element.getAttribute('data-testid'))) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length < 2) return false;
        const entry = getSkillPickerDisplayEntry(textNodes);
        if (!entry) return false;

        if (Array.from(element.children || []).some(child => {
            return !!getSkillPickerDisplayEntry(collectTextNodes(child));
        })) return false;

        let changed = false;
        const nameNode = textNodes.find(textNode => {
            const v = norm(textNode.nodeValue);
            return v === entry.source || v === entry.display;
        });
        if (nameNode && norm(nameNode.nodeValue) === entry.source) {
            if (replaceTextNode(nameNode, entry.display)) changed = true;
        }

        for (const tn of textNodes) {
            if (tn === nameNode) continue;
            const rawVal = norm(tn.nodeValue);
            if (!rawVal || rawVal.length < 4) continue;
            const trans = map.get(rawVal) || lowerMap.get(rawVal.toLowerCase());
            if (trans && replaceTextNode(tn, trans)) {
                changed = true;
            }
        }

        return changed;
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

    function translateUsedSkillNameTextNode(node, value) {
        const normalized = norm(value);
        const entry = SKILL_PICKER_DISPLAY_ENTRIES.find(entry => entry.source === normalized);
        if (!entry) return false;

        let current = node.parentElement;
        for (let depth = 0; current && depth < 6; depth++) {
            if (current === document.body || current === document.documentElement) break;
            const text = current.textContent || '';
            if (text.length <= 2500 && /(?:Skills?\\s+Used|已使用的技能)/i.test(text)) {
                return replaceTextNode(node, entry.display);
            }
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
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0) return false;
        const original = norm(textNodes.map(textNode => textNode.nodeValue || '').join(''));
        const translated = getCompactCountLabelTranslation(original);
        if (!translated || translated === original) return false;

        const isFoldButton = /^(\\+)?\\s*\\d+\\s+more\\s+lines?$/i.test(original);
        if (!isFoldButton && (isInBlockedZone(element) || textNodes.some(textNode => isInBlockedZone(textNode)))) return false;

        if (Array.from(element.children || []).some(child => {
            return !!getCompactCountLabelTranslation(child.textContent || '');
        })) return false;

        if (textNodes.length === 1) return replaceTextNode(textNodes[0], translated);

        const countIndex = textNodes.findIndex(textNode => /^\\s*\\d+\\s*$/.test(textNode.nodeValue || ''));
        if (countIndex < 0) {
            const seeAllMatch = original.match(/^(?:See all|显示全部|查看全部)\\s*[（(]\\s*(\\d+)\\s*[)）]$/i);
            if (seeAllMatch) {
                replaceTextNode(textNodes[0], "显示全部 (" + seeAllMatch[1] + ")");
                for (let i = 1; i < textNodes.length; i++) {
                    replaceTextNode(textNodes[i], '');
                }
                return true;
            }
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
        return noticePattern.test(norm(value)) ? "可在“历史记录”中查看已归档的会话" : null;
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
                replaceTextNode(suffixNodes[0], "中查看已归档的会话");
                for (let i = 1; i < suffixNodes.length; i++) replaceTextNode(suffixNodes[i], '');
            } else {
                historyElement.parentNode.insertBefore(document.createTextNode("中查看已归档的会话"), historyElement.nextSibling);
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

            replaceTextNode(middleNodes[0], " 不存在. 请在此");
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

    function translateDuplicateProjectInlineWarning(element) {
        if (!element) return false;
        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;

        for (let depth = 0; current && depth < 4; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(current)) {
                current = current.parentElement;
                continue;
            }

            const bounded = getBoundedTextContent(current, 16, 160);
            if (!bounded) break;
            const rawText = norm(bounded);
            if (!/(?:with the same folders? exists|A similar.*exists|已存在包含相同文件夹|已存在类似)/i.test(rawText)) {
                current = current.parentElement;
                continue;
            }

            if (rawText.includes("已存在包含相同文件夹") || rawText.includes("已存在类似")) {
                return true;
            }

            const projectBtn = Array.from(current.querySelectorAll("button")).find(btn => {
                return !isInBlockedZone(btn) && /^(?:project|项目)$/i.test(norm(btn.textContent));
            });
            if (!projectBtn) {
                current = current.parentElement;
                continue;
            }

            const prefixSpan = projectBtn.previousElementSibling;
            const suffixSpan = projectBtn.nextElementSibling;
            if (!prefixSpan || !suffixSpan) {
                current = current.parentElement;
                continue;
            }

            const prefixText = norm(prefixSpan.textContent);
            const suffixText = norm(suffixSpan.textContent);

            const isSimilar = /similar/i.test(prefixText) || (/exists/i.test(suffixText) && !/folder/i.test(suffixText));
            const isMulti = /folders/i.test(suffixText);

            const newPrefix = isSimilar
                ? "已存在类似的 "
                : (isMulti ? "已存在包含相同文件夹组合的 " : "已存在包含相同文件夹的 ");

            const prefixNodes = collectTextNodes(prefixSpan);
            if (prefixNodes.length > 0) {
                replaceTextNode(prefixNodes[0], newPrefix);
                for (let i = 1; i < prefixNodes.length; i++) replaceTextNode(prefixNodes[i], "");
            }

            const btnNodes = collectTextNodes(projectBtn);
            if (btnNodes.length > 0) {
                replaceTextNode(btnNodes[0], "项目");
                for (let i = 1; i < btnNodes.length; i++) replaceTextNode(btnNodes[i], "");
            }

            const suffixNodes = collectTextNodes(suffixSpan);
            for (let i = 0; i < suffixNodes.length; i++) {
                replaceTextNode(suffixNodes[i], "");
            }

            return true;
        }
        return false;
    }

    function translateDuplicateProjectModalNotice(element) {
        if (!element) return false;
        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;

        for (let depth = 0; current && depth < 5; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(current)) {
                current = current.parentElement;
                continue;
            }

            const rawText = norm(current.textContent);
            if (!/(?:already exists for this (?:folder|combination of folders)|已存在于此文件夹中|已存在于这些文件夹组合中)/i.test(rawText) ||
                !/(?:Would you like to continue using it or make a new one\\?|您是否希望继续使用该项目)/i.test(rawText)) {
                current = current.parentElement;
                continue;
            }

            let noticeContainer = current;
            if (current.querySelector("button")) {
                const candidate = Array.from(current.querySelectorAll("div, p")).find(child => {
                    if (child.querySelector("button")) return false;
                    const childText = norm(child.textContent);
                    return /(?:already exists for this (?:folder|combination of folders)|已存在于此文件夹中|已存在于这些文件夹组合中)/i.test(childText) &&
                           /(?:Would you like to continue using it or make a new one\\?|您是否希望继续使用该项目)/i.test(childText);
                });
                if (candidate) {
                    noticeContainer = candidate;
                } else {
                    current = current.parentElement;
                    continue;
                }
            }

            const noticeText = norm(noticeContainer.textContent);
            if (noticeText.includes("已存在于此文件夹中") || noticeText.includes("已存在于这些文件夹组合中")) {
                return true;
            }

            const spans = Array.from(noticeContainer.querySelectorAll("span")).filter(s => !isInBlockedZone(s));
            if (spans.length === 0) {
                current = current.parentElement;
                continue;
            }

            const nameSpan = spans[0];
            const allTextNodes = collectTextNodes(noticeContainer);
            const nameTextNodes = collectTextNodes(nameSpan);
            if (allTextNodes.length === 0 || nameTextNodes.length === 0) {
                current = current.parentElement;
                continue;
            }

            const firstNameIndex = allTextNodes.indexOf(nameTextNodes[0]);
            const lastNameIndex = allTextNodes.indexOf(nameTextNodes[nameTextNodes.length - 1]);
            if (firstNameIndex <= 0 || lastNameIndex < firstNameIndex) {
                current = current.parentElement;
                continue;
            }

            const isMulti = /combination of folders/i.test(noticeText);
            const suffixText = isMulti
                ? " 已存在于这些文件夹组合中. 您是否希望继续使用该项目或创建一个新项目?"
                : " 已存在于此文件夹中. 您是否希望继续使用该项目或创建一个新项目?";

            const beforeNodes = allTextNodes.slice(0, firstNameIndex);
            replaceTextNode(beforeNodes[0], "项目 ");
            for (let i = 1; i < beforeNodes.length; i++) {
                replaceTextNode(beforeNodes[i], "");
            }

            const afterNodes = allTextNodes.slice(lastNameIndex + 1);
            if (afterNodes.length > 0) {
                replaceTextNode(afterNodes[0], suffixText);
                for (let i = 1; i < afterNodes.length; i++) {
                    replaceTextNode(afterNodes[i], "");
                }
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

        return "您当前计划的基础配额将于 " + refreshTime + " 刷新";
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

        match = normalized.match(/^(\\d+)\\s+(?:Side\\s+Questions?|个?侧边提问)(?:\\s*([>›❯〉→]))?$/i);
        if (match) return match[1] + " 个侧边提问" + (match[2] ? " " + match[2] : "");

        match = normalized.match(/^(\\d+)\\s+questions?$/i);
        if (match) return match[1] + " 个问题";

        match = normalized.match(/^View\\s+(\\d+)\\s+side\\s+questions?(?:\\s*([>›❯〉→]))?$/i);
        if (match) return "查看 " + match[1] + " 个侧边提问" + (match[2] ? " " + match[2] : "");

        match = normalized.match(/^Question\\s+(\\d+)\\s+of\\s+(\\d+)$/i);
        if (match) return "第 " + match[1] + " 个问题，共 " + match[2] + " 个";

        match = normalized.match(/^Side\\s+question\\s+failed:\\s*(.+)$/i);
        if (match) return "侧边提问失败：" + match[1];

        match = normalized.match(/^Side\\s+question\\s+answered\\.?$/i);
        if (match) return "侧边提问已回答";

        match = normalized.match(/^Asked\\s+(\\d+)\\s+questions?$/i);
        if (match) return "已询问 " + match[1] + " 个问题";

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

    
    function getBulletedStatusTranslation(value) {
        if (!value) return null;
        const normalized = norm(value);
        const match = normalized.match(/^([●•·◦∙○]|\\u2022|\\u25CF|\\u25CB)\\s*(Running|Completed|Failed|Stopped|In Progress|Cancelled|Canceled|Scheduled|Pending|Paused|Idle|Blocked)\\b/i);
        if (!match) return null;
        const statusKey = match[2];
        const translatedStatus = map.get(statusKey) || lowerMap.get(statusKey.toLowerCase());
        if (!translatedStatus) return null;
        return match[1] + " " + translatedStatus;
    }

function getDynamicProductUiTranslation(value) {
        const normalized = norm(value);
        let match = normalized.match(/^When toggled on,\\s+(.+?)\\s+collects usage data to help Google enhance performance and features\\.$/i);
        if (match) return "启用后，" + match[1] + " 会收集使用数据，以帮助 Google 改进性能和功能";

        match = normalized.match(/^Receive product updates, tips, and promotions from Google\\s+(.+?)\\s+via email\\.$/i);
        if (match) return "通过电子邮件接收 Google " + match[1] + " 的产品更新、使用技巧和推广信息.";

        match = normalized.match(/^When toggled on,\\s+(.+?)\\s+will use your AI credits to fulfill model requests once you're out of model quota\\.\\s+\\1\\s+will always use your model quota first before using AI credits\\.$/i);
        if (match) return "启用后，当模型配额用尽时，" + match[1] + " 将使用您的 AI 额度处理模型请求. 系统会优先使用模型配额，之后才使用 AI 额度.";

        match = normalized.match(/^(.+?)\\s+Weekly Limit(:?)$/i);
        if (match) {
            const prefix = match[1].trim();
            const isYour = /^your$/i.test(prefix);
            const colon = match[2] ? ":" : "";
            return (isYour ? "您的" : prefix + " ") + "每周配额限制" + colon;
        }

        match = normalized.match(/^(.+?)\\s+Weekly Limit Remaining(:?)$/i);
        if (match) {
            const prefix = match[1].trim();
            const isYour = /^your$/i.test(prefix);
            const colon = match[2] ? ":" : "";
            return (isYour ? "您的" : prefix + " ") + "每周配额剩余" + colon;
        }

        match = normalized.match(/^(\\d+(?:\\.\\d+)?%)\\s+left$/i);
        if (match) return match[1] + " 剩余";

        match = normalized.match(/^(.+?)\\s+(?:5-Hour|Five Hour|5h)\\s+Limit(:?)$/i);
        if (match) {
            const prefix = match[1].trim();
            const isYour = /^your$/i.test(prefix);
            const colon = match[2] ? ":" : "";
            return (isYour ? "您的" : prefix + " ") + "5 小时配额限制" + colon;
        }

        match = normalized.match(/^(.+?)\\s+(?:5-Hour|Five Hour|5h)\\s+Limit Remaining(:?)$/i);
        if (match) {
            const prefix = match[1].trim();
            const isYour = /^your$/i.test(prefix);
            const colon = match[2] ? ":" : "";
            return (isYour ? "您的" : prefix + " ") + "5 小时配额剩余" + colon;
        }

        match = normalized.match(/^Build with\\s+(.+?)\\s+Plugins$/i);
        if (match) return "使用 " + match[1] + " 插件构建";

        match = normalized.match(/^Plugins are packaged collections of skills and MCPs to help the Agent in\\s+(.+?)\\s+work with Google developer products\\. You can always change your choices in Settings\\.$/i);
        if (match) return "插件是打包的技能与 MCP 集合，用于帮助 " + match[1] + " 中的智能体使用 Google 开发者产品. 您随时可以在设置中更改选择.";

        match = normalized.match(/^Manage\\s+(project|workspace)\\s+folders, agent settings, and permissions\\.$/i);
        if (match) {
            const scope = match[1].toLowerCase() === "project" ? "项目" : "工作区";
            return "管理" + scope + "文件夹、智能体设置和权限.";
        }

        match = normalized.match(/^Agent settings and permissions for conversations outside of\\s+(projects|workspaces)\\.$/i);
        if (match) {
            const scope = match[1].toLowerCase() === "projects" ? "项目" : "工作区";
            return "用于不属于任何" + scope + "的会话的智能体设置和权限.";
        }

        match = normalized.match(/^File exceeds the (\\d+(?:\\.\\d+)?\\s*(?:[KMGTP]?B|bytes?))\\s+display limit(?:\\s*\\(([^)]+)\\))?\\.?$/i);
        if (match) {
            return "文件超过 " + match[1] + " 显示限制" + (match[2] ? " (" + match[2] + ")" : "");
        }

        match = normalized.match(/^Setting up WSL:\\s*(.+)$/i);
        if (match) return "正在设置 WSL: " + match[1];

        match = normalized.match(/^Deleted\\s+["“](.+?)["”][.。]?$/i);
        if (match) return "已删除“" + match[1] + "”";

        match = normalized.match(/^Enabled\\s+["“](.+?)["”][.。]?$/i);
        if (match) return "已启用“" + match[1] + "”";

        match = normalized.match(/^Disabled\\s+["“](.+?)["”][.。]?$/i);
        if (match) return "已禁用“" + match[1] + "”";

        match = normalized.match(/^Started\\s+["“](.+?)["”][.。]?$/i);
        if (match) return "已启动“" + match[1] + "”";

        match = normalized.match(/^Failed to start\\s+["“](.+?)["”][.。]?$/i);
        if (match) return "启动“" + match[1] + "”失败";

        match = normalized.match(/^Restarted\\s+["“](.+?)["”][.。]?$/i);
        if (match) return "已重启“" + match[1] + "”";

        match = normalized.match(/^Created\\s+(automation|scheduled task)\\s+["“](.+?)["”][.。]?$/i);
        if (match) {
            const entity = match[1].toLowerCase() === "automation" ? "自动化" : "计划任务";
            return "已创建" + entity + "“" + match[2] + "”";
        }

        match = normalized.match(/^Failed to (update|save|delete)\\s+["“](.+?)["”][.。]?$/i);
        if (match) {
            const act = match[1].toLowerCase();
            const verb = act === "update" ? "更新" : act === "save" ? "保存" : "删除";
            return verb + "“" + match[2] + "”失败";
        }

        match = normalized.match(/^(Automation|Task|Scheduled task)\\s+["“](.+?)["”]\\s+not found\\.?$/i);
        if (match) {
            const entity = match[1].toLowerCase() === "automation" ? "自动化" : "任务";
            return "未找到" + entity + "“" + match[2] + "”";
        }

        match = normalized.match(/^Agents created by this (automation|scheduled task) run in a dedicated (project|workspace) with its own permissions\\.\\s*You can change the permissions in the \\2 settings page\\.?$/i);
        if (match) {
            const entity = match[1].toLowerCase() === "automation" ? "自动化" : "计划任务";
            const scope = match[2].toLowerCase() === "project" ? "项目" : "工作区";
            return "由此" + entity + "创建的智能体会在具有独立权限的专用" + scope + "中运行. 您可以在" + scope + "设置页面中更改这些权限.";
        }

        match = normalized.match(/^Marked\\s+(\\d+)\\s+conversations?\\s+as\\s+(read|unread)[.。]?$/i);
        if (match) {
            const state = match[2].toLowerCase() === "read" ? "已读" : "未读";
            return "已将 " + match[1] + " 个会话标记为" + state;
        }

        match = normalized.match(/^All (scheduled tasks|automations) run (?:as|with the)\\s+(.+?)(?:\\s+model)?[.。]?$/i);
        if (match) {
            const entity = match[1].toLowerCase() === "automations" ? "自动化" : "计划任务";
            const model = match[2].replace(/[.。]+$/, '').trim();
            if (model) return "所有" + entity + "均以 " + model + " 模型运行";
        }

        match = normalized.match(/^(?:A|An)\\s+(automation|scheduled task)\\s+with ID\\s+(.+?)\\s+already exists\\.?$/i);
        if (match) {
            const entity = match[1].toLowerCase() === "automation" ? "自动化" : "计划任务";
            return "ID 为 " + match[2] + " 的" + entity + "已存在";
        }

        match = normalized.match(/^Domains:\\s+(.+)$/i);
        if (match) return "域名：" + match[1];

        match = normalized.match(/^Scopes:\\s+(.+)$/i);
        if (match) return "权限范围：" + match[1];

        match = normalized.match(/^Secret for a new\\s+(.+?)\\s+account$/i);
        if (match) return "用于新 " + match[1] + " 账号的密钥";

        match = normalized.match(/^Secret for\\s+(.+)$/i);
        if (match) return "用于 " + match[1] + " 的密钥";

        match = normalized.match(/^Managed by the\\s+(.+?)\\s+automation$/i);
        if (match) return "由 " + match[1] + " 自动化管理";

        // Permission options (both pure English and half-translated recovery)
        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, and always allow|是，且始终允许)(?: '(.+)')?\\s+in this project$/i);
        if (match) return match[1] ? "是，且在此项目中始终允许运行 '" + match[1] + "'" : "是，且在此项目中始终允许";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, and always allow|是，且始终允许)(?: '(.+)')?\\s+when not in a project$/i);
        if (match) return match[1] ? "是，且在不属于任何项目时始终允许运行 '" + match[1] + "'" : "是，且在不属于任何项目时始终允许";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, and always allow|是，且始终允许)(?: '(.+)')?\\s+in this workspace$/i);
        if (match) return match[1] ? "是，且在此工作区中始终允许运行 '" + match[1] + "'" : "是，且在此工作区中始终允许";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, and always allow|是，且始终允许)(?: '(.+)')?\\s+in this conversation$/i);
        if (match) return match[1] ? "是，且在此会话中始终允许运行 '" + match[1] + "'" : "是，且在此会话中始终允许";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, and always allow|是，且始终允许)\\s*'(.+)'$/i);
        if (match) return "是，且始终允许运行 '" + match[1] + "'";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, save rule|是，保存规则)(?:\\s*(?:for|用于)\\s*'(.+)')?\\s+in this project$/i);
        if (match) return match[1] ? "是，在此项目中为 '" + match[1] + "' 保存规则" : "是，在此项目中保存规则";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, save rule|是，保存规则)(?:\\s*(?:for|用于)\\s*'(.+)')?\\s+when not in a project$/i);
        if (match) return match[1] ? "是，在不属于任何项目时为 '" + match[1] + "' 保存规则" : "是，在不属于任何项目时保存规则";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, save rule|是，保存规则)(?:\\s*(?:for|用于)\\s*'(.+)')?\\s+in this workspace$/i);
        if (match) return match[1] ? "是，在此工作区中为 '" + match[1] + "' 保存规则" : "是，在此工作区中保存规则";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, save rule|是，保存规则)(?:\\s*(?:for|用于)\\s*'(.+)')?\\s+in this conversation$/i);
        if (match) return match[1] ? "是，在此会话中为 '" + match[1] + "' 保存规则" : "是，在此会话中保存规则";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, save rule|是，保存规则)(?:\\s*(?:for|用于)\\s*'(.+)')?\\s+globally$/i);
        if (match) return match[1] ? "是，全局为 '" + match[1] + "' 保存规则" : "是，全局保存规则";

        match = normalized.match(/^(?:(?:\\[\\d+\\]|\\d+[.):]?)\\s+)?(?:Yes, save rule|是，保存规则)\\s*(?:for|用于)\\s*'(.+)'$/i);
        if (match) return "是，为 '" + match[1] + "' 保存规则";

        // Permission questions
        match = normalized.match(/^(?:Save rule to always allow|保存为始终允许规则)\\s+(.+?)\\??$/i);
        if (match) {
            let act = match[1].toLowerCase();
            let actTrans = null;
            if (act === 'read access to this path') actTrans = '读取此路径';
            else if (act === 'write access to this path') actTrans = '写入此路径';
            else if (act === 'reading this url') actTrans = '读取此 URL';
            else if (act === 'executing actions on this url') actTrans = '在此 URL 上执行操作';
            else if (act === 'running this command') actTrans = '运行此命令';
            else if (act === 'running this command outside the sandbox') actTrans = '在沙箱外运行此命令';
            else if (act === 'using this mcp tool') actTrans = '使用此 MCP 工具';
            else if (act === 'a one-time administrator (uac) elevation') actTrans = '单次管理员 (UAC) 提权';
            else if (act === 'access to this resource') actTrans = '访问此资源';
            if (actTrans) {
                const separator = /[A-Za-z0-9]$/.test(actTrans) ? " 的规则？" : "的规则？";
                return "保存为始终允许" + actTrans + separator;
            }
        }

        match = normalized.match(/^Allow\\s+(.+?)\\??$/i);
        if (match) {
            let act = match[1].toLowerCase();
            let actTrans = null;
            if (act === 'read access to this path') actTrans = '读取此路径';
            else if (act === 'write access to this path') actTrans = '写入此路径';
            else if (act === 'reading this url') actTrans = '读取此 URL';
            else if (act === 'executing actions on this url') actTrans = '在此 URL 上执行操作';
            else if (act === 'running this command') actTrans = '运行此命令';
            else if (act === 'running this command outside the sandbox') actTrans = '在沙箱外运行此命令';
            else if (act === 'using this mcp tool') actTrans = '使用此 MCP 工具';
            else if (act === 'a one-time administrator (uac) elevation') actTrans = '单次管理员 (UAC) 提权';
            else if (act === 'access to this resource') actTrans = '访问此资源';
            if (actTrans) return "是否允许" + actTrans + "？";
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
        return countTranslation ? "永久删除 " + match[1] + "，包含 " + countTranslation : null;
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
                    if (punctuationNode) replaceTextNode(punctuationNode, "");
                    return true;
                }
            }
            current = current.parentElement || (current.parentNode && current.parentNode.host);
        }
        return false;
    }

    function translatePermanentlyDeleteNotice(element) {
        if (!element) return false;

        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
        for (let depth = 0; current && depth < 6; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType === Node.ELEMENT_NODE && !isInBlockedZone(current)) {
                const textNodes = collectTextNodes(current).filter(textNode => !isInBlockedZone(textNode));
                if (textNodes.length > 0) {
                    const rawText = textNodes.map(tn => tn.nodeValue || '').join('');
                    const normalized = norm(rawText);

                    const activeAndArchivedMatch = normalized.match(/^(?:This will permanently delete|这将永久删除)\\s+(\\d+)\\s+(?:active (?:conversations?|chats?)|个活跃会话)\\s*(?:and|及)\\s*(\\d+)\\s+(?:archived (?:conversations?|chats?)|个已归档会话)\\s*(?:within it[.。]?)?$/i);
                    const activeOnlyMatch = normalized.match(/^(?:This will permanently delete|这将永久删除)\\s+(\\d+)\\s+(?:active (?:conversations?|chats?)|个活跃会话)\\s*(?:within it[.。]?)?$/i);
                    const archivedOnlyMatch = normalized.match(/^(?:This will permanently delete|这将永久删除)\\s+(\\d+)\\s+(?:archived (?:conversations?|chats?)|个已归档会话)\\s*(?:within it[.。]?)?$/i);

                    if (activeAndArchivedMatch) {
                        const activeCount = activeAndArchivedMatch[1];
                        const archivedCount = activeAndArchivedMatch[2];
                        if (textNodes.length === 1) {
                            return replaceTextNode(textNodes[0], "这将永久删除 " + activeCount + " 个活跃会话及 " + archivedCount + " 个已归档会话");
                        }
                        const firstCountIndex = textNodes.findIndex(tn => {
                            const val = norm(tn.nodeValue);
                            return val === activeCount || val.startsWith(activeCount + " ");
                        });
                        const secondCountIndex = firstCountIndex >= 0
                            ? textNodes.findIndex((tn, idx) => {
                                if (idx <= firstCountIndex) return false;
                                const val = norm(tn.nodeValue);
                                return val === archivedCount || val.startsWith(archivedCount + " ");
                            })
                            : -1;
                        if (firstCountIndex >= 0 && secondCountIndex > firstCountIndex) {
                            let changed = replaceTextNode(textNodes[0], "这将永久删除 ");
                            for (let i = 1; i < firstCountIndex; i++) {
                                changed = replaceTextNode(textNodes[i], "") || changed;
                            }
                            const firstIsIsolated = norm(textNodes[firstCountIndex].nodeValue) === activeCount;
                            if (firstIsIsolated) {
                                changed = replaceTextNode(textNodes[firstCountIndex + 1], " 个活跃会话及 ") || changed;
                                for (let i = firstCountIndex + 2; i < secondCountIndex; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            } else {
                                changed = replaceTextNode(textNodes[firstCountIndex], activeCount + " 个活跃会话及 ") || changed;
                                for (let i = firstCountIndex + 1; i < secondCountIndex; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            const secondIsIsolated = norm(textNodes[secondCountIndex].nodeValue) === archivedCount;
                            if (secondIsIsolated) {
                                if (secondCountIndex + 1 < textNodes.length) {
                                    changed = replaceTextNode(textNodes[secondCountIndex + 1], " 个已归档会话") || changed;
                                    for (let i = secondCountIndex + 2; i < textNodes.length; i++) {
                                        changed = replaceTextNode(textNodes[i], "") || changed;
                                    }
                                }
                            } else {
                                changed = replaceTextNode(textNodes[secondCountIndex], archivedCount + " 个已归档会话") || changed;
                                for (let i = secondCountIndex + 1; i < textNodes.length; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            return changed;
                        }
                    } else if (activeOnlyMatch) {
                        const activeCount = activeOnlyMatch[1];
                        if (textNodes.length === 1) {
                            return replaceTextNode(textNodes[0], "这将永久删除 " + activeCount + " 个活跃会话");
                        }
                        const countIndex = textNodes.findIndex(tn => {
                            const val = norm(tn.nodeValue);
                            return val === activeCount || val.startsWith(activeCount + " ");
                        });
                        if (countIndex >= 0) {
                            let changed = replaceTextNode(textNodes[0], "这将永久删除 ");
                            for (let i = 1; i < countIndex; i++) {
                                changed = replaceTextNode(textNodes[i], "") || changed;
                            }
                            const isIsolated = norm(textNodes[countIndex].nodeValue) === activeCount;
                            if (isIsolated) {
                                if (countIndex + 1 < textNodes.length) {
                                    changed = replaceTextNode(textNodes[countIndex + 1], " 个活跃会话") || changed;
                                    for (let i = countIndex + 2; i < textNodes.length; i++) {
                                        changed = replaceTextNode(textNodes[i], "") || changed;
                                    }
                                }
                            } else {
                                changed = replaceTextNode(textNodes[countIndex], activeCount + " 个活跃会话") || changed;
                                for (let i = countIndex + 1; i < textNodes.length; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            return changed;
                        }
                    } else if (archivedOnlyMatch) {
                        const archivedCount = archivedOnlyMatch[1];
                        if (textNodes.length === 1) {
                            return replaceTextNode(textNodes[0], "这将永久删除 " + archivedCount + " 个已归档会话");
                        }
                        const countIndex = textNodes.findIndex(tn => {
                            const val = norm(tn.nodeValue);
                            return val === archivedCount || val.startsWith(archivedCount + " ");
                        });
                        if (countIndex >= 0) {
                            let changed = replaceTextNode(textNodes[0], "这将永久删除 ");
                            for (let i = 1; i < countIndex; i++) {
                                changed = replaceTextNode(textNodes[i], "") || changed;
                            }
                            const isIsolated = norm(textNodes[countIndex].nodeValue) === archivedCount;
                            if (isIsolated) {
                                if (countIndex + 1 < textNodes.length) {
                                    changed = replaceTextNode(textNodes[countIndex + 1], " 个已归档会话") || changed;
                                    for (let i = countIndex + 2; i < textNodes.length; i++) {
                                        changed = replaceTextNode(textNodes[i], "") || changed;
                                    }
                                }
                            } else {
                                changed = replaceTextNode(textNodes[countIndex], archivedCount + " 个已归档会话") || changed;
                                for (let i = countIndex + 1; i < textNodes.length; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            return changed;
                        }
                    }
                }
            }
            current = current.parentElement || (current.parentNode && current.parentNode.host);
        }
        return false;
    }

    function translateArchiveNotice(element) {
        if (!element) return false;

        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
        for (let depth = 0; current && depth < 6; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType === Node.ELEMENT_NODE && !isInBlockedZone(current)) {
                const textNodes = collectTextNodes(current).filter(textNode => !isInBlockedZone(textNode));
                if (textNodes.length > 0) {
                    const rawText = textNodes.map(tn => tn.nodeValue || '').join('');
                    const normalized = norm(rawText);

                    const activeAndArchivedMatch = normalized.match(/^(?:This will archive|这将归档)\\s+(\\d+)\\s*(?:active (?:conversations?|chats?)|个活跃会话)\\s*(?:and|及)\\s*(\\d+)\\s*(?:archived (?:conversations?|chats?)|个已归档会话)\\s*(?:within it[.。]?)?$/i);
                    const activeOnlyMatch = normalized.match(/^(?:This will archive|这将归档)\\s+(\\d+)\\s*(?:active (?:conversations?|chats?)|个活跃会话)\\s*(?:within it[.。]?)?$/i);
                    const archivedOnlyMatch = normalized.match(/^(?:This will archive|这将归档)\\s+(\\d+)\\s*(?:archived (?:conversations?|chats?)|个已归档会话)\\s*(?:within it[.。]?)?$/i);
                    const countOnlyMatch = normalized.match(/^(?:This will archive|这将归档)\\s+(\\d+)\\s*(?:conversations?|chats?|会话s?|个会话)\\s*(?:within it[.。]?)?$/i);

                    if (activeAndArchivedMatch) {
                        const activeCount = activeAndArchivedMatch[1];
                        const archivedCount = activeAndArchivedMatch[2];
                        if (textNodes.length === 1) {
                            return replaceTextNode(textNodes[0], "这将归档其中的 " + activeCount + " 个活跃会话及 " + archivedCount + " 个已归档会话");
                        }
                        const firstCountIndex = textNodes.findIndex(tn => {
                            const val = norm(tn.nodeValue);
                            return val === activeCount || val.startsWith(activeCount + " ");
                        });
                        const secondCountIndex = firstCountIndex >= 0
                            ? textNodes.findIndex((tn, idx) => {
                                if (idx <= firstCountIndex) return false;
                                const val = norm(tn.nodeValue);
                                return val === archivedCount || val.startsWith(archivedCount + " ");
                            })
                            : -1;
                        if (firstCountIndex >= 0 && secondCountIndex > firstCountIndex) {
                            let changed = replaceTextNode(textNodes[0], "这将归档其中的 ");
                            for (let i = 1; i < firstCountIndex; i++) {
                                changed = replaceTextNode(textNodes[i], "") || changed;
                            }
                            const firstIsIsolated = norm(textNodes[firstCountIndex].nodeValue) === activeCount;
                            if (firstIsIsolated) {
                                changed = replaceTextNode(textNodes[firstCountIndex + 1], " 个活跃会话及 ") || changed;
                                for (let i = firstCountIndex + 2; i < secondCountIndex; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            } else {
                                changed = replaceTextNode(textNodes[firstCountIndex], activeCount + " 个活跃会话及 ") || changed;
                                for (let i = firstCountIndex + 1; i < secondCountIndex; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            const secondIsIsolated = norm(textNodes[secondCountIndex].nodeValue) === archivedCount;
                            if (secondIsIsolated) {
                                if (secondCountIndex + 1 < textNodes.length) {
                                    changed = replaceTextNode(textNodes[secondCountIndex + 1], " 个已归档会话") || changed;
                                    for (let i = secondCountIndex + 2; i < textNodes.length; i++) {
                                        changed = replaceTextNode(textNodes[i], "") || changed;
                                    }
                                }
                            } else {
                                changed = replaceTextNode(textNodes[secondCountIndex], archivedCount + " 个已归档会话") || changed;
                                for (let i = secondCountIndex + 1; i < textNodes.length; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            return changed;
                        }
                    } else if (activeOnlyMatch) {
                        const activeCount = activeOnlyMatch[1];
                        if (textNodes.length === 1) {
                            return replaceTextNode(textNodes[0], "这将归档其中的 " + activeCount + " 个活跃会话");
                        }
                        const countIndex = textNodes.findIndex(tn => {
                            const val = norm(tn.nodeValue);
                            return val === activeCount || val.startsWith(activeCount + " ");
                        });
                        if (countIndex >= 0) {
                            let changed = replaceTextNode(textNodes[0], "这将归档其中的 ");
                            for (let i = 1; i < countIndex; i++) {
                                changed = replaceTextNode(textNodes[i], "") || changed;
                            }
                            const isIsolated = norm(textNodes[countIndex].nodeValue) === activeCount;
                            if (isIsolated) {
                                if (countIndex + 1 < textNodes.length) {
                                    changed = replaceTextNode(textNodes[countIndex + 1], " 个活跃会话") || changed;
                                    for (let i = countIndex + 2; i < textNodes.length; i++) {
                                        changed = replaceTextNode(textNodes[i], "") || changed;
                                    }
                                }
                            } else {
                                changed = replaceTextNode(textNodes[countIndex], activeCount + " 个活跃会话") || changed;
                                for (let i = countIndex + 1; i < textNodes.length; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            return changed;
                        }
                    } else if (archivedOnlyMatch) {
                        const archivedCount = archivedOnlyMatch[1];
                        if (textNodes.length === 1) {
                            return replaceTextNode(textNodes[0], "这将归档其中的 " + archivedCount + " 个已归档会话");
                        }
                        const countIndex = textNodes.findIndex(tn => {
                            const val = norm(tn.nodeValue);
                            return val === archivedCount || val.startsWith(archivedCount + " ");
                        });
                        if (countIndex >= 0) {
                            let changed = replaceTextNode(textNodes[0], "这将归档其中的 ");
                            for (let i = 1; i < countIndex; i++) {
                                changed = replaceTextNode(textNodes[i], "") || changed;
                            }
                            const isIsolated = norm(textNodes[countIndex].nodeValue) === archivedCount;
                            if (isIsolated) {
                                if (countIndex + 1 < textNodes.length) {
                                    changed = replaceTextNode(textNodes[countIndex + 1], " 个已归档会话") || changed;
                                    for (let i = countIndex + 2; i < textNodes.length; i++) {
                                        changed = replaceTextNode(textNodes[i], "") || changed;
                                    }
                                }
                            } else {
                                changed = replaceTextNode(textNodes[countIndex], archivedCount + " 个已归档会话") || changed;
                                for (let i = countIndex + 1; i < textNodes.length; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            return changed;
                        }
                    } else if (countOnlyMatch) {
                        const count = countOnlyMatch[1];
                        if (textNodes.length === 1) {
                            return replaceTextNode(textNodes[0], "这将归档其中的 " + count + " 个会话");
                        }
                        const countIndex = textNodes.findIndex(tn => {
                            const val = norm(tn.nodeValue);
                            return val === count || val.startsWith(count + " ") || val.startsWith(count + "会话");
                        });
                        if (countIndex >= 0) {
                            let changed = replaceTextNode(textNodes[0], "这将归档其中的 ");
                            for (let i = 1; i < countIndex; i++) {
                                changed = replaceTextNode(textNodes[i], "") || changed;
                            }
                            const countNodeVal = norm(textNodes[countIndex].nodeValue);
                            const isIsolated = countNodeVal === count;
                            if (isIsolated) {
                                if (countIndex + 1 < textNodes.length) {
                                    changed = replaceTextNode(textNodes[countIndex + 1], " 个会话") || changed;
                                    for (let i = countIndex + 2; i < textNodes.length; i++) {
                                        changed = replaceTextNode(textNodes[i], "") || changed;
                                    }
                                }
                            } else {
                                changed = replaceTextNode(textNodes[countIndex], count + " 个会话") || changed;
                                for (let i = countIndex + 1; i < textNodes.length; i++) {
                                    changed = replaceTextNode(textNodes[i], "") || changed;
                                }
                            }
                            return changed;
                        }
                    }
                }
            }
            current = current.parentElement || (current.parentNode && current.parentNode.host);
        }
        return false;
    }

    function translateBrowserSubagentNotice(element) {
        if (!element) return false;

        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
        for (let depth = 0; current && depth < 6; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType === Node.ELEMENT_NODE && !isInBlockedZone(current)) {
                const cText = getBoundedTextContent(current, 24, 500);
                if (cText === null) break;
                if (cText.length <= 500 &&
                    /(?:Configure the browser subagent|配置浏览器子智能体)/i.test(cText) &&
                    /(?:Google Chrome|to be installed)/i.test(cText)) {
                    const textNodes = collectTextNodes(current).filter(tn => !isInBlockedZone(tn));
                    if (textNodes.length === 0) return false;

                    let changed = false;
                    for (let i = 0; i < textNodes.length; i++) {
                        const tn = textNodes[i];
                        const val = tn.nodeValue || '';
                        const valN = norm(val);

                        if (/^Configure the browser subagent\\.\\s*It requires$/i.test(valN)) {
                            changed = replaceTextNode(tn, "配置浏览器子智能体. 它需要安装 ") || changed;
                        } else if (/^to be installed\\.?$/i.test(valN)) {
                            changed = replaceTextNode(tn, ". ") || changed;
                        } else if (/^to be installed\\.\\s*(.+)$/i.test(valN)) {
                            const match = valN.match(/^to be installed\\.\\s*(.+)$/i);
                            const rest = match[1];
                            const restTrans = map.get(norm(rest)) || lowerMap.get(norm(rest).toLowerCase()) || rest;
                            changed = replaceTextNode(tn, ". " + restTrans) || changed;
                        } else if (/^The browser subagent can be invoked by typing \\/browser in the conversation input box\\.?$/i.test(valN)) {
                            changed = replaceTextNode(tn, "您可以通过在会话输入框中输入 /browser 来调用浏览器子智能体.") || changed;
                        }
                    }
                    if (changed) return true;
                }
            }
            current = current.parentElement || (current.parentNode && current.parentNode.host);
        }
        return false;
    }

    function translateLegalHelpNotice(element) {
        if (!element) return false;

        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
        for (let depth = 0; current && depth < 6; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType === Node.ELEMENT_NODE && !isInBlockedZone(current)) {
                const cText = getBoundedTextContent(current, 24, 320);
                if (cText === null) break;
                if (cText.length <= 300 &&
                    /(?:Visit|访问)\\s*(?:Legal Help|法律帮助)/i.test(cText) &&
                    /(?:to ask for content changes for legal reasons|出于法律原因)/i.test(cText)) {
                    const textNodes = collectTextNodes(current).filter(tn => !isInBlockedZone(tn));
                    if (textNodes.length === 0) return false;

                    let changed = false;
                    for (let i = 0; i < textNodes.length; i++) {
                        const tn = textNodes[i];
                        const val = tn.nodeValue || '';
                        const valN = norm(val);

                        if (/^Visit$/i.test(valN)) {
                            changed = replaceTextNode(tn, "若出于法律原因需要申请更改内容，请访问 ") || changed;
                        } else if (/^Legal Help$/i.test(valN)) {
                            changed = replaceTextNode(tn, "法律帮助") || changed;
                        } else if (/^to ask for content changes for legal reasons[.。]?$/i.test(valN)) {
                            changed = replaceTextNode(tn, " 页面") || changed;
                        } else if (/^Visit Legal Help to ask for content changes for legal reasons[.。]?$/i.test(valN)) {
                            changed = replaceTextNode(tn, "若出于法律原因需要申请更改内容，请访问法律帮助页面") || changed;
                        }
                    }
                    if (changed) return true;
                }
            }
            current = current.parentElement || (current.parentNode && current.parentNode.host);
        }
        return false;
    }

    function translatePlanCommandAlert(element) {
        if (!element) return false;

        let alertContainer = null;
        let current = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
        for (let depth = 0; current && depth < 6; depth++) {
            if (current === document.body || current === document.documentElement) break;
            if (current.nodeType === Node.ELEMENT_NODE && !isInBlockedZone(current)) {
                if (current.getAttribute?.('data-testid') === 'plan-command-fyi-alert') {
                    alertContainer = current;
                    break;
                }
                const cText = getBoundedTextContent(current, 24, 260);
                if (cText === null) break;
                if (cText.length <= 250 &&
                    /(?:Type|类型|键入)\\s*\\/\\s*(?:and\\s+select|并选择)\\s*plan/i.test(cText) &&
                    /(?:to have the agent generate a plan|让智能体生成计划)/i.test(cText)) {
                    alertContainer = current;
                    break;
                }
            }
            current = current.parentElement || (current.parentNode && current.parentNode.host);
        }

        if (!alertContainer) return false;

        const span = alertContainer.querySelector('span') || alertContainer;
        const allTextNodes = collectTextNodes(span);
        if (allTextNodes.length === 0) return false;

        let idxSlash = -1;
        let idxPlan = -1;
        for (let i = 0; i < allTextNodes.length; i++) {
            const tn = allTextNodes[i];
            const parentTag = tn.parentElement?.tagName?.toUpperCase();
            const val = (tn.nodeValue || '').trim();
            if (parentTag === 'CODE' && val === '/' && idxSlash === -1) {
                idxSlash = i;
            } else if (parentTag === 'CODE' && /^plan$/i.test(val) && idxSlash !== -1 && idxPlan === -1) {
                idxPlan = i;
            }
        }

        if (idxSlash === -1 || idxPlan === -1 || idxSlash >= idxPlan) return false;

        let changed = false;

        const beforeNodes = allTextNodes.slice(0, idxSlash);
        if (beforeNodes.length > 0) {
            if (beforeNodes[0].nodeValue !== '键入 ') {
                changed = replaceTextNode(beforeNodes[0], '键入 ') || changed;
            }
            for (let i = 1; i < beforeNodes.length; i++) {
                if (beforeNodes[i].nodeValue !== '') {
                    changed = replaceTextNode(beforeNodes[i], '') || changed;
                }
            }
        }

        const middleNodes = allTextNodes.slice(idxSlash + 1, idxPlan);
        if (middleNodes.length > 0) {
            if (middleNodes[0].nodeValue !== ' 并选择 ') {
                changed = replaceTextNode(middleNodes[0], ' 并选择 ') || changed;
            }
            for (let i = 1; i < middleNodes.length; i++) {
                if (middleNodes[i].nodeValue !== '') {
                    changed = replaceTextNode(middleNodes[i], '') || changed;
                }
            }
        }

        const afterNodes = allTextNodes.slice(idxPlan + 1);
        if (afterNodes.length > 0) {
            if (afterNodes[0].nodeValue !== '，即可让智能体生成计划') {
                changed = replaceTextNode(afterNodes[0], '，即可让智能体生成计划') || changed;
            }
            for (let i = 1; i < afterNodes.length; i++) {
                if (afterNodes[i].nodeValue !== '') {
                    changed = replaceTextNode(afterNodes[i], '') || changed;
                }
            }
        }

        return changed;
    }

    function getCustomizationBudgetTranslation(value) {
        const match = norm(value).match(/^(\\d+(?:\\.\\d+)?)%\\s+of the customization budget is available[.。]?$/i);
        return match ? match[1] + "% 的个性化定制预算可用" : null;
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

    function translateLearnMoreAboutPresetContainer(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        const rawText = getBoundedTextContent(element, 16, 160);
        if (!rawText) return false;
        const normText = norm(rawText);
        if (!/^(?:Learn more about|了解更多关于)\\s+(?:Default|Full machine|Turbo mode|Custom|Inherit Global|默认|全机访问|极速模式|自定义|继承全局)/i.test(normText)) {
            return false;
        }

        const textNodes = collectTextNodes(element).filter(tn => !isInBlockedZone(tn));
        if (textNodes.length === 0) return false;

        const presetMap = {
            'default': '默认',
            'full machine': '全机访问',
            'turbo mode': '极速模式',
            'custom': '自定义',
            'inherit global': '继承全局'
        };

        if (textNodes.length === 1) {
            const val = norm(textNodes[0].nodeValue);
            const m = val.match(/^Learn more about\\s+(Default|Full machine|Turbo mode|Custom|Inherit Global)(.*)$/i);
            if (m) {
                const trans = presetMap[m[1].toLowerCase()] || m[1];
                const suffix = m[2] ? (' ' + m[2].trim()) : '';
                return replaceTextNode(textNodes[0], "了解更多关于 " + trans + suffix);
            }
            return false;
        }

        let changed = false;
        let prefixNode = null;
        let presetNode = null;
        let presetTrans = '';

        for (const tn of textNodes) {
            const v = norm(tn.nodeValue);
            if (/^(?:Learn more about|了解更多关于)$/i.test(v)) {
                prefixNode = tn;
            } else if (/^(?:Default|Full machine|Turbo mode|Custom|Inherit Global)$/i.test(v)) {
                presetNode = tn;
                presetTrans = presetMap[v.toLowerCase()] || v;
            } else if (/^(?:默认|全机访问|极速模式|自定义|继承全局)$/i.test(v)) {
                presetNode = tn;
                presetTrans = v;
            }
        }

        if (prefixNode) {
            if (norm(prefixNode.nodeValue) !== "了解更多关于") {
                changed = replaceTextNode(prefixNode, "了解更多关于 ") || changed;
            }
            if (presetNode && presetNode.nodeValue !== presetTrans) {
                changed = replaceTextNode(presetNode, presetTrans) || changed;
            }
            return changed;
        }

        return false;
    }

    function translateProjectPermissionsSubtitle(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        if (element.tagName?.toUpperCase() !== 'SPAN') return false;
        const rawText = element.textContent || '';
        if (rawText.length > 360 || !/(?:Also includes|when working in this|在此(?:项目|工作区)中工作时还包括)/i.test(rawText)) return false;

        const children = Array.from(element.children || []);
        const globalPermSpan = children.find(child => {
            return child.tagName?.toUpperCase() === 'SPAN' &&
                /^(?:Global Permissions|全局权限)$/i.test(norm(child.textContent));
        });
        if (!globalPermSpan) return false;

        const strongEl = children.find(child => child.tagName?.toUpperCase() === 'STRONG');
        const learnMoreLink = children.find(child => child.tagName?.toUpperCase() === 'A');
        const scope = /\\bworkspace\\b|工作区/i.test(rawText) ? "工作区" : "项目";
        const hasAutoPrefix = !!strongEl || /(?:was created for|是为.*自动化创建的)/i.test(rawText);

        let changed = false;
        const globalPermTextNodes = collectTextNodes(globalPermSpan);
        if (globalPermTextNodes.length === 1 && norm(globalPermTextNodes[0].nodeValue) !== "全局权限") {
            changed = replaceTextNode(globalPermTextNodes[0], "全局权限") || changed;
        }
        if (learnMoreLink) {
            const linkTextNodes = collectTextNodes(learnMoreLink);
            if (linkTextNodes.length === 1 && /^Learn more$/i.test(norm(linkTextNodes[0].nodeValue))) {
                changed = replaceTextNode(linkTextNodes[0], "了解更多") || changed;
            }
        }

        const childNodes = Array.from(element.childNodes || []);
        const strongIdx = strongEl ? childNodes.indexOf(strongEl) : -1;
        const globalIdx = childNodes.indexOf(globalPermSpan);
        const linkIdx = learnMoreLink ? childNodes.indexOf(learnMoreLink) : -1;
        if (globalIdx < 0) return false;

        const setRangeText = (startIdx, endIdx, targetText) => {
            let assigned = false;
            for (let i = startIdx; i < endIdx; i++) {
                const node = childNodes[i];
                if (node.nodeType !== Node.TEXT_NODE) continue;
                const val = assigned ? "" : targetText;
                assigned = true;
                changed = replaceTextNode(node, val) || changed;
            }
        };

        if (strongIdx >= 0 && strongIdx < globalIdx) {
            setRangeText(0, strongIdx, "此" + scope + "是为 ");
            setRangeText(strongIdx + 1, globalIdx, " 自动化创建的. 在此" + scope + "中工作时还包括 ");
        } else {
            const prefix = hasAutoPrefix
                ? "此" + scope + "是为自动化创建的. 在此" + scope + "中工作时还包括 "
                : "在此" + scope + "中工作时还包括 ";
            setRangeText(0, globalIdx, prefix);
        }

        if (linkIdx > globalIdx) {
            setRangeText(globalIdx + 1, linkIdx, ". ");
            setRangeText(linkIdx + 1, childNodes.length, "");
        } else {
            setRangeText(globalIdx + 1, childNodes.length, "");
        }

        return changed;
    }

    function translateManagedByAutomationNotice(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        if (element.tagName?.toUpperCase() !== 'SPAN') return false;
        const rawText = element.textContent || '';
        if (rawText.length > 320 || !/(?:is managed by the|can only be deleted by deleting that automation|自动化管理，只能通过删除该自动化来将其删除)/i.test(rawText)) return false;

        const children = Array.from(element.children || []);
        if (children.length !== 1 || children[0].tagName?.toUpperCase() !== 'STRONG') return false;
        const strongEl = children[0];
        const scope = /\\bworkspace\\b|工作区/i.test(rawText) ? "工作区" : "项目";

        const childNodes = Array.from(element.childNodes || []);
        const strongIdx = childNodes.indexOf(strongEl);
        if (strongIdx < 0) return false;

        let changed = false;
        let assignedBefore = false;
        for (let i = 0; i < strongIdx; i++) {
            const node = childNodes[i];
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const val = assignedBefore ? "" : ("此" + scope + "由 ");
            assignedBefore = true;
            changed = replaceTextNode(node, val) || changed;
        }
        let assignedAfter = false;
        for (let i = strongIdx + 1; i < childNodes.length; i++) {
            const node = childNodes[i];
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const val = assignedAfter ? "" : " 自动化管理，只能通过删除该自动化来将其删除";
            assignedAfter = true;
            changed = replaceTextNode(node, val) || changed;
        }
        return changed;
    }

    function translateAutomationScheduleContainer(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        const rawText = getBoundedTextContent(element, 16, 120);
        if (!rawText) return false;
        const normText = norm(rawText);

        const dayMatch = normText.match(/^(?:Weekly|每周)(?:\\s+on)?\\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|星期[一二三四五六日])\\s*(?:around|at|在)\\s+(.+)$/i);
        const match = normText.match(/^(Daily|Weekly|Monthly|每[天周月])\\s+(?:around|at|在)\\s+(.+)$/i);
        if (!match && !dayMatch) return false;

        const textNodes = collectTextNodes(element);
        if (textNodes.length === 0) return false;

        let changed = false;
        if (dayMatch) {
            const dayMap = {
                monday: "星期一", tuesday: "星期二", wednesday: "星期三",
                thursday: "星期四", friday: "星期五", saturday: "星期六", sunday: "星期日"
            };
            const chineseDay = dayMap[dayMatch[1].toLowerCase()] || dayMatch[1];
            let clearNextWhitespace = false;
            for (const tn of textNodes) {
                if (clearNextWhitespace && tn.nodeValue && tn.nodeValue.trim() === '') {
                    changed = replaceTextNode(tn, '') || changed;
                    clearNextWhitespace = false;
                    continue;
                }
                clearNextWhitespace = false;
                const val = norm(tn.nodeValue);
                if (!val) continue;
                const fullTrans = getAutomationScheduleTranslation(val);
                if (fullTrans) {
                    changed = replaceTextNode(tn, fullTrans) || changed;
                    continue;
                }
                const combinedWeeklyMatch = val.match(/^Weekly\\s+on\\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i);
                if (combinedWeeklyMatch) {
                    const cDay = dayMap[combinedWeeklyMatch[1].toLowerCase()] || combinedWeeklyMatch[1];
                    changed = replaceTextNode(tn, "每周" + cDay) || changed;
                } else if (/^(?:Weekly(?:\\s+on)?|每周)$/i.test(val)) {
                    changed = replaceTextNode(tn, "每周") || changed;
                } else if (/^on$/i.test(val)) {
                    changed = replaceTextNode(tn, "") || changed;
                    clearNextWhitespace = true;
                } else if (new RegExp('^' + dayMatch[1] + '$', 'i').test(val)) {
                    changed = replaceTextNode(tn, chineseDay) || changed;
                } else if (/^(?:around|at)$/i.test(val)) {
                    changed = replaceTextNode(tn, "在 ") || changed;
                    clearNextWhitespace = true;
                }
            }
            return changed;
        }

        if (match) {
            const freqMap = {
                daily: "每天",
                weekly: "每周",
                monthly: "每月",
                "每天": "每天",
                "每周": "每周",
                "每月": "每月"
            };
            const freq = freqMap[match[1].toLowerCase()] || match[1];
            let clearNextWhitespace = false;
            for (const tn of textNodes) {
                if (clearNextWhitespace && tn.nodeValue && tn.nodeValue.trim() === '') {
                    changed = replaceTextNode(tn, '') || changed;
                    clearNextWhitespace = false;
                    continue;
                }
                clearNextWhitespace = false;
                const val = norm(tn.nodeValue);
                if (!val) continue;
                const fullTrans = getAutomationScheduleTranslation(val);
                if (fullTrans) {
                    changed = replaceTextNode(tn, fullTrans) || changed;
                    continue;
                }
                if (/^(?:Daily|Weekly|Monthly)$/i.test(val)) {
                    changed = replaceTextNode(tn, freq) || changed;
                } else if (/^(?:around|at)$/i.test(val)) {
                    changed = replaceTextNode(tn, "在 ") || changed;
                    clearNextWhitespace = true;
                }
            }
            return changed;
        }
        return false;
    }

    function translateSearchAndArchivedGuideNotice(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || isInBlockedZone(element)) return false;
        const rawText = element.textContent || '';
        if (rawText.length > 260) return false;
        if (!/(?:Search conversations with|in the top left|View archived in the sidebar|使用左上角的|中查看已归档会话)/i.test(rawText)) return false;

        const childNodes = Array.from(element.childNodes || []);
        const setRangeText = (nodes, startIdx, endIdx, targetText) => {
            let changed = false;
            let assigned = false;
            for (let i = startIdx; i < endIdx; i++) {
                const node = nodes[i];
                if (node.nodeType !== Node.TEXT_NODE) continue;
                const val = assigned ? "" : targetText;
                assigned = true;
                changed = replaceTextNode(node, val) || changed;
            }
            return changed;
        };

        const directElementChildren = Array.from(element.children || []);
        const nonBrChildren = directElementChildren.filter(child => child.tagName?.toUpperCase() !== 'BR');
        if (nonBrChildren.length === 2 &&
            nonBrChildren[0].tagName?.toUpperCase() === 'SVG' &&
            nonBrChildren[1].tagName?.toUpperCase() === 'SVG' &&
            /(?:Search conversations with|使用左上角的)/i.test(rawText) &&
            /(?:View archived in the sidebar|中查看已归档会话)/i.test(rawText)) {
            const svg0Idx = childNodes.indexOf(nonBrChildren[0]);
            const svg1Idx = childNodes.indexOf(nonBrChildren[1]);
            if (svg0Idx < 0 || svg1Idx <= svg0Idx) return false;
            let changed = false;
            changed = setRangeText(childNodes, 0, svg0Idx, "使用左上角的 ") || changed;
            const brIdx = childNodes.findIndex((node, idx) => idx > svg0Idx && idx < svg1Idx && node.nodeType === Node.ELEMENT_NODE && node.tagName?.toUpperCase() === 'BR');
            if (brIdx > svg0Idx) {
                changed = setRangeText(childNodes, svg0Idx + 1, brIdx, " 搜索会话") || changed;
                changed = setRangeText(childNodes, brIdx + 1, svg1Idx, "在侧边栏(") || changed;
            } else {
                changed = setRangeText(childNodes, svg0Idx + 1, svg1Idx, " 搜索会话. 在侧边栏(") || changed;
            }
            changed = setRangeText(childNodes, svg1Idx + 1, childNodes.length, " 菜单)中查看已归档会话") || changed;
            return changed;
        }

        if (directElementChildren.length === 1 &&
            directElementChildren[0].tagName?.toUpperCase() === 'SVG' &&
            /(?:Search conversations with|in the top left|使用左上角的)/i.test(rawText) &&
            !/(?:View archived|已归档会话)/i.test(rawText)) {
            const svgIdx = childNodes.indexOf(directElementChildren[0]);
            if (svgIdx < 0) return false;
            let changed = false;
            changed = setRangeText(childNodes, 0, svgIdx, "使用左上角的 ") || changed;
            changed = setRangeText(childNodes, svgIdx + 1, childNodes.length, " 搜索会话") || changed;
            return changed;
        }

        if (directElementChildren.length === 1 &&
            directElementChildren[0].tagName?.toUpperCase() === 'SVG' &&
            /(?:View archived in the sidebar|中查看已归档会话)/i.test(rawText) &&
            !/(?:Search conversations with|in the top left|使用左上角的)/i.test(rawText)) {
            const svgIdx = childNodes.indexOf(directElementChildren[0]);
            if (svgIdx < 0) return false;
            let changed = false;
            changed = setRangeText(childNodes, 0, svgIdx, "在侧边栏（") || changed;
            changed = setRangeText(childNodes, svgIdx + 1, childNodes.length, " 菜单）中查看已归档会话") || changed;
            return changed;
        }

        if (directElementChildren.length === 1 &&
            directElementChildren[0].tagName?.toUpperCase() === 'SPAN' &&
            /(?:View archived in the sidebar|中查看已归档会话)/i.test(rawText)) {
            const innerSpan = directElementChildren[0];
            const innerChildren = Array.from(innerSpan.children || []);
            if (innerChildren.length !== 1 || innerChildren[0].tagName?.toUpperCase() !== 'SVG') return false;
            const spanIdx = childNodes.indexOf(innerSpan);
            const innerNodes = Array.from(innerSpan.childNodes || []);
            const svgIdx = innerNodes.indexOf(innerChildren[0]);
            if (spanIdx < 0 || svgIdx < 0) return false;
            let changed = false;
            changed = setRangeText(childNodes, 0, spanIdx, "在侧边栏") || changed;
            changed = setRangeText(innerNodes, 0, svgIdx, "（") || changed;
            changed = setRangeText(innerNodes, svgIdx + 1, innerNodes.length, " 菜单）") || changed;
            changed = setRangeText(childNodes, spanIdx + 1, childNodes.length, "中查看已归档会话") || changed;
            return changed;
        }

        return false;
    }

    const SKILL_PICKER_CONTAINER_REGEX = /(?:quick question without interrupting|align on a plan|team of agents to autonomously|recent successes or corrections|Boost multi-agent orchestrator|Antigravity Customization System|comprehensive guide, quick reference, and sitemap|render rich interactive HTML widgets|scheduled background automation|manage and create plugins|namespaced bundles of skills|manage Google Docs|draft, and edit docs|and write your Google Docs|schedule events, and RSVP|format spreadsheets|edit, and export presentations|upload, download, and share files|不中断主会话|通过访谈与我对齐|智能体团队自主应对|反思最近的成功或改进|Boost 多智能体编排器|个性化定制系统的综合指南|全面指南、快速参考和网站地图|交互式 HTML 小组件|定时后台自动化|计划后台自动化|管理和创建插件|管理 Google 文档|起草和编辑文档|安排活动并回复邀请|编写和格式化电子表格|导出演示文稿|上传、下载和共享文件)/i;

    function translateSpecialContainers(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        if (!element.childNodes || element.childNodes.length === 0) return false;
        if (element.children && element.children.length > 8) return false;

        if ((!element.children || element.children.length === 0) && element.childNodes.length === 1) {
            const firstChild = element.firstChild;
            if (!firstChild || firstChild.nodeType !== Node.TEXT_NODE) return false;
            const singleVal = firstChild.nodeValue || '';
            if (singleVal.length <= 160 && isCollapsibleActivityHeader(singleVal)) {
                markThoughtContentSibling(element);
                return 'skip_children';
            }
            if (singleVal.length <= 40 && /^(\\+)?\\s*\\d+\\s+more\\s+lines?$/i.test(singleVal.trim())) {
                return translateCompactCountLabelContainer(element);
            }
            if (singleVal.length <= 8 && element.tagName?.toUpperCase() === 'SPAN' && /^OR$/i.test(singleVal.trim())) {
                if (isInBlockedZone(element)) return false;
                return translateBusinessSsoOrDivider(element);
            }
            if (element.getAttribute?.('data-testid') === 'agent-loading') {
                if (isInBlockedZone(element)) return false;
                return translateAgentLoadingStatus(element);
            }
            if (singleVal.length <= 1600 && /(?:baseline quota|基础配额)/i.test(singleVal)) {
                if (isInBlockedZone(element)) return false;
                return translateBaselineQuotaNotice(element);
            }
            return false;
        }

        const rawText = getBoundedTextContent(element, 36, 1600);
        if (rawText === null) return false;
        const textLength = rawText.length;
        if (textLength === 0) return false;
        const isFoldButton = textLength <= 40 && /^(\\+)?\\s*\\d+\\s+more\\s+lines?$/i.test(rawText);
        if (isInBlockedZone(element) && !isFoldButton) return false;

        if (textLength <= 160 && isCollapsibleActivityHeader(rawText)) {
            markThoughtContentSibling(element);
            return 'skip_children';
        }
        let translated = false;
        const isSpan = element.tagName?.toUpperCase() === 'SPAN';

        if (textLength <= 160 && /(?:(?:Also\\s+modified|Modified)\\s+in|修改于|也修改于)/i.test(rawText)) {
            translated = translateSettingOverrides(element) || translated;
        }
        if (isSpan && textLength <= 360 && /(?:Also includes|when working in this|在此(?:项目|工作区)中工作时还包括)/i.test(rawText)) {
            translated = translateProjectPermissionsSubtitle(element) || translated;
        }
        if (isSpan && textLength <= 320 && /(?:is managed by the|can only be deleted by deleting that automation|自动化管理，只能通过删除该自动化来将其删除)/i.test(rawText)) {
            translated = translateManagedByAutomationNotice(element) || translated;
        }
        if (textLength <= 120 && /(?:Daily|Weekly|Monthly|每[天周月])(?:\\s+on)?(?:\\s+(?:[A-Za-z]+|星期[一二三四五六日]))?\\s*(?:around|at|在)/i.test(rawText)) {
            translated = translateAutomationScheduleContainer(element) || translated;
        }
        if (textLength <= 260 && /(?:Search conversations with|View archived in the sidebar|使用左上角的|中查看已归档会话)/i.test(rawText)) {
            translated = translateSearchAndArchivedGuideNotice(element) || translated;
        }
        if (textLength <= 120 && /(?:Learn more about|了解更多关于)\\s+(?:Default|Full machine|Turbo mode|Custom|Inherit Global|默认|全机访问|极速模式|自定义|继承全局)/i.test(rawText)) {
            translated = translateLearnMoreAboutPresetContainer(element) || translated;
        }

        if (textLength <= 300 && /(?:archived conversations?|已归档.*(?:会话|对话)|^(?:History|历史记录)[.。]?$)/i.test(rawText.trim())) {
            translated = translateArchivedConversationNotice(element) || translated;
        }
        if (textLength <= 320 && /(?:Input disabled because|输入已禁用[，,]因为|does not exist|Create the folder in this)/i.test(rawText)) {
            translated = translateInputDisabledNotice(element) || translated;
        }
        if (textLength <= 120 && /(?:with the same folders? exists|A similar.*exists|已存在包含相同文件夹|已存在类似)/i.test(rawText)) {
            translated = translateDuplicateProjectInlineWarning(element) || translated;
        }
        if (textLength <= 260 && /(?:already exists for this (?:folder|combination of folders)|已存在于此文件夹中|已存在于这些文件夹组合中)/i.test(rawText) &&
            /(?:Would you like to continue using it or make a new one\\?|您是否希望继续使用该项目)/i.test(rawText)) {
            translated = translateDuplicateProjectModalNotice(element) || translated;
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
        if (textLength >= 25 && textLength <= 1400 && SKILL_PICKER_CONTAINER_REGEX.test(rawText)) {
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
        if (textLength <= 120 && (/\\d/.test(rawText) || /(?:See all|显示全部|Show\\s+(?:submitted|more)|显示(?:已提交|更多))/i.test(rawText)) && /(?:\\bresults?\\b|个结果|(?:Comments?|评论)\\s*[（(]\\s*\\d+|(?:\\d+\\s+)?(?:Side Questions?|侧边提问)(?:\\s*[（(]\\s*\\d+|\\b)|Listed|列出了|[（(]\\s*\\d+\\s*(?:subagents?|个?\\s*子智能体)|\\baccounts\\b|个账号|See all|显示全部|See\\s+\\d+\\s+more|查看另外|Show\\s+(?:submitted|more)|显示(?:已提交|更多)|\\bmore\\s+lines?\\b|行代码)/i.test(rawText)) {
            translated = translateCompactCountLabelContainer(element) || translated;
        }
        if (textLength <= 240 &&
            /^(?:\\d+\\s+|Found\\s+|Killed\\s+|已中止\\s+|Messaged?\\s+|Error\\s+from\\s+|Timed\\s+\\d+|Goals?\\s+\\d+|View\\s+\\d+|Questions?\\s+\\d+|Side\\s+question\\s+|Asked\\s+\\d+)/i.test(rawText.trim())) {
            translated = translateDynamicSubagentStatusContainer(element) || translated;
        }
        if (textLength <= 600 &&
            /(?:Permanently delete|\\bincluding\\b|\\bactive conversations?\\b|\\barchived conversations?\\b|永久删除|，包含)/i.test(rawText)) {
            translated = translateProjectDeleteSummary(element) || translated;
        }
        if (textLength <= 600 &&
            /(?:This will permanently delete|这将永久删除|within it)/i.test(rawText) &&
            /(?:active (?:conversations?|chats?)|archived (?:conversations?|chats?)|个活跃会话|个已归档会话|within it)/i.test(rawText)) {
            translated = translatePermanentlyDeleteNotice(element) || translated;
        }
        if (textLength <= 600 &&
            /(?:This will archive|这将归档)/i.test(rawText) &&
            /(?:conversations?|chats?|会话|within it)/i.test(rawText)) {
            translated = translateArchiveNotice(element) || translated;
        }
        if (textLength <= 500 &&
            /(?:Configure the browser subagent|配置浏览器子智能体)/i.test(rawText) &&
            /(?:Google Chrome|to be installed)/i.test(rawText)) {
            translated = translateBrowserSubagentNotice(element) || translated;
        }
        if (element.getAttribute?.('data-testid') === 'plan-command-fyi-alert' ||
            (textLength <= 250 && /(?:Type|类型|键入)\\s*\\/\\s*(?:and\\s+select|并选择)\\s*plan/i.test(rawText))) {
            translated = translatePlanCommandAlert(element) || translated;
        }
        if (textLength <= 300 &&
            /(?:Visit|访问)\\s*(?:Legal Help|法律帮助)/i.test(rawText) &&
            /(?:to ask for content changes for legal reasons|出于法律原因)/i.test(rawText)) {
            translated = translateLegalHelpNotice(element) || translated;
        }
        if (textLength <= 8 && isSpan && /^OR$/i.test(rawText.trim())) {
            translated = translateBusinessSsoOrDivider(element) || translated;
        }
        return translated;
    }

    function getCombinedStatusTranslation(value) {
        const normalized = norm(value);
        if (!normalized) return null;
        if (!/^[a-zA-Z]+$/.test(normalized)) {
            if (map.has(normalized)) return map.get(normalized);
            if (lowerMap.has(normalized.toLowerCase())) return lowerMap.get(normalized.toLowerCase());
        }

        const versionControlTranslation = getVersionControlUiTranslation(normalized);
        if (versionControlTranslation) return versionControlTranslation;

        const automationScheduleTranslation = getAutomationScheduleTranslation(normalized);
        if (automationScheduleTranslation) return automationScheduleTranslation;

        const bulletedStatusTranslation = getBulletedStatusTranslation(normalized);
        if (bulletedStatusTranslation) return bulletedStatusTranslation;

        const workingStatusTranslation = getWorkingStatusTranslation(normalized);
        if (workingStatusTranslation) return workingStatusTranslation;

        const executionTimingTranslation = getExecutionTimingTranslation(normalized);
        if (executionTimingTranslation) return executionTimingTranslation;

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

        const toolMatch = normalized.match(/^(\\d+)\\s+tools?\\s+enabled$/i);
        if (toolMatch) return toolMatch[1] + " 个工具已启用";

        const scheduleMatch = normalized.match(/^All (scheduled tasks|automations) run (?:as|with the)\\s+(.+?)(?:\\s+model)?[.。]?$/i);
        if (scheduleMatch) {
            const entity = scheduleMatch[1].toLowerCase() === "automations" ? "自动化" : "计划任务";
            const model = scheduleMatch[2].replace(/[.。]+$/, '').trim();
            if (model) return "所有" + entity + "均以 " + model + " 模型运行";
        }
        const viewArchivedHistMatch = normalized.match(/^View(?:\\s+(\\d+))?\\s+archived conversations?\\s+in\\s+History[.。]?$/i);
        if (viewArchivedHistMatch) {
            return viewArchivedHistMatch[1]
                ? "在“历史记录”中查看 " + viewArchivedHistMatch[1] + " 个已归档会话"
                : "可在“历史记录”中查看已归档的会话";
        }
        const viewArchivedMatch = normalized.match(/^View(?:\\s+(\\d+))?\\s+archived conversations?(?:\\s+in)?$/i);
        if (viewArchivedMatch) {
            const countText = viewArchivedMatch[1] ? " " + viewArchivedMatch[1] + " 个" : "";
            return "查看" + countText + "已归档会话" + (/in$/i.test(normalized) ? "，请前往 " : "");
        }
        const deleteProjectPrefixMatch = normalized.match(/^Are you sure you want to delete\\s+(?:the\\s+|this\\s+)?(project|workspace|项目|工作区)$/i);
        if (deleteProjectPrefixMatch) {
            const scope = /^(?:workspace|工作区)$/i.test(deleteProjectPrefixMatch[1]) ? "工作区" : "项目";
            return "您确定要删除" + scope + (/\\s$/.test(value) ? " " : "");
        }

        return null;
    }

    function translateCombinedTextChildren(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || !element.childNodes || element.childNodes.length < 2) {
            return false;
        }

        let hasAdjacentTextNodes = false;
        for (let i = 0; i < element.childNodes.length - 1; i++) {
            if (element.childNodes[i].nodeType === Node.TEXT_NODE && element.childNodes[i + 1].nodeType === Node.TEXT_NODE) {
                hasAdjacentTextNodes = true;
                break;
            }
        }
        if (!hasAdjacentTextNodes) return false;
        if (isInBlockedZone(element) || isContentBodyContainer(element)) return false;

        const boundedText = getBoundedTextContent(element, 16, 240);
        if (boundedText !== null && getCompactCountLabelTranslation(boundedText)) return false;

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
        if (!currentText || currentText.length > 120) return null;

        let _prevLoaded = false;
        let _previous = null;
        let _previousText = '';
        const getPrev = () => {
            if (!_prevLoaded) {
                _prevLoaded = true;
                _previous = findPreviousTextNode(node);
                _previousText = _previous ? norm(_previous.nodeValue) : '';
            }
            return _previous;
        };
        const getPrevText = () => {
            getPrev();
            return _previousText;
        };

        if (/^(?:Default|Full machine|Turbo mode|Custom|Inherit Global|默认|全机访问|极速模式|自定义|继承全局)$/i.test(currentText)) {
            const previousText = getPrevText();
            if (/^(?:Learn more about|了解更多关于)$/i.test(previousText)) {
                replaceTextNode(getPrev(), "了解更多关于 ");
                const presetMap = {
                    'default': "默认",
                    'full machine': "全机访问",
                    'turbo mode': "极速模式",
                    'custom': "自定义",
                    'inherit global': "继承全局"
                };
                return presetMap[currentText.toLowerCase()] || currentText;
            }
        }

        if (/^to be installed\\.?$/i.test(currentText)) {
            const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 500) || '') : '';
            if (/^Google Chrome$/i.test(getPrevText()) || /(?:browser subagent|浏览器子智能体|Google Chrome)/i.test(parentText)) {
                return ". ";
            }
        }
        if (/^to ask for content changes for legal reasons[.。]?$/i.test(currentText)) {
            const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 400) || '') : '';
            if (/^(?:Legal Help|法律帮助)$/i.test(getPrevText()) || /(?:Legal Help|法律帮助)/i.test(parentText)) {
                return " 页面";
            }
        }
        if (/^Visit$/i.test(currentText)) {
            const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 400) || '') : '';
            if (/(?:Legal Help|法律帮助)/i.test(parentText) && /(?:to ask for content changes for legal reasons|出于法律原因)/i.test(parentText)) {
                return "若出于法律原因需要申请更改内容，请访问 ";
            }
        }
        if (/^(?:,?\\s*found here:?|found here:?)$/i.test(currentText)) {
            const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 500) || '') : '';
            if (/(?:Privacy Policy|隐私政策)/i.test(getPrevText()) || /(?:third party developer tools|第三方开发者工具|policies\\.google\\.com)/i.test(parentText)) {
                return " 保护任何此类数据，具体请参见此处:";
            }
        }
        if (/^Google does not control the availability or functionality of third party developer tools\\.\\s*Your data from third party developer tools connected to your Antigravity instance may be shared with Google\\.\\s*Google will protect any such data in accordance with the$/i.test(currentText)) {
            return "Google 无法控制第三方开发者工具的可用性或功能. 从连接到您 Antigravity 实例的第三方开发者工具中获取的数据可能会与 Google 共享. Google 将根据 ";
        }
        if (/^Google will protect any such data in accordance with the$/i.test(currentText)) {
            const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 500) || '') : '';
            if (/(?:third party developer tools|第三方开发者工具)/i.test(parentText)) {
                return "Google 将根据 ";
            }
        }
        const toBeInstalledMatch = currentText.match(/^to be installed\\.\\s*(.+)$/i);
        if (toBeInstalledMatch) {
            const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 500) || '') : '';
            if (/^Google Chrome$/i.test(getPrevText()) || /(?:browser subagent|浏览器子智能体|Google Chrome)/i.test(parentText)) {
                const rest = toBeInstalledMatch[1];
                const restTrans = map.get(norm(rest)) || lowerMap.get(norm(rest).toLowerCase()) || rest;
                return ". " + restTrans;
            }
        }

        const commentCountMatch = currentText.match(/^[（(]\\s*(\\d+)\\s*[)）]$/);
        if (commentCountMatch && /^(?:Comments?|评论)$/i.test(getPrevText())) {
            replaceTextNode(getPrev(), "评论");
            return "(" + commentCountMatch[1] + ")";
        }

        const statusItemMatch = currentText.match(STATUS_ITEM_REGEX);
        if (statusItemMatch && getPrev()) {
            const previousText = getPrevText();
            if (/^(?:Explored|Exploring|ran|run|executed|edited|editing)\\s+\\d+$/i.test(previousText) || /^\\d+$/.test(previousText)) {
                markThoughtContentSibling(node);
                return null;
            }
        }

        let statusMatch = currentText.match(/^(?:subagents?|子智能体)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch) {
            const previous = getPrev();
            const previousText = getPrevText();
            if (/^Found$/i.test(previousText)) {
                replaceTextNode(previous, "已找到");
                return "子智能体" + (statusMatch[1] ? " " + statusMatch[1] : "");
            }
            if (/^\\d+$/.test(previousText)) {
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
        }

        statusMatch = currentText.match(/^(?:Browsers?|浏览器)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Found$/i.test(getPrevText())) {
            replaceTextNode(getPrev(), "已找到");
            return "浏览器" + (statusMatch[1] ? " " + statusMatch[1] : "");
        }

        statusMatch = currentText.match(/^(\\d+)\\s+subagents?(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch) {
            const previous = getPrev();
            const previousText = getPrevText();
            if (/^Found$/i.test(previousText)) {
                replaceTextNode(previous, "找到");
                return " " + statusMatch[1] + " 个子智能体" + (statusMatch[2] ? " " + statusMatch[2] : "");
            }
            if (/^(?:Killed|已中止)$/i.test(previousText)) {
                replaceTextNode(previous, "已中止");
                return " " + statusMatch[1] + " 个子智能体" + (statusMatch[2] ? " " + statusMatch[2] : "");
            }
        }

        statusMatch = currentText.match(/^(\\d+)\\s+(seconds?|minutes?|hours?)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Timed$/i.test(getPrevText())) {
            const unit = /^second/i.test(statusMatch[2]) ? "秒" : /^minute/i.test(statusMatch[2]) ? "分钟" : "小时";
            replaceTextNode(getPrev(), "耗时");
            return " " + statusMatch[1] + " " + unit + (statusMatch[3] ? " " + statusMatch[3] : "");
        }
        statusMatch = currentText.match(/^(seconds?|minutes?|hours?)(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^\\d+$/.test(getPrevText())) {
            const timedNode = findPreviousTextNode(getPrev());
            if (timedNode && /^Timed$/i.test(norm(timedNode.nodeValue))) {
                const unit = /^second/i.test(statusMatch[1]) ? "秒" : /^minute/i.test(statusMatch[1]) ? "分钟" : "小时";
                replaceTextNode(timedNode, "耗时 ");
                return " " + unit + (statusMatch[2] ? " " + statusMatch[2] : "");
            }
        }

        statusMatch = currentText.match(/^Root\\s+Agent(?:\\s*([>›❯〉→]))?$/i);
        if (statusMatch && /^Messaged$/i.test(getPrevText())) {
            replaceTextNode(getPrev(), "已向");
            return "主智能体发送消息" + (statusMatch[1] ? " " + statusMatch[1] : "");
        }

        statusMatch = currentText.match(/^(\\d+)\\s+active\\s+goals?$/i);
        if (statusMatch && /^(\\d+)\\s+tasks?\\s+running,?$/i.test(getPrevText())) {
            const taskCount = getPrevText().match(/^(\\d+)/)[1];
            replaceTextNode(getPrev(), taskCount + " 个任务正在运行，");
            return statusMatch[1] + " 个活跃目标";
        }
        if (/^active\\s+goals?$/i.test(currentText) && /^\\d+$/.test(getPrevText())) {
            return " 个活跃目标";
        }

        if (/^found$/i.test(currentText) && getPrevText() === "项目") {
            const noNode = findPreviousTextNode(getPrev());
            if (noNode && /^No$/i.test(norm(noNode.nodeValue))) {
                replaceTextNode(noNode, '');
                replaceTextNode(getPrev(), "未找到项目");
                return '';
            }
        }

        if (/^(?:when not in a project|in this project|in this workspace|in this conversation)$/i.test(currentText) && getPrev()) {
            const previous = getPrev();
            const previousText = getPrevText();
            const isAllow = /^(?:Yes, and always allow|是，且始终允许)$/i.test(previousText);
            const isSaveRule = /^(?:Yes, save rule|是，保存规则)$/i.test(previousText);
            if (isAllow || isSaveRule) {
                let scopeTrans = "";
                if (/^in this project$/i.test(currentText)) scopeTrans = "在此项目中";
                else if (/^when not in a project$/i.test(currentText)) scopeTrans = "在不属于任何项目时";
                else if (/^in this workspace$/i.test(currentText)) scopeTrans = "在此工作区中";
                else if (/^in this conversation$/i.test(currentText)) scopeTrans = "在此会话中";

                if (isAllow) {
                    replaceTextNode(previous, "是，且" + scopeTrans + "始终允许");
                } else {
                    replaceTextNode(previous, "是，" + scopeTrans + "保存规则");
                }
                return '';
            }
        }

        if (/^s\\s+enabled$/i.test(currentText) && getPrev()) {
            const countAndTool = getPrevText().match(/^(\\d+)\\s+tools?$/i);
            if (countAndTool) {
                replaceTextNode(getPrev(), countAndTool[1] + " 个工具已启用");
                return '';
            }
        }

        const isEnabledSuffix = /^s\\s+enabled$/i.test(currentText) || /^enabled$/i.test(currentText);
        if (isEnabledSuffix && getPrev()) {
            const previous = getPrev();
            let toolNode = previous;
            let toolText = getPrevText();

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

        if (currentText.length <= 40 && !/[\\u4e00-\\u9fff]/.test(currentText) &&
            node.previousSibling &&
            node.parentElement && node.parentElement.childNodes && node.parentElement.childNodes.length >= 2 &&
            getPrevText() === "所有计划任务均以") {
            const model = currentText.replace(/[.。]+$/, '').trim();
            if (model) return model + " 模型运行";
        }

        if (/^[.。]$/.test(currentText) && /模型运行$/.test(getPrevText())) {
            return '';
        }

        if (/^\\?\\s*(?:This action cannot be undone\\.?)?$/i.test(currentText) && getPrev()) {
            let candidate = getPrev();
            for (let i = 0; i < 6 && candidate; i++) {
                if (/^您确定要删除(?:计划)?任务$/.test(norm(candidate.nodeValue))) {
                    return /This action cannot be undone/i.test(currentText)
                        ? " 吗? 此操作无法撤销"
                        : " 吗?";
                }
                candidate = findPreviousTextNode(candidate);
            }
        }

        const deletePrefixMatch = currentText.match(/^Are you sure you want to delete(?:\\s+(?:the|this))?(?:\\s+(project|workspace|项目|工作区))?$/i);
        if (deletePrefixMatch) {
            let container = node && node.parentElement;
            for (let depth = 0; depth < 3 && container; depth++) {
                if (container === document.body || container === document.documentElement) break;
                const containerText = getBoundedTextContent(container, 16, 320) || '';
                if (/^Are you sure you want to delete\\s+(?:the\\s+|this\\s+)?(?:project|workspace|项目|工作区)\\s+.+\\?$/i.test(containerText)) {
                    if (deletePrefixMatch[1]) {
                        const scope = /^(?:workspace|工作区)$/i.test(deletePrefixMatch[1]) ? "工作区" : "项目";
                        return "您确定要删除" + scope + (/\\s$/.test(originalVal) ? " " : "");
                    }
                    return "您确定要删除";
                }
                container = container.parentElement;
            }
        }

        if (/^(?:project|workspace)$/i.test(currentText) && getPrev()) {
            let candidate = getPrev();
            for (let i = 0; i < 4 && candidate; i++) {
                const candidateText = norm(candidate.nodeValue);
                if (/^您确定要删除\\s*$/.test(candidateText) || /^Are you sure you want to delete(?:\\s+(?:the|this))?$/i.test(candidateText)) {
                    return /workspace/i.test(currentText) ? "工作区 " : "项目 ";
                }
                candidate = findPreviousTextNode(candidate);
            }
        }

        if (currentText === '?' && getPrev()) {
            let candidate = getPrev();
            let hasProjectScope = false;
            for (let i = 0; i < 8 && candidate; i++) {
                const candidateText = norm(candidate.nodeValue);
                if (/^(?:project|workspace|项目|工作区)$/i.test(candidateText)) {
                    hasProjectScope = true;
                } else if (candidateText === "您确定要删除" && hasProjectScope) {
                    return " 吗?";
                } else if (/^您确定要删除(?:项目|工作区)$/.test(candidateText)) {
                    return " 吗?";
                }
                candidate = findPreviousTextNode(candidate);
            }
        }

        if (/^(?:Daily|Weekly|Monthly)$/i.test(currentText)) {
            const parent = node.parentElement;
            const outer = (parent && parent.parentElement) || parent;
            const containerText = outer ? (getBoundedTextContent(outer, 16, 120) || '') : '';
            if (/(?:around|at|在)/i.test(containerText)) {
                const freqMap = {
                    daily: "每天",
                    weekly: "每周",
                    monthly: "每月"
                };
                return freqMap[currentText.toLowerCase()];
            }
        }

        if (/^on$/i.test(currentText) && getPrev()) {
            const prevText = getPrevText();
            const parent = node.parentElement;
            const containerText = parent ? (getBoundedTextContent(parent, 16, 120) || '') : '';
            if (/^(?:每周|Weekly)$/i.test(prevText) && /(?:around|at|在)/i.test(containerText)) {
                const nextSibling = node.nextSibling;
                if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE && nextSibling.nodeValue && nextSibling.nodeValue.trim() === '') {
                    replaceTextNode(nextSibling, '');
                }
                return "";
            }
        }

        if (/^(?:around|at)$/i.test(currentText) && getPrev()) {
            const prevText = getPrevText();
            if (/^(?:每天|每周|每月|Daily|Weekly|Monthly|星期[一二三四五六日]|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|每周星期[一二三四五六日]|Weekly\\s+on\\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))$/i.test(prevText)) {
                return "在 ";
            }
        }

        const weeklyOnDayMatch = currentText.match(/^Weekly\\s+on\\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i);
        if (weeklyOnDayMatch) {
            const dayMap = {
                monday: "星期一", tuesday: "星期二", wednesday: "星期三",
                thursday: "星期四", friday: "星期五", saturday: "星期六", sunday: "星期日"
            };
            return "每周" + (dayMap[weeklyOnDayMatch[1].toLowerCase()] || weeklyOnDayMatch[1]);
        }

        if (/^Weekly\\s+on$/i.test(currentText)) {
            return "每周";
        }

        if (/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(currentText) && getPrev()) {
            const prevText = getPrevText();
            const parent = node.parentElement;
            const outer = (parent && parent.parentElement) || parent;
            const containerText = outer ? (getBoundedTextContent(outer, 16, 120) || '') : '';
            if ((/^(?:每周|Weekly(?:\\s+on)?|on)$/i.test(prevText)) && /(?:around|at|在)/i.test(containerText)) {
                const dayMap = {
                    monday: "星期一", tuesday: "星期二", wednesday: "星期三",
                    thursday: "星期四", friday: "星期五", saturday: "星期六", sunday: "星期日"
                };
                return dayMap[currentText.toLowerCase()];
            }
        }

        if (/^in$/i.test(currentText)) {
            const previous = getPrev();
            const previousText = getPrevText();
            if (previousText === "个已归档会话" || previousText === "已归档会话" || previousText === "个已归档对话" || previousText === "已归档对话" || previousText === "archived conversation" || previousText === "archived conversations") {
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
        }

        return null;
    }

    function translateElementAttributes(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        const blockedState = getElementBlockedState(node);
        if (blockedState === 2) {
            const tag = node.tagName ? node.tagName.toUpperCase() : '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SVG') {
                const parentState = getElementBlockedState(node.parentElement);
                for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'aria-label']) {
                    const v = node.getAttribute(attr);
                    if (v) {
                        const searchingTrans = getSearchingStatusTranslation(v);
                        if (searchingTrans && searchingTrans !== v) {
                            node.setAttribute(attr, searchingTrans);
                        } else if (parentState === 0) {
                            const t = norm(v);
                            const target = getVersionControlUiTranslation(t)
                                || getDynamicSubagentStatusTranslation(t)
                                || getDynamicProductUiTranslation(t)
                                || getCompactCountLabelTranslation(t)
                                || translateWithShortcut(t)
                                || map.get(t)
                                || lowerMap.get(t.toLowerCase());
                            if (target && target !== v) node.setAttribute(attr, target);
                        }
                    }
                }
            }
            return;
        }
        if (node.getAttribute('contenteditable') === 'true') {
            for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'aria-label', 'title']) {
                const value = node.getAttribute(attr);
                if (!value) continue;
                const normalizedValue = norm(value);
                const target = getVersionControlUiTranslation(normalizedValue)
                    || translateWithShortcut(normalizedValue)
                    || map.get(normalizedValue)
                    || lowerMap.get(normalizedValue.toLowerCase());
                if (target && target !== value) node.setAttribute(attr, target);
            }
            return;
        }
        if (blockedState === 0 || node.tagName === 'BUTTON' || node.getAttribute?.('role') === 'button') {
            for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'aria-label']) {
                const v = node.getAttribute(attr);
                if (v) {
                    const searchingTrans = getSearchingStatusTranslation(v);
                    if (searchingTrans && searchingTrans !== v) {
                        node.setAttribute(attr, searchingTrans);
                    } else {
                        const t = norm(v);
                        const target = getVersionControlUiTranslation(t)
                            || getDynamicSubagentStatusTranslation(t)
                            || getDynamicProductUiTranslation(t)
                            || getCompactCountLabelTranslation(t)
                            || translateWithShortcut(t)
                            || map.get(t)
                            || lowerMap.get(t.toLowerCase());
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
    }

    function translateNode(node, parentContainersScanned = false, visitedElements = null) {
        try {
            if (!node) return;

            if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                for (const child of node.childNodes) translateNode(child, false, visitedElements);
                return;
            }

            if (node.nodeType === Node.ELEMENT_NODE) {
                if (visitedElements) {
                    if (visitedElements.has(node)) return;
                    visitedElements.add(node);
                }
                if (node.hasAttribute(SKIP_TRANSLATION_ATTR)) return;
                const prev = node.previousElementSibling;
                if (prev && prev.hasAttribute('data-ag-thought-header') && node.parentElement && node.parentElement.children.length === 2) {
                    node.setAttribute(SKIP_TRANSLATION_ATTR, 'true');
                    blockedZoneCache.set(node, -1);
                    return;
                }

                const tag = node.tagName.toUpperCase();
                const className = typeof node.className === 'string' ? node.className : '';

                if (className && HARD_PRUNED_CLASS_REGEX.test(className)) {
                    if (node.getAttribute('translate') !== 'no') node.setAttribute('translate', 'no');
                    try {
                        if (!node.classList.contains('notranslate')) node.classList.add('notranslate');
                    } catch (e) {}
                    blockedZoneCache.set(node, -1);
                    return;
                }

                let isBlocked = BLOCKED_TAGS_SET.has(tag);
                if (!isBlocked && className) {
                    for (let i = 0; i < BLOCKED_CLASSES.length; i++) {
                        if (className.includes(BLOCKED_CLASSES[i])) {
                            isBlocked = true;
                            break;
                        }
                    }
                }
                if (node.getAttribute('contenteditable') === 'true') {
                    isBlocked = true;

                    for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'aria-label', 'title']) {
                        const value = node.getAttribute(attr);
                        if (!value) continue;
                        const normalizedValue = norm(value);
                        const target = getVersionControlUiTranslation(normalizedValue)
                            || translateWithShortcut(normalizedValue)
                            || map.get(normalizedValue)
                            || lowerMap.get(normalizedValue.toLowerCase());
                        if (target && target !== value) node.setAttribute(attr, target);
                    }
                }

                const shouldMarkBlocked = isBlocked &&
                    (!BLOCKED_TAGS_SET.has(tag) || AUTO_TRANSLATE_PROTECTED_TAGS.has(tag));
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

                if (BLOCKED_TAGS_SET.has(tag)) {
                    blockedZoneCache.set(node, -1);
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SVG') {
                        const parentBlocked = getElementBlockedState(node.parentElement) !== 0;
                        for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'aria-label']) {
                            const v = node.getAttribute(attr);
                            if (v) {
                                const searchingTrans = getSearchingStatusTranslation(v);
                                if (searchingTrans && searchingTrans !== v) {
                                    node.setAttribute(attr, searchingTrans);
                                } else if (!parentBlocked) {
                                    const t = norm(v);
                                    const target = getVersionControlUiTranslation(t)
                                        || getDynamicSubagentStatusTranslation(t)
                                        || getDynamicProductUiTranslation(t)
                                        || getCompactCountLabelTranslation(t)
                                        || translateWithShortcut(t)
                                        || map.get(t)
                                        || lowerMap.get(t.toLowerCase());
                                    if (target && target !== v) node.setAttribute(attr, target);
                                }
                            }
                        }
                    }
                    return;
                }

                const blockedState = getElementBlockedState(node);
                if (blockedState === 2) return;

                const isFoldButtonContainer = tag === 'BUTTON' || node.getAttribute?.('role') === 'button';
                if (blockedState === 0 || isFoldButtonContainer) {
                    if (translateSpecialContainers(node) === 'skip_children') return;
                    translateCombinedTextChildren(node);
                    for (const attr of ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'aria-label']) {
                        const v = node.getAttribute(attr);
                        if (v) {
                            const searchingTrans = getSearchingStatusTranslation(v);
                            if (searchingTrans && searchingTrans !== v) {
                                node.setAttribute(attr, searchingTrans);
                            } else {
                                const t = norm(v);
                                const target = getVersionControlUiTranslation(t)
                                    || getDynamicSubagentStatusTranslation(t)
                                    || getDynamicProductUiTranslation(t)
                                    || getCompactCountLabelTranslation(t)
                                    || translateWithShortcut(t)
                                    || map.get(t)
                                    || lowerMap.get(t.toLowerCase());
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

                if (node.shadowRoot) translateNode(node.shadowRoot, false, visitedElements);
                for (const child of node.childNodes) translateNode(child, true, visitedElements);

            } else if (node.nodeType === Node.TEXT_NODE) {
                let originalVal = node.nodeValue;
                if (!originalVal || originalVal.trim().length < 1) return;
                if (translatedValues.get(node) === originalVal) return;

                const parentEl = node.parentElement;
                const parentBlockedState = getElementBlockedState(parentEl);
                if (parentBlockedState === 2) return;

                if (originalVal.length >= 9 && (originalVal.includes('pack.info') || originalVal.includes('PACK.INFO') || originalVal.toLowerCase().includes('pack.info'))) {
                    if (parentEl) {
                        if (parentEl.getAttribute('translate') !== 'no') {
                            parentEl.setAttribute('translate', 'no');
                        }
                        try {
                            if (!parentEl.classList.contains('notranslate')) {
                                parentEl.classList.add('notranslate');
                            }
                        } catch (e) {}
                    }
                    return;
                }

                if (parentBlockedState === 1 || isInSkillItemContext(node)) {
                    const protectedProductUiTranslation = getProtectedProductUiTranslation(node, originalVal);
                    if (protectedProductUiTranslation) {
                        replaceTextNode(node, protectedProductUiTranslation);
                    }
                    return;
                }

                if (translateAttachmentMenuFolder(node, originalVal)) return;
                if (translateSkillPickerNameTextNode(node, originalVal)) return;
                if (translateUsedSkillNameTextNode(node, originalVal)) return;
                if (translateCommitSummaryTextNode(node, originalVal)) return;
                if (!parentContainersScanned && translateSpecialContainers(parentEl)) return;
                if (!parentContainersScanned && translateCombinedTextChildren(parentEl)) return;

                let newVal = originalVal;
                const hasRecommended = /^\\(Recommended\\)(?:\\s+|$)/i.test(newVal);
                if (hasRecommended) {
                    newVal = newVal.replace(/^\\(Recommended\\)(?:\\s+|$)/i, '');
                }
                const valNorm = norm(newVal);
                if (!valNorm) return;

                if (!/[a-zA-Z]/.test(valNorm)) {
                    let dynNonAlpha = null;
                    if (/^[（(.。?]/.test(valNorm)) {
                        dynNonAlpha = translateFragmentedStatus(node, originalVal);
                    }
                    if (dynNonAlpha === null && /^[●•·◦∙○\\u2022\\u25CF\\u25CB]/.test(valNorm)) {
                        dynNonAlpha = getBulletedStatusTranslation(valNorm);
                    }
                    if (dynNonAlpha !== null && dynNonAlpha !== undefined) {
                        newVal = dynNonAlpha;
                    }
                    if (hasRecommended) {
                        newVal = '（推荐）' + newVal;
                    }
                    if (newVal !== originalVal) {
                        const leadingMatch = originalVal.match(/^\\s+/);
                        const trailingMatch = originalVal.match(/\\s+$/);
                        if (leadingMatch && !newVal.startsWith(leadingMatch[0])) {
                            newVal = leadingMatch[0] + newVal;
                        }
                        if (trailingMatch && !newVal.endsWith(trailingMatch[0])) {
                            newVal = newVal + trailingMatch[0];
                        }
                        if (newVal !== originalVal) {
                            translatedValues.set(node, newVal);
                            node.nodeValue = newVal;
                            return;
                        }
                    }
                    if (parentEl && parentEl.childNodes.length === 1) {
                        translatedValues.set(node, originalVal);
                    }
                    return;
                }

                if (isCollapsibleActivityHeader(valNorm)) {
                    markThoughtContentSibling(node);
                    return;
                }
                const valLower = valNorm.toLowerCase();

                let dynRes;
                if (map.has(valNorm) && !/^(?:Build With\\b|All (?:automations|scheduled tasks)\\b|Allow reading\\b|No suggestions|Previous match|0 results|Visit$|Browsers?$|enabled$)/i.test(valNorm) && isIsolatedUiControlLabel(node, valNorm, originalVal)) {
                    newVal = map.get(valNorm);
                    if ((valNorm === 'Modified in' || valNorm === 'Also modified in') && /\\s$/.test(originalVal)) {
                        newVal += ' ';
                    }
                } else if ((dynRes = translateFragmentedStatus(node, originalVal)) !== null) {
                    newVal = dynRes;
                } else if ((dynRes = translateQuestionnaireOptionLabel(node, valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getTimestampNowTranslation(node, valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getRecentProjectSectionTranslation(node, valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getDeleteTaskConfirmationTranslation(node, valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = translateWithShortcut(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getVersionControlUiTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getBaselineQuotaRefreshTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getDynamicSubagentStatusTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getBracketedTaskStatusTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getBulletedStatusTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getDynamicProductUiTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getProjectDeleteSummaryTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getCustomizationBudgetTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getArtifactFileCountTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getCommandInputStatusTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getRelativeTimeTranslation(valNorm, node))) {
                    newVal = dynRes;
                } else if ((dynRes = getWorkingStatusTranslation(valNorm))) {
                    markThoughtContentSibling(node);
                    newVal = dynRes;
                } else if ((dynRes = getExecutionTimingTranslation(valNorm))) {
                    markThoughtContentSibling(node);
                    newVal = dynRes;
                } else if ((dynRes = getSearchingStatusTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getCompactCountLabelTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getArtifactTimestampTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getQuotaNoticeTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getArchivedConversationNoticeTranslation(valNorm))) {
                    newVal = dynRes;
                } else if ((dynRes = getAutomationScheduleTranslation(valNorm))) {
                    newVal = dynRes;
                } else if (map.has(valNorm) && isIsolatedUiControlLabel(node, valNorm, originalVal)) {
                    newVal = map.get(valNorm);
                    if ((valNorm === 'Modified in' || valNorm === 'Also modified in') && /\\s$/.test(originalVal)) {
                        newVal += ' ';
                    }
                } else if (lowerMap.has(valLower) && isIsolatedUiControlLabel(node, valNorm, originalVal)) {
                    newVal = lowerMap.get(valLower);
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
                } else if (/^(?:Refreshes in |Resets in |You have (?:used|hit) |Your 5-hour limit )/i.test(valNorm)) {
                    if (/^Refreshes in (\\d+) days?, (\\d+) hours?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Refreshes in (\\d+) days?, (\\d+) hours?$/i, (match, d, h) => d + " 天 " + h + " 小时后刷新");
                    } else if (/^Refreshes in (\\d+) hours?, (\\d+) minutes?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Refreshes in (\\d+) hours?, (\\d+) minutes?$/i, (match, h, m) => h + " 小时 " + m + " 分钟后刷新");
                    } else if (/^Refreshes in (\\d+) days?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Refreshes in (\\d+) days?$/i, (match, d) => d + " 天后刷新");
                    } else if (/^Refreshes in (\\d+) hours?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Refreshes in (\\d+) hours?$/i, (match, h) => h + " 小时后刷新");
                    } else if (/^Refreshes in (\\d+) minutes?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Refreshes in (\\d+) minutes?$/i, (match, m) => m + " 分钟后刷新");
                    } else if (/^Resets in <1m$/i.test(valNorm)) {
                        newVal = "不足 1 分钟后重置";
                    } else if (/^Resets in (?:(\\d+)\\s*(?:d|days?))?\\s*,?\\s*(?:(\\d+)\\s*(?:h|hours?))?\\s*,?\\s*(?:(\\d+)\\s*(?:m|mins?|minutes?))?\\s*,?\\s*(?:(\\d+)\\s*(?:s|secs?|seconds?))?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Resets in (?:(\\d+)\\s*(?:d|days?))?\\s*,?\\s*(?:(\\d+)\\s*(?:h|hours?))?\\s*,?\\s*(?:(\\d+)\\s*(?:m|mins?|minutes?))?\\s*,?\\s*(?:(\\d+)\\s*(?:s|secs?|seconds?))?$/i, (match, d, h, m, s) => {
                            let parts = [];
                            if (d) parts.push(d + " 天");
                            if (h) parts.push(h + " 小时");
                            if (m) parts.push(m + " 分钟");
                            if (s) parts.push(s + " 秒");
                            return parts.length ? parts.join(" ") + "后重置" : match;
                        });
                    } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i, (match, d, h) => "您已使用部分每周配额，将在 " + d + " 天 " + h + " 小时后完全刷新");
                    } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => "您已使用部分每周配额，将在 " + h + " 小时 " + m + " 分钟后完全刷新");
                    } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) days?\\.$/i, (match, d) => "您已使用部分每周配额，将在 " + d + " 天后完全刷新");
                    } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i, (match, h) => "您已使用部分每周配额，将在 " + h + " 小时后完全刷新");
                    } else if (/^You have used some of your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i, (match, m) => "您已使用部分每周配额，将在 " + m + " 分钟后完全刷新");
                    } else if (/^You have used some of your weekly limit, it will fully refresh in less than a minute\\.$/i.test(valNorm)) {
                        newVal = "您已使用部分每周配额，将在不到 1 分钟后完全刷新";
                    } else if (/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => "您已使用部分 5 小时配额，将在 " + h + " 小时 " + m + " 分钟后完全刷新");
                    } else if (/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) hours?\\.$/i, (match, h) => "您已使用部分 5 小时配额，将在 " + h + " 小时后完全刷新");
                    } else if (/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have used some of your 5-hour limit, it will fully refresh in (\\d+) minutes?\\.$/i, (match, m) => "您已使用部分 5 小时配额，将在 " + m + " 分钟后完全刷新");
                    } else if (/^You have used some of your 5-hour limit, it will fully refresh in less than a minute\\.$/i.test(valNorm)) {
                        newVal = "您已使用部分 5 小时配额，将在不到 1 分钟后完全刷新";
                    } else if (/^Your 5-hour limit will refresh in (\\d+) days?, (\\d+) hours?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) days?, (\\d+) hours?\\.$/i, (match, d, h) => "您的 5 小时配额将在 " + d + " 天 " + h + " 小时后刷新");
                    } else if (/^Your 5-hour limit will refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => "您的 5 小时配额将在 " + h + " 小时 " + m + " 分钟后刷新");
                    } else if (/^Your 5-hour limit will refresh in (\\d+) days?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) days?\\.$/i, (match, d) => "您的 5 小时配额将在 " + d + " 天后刷新");
                    } else if (/^Your 5-hour limit will refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) hours?\\.$/i, (match, h) => "您的 5 小时配额将在 " + h + " 小时后刷新");
                    } else if (/^Your 5-hour limit will refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Your 5-hour limit will refresh in (\\d+) minutes?\\.$/i, (match, m) => "您的 5 小时配额将在 " + m + " 分钟后刷新");
                    } else if (/^Your 5-hour limit will refresh in less than a minute\\.$/i.test(valNorm)) {
                        newVal = "您的 5 小时配额将在不到 1 分钟后刷新";
                    } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) days?, (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) days?, (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, d, h) => "您已达到 5 小时配额限制，将在 " + d + " 天 " + h + " 小时后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.");
                    } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?, (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?, (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, h, m) => "您已达到 5 小时配额限制，将在 " + h + " 小时 " + m + " 分钟后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.");
                    } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) days?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) days?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, d) => "您已达到 5 小时配额限制，将在 " + d + " 天后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.");
                    } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, h) => "您已达到 5 小时配额限制，将在 " + h + " 小时后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.");
                    } else if (/^You have hit your 5-hour limit, it will refresh in (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your 5-hour limit, it will refresh in (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i, (match, m) => "您已达到 5 小时配额限制，将在 " + m + " 分钟后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.");
                    } else if (/^You have hit your 5-hour limit, it will refresh in less than a minute\\. If on a supported paid plan, you can use AI credits in the interim\\.$/i.test(valNorm)) {
                        newVal = "您已达到 5 小时配额限制，将在不到 1 分钟后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.";
                    } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\.$/i, (match, d, h) => "您已达到每周配额限制，将在 " + d + " 天 " + h + " 小时后完全刷新");
                    } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\.$/i, (match, h, m) => "您已达到每周配额限制，将在 " + h + " 小时 " + m + " 分钟后完全刷新");
                    } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) days?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) days?\\.$/i, (match, d) => "您已达到每周配额限制，将在 " + d + " 天后完全刷新");
                    } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) hours?\\.$/i, (match, h) => "您已达到每周配额限制，将在 " + h + " 小时后完全刷新");
                    } else if (/^You have hit your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^You have hit your weekly limit, it will fully refresh in (\\d+) minutes?\\.$/i, (match, m) => "您已达到每周配额限制，将在 " + m + " 分钟后完全刷新");
                    } else if (/^You have hit your weekly limit, it will fully refresh in less than a minute\\.$/i.test(valNorm)) {
                        newVal = "您已达到每周配额限制，将在不到 1 分钟后完全刷新";
                    }
                } else if (/^Error ID:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Error ID:\\s*(.+)$/i, (match, id) => "错误 ID: " + id);
                } else if (/^Models within this group:\\s*(.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Models within this group:\\s*(.+)$/i, (match, models) => "此组内的模型: " + models);
                } else if (/^Executor is not currently running \\(error ID:\\s*(.+)\\)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Executor is not currently running \\(error ID:\\s*(.+)\\)$/i, (match, id) => "执行器当前未运行 (错误 ID: " + id + ")");
                } else if (valNorm.endsWith(')') && /^(?:Match (?:case|whole word)|Use regular expression|(?:Previous|Next) match|Close) \\(/i.test(valNorm)) {
                    if (/^Match case \\((.+)\\)$/i.test(valNorm)) {
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
                    }
                } else if (/^Learn more about (.+)$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^Learn more about (.+)$/i, (match, p) => {
                        let translatedPreset = p;
                        const pLower = p.toLowerCase().trim();
                        if (pLower === 'default') translatedPreset = "默认";
                        else if (pLower === 'full machine') translatedPreset = "全机访问";
                        else if (pLower === 'turbo mode') translatedPreset = "极速模式";
                        else if (pLower === 'custom') translatedPreset = "自定义";
                        else if (pLower === 'inherit global') translatedPreset = "继承全局";
                        else if (map.has(norm(p))) translatedPreset = map.get(norm(p));
                        else if (lowerMap.has(pLower)) translatedPreset = lowerMap.get(pLower);
                        return "了解更多关于 " + translatedPreset + " 的信息";
                    });
                } else if (/^\\d+\\s+(?:tools?|active|archived|tasks?|files?|subagents?|questions?)\\b/i.test(valNorm)) {
                    if (/^(\\d+) tools? enabled$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^(\\d+) tools? enabled$/i, (match, num) => num + " 个工具已启用");
                    } else if (/^(\\d+) active conversations?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^(\\d+) active conversations?$/i, (match, num) => num + " 个活跃会话");
                    } else if (/^(\\d+) archived conversations?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^(\\d+) archived conversations?$/i, (match, num) => num + " 个已归档会话");
                    } else if (/^(\\d+) tasks? running$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^(\\d+) tasks? running$/i, (match, num) => num + " 个任务正在运行");
                    } else if (/^(\\d+) files? changed$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^(\\d+) files? changed$/i, (match, num) => num + " 个文件已更改");
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
                        newVal = valNorm.replace(/^(\\d+)\\s+questions?$/i, (match, num) => num + " 个问题");
                    }
                } else if (/^(?:Show (?:\\d+)|See all \\(\\d+\\)|Send all \\(\\d+\\)|Available AI Credits:|Send feedback as\\s+|Media\\s*\\(|Updated\\s+|All (?:scheduled tasks|automations) run |Individual quota reached\\.|Mark\\s+|Version\\s+|Asking\\s+\\d+|View\\s+\\d+\\s+side|Asked\\s+\\d+)/i.test(valNorm)) {
                    if (/^Show (\\d+) more(\\.\\.\\.|…)?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Show (\\d+) more(\\.\\.\\.|…)?$/i, (match, num) => "显示另外 " + num + " 个...");
                    } else if (/^Show (\\d+) breakdowns?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Show (\\d+) breakdowns?$/i, (match, num) => "显示 " + num + " 项明细");
                    } else if (/^See all \\((\\d+)\\)$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^See all \\((\\d+)\\)$/i, (match, num) => "显示全部 (" + num + ")");
                    } else if (/^Send all \\((\\d+)\\)$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Send all \\((\\d+)\\)$/i, (match, num) => "全部发送 (" + num + ")");
                    } else if (/^Available AI Credits: (\\d+)$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Available AI Credits: (\\d+)$/i, (match, num) => "可用 AI 额度: " + num);
                    } else if (/^Send feedback as\\s+(.+)$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Send feedback as\\s+(.+)$/i, (match, email) => "发送反馈身份为 " + email);
                    } else if (/^Media\\s*\\((.+)\\)$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Media\\s*\\((.+)\\)$/i, (match, timeStr) => {
                            let t = timeStr.replace(/Today/i, '今天').replace(/Yesterday/i, '昨天');
                            return "媒体 (" + t + ")";
                        });
                    } else if (/^Updated\\s+(.+)$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Updated\\s+(.+)$/i, (match, rest) => "更新于 " + rest);
                    } else if (/^All (scheduled tasks|automations) run (?:as|with the)\\s+(.+?)(?:\\s+model)?[\\.\\s]*$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^All (scheduled tasks|automations) run (?:as|with the)\\s+(.+?)(?:\\s+model)?[\\.\\s]*$/i, (match, entity, model) => {
                            const label = entity.toLowerCase() === "automations" ? "自动化" : "计划任务";
                            return "所有" + label + "均以 " + model + " 模型运行";
                        });
                    } else if (/^Individual quota reached\\. Please upgrade your subscription to increase your limits\\. Resets in (.+?)\\.?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Individual quota reached\\. Please upgrade your subscription to increase your limits\\. Resets in (.+?)\\.?$/i, (match, t) => "个人配额已达上限. 请升级订阅以提高限额. 将于 " + t + " 后重置");
                    } else if (/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+read$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+read$/i, (match, num) => "将 " + num + " 个会话标记为已读");
                    } else if (/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+unread$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Mark\\s+(\\d+)\\s+conversations?\\s+as\\s+unread$/i, (match, num) => "将 " + num + " 个会话标记为未读");
                    } else if (/^Mark\\s+all\\s+(?:conversations?\\s+)?as\\s+read$/i.test(valNorm)) {
                        newVal = "将所有会话标记为已读";
                    } else if (/^Mark\\s+all\\s+(?:conversations?\\s+)?as\\s+unread$/i.test(valNorm)) {
                        newVal = "将所有会话标记为未读";
                    } else if (/^Version\\s+([\\d\\.]+)$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Version\\s+([\\d\\.]+)$/i, (match, v) => "版本 " + v);
                    } else if (/^Asking\\s+(\\d+)\\s+questions?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Asking\\s+(\\d+)\\s+questions?$/i, (match, num) => "正在询问 " + num + " 个问题");
                    } else if (/^View\\s+(\\d+)\\s+side\\s+questions?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^View\\s+(\\d+)\\s+side\\s+questions?$/i, (match, num) => "查看 " + num + " 个侧边提问");
                    } else if (/^Asked\\s+(\\d+)\\s+questions?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Asked\\s+(\\d+)\\s+questions?$/i, (match, num) => "已询问 " + num + " 个问题");
                    }
                } else if (/^(?:This will (?:permanently delete|archive)|Permanently delete |Are you sure you want to delete |to be installed)|(?:within it[.。]?)$/i.test(valNorm)) {
                    if (/^This will permanently delete (\\d+) active (?:conversations?|chats?)(?: and (\\d+) archived (?:conversations?|chats?))? within it\\.?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^This will permanently delete (\\d+) active (?:conversations?|chats?)(?: and (\\d+) archived (?:conversations?|chats?))? within it\\.?$/i, (match, active, archived) => {
                            if (archived) {
                                return "这将永久删除 " + active + " 个活跃会话及 " + archived + " 个已归档会话";
                            }
                            return "这将永久删除 " + active + " 个活跃会话";
                        });
                    } else if (/^This will permanently delete (\\d+) archived (?:conversations?|chats?)\\s+within it\\.?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^This will permanently delete (\\d+) archived (?:conversations?|chats?)\\s+within it\\.?$/i, (match, archived) => "这将永久删除 " + archived + " 个已归档会话");
                    } else if (/^This will archive (\\d+) active (?:conversations?|chats?)(?: and (\\d+) archived (?:conversations?|chats?))? within it\\.?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^This will archive (\\d+) active (?:conversations?|chats?)(?: and (\\d+) archived (?:conversations?|chats?))? within it\\.?$/i, (match, active, archived) => {
                            if (archived) {
                                return "这将归档其中的 " + active + " 个活跃会话及 " + archived + " 个已归档会话";
                            }
                            return "这将归档其中的 " + active + " 个活跃会话";
                        });
                    } else if (/^This will archive (\\d+)\\s*(?:active )?(?:conversations?|chats?|会话s?|个会话)(?: within it)?\\.?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^This will archive (\\d+)\\s*(?:active )?(?:conversations?|chats?|会话s?|个会话)(?: within it)?\\.?$/i, (match, count) => "这将归档其中的 " + count + " 个会话");
                    } else if (/^(?:active (?:conversations?|chats?)|个活跃会话)\\s+within it[.。]?$/i.test(valNorm)) {
                        newVal = " 个活跃会话";
                    } else if (/^(?:archived (?:conversations?|chats?)|个已归档会话)\\s+within it[.。]?$/i.test(valNorm)) {
                        newVal = " 个已归档会话";
                    } else if (/^(?:conversations?|chats?|会话s?|个会话)\\s+within it[.。]?$/i.test(valNorm)) {
                        newVal = " 个会话";
                    } else if (/^within it[.。]?$/i.test(valNorm)) {
                        const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 300) || '') : '';
                        if (/(?:This will permanently delete|这将永久删除|This will archive|这将归档)/i.test(parentText)) {
                            newVal = '';
                        }
                    } else if (/^This will archive$/i.test(valNorm)) {
                        newVal = "这将归档其中的 ";
                    } else if (/^to be installed\\.?$/i.test(valNorm)) {
                        const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 500) || '') : '';
                        if (/(?:browser subagent|浏览器子智能体|Google Chrome)/i.test(parentText)) {
                            newVal = '. ';
                        }
                    } else if (/^to be installed\\.\\s*(.+)$/i.test(valNorm)) {
                        const parentText = node && node.parentElement ? (getBoundedTextContent(node.parentElement, 16, 500) || '') : '';
                        if (/(?:browser subagent|浏览器子智能体|Google Chrome)/i.test(parentText)) {
                            const match = valNorm.match(/^to be installed\\.\\s*(.+)$/i);
                            const rest = match[1];
                            const restTrans = map.get(norm(rest)) || lowerMap.get(norm(rest).toLowerCase()) || rest;
                            newVal = '. ' + restTrans;
                        }
                    } else if (/^Are you sure you want to delete (?:the |this )?(project|workspace|项目|工作区) (.+?)\\??$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Are you sure you want to delete (?:the |this )?(project|workspace|项目|工作区) (.+?)\\??$/i, (match, scope, name) => {
                            const scopeLabel = /^(?:workspace|工作区)$/i.test(scope) ? "工作区" : "项目";
                            return "您确定要删除" + scopeLabel + " " + name + " 吗？";
                        });
                    } else if (/^Permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?\\.?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^Permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?\\.?$/i, (match, name, active, archived) => "永久删除 " + name + "，包含 " + active + " 个活跃会话及 " + archived + " 个已归档会话");
                    } else if (/^This will permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?(?:\\. This action cannot be undone\\.)?$/i.test(valNorm)) {
                        newVal = valNorm.replace(/^This will permanently delete (.+?) including (\\d+) active conversations? and (\\d+) archived conversations?(?:\\. This action cannot be undone\\.)?$/i, (match, name, active, archived) => "这将永久删除 " + name + "，包含 " + active + " 个活跃会话及 " + archived + " 个已归档会话，此操作无法撤销");
                    }
                } else if (/^(.+?): context deadline exceeded$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): context deadline exceeded$/i, (match, prefix) => {
                        return prefix + ": 请求超时 (context deadline exceeded)";
                    });
                } else if (/^(.+?): i\\/o timeout$/i.test(valNorm)) {
                    newVal = valNorm.replace(/^(.+?): i\\/o timeout$/i, (match, prefix) => {
                        return prefix + ": I/O 超时 (i/o timeout)";
                    });
                } else if (/[a-zA-Z]{2,}/.test(valNorm)) {
                    if (valNorm.length > 21 && valNorm.includes(' ') && !unmatchedLongStrings.has(valNorm) && longScannedValues.get(node) !== originalVal && /[A-Za-z][ -~]{19,}/.test(valNorm)) {
                        longScannedValues.set(node, originalVal);
                        const beforeLong = newVal;
                        for (const [key, translated] of longEntries) {
                            if (key.length < valNorm.length && valNorm.includes(key)) {
                                newVal = replaceLongDictionaryEntry(newVal, key, translated);
                            }
                        }
                        if (newVal === beforeLong) {
                            if (unmatchedLongStrings.size > 2000) unmatchedLongStrings.clear();
                            unmatchedLongStrings.add(valNorm);
                        }
                    }

                    if (/(?:5-hour|weekly)\\s+limit/i.test(newVal)) {
                        newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) days?, (\\d+) hours?\\./gi, (match, d, h) => {
                            return "您的 5 小时配额将在 " + d + " 天 " + h + " 小时后刷新";
                        });
                        newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) hours?, (\\d+) minutes?\\./gi, (match, h, m) => {
                            return "您的 5 小时配额将在 " + h + " 小时 " + m + " 分钟后刷新";
                        });
                        newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) days?\\./gi, (match, d) => {
                            return "您的 5 小时配额将在 " + d + " 天后刷新";
                        });
                        newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) hours?\\./gi, (match, h) => {
                            return "您的 5 小时配额将在 " + h + " 小时后刷新";
                        });
                        newVal = newVal.replace(/Your 5-hour limit will refresh in (\\d+) minutes?\\./gi, (match, m) => {
                            return "您的 5 小时配额将在 " + m + " 分钟后刷新";
                        });
                        newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) days?, (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, d, h) => {
                            return "您已达到 5 小时配额限制，将在 " + d + " 天 " + h + " 小时后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.";
                        });
                        newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) hours?, (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, h, m) => {
                            return "您已达到 5 小时配额限制，将在 " + h + " 小时 " + m + " 分钟后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.";
                        });
                        newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) days?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, d) => {
                            return "您已达到 5 小时配额限制，将在 " + d + " 天后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.";
                        });
                        newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) hours?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, h) => {
                            return "您已达到 5 小时配额限制，将在 " + h + " 小时后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.";
                        });
                        newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in (\\d+) minutes?\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, (match, m) => {
                            return "您已达到 5 小时配额限制，将在 " + m + " 分钟后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.";
                        });
                        newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\./gi, (match, d, h) => {
                            return "您已使用部分每周配额，将在 " + d + " 天 " + h + " 小时后完全刷新";
                        });
                        newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\./gi, (match, h, m) => {
                            return "您已使用部分每周配额，将在 " + h + " 小时 " + m + " 分钟后完全刷新";
                        });
                        newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) days?\\./gi, (match, d) => {
                            return "您已使用部分每周配额，将在 " + d + " 天后完全刷新";
                        });
                        newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) hours?\\./gi, (match, h) => {
                            return "您已使用部分每周配额，将在 " + h + " 小时后完全刷新";
                        });
                        newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in (\\d+) minutes?\\./gi, (match, m) => {
                            return "您已使用部分每周配额，将在 " + m + " 分钟后完全刷新";
                        });
                        newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) days?, (\\d+) hours?\\./gi, (match, d, h) => {
                            return "您已达到每周配额限制，将在 " + d + " 天 " + h + " 小时后完全刷新";
                        });
                        newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) hours?, (\\d+) minutes?\\./gi, (match, h, m) => {
                            return "您已达到每周配额限制，将在 " + h + " 小时 " + m + " 分钟后完全刷新";
                        });
                        newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) days?\\./gi, (match, d) => {
                            return "您已达到每周配额限制，将在 " + d + " 天后完全刷新";
                        });
                        newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) hours?\\./gi, (match, h) => {
                            return "您已达到每周配额限制，将在 " + h + " 小时后完全刷新";
                        });
                        newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in (\\d+) minutes?\\./gi, (match, m) => {
                            return "您已达到每周配额限制，将在 " + m + " 分钟后完全刷新";
                        });
                        newVal = newVal.replace(/You have used some of your weekly limit, it will fully refresh in less than a minute\\./gi, "您已使用部分每周配额，将在不到 1 分钟后完全刷新");
                        newVal = newVal.replace(/You have hit your weekly limit, it will fully refresh in less than a minute\\./gi, "您已达到每周配额限制，将在不到 1 分钟后完全刷新");
                        newVal = newVal.replace(/Your 5-hour limit will refresh in less than a minute\\./gi, "您的 5 小时配额将在不到 1 分钟后刷新");
                        newVal = newVal.replace(/You have hit your 5-hour limit, it will refresh in less than a minute\\. If on a supported paid plan, you can use AI credits in the interim\\./gi, "您已达到 5 小时配额限制，将在不到 1 分钟后刷新. 如果使用的是受支持的付费计划，您可以在此期间使用 AI 额度.");
                    }
                    if (newVal.includes('(')) {
                        newVal = newVal.replace(/Match case \\((.+)\\)/gi, (m, k) => "区分大小写 (" + k + ")");
                        newVal = newVal.replace(/Match whole word \\((.+)\\)/gi, (m, k) => "全字匹配 (" + k + ")");
                        newVal = newVal.replace(/Use regular expression \\((.+)\\)/gi, (m, k) => "使用正则表达式 (" + k + ")");
                        newVal = newVal.replace(/Previous match \\((.+)\\)/gi, (m, k) => "上一个匹配项 (" + k + ")");
                        newVal = newVal.replace(/Next match \\((.+)\\)/gi, (m, k) => "下一个匹配项 (" + k + ")");
                        newVal = newVal.replace(/Close \\((.+)\\)/gi, (m, k) => "关闭 (" + k + ")");
                    }
                }
                if (hasRecommended) {
                    newVal = '（推荐）' + newVal;
                }
                if (newVal !== originalVal) {
                    const leadingMatch = originalVal.match(/^\\s+/);
                    const trailingMatch = originalVal.match(/\\s+$/);
                    if (leadingMatch && !newVal.startsWith(leadingMatch[0])) {
                        newVal = leadingMatch[0] + newVal;
                    }
                    if (trailingMatch && !newVal.endsWith(trailingMatch[0])) {
                        newVal = newVal + trailingMatch[0];
                    }
                    if (newVal !== originalVal) {
                        translatedValues.set(node, newVal);
                        node.nodeValue = newVal;
                        return;
                    }
                }
                if (parentEl && parentEl.childNodes.length === 1) {
                    translatedValues.set(node, originalVal);
                }
            }
        } catch (e) {}
    }

    const observer = new MutationObserver(mutations => {
        const visitedElements = new WeakSet();
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) translateNode(n, false, visitedElements);
            } else if (m.type === 'characterData') {
                translateNode(m.target, false, visitedElements);
            } else if (m.type === 'attributes') {
                translateElementAttributes(m.target);
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

    const CONTEXT_MENU_EXACT_MAP = {
        "Rename": "重命名",
        "Mark Unread": "标记为未读",
        "Mark Read": "标记为已读",
        "Copy": "复制",
        "Split": "拆分",
        "Archive": "归档",
        "Delete": "删除",
        "Stop": "停止",
        "Pin": "置顶",
        "Unpin": "取消置顶",
        "Conversation Name": "会话名称",
        "Conversation ID": "会话 ID",
        "Project Name": "项目名称",
        "Workspace Name": "工作区名称",
        "Worktree Name": "工作树名称",
        "Split Right": "向右拆分",
        "Split Down": "向下拆分",
        "Replace with New": "替换为新会话",
        "Replace With New": "替换为新会话",
        "Remove from Split": "从拆分中移除",
        "Remove From Split": "从拆分中移除",
        "Copy File Path": "复制文件路径",
        "Copy File Name": "复制文件名称",
        "Add to Chat": "添加到聊天",
        "Copy Image": "复制图片",
        "Save Image": "保存图片",
        "Copy Video": "复制视频",
        "Save Video": "保存视频",
        "Cut": "剪切",
        "Paste": "粘贴",
        "Select All": "全选",
        "Close Tab": "关闭标签页",
        "Close Other Tabs": "关闭其他标签页",
        "Close Tabs to the Right": "关闭右侧标签页",
        "Back": "后退",
        "Forward": "前进",
        "Reload": "重新加载",
        "Open in External Browser": "在外部浏览器中打开",
        "Open in Built-in Browser": "在内置浏览器中打开",
        "Open in Browser": "在浏览器中打开",
        "Copy Link": "复制链接",
        "Reopen Closed Tab": "重新打开关闭的标签页",
        "Move Conversation Up": "向上移动会话",
        "Move Conversation Down": "向下移动会话",
        "Background Commands": "后台命令"
    };

    function translateContextMenuLabel(label, id) {
        if (typeof label !== 'string' || !label) return label;
        const itemId = String(id || '');
        if (/^group-(?!new$|remove$)/i.test(itemId)) return label;
        const trimmed = norm(label);
        if (!trimmed) return label;
        if (CONTEXT_MENU_EXACT_MAP[trimmed]) return CONTEXT_MENU_EXACT_MAP[trimmed];
        return label;
    }

    function translateContextMenuItems(items) {
        if (!Array.isArray(items)) return items;
        return items.map(item => {
            if (!item || typeof item !== 'object') return item;
            const next = Object.assign({}, item);
            if (typeof next.label === 'string') {
                next.label = translateContextMenuLabel(next.label, next.id);
            }
            if (Array.isArray(next.submenu)) {
                next.submenu = translateContextMenuItems(next.submenu);
            }
            if (Array.isArray(next.items)) {
                next.items = translateContextMenuItems(next.items);
            }
            return next;
        });
    }

    globalThis.__agTranslateContextMenuItems = translateContextMenuItems;

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
    const withoutSig = removeMarkedBlocks(withoutLegacy, SIGNATURE_START, SIGNATURE_END);
    return withoutSig.replace(
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', typeof globalThis.__agTranslateContextMenuItems === 'function' ? globalThis.__agTranslateContextMenuItems(items) : items),",
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', items),"
    );
}

function cleanMenuJsContent(content) {
    const withoutLegacy = removeMarkedBlocks(content, LEGACY_MENU_SIGNATURE_START, LEGACY_MENU_SIGNATURE_END);
    return removeMarkedBlocks(withoutLegacy, MENU_SIGNATURE_START, MENU_SIGNATURE_END);
}

function cleanTrayJsContent(content) {
    const withoutLegacy = removeMarkedBlocks(content, LEGACY_TRAY_SIGNATURE_START, LEGACY_TRAY_SIGNATURE_END);
    return removeMarkedBlocks(withoutLegacy, TRAY_SIGNATURE_START, TRAY_SIGNATURE_END);
}

function cleanIpcHandlersJsContent(content) {
    return removeMarkedBlocks(content, IPC_CONTEXT_MENU_SIGNATURE_START, IPC_CONTEXT_MENU_SIGNATURE_END);
}

let wasAppRunning = false;

function getPosixTargetUid() {
    const sudoUidText = String(process.env.SUDO_UID || '');
    if (/^\d+$/.test(sudoUidText)) return Number(sudoUidText);
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function getPosixProcessTable() {
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

function isPosixAntigravityMainProcess(entry, targetUid = getPosixTargetUid()) {
    if (targetUid !== null && entry.uid !== targetUid) return false;
    if (/(?:^|\s)--type(?:=|\s)/i.test(entry.args)) return false;

    const commBase = path.basename(entry.comm).toLowerCase();
    if (commBase === 'antigravity') return true;

    return /^\s*\/.*\/Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/i.test(entry.args);
}

function getPosixAntigravityMainProcesses(processTable = getPosixProcessTable()) {
    const targetUid = getPosixTargetUid();
    return processTable.filter(entry => isPosixAntigravityMainProcess(entry, targetUid));
}

function collectPosixProcessTreePids(processTable, rootPids) {
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

function refreshPosixProcessTree(trackedPids) {
    const processTable = getPosixProcessTable();
    const expanded = collectPosixProcessTreePids(processTable, trackedPids);
    for (const pid of expanded) trackedPids.add(pid);
    return processTable.filter(entry => {
        return trackedPids.has(entry.pid) && !entry.stat.toUpperCase().startsWith('Z');
    });
}

function sleepSync(milliseconds) {
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitArray, 0, 0, milliseconds);
}

function signalPosixProcesses(processEntries, signal) {
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

function waitForPosixProcessTreeExit(trackedPids, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let remaining = refreshPosixProcessTree(trackedPids);
    while (remaining.length > 0 && Date.now() < deadline) {
        sleepSync(100);
        remaining = refreshPosixProcessTree(trackedPids);
    }
    return remaining;
}

function checkIfAppIsRunning() {
    try {
        if (process.platform === 'win32') {
            const stdout = child_process.execSync('tasklist /fi "imagename eq Antigravity.exe" /nh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return stdout.toLowerCase().includes('antigravity.exe');
        } else {
            const processTable = getPosixProcessTable();
            if (processTable.length === 0) return true;
            return getPosixAntigravityMainProcesses(processTable).length > 0;
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

    const platformLabel = process.platform === 'darwin' ? 'macOS' : 'Linux';
    const processTable = getPosixProcessTable();
    if (processTable.length === 0) {
        console.error(`[错误] 无法读取 ${platformLabel} 进程列表，已停止汉化以避免覆盖运行中的客户端文件。`);
        return false;
    }
    const mainProcesses = getPosixAntigravityMainProcesses(processTable);
    if (mainProcesses.length === 0) return true;

    const trackedPids = collectPosixProcessTreePids(
        processTable,
        mainProcesses.map(entry => entry.pid)
    );
    const mainPids = new Set(mainProcesses.map(entry => entry.pid));

    signalPosixProcesses(mainProcesses, 'SIGTERM');
    let remaining = waitForPosixProcessTreeExit(trackedPids, 10000);

    if (remaining.length > 0) {
        const remainingMainProcesses = remaining.filter(entry => mainPids.has(entry.pid));
        if (remainingMainProcesses.length > 0) {
            console.log("[等待] Antigravity 主进程仍在关闭，正在再次请求正常退出...");
            signalPosixProcesses(remainingMainProcesses, 'SIGTERM');
            remaining = waitForPosixProcessTreeExit(trackedPids, 5000);
        }
    }

    if (remaining.length > 0 && !remaining.some(entry => mainPids.has(entry.pid))) {
        console.log("[等待] 主程序已退出，正在关闭 " + remaining.length + " 个遗留后台进程...");
        signalPosixProcesses(remaining, 'SIGTERM');
        remaining = waitForPosixProcessTreeExit(trackedPids, 5000);
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
            fs.existsSync(path.join(candidate, "resources", "app.asar.bak")) ||
            fs.existsSync(path.join(candidate, "app.asar")) ||
            fs.existsSync(path.join(candidate, "app.asar.bak")) ||
            fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar")) ||
            fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar.bak")) ||
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
    } else if (process.platform === 'darwin') {
        const homeDirs = [];
        if (process.env.HOME) homeDirs.push(process.env.HOME);
        if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
            const sudoHome = path.join('/Users', process.env.SUDO_USER);
            if (fs.existsSync(sudoHome) && !homeDirs.includes(sudoHome)) {
                homeDirs.push(sudoHome);
            }
        }
        addCandidate('/Applications/Antigravity.app');
        for (const h of homeDirs) {
            addCandidate(path.join(h, 'Applications', 'Antigravity.app'));
        }
        try {
            const mdfindOut = child_process.execSync('mdfind "kMDItemFSName == \'Antigravity.app\'" 2>/dev/null', { encoding: 'utf-8' });
            for (const line of mdfindOut.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.includes('/.Trash') && !trimmed.includes('/.Trashes') && !trimmed.startsWith('/Volumes/')) {
                    addCandidate(trimmed);
                }
            }
        } catch (e) {}
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

function runCommandSync(cmd, args) {
    try {
        if (Array.isArray(args)) {
            const res = child_process.spawnSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe' });
            if (res.error) throw res.error;
            return {
                success: res.status === 0,
                stdout: res.stdout || '',
                stderr: res.stderr || ''
            };
        }
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

function findMacAppBundle(resourcesDir) {
    if (!resourcesDir) return null;
    let current = path.resolve(resourcesDir);
    while (current && current !== path.dirname(current)) {
        if (current.toLowerCase().endsWith('.app') && fs.existsSync(current)) {
            return current;
        }
        current = path.dirname(current);
    }
    return null;
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
        if (process.platform === 'darwin') {
            const targetApp = findMacAppBundle(resourcesDir);
            if (targetApp) {
                fs.accessSync(targetApp, fs.constants.W_OK | fs.constants.X_OK);
            }
        }
        return true;
    } catch (e) {
        reportWritePermissionError(resourcesDir, e, '写入', entryScript);
        return false;
    }
}

function resignAppOnMac(resourcesDir) {
    if (process.platform !== 'darwin') return true;

    let targetApp = findMacAppBundle(resourcesDir);
    if (!targetApp) {
        console.warn("[警告] 未能识别到 Antigravity.app 目录结构，跳过 macOS 重签名。");
        return true;
    }
    try {
        targetApp = fs.realpathSync(targetApp);
    } catch (e) {}

    console.log(`[签名] 正在清理 macOS 隔离属性并执行自签名: ${targetApp}`);
    const xattrRes = runCommandSync('xattr', ['-cr', targetApp]);
    if (!xattrRes.success) {
        console.warn(`[警告] 清理 quarantine 属性时出现提示: ${xattrRes.stderr || xattrRes.stdout}`);
    }

    // 由内而外（Inside-Out）优先重签内部 Frameworks / Dylibs / Helpers，
    // 嵌套的 .framework 与 .app 需带上 --deep 确保其内部动态库及辅助程序完成签名，
    // 避免顶层签名时遗留旧签名导致 dyld 报签名/校验不一致。
    const frameworksDir = path.join(targetApp, 'Contents', 'Frameworks');
    if (fs.existsSync(frameworksDir)) {
        try {
            const entries = fs.readdirSync(frameworksDir);
            for (const entry of entries) {
                const fullPath = path.join(frameworksDir, entry);
                if (entry.endsWith('.framework') || entry.endsWith('.app')) {
                    const res = runCommandSync('codesign', ['--force', '--deep', '--sign', '-', fullPath]);
                    if (!res.success) {
                        console.warn(`[警告] 重签内部组件 ${entry} 出现提示: ${res.stderr || res.stdout}`);
                    }
                } else if (entry.endsWith('.dylib')) {
                    const res = runCommandSync('codesign', ['--force', '--sign', '-', fullPath]);
                    if (!res.success) {
                        console.warn(`[警告] 重签内部动态库 ${entry} 出现提示: ${res.stderr || res.stdout}`);
                    }
                }
            }
        } catch (e) {
            console.warn(`[警告] 遍历 Frameworks 目录失败: ${e.message}`);
        }
    }

    // 注意：绝不能传入 --preserve-metadata=flags,runtime！
    // 否则会保留 Hardened Runtime（硬化运行时），而硬化运行时默认强制执行 Library Validation（库校验）；
    // 在本地自签名（ad-hoc，-）缺少 Apple Team ID 的情况下，dyld 会因 Team ID 不一致在启动阶段直接终止进程闪退（SIGABRT）。
    const signRes = runCommandSync('codesign', [
        '--force',
        '--deep',
        '--sign',
        '-',
        targetApp
    ]);
    if (!signRes.success) {
        console.error(`[错误] macOS 应用签名失败。`);
        console.error(`详情: ${signRes.stderr}\n${signRes.stdout}`);
        console.error(`[提示] 请检查是否已安装 Xcode Command Line Tools (xcode-select --install)。`);
        return false;
    }

    console.log(`[√] macOS 应用自签名成功！`);
    return true;
}

class AsarArchive {
    static align4(n) {
        return (n + 3) & ~3;
    }

    static readHeader(asarPath) {
        const fd = fs.openSync(asarPath, 'r');
        try {
            const sizeBuf = Buffer.alloc(8);
            fs.readSync(fd, sizeBuf, 0, 8, 0);

            const headerSize = sizeBuf.readUInt32LE(4);
            const headerBuf = Buffer.alloc(headerSize);
            fs.readSync(fd, headerBuf, 0, headerSize, 8);

            const jsonLen = headerBuf.readUInt32LE(4);
            const jsonStr = headerBuf.slice(8, 8 + jsonLen).toString('utf8');
            const header = JSON.parse(jsonStr);
            const baseOffset = 8 + headerSize;
            return { header, baseOffset, headerSize, jsonLen };
        } finally {
            fs.closeSync(fd);
        }
    }

    static createHeaderBuffer(headerJson) {
        const jsonBuf = Buffer.from(headerJson, 'utf8');
        const jsonLen = jsonBuf.length;
        const alignedJsonLen = this.align4(jsonLen);

        const headerPayloadSize = 4 + alignedJsonLen;
        const headerBuf = Buffer.alloc(4 + headerPayloadSize);
        headerBuf.writeUInt32LE(headerPayloadSize, 0);
        headerBuf.writeUInt32LE(jsonLen, 4);
        jsonBuf.copy(headerBuf, 8);

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeUInt32LE(4, 0);
        sizeBuf.writeUInt32LE(headerBuf.length, 4);

        return Buffer.concat([sizeBuf, headerBuf]);
    }

    static readFile(sourceAsar, relPath) {
        const { header, baseOffset } = this.readHeader(sourceAsar);
        const parts = relPath.replace(/\\/g, '/').split('/');
        let cur = header.files;
        for (const p of parts) {
            if (!cur || !cur[p]) return null;
            cur = cur[p].files ? cur[p].files : cur[p];
        }
        if (cur.unpacked) {
            const unpackedPath = path.join(`${sourceAsar}.unpacked`, ...parts);
            if (fs.existsSync(unpackedPath)) return fs.readFileSync(unpackedPath);
            return null;
        }
        if (cur.offset === undefined || cur.size === undefined) return null;
        const fd = fs.openSync(sourceAsar, 'r');
        try {
            const buf = Buffer.alloc(cur.size);
            fs.readSync(fd, buf, 0, cur.size, baseOffset + parseInt(cur.offset));
            return buf;
        } finally {
            fs.closeSync(fd);
        }
    }

    static patchArchive(sourceAsar, targetAsar, filePatches) {
        const { header, baseOffset } = this.readHeader(sourceAsar);
        const srcFd = fs.openSync(sourceAsar, 'r');
        let destFd = null;

        try {
            const fileEntries = [];
            function walk(dir, currentPath) {
                for (const [name, entry] of Object.entries(dir)) {
                    const fullPath = currentPath ? `${currentPath}/${name}` : name;
                    if (entry.files) {
                        walk(entry.files, fullPath);
                    } else {
                        fileEntries.push({ path: fullPath, entry });
                    }
                }
            }
            walk(header.files, '');

            const packedFiles = fileEntries.filter(f => !f.entry.unpacked && f.entry.offset !== undefined);
            packedFiles.sort((a, b) => parseInt(a.entry.offset) - parseInt(b.entry.offset));

            for (const item of packedFiles) {
                item.oldOffset = parseInt(item.entry.offset);
                item.oldSize = item.entry.size;
                const patch = filePatches[item.path];
                if (patch !== undefined && patch !== null) {
                    const patchBuf = Buffer.isBuffer(patch) ? patch : Buffer.from(patch, 'utf8');
                    item.patchBuffer = patchBuf;
                    item.entry.size = patchBuf.length;
                }
            }

            let currentOffset = BigInt(0);
            for (const item of packedFiles) {
                item.entry.offset = currentOffset.toString();
                currentOffset += BigInt(item.entry.size);
            }

            const newHeaderBuf = this.createHeaderBuffer(JSON.stringify(header));
            destFd = fs.openSync(targetAsar, 'w');
            fs.writeSync(destFd, newHeaderBuf, 0, newHeaderBuf.length, 0);

            let writePos = newHeaderBuf.length;
            const copyBufSize = 256 * 1024;
            const copyBuf = Buffer.alloc(copyBufSize);

            for (const item of packedFiles) {
                if (item.patchBuffer) {
                    fs.writeSync(destFd, item.patchBuffer, 0, item.patchBuffer.length, writePos);
                    writePos += item.patchBuffer.length;
                } else {
                    let remaining = item.oldSize;
                    let readPos = baseOffset + item.oldOffset;
                    while (remaining > 0) {
                        const toRead = Math.min(remaining, copyBufSize);
                        fs.readSync(srcFd, copyBuf, 0, toRead, readPos);
                        fs.writeSync(destFd, copyBuf, 0, toRead, writePos);
                        readPos += toRead;
                        writePos += toRead;
                        remaining -= toRead;
                    }
                }
            }
        } finally {
            if (srcFd) fs.closeSync(srcFd);
            if (destFd) fs.closeSync(destFd);
        }
    }
}

function installLocalization(resourcesDir) {
    const asarPath = path.join(resourcesDir, "app.asar");
    const bakPath = path.join(resourcesDir, "app.asar.bak");

    if (!fs.existsSync(asarPath) && !fs.existsSync(bakPath)) {
        console.error(`[错误] 未在资源目录中找到 app.asar: ${resourcesDir}`);
        return false;
    }

    if (!fs.existsSync(bakPath)) {
        console.log(`[备份] 正在创建官方原始包备份: app.asar.bak ...`);
        try {
            fs.copyFileSync(asarPath, bakPath);
            console.log(`[备份] 备份成功！`);
        } catch (e) {
            if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
                reportWritePermissionError(resourcesDir, e, '备份到');
            } else {
                console.error(`[错误] 创建 app.asar.bak 备份失败: ${e.message}`);
            }
            return false;
        }
    }

    const sourceAsar = fs.existsSync(bakPath) ? bakPath : asarPath;
    console.log(`[读取] 正在解析应用包元数据...`);

    const filePatches = {};

    // 1. dist/preload.js
    const preloadBuf = AsarArchive.readFile(sourceAsar, "dist/preload.js");
    if (!preloadBuf) {
        console.error(`[错误] 未能在应用包中找到 dist/preload.js`);
        return false;
    }

    console.log(`[修改] 正在向 preload.js 注入汉化代码...`);
    const content = preloadBuf.toString('utf-8');
    const cleanedContent = cleanJsContent(content).replace(
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', items),",
        "showContextMenu: (items) => electron_1.ipcRenderer.invoke('window:show-context-menu', typeof globalThis.__agTranslateContextMenuItems === 'function' ? globalThis.__agTranslateContextMenuItems(items) : items),"
    );
    const translationJs = generateJs();

    try {
        new vm.Script(translationJs);
    } catch (syntaxErr) {
        console.error(`[致命错误] 生成的汉化注入脚本存在语法错误，已中止注入以避免客户端崩溃: ${syntaxErr.message}`);
        console.error(syntaxErr.stack);
        return false;
    }

    filePatches["dist/preload.js"] = cleanedContent + "\n" + translationJs;
    console.log(`[修改] preload.js 注入成功！`);

    // 2. dist/menu.js
    const menuBuf = AsarArchive.readFile(sourceAsar, "dist/menu.js");
    if (menuBuf) {
        console.log(`[修改] 正在向 menu.js 注入菜单汉化代码...`);
        let menuContent = menuBuf.toString('utf-8');
        const menuCleaned = cleanMenuJsContent(menuContent);
        const menuTranslationJs = `
    ${MENU_SIGNATURE_START}
    const translations = {
        'File': '文件',
        'Edit': '编辑',
        'Workspace': '工作区',
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
        'Version': '版本',
        'About Antigravity': '关于 Antigravity',
        'Services': '服务',
        'Hide Antigravity': '隐藏 Antigravity',
        'Hide Others': '隐藏其他',
        'Show All': '显示全部',
        'Quit Antigravity': '退出 Antigravity',
        'Quit': '退出',
        'Connect to WSL': '连接至 WSL',
        'Reopen Locally': '在本地重新打开'
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
            let patchedMenuContent = menuCleaned.substring(0, idx) + menuTranslationJs + "\n    " + menuCleaned.substring(idx);
            patchedMenuContent = patchedMenuContent
                .replace("return { label: 'Connect to WSL', submenu };", "return { label: '连接至 WSL', submenu };")
                .replace("return { label: 'Reopen Locally', click: () => relaunchWithWslDistro('') };", "return { label: '在本地重新打开', click: () => relaunchWithWslDistro('') };");
            filePatches["dist/menu.js"] = patchedMenuContent;
            console.log(`[修改] 菜单汉化注入成功！`);
        } else {
            console.warn(`[警告] 未能在 menu.js 中找到设定的插入点。`);
        }
    }

    // 3. dist/tray.js
    const trayBuf = AsarArchive.readFile(sourceAsar, "dist/tray.js");
    if (trayBuf) {
        console.log(`[修改] 正在向 tray.js 注入任务栏菜单汉化...`);
        let trayContent = trayBuf.toString('utf-8');
        let trayCleaned = cleanTrayJsContent(trayContent);

        let trayPatched = trayCleaned;
        const createTrayMatch = trayCleaned.match(/function\s+createTray\s*\(\s*actions(?:\s*,\s*onClick)?\s*\)\s*\{/);
        if (createTrayMatch) {
            const matchedFuncHeader = createTrayMatch[0];
            const replacementCreate = `${matchedFuncHeader}
    ${TRAY_SIGNATURE_START}
    const translations = {
        'No agents running': '无运行中的智能体',
        'Open Antigravity': '打开 Antigravity',
        'Quit': '退出',
        'Connect to WSL': '连接至 WSL',
        'Reopen Locally': '在本地重新打开'
    };
    for (const item of actions) {
        if (translations[item.label]) {
            item.label = translations[item.label];
        }
    }
    ${TRAY_SIGNATURE_END}`;
            trayPatched = trayCleaned.replace(matchedFuncHeader, replacementCreate);
        } else {
            console.warn(`[警告] 未能在 tray.js 中找到 createTray 函数的插入点。`);
        }

        const targetInsert = "function insertTrayMenuItem(position, options) {";
        const replacementInsert = `function insertTrayMenuItem(position, options) {
    ${TRAY_SIGNATURE_START}
    const asyncTranslations = {
        'Connect to WSL': '连接至 WSL',
        'Reopen Locally': '在本地重新打开'
    };
    if (options && asyncTranslations[options.label]) {
        options.label = asyncTranslations[options.label];
    }
    ${TRAY_SIGNATURE_END}`;

        trayPatched = trayPatched.replace(targetInsert, replacementInsert);

        const countRegex = /countItem\.label\s*=\s*\([\s\S]*?' running';/g;
        const replacementCount = "countItem.label = count > 0 ? `${count} 个智能体运行中` : '无运行中的智能体';";
        trayPatched = trayPatched.replace(countRegex, replacementCount);

        filePatches["dist/tray.js"] = trayPatched;
        console.log(`[修改] 任务栏菜单汉化注入成功！`);
    }

    // 4. dist/updater.js
    const updaterBuf = AsarArchive.readFile(sourceAsar, "dist/updater.js");
    if (updaterBuf) {
        console.log(`[修改] 正在向 updater.js 注入更新弹窗汉化...`);
        let updaterContent = updaterBuf.toString('utf-8');
        const targetOptions = `                title: 'Check for Updates',
                message: 'No updates available',
                buttons: ['OK'],`;
        const replacementOptions = `                title: '检查更新',
                message: '暂无可用更新',
                buttons: ['确定'],`;

        updaterContent = updaterContent.replace(targetOptions, replacementOptions);
        filePatches["dist/updater.js"] = updaterContent;
        console.log(`[修改] 更新弹窗汉化注入成功！`);
    }

    // 5. dist/provisionSplash.js
    const splashBuf = AsarArchive.readFile(sourceAsar, "dist/provisionSplash.js");
    if (splashBuf) {
        console.log(`[修改] 正在向 provisionSplash.js 注入 WSL 引导遮罩汉化...`);
        let splashContent = splashBuf.toString('utf-8');
        splashContent = splashContent.replace('<div>Setting up WSL: ${escapeHtml(distro)}</div>', '<div>正在设置 WSL：${escapeHtml(distro)}</div>');
        filePatches["dist/provisionSplash.js"] = splashContent;
        console.log(`[修改] WSL 引导遮罩汉化注入成功！`);
    }

    // 6. dist/wsl.js
    const wslBuf = AsarArchive.readFile(sourceAsar, "dist/wsl.js");
    if (wslBuf) {
        console.log(`[修改] 正在向 wsl.js 注入 WSL 服务端安装提示汉化...`);
        let wslContent = wslBuf.toString('utf-8');
        wslContent = wslContent
            .replace("onStatus?.('Downloading the Antigravity binary\\u2026');", "onStatus?.('正在下载 Antigravity 二进制文件\\u2026');")
            .replace("onStatus?.(`Installing into ${distro}\\u2026`);", "onStatus?.(`正在安装至 ${distro}\\u2026`);");
        filePatches["dist/wsl.js"] = wslContent;
        console.log(`[修改] WSL 服务端安装提示汉化注入成功！`);
    }

    // 7. dist/main.js
    const mainBuf = AsarArchive.readFile(sourceAsar, "dist/main.js");
    if (mainBuf) {
        console.log(`[修改] 正在向 main.js 注入主进程 WSL 提示汉化...`);
        let mainContent = mainBuf.toString('utf-8');
        mainContent = mainContent
            .replace("await electron_1.dialog.showErrorBox('WSL setup failed', msg);", "await electron_1.dialog.showErrorBox('WSL 设置失败', msg);")
            .replace("`Failed to install the server into WSL distro \"${WSL_DISTRO}\":\\n${err.message}`", "`未能将服务端安装至 WSL 分发版 \"${WSL_DISTRO}\"：\\n${err.message}`");
        filePatches["dist/main.js"] = mainContent;
        console.log(`[修改] 主进程 WSL 提示汉化注入成功！`);
    }

    // 8. dist/ipcHandlers.js
    const ipcHandlersBuf = AsarArchive.readFile(sourceAsar, "dist/ipcHandlers.js");
    if (ipcHandlersBuf) {
        console.log(`[修改] 正在向 ipcHandlers.js 注入原生右键菜单汉化...`);
        let ipcContent = ipcHandlersBuf.toString('utf-8');
        let ipcCleaned = cleanIpcHandlersJsContent(ipcContent);
        const contextMenuMatch = ipcCleaned.match(/function\s+buildContextMenuTemplate\s*\(\s*items\s*,\s*onSelect\s*\)\s*\{/);
        if (contextMenuMatch) {
            const matchedHeader = contextMenuMatch[0];
            const replacementHeader = `${matchedHeader}
    ${IPC_CONTEXT_MENU_SIGNATURE_START}
    const contextMenuTranslations = {
        "Rename": "重命名",
        "Mark Unread": "标记为未读",
        "Mark Read": "标记为已读",
        "Cut": "剪切",
        "Copy": "复制",
        "Paste": "粘贴",
        "Select All": "全选",
        "Split": "拆分",
        "Archive": "归档",
        "Delete": "删除",
        "Stop": "停止",
        "Pin": "置顶",
        "Unpin": "取消置顶",
        "Conversation Name": "会话名称",
        "Conversation ID": "会话 ID",
        "Project Name": "项目名称",
        "Workspace Name": "工作区名称",
        "Worktree Name": "工作树名称",
        "Copy Project Name": "复制项目名称",
        "Project Settings": "项目设置",
        "Show in File Explorer": "在文件资源管理器中显示",
        "Show in Finder": "在 Finder 中显示",
        "Show in File Manager": "在文件管理器中显示",
        "Reveal in File Explorer": "在文件资源管理器中显示",
        "Reveal in Finder": "在 Finder 中显示",
        "Delete Project": "删除项目",
        "Split Right": "向右拆分",
        "Split Down": "向下拆分",
        "Replace with New": "替换为新会话",
        "Replace With New": "替换为新会话",
        "Remove from Split": "从拆分中移除",
        "Remove From Split": "从拆分中移除",
        "Copy File Path": "复制文件路径",
        "Copy File Name": "复制文件名称",
        "Add to Chat": "添加到聊天",
        "Copy Image": "复制图片",
        "Save Image": "保存图片",
        "Copy Video": "复制视频",
        "Save Video": "保存视频",
        "Close Tab": "关闭标签页",
        "Close Other Tabs": "关闭其他标签页",
        "Close Tabs to the Right": "关闭右侧标签页",
        "Back": "后退",
        "Forward": "前进",
        "Reload": "重新加载",
        "Open in External Browser": "在外部浏览器中打开",
        "Open in Built-in Browser": "在内置浏览器中打开",
        "Open in Browser": "在浏览器中打开",
        "Copy Link": "复制链接",
        "Reopen Closed Tab": "重新打开关闭的标签页",
        "Move Conversation Up": "向上移动会话",
        "Move Conversation Down": "向下移动会话",
        "Background Commands": "后台命令"
    };
    if (Array.isArray(items)) {
        items = items.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const itemId = String(item.id || '');
            if (/^group-(?!new$|remove$)/i.test(itemId)) return item;
            const rawLabel = typeof item.label === 'string' ? item.label.trim() : '';
            const translatedLabel = rawLabel && contextMenuTranslations[rawLabel] ? contextMenuTranslations[rawLabel] : item.label;
            return translatedLabel !== item.label ? Object.assign({}, item, { label: translatedLabel }) : item;
        });
    }
    ${IPC_CONTEXT_MENU_SIGNATURE_END}`;
            filePatches["dist/ipcHandlers.js"] = ipcCleaned.replace(matchedHeader, replacementHeader);
            console.log(`[修改] 原生右键菜单汉化注入成功！`);
        } else {
            console.warn(`[警告] 未能在 ipcHandlers.js 中找到 buildContextMenuTemplate 函数的插入点。`);
        }
    }

    // 9. 打包并写入 app.asar
    const tempAsarPath = path.join(resourcesDir, "app.asar.tmp");
    try {
        console.log(`[打包] 正在将修改后的内容打包回 app.asar...`);
        AsarArchive.patchArchive(sourceAsar, tempAsarPath, filePatches);

        try {
            if (fs.existsSync(asarPath)) {
                fs.unlinkSync(asarPath);
            }
            fs.renameSync(tempAsarPath, asarPath);
        } catch (renameErr) {
            try {
                fs.copyFileSync(tempAsarPath, asarPath);
                fs.unlinkSync(tempAsarPath);
            } catch (copyErr) {
                if (copyErr.code === 'EBUSY' || copyErr.code === 'EPERM' || renameErr.code === 'EBUSY' || renameErr.code === 'EPERM') {
                    console.error(`[错误] 写入 app.asar 失败：文件被锁定占用。请确保已完全退出 Antigravity 客户端后重试。`);
                } else {
                    console.error(`[错误] 替换 app.asar 失败: ${copyErr.message}`);
                }
                return false;
            }
        }
    } catch (err) {
        try { if (fs.existsSync(tempAsarPath)) fs.unlinkSync(tempAsarPath); } catch (e) {}
        console.error(`[错误] 汉化打包失败: ${err.message}`);
        return false;
    }

    // 清理可能遗留的历史临时解压目录
    const legacyTempDir = path.join(__dirname, "_temp_asar");
    if (fs.existsSync(legacyTempDir)) {
        try { fs.rmSync(legacyTempDir, { recursive: true, force: true }); } catch (e) {}
    }

    console.log(`[√] Antigravity 汉化部署完成！`);
    if (process.platform === 'darwin') {
        if (!resignAppOnMac(resourcesDir)) {
            return false;
        }
    }
    return true;
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
    if (process.platform === 'darwin') {
        if (!resignAppOnMac(resourcesDir)) {
            return false;
        }
    }
    return true;
}

function main() {
    if (process.platform !== 'win32') {
        const shellScripts = [
            'install.sh',
            'uninstall.sh',
            '双击安装中文汉化.command',
            '双击卸载还原官方英文.command'
        ];
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
            if (process.platform === 'darwin') {
                const targetApp = findMacAppBundle(resourcesDir);
                if (targetApp) {
                    fs.accessSync(targetApp, fs.constants.W_OK | fs.constants.X_OK);
                }
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
        console.log("\n[启动] 检测到安装前 Antigravity 客户端处于开启状态，正在重新启动客户端...");
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
                } else if (process.platform === 'darwin') {
                    const targetApp = findMacAppBundle(resourcesDir) || (installDir.endsWith('.app') ? installDir : null);
                    if (targetApp && fs.existsSync(targetApp)) {
                        child_process.spawn('open', [targetApp], { detached: true, stdio: 'ignore' }).unref();
                        console.log("[启动] 客户端启动成功！");
                        launched = true;
                    } else {
                        try {
                            child_process.spawn('open', ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' }).unref();
                            console.log("[启动] 客户端启动成功！");
                            launched = true;
                        } catch (e) {}
                    }
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

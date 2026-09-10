#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { auditDictionaries } = require('./lib/dictionary-audit');
const { compileJavaScript, generateInjection } = require('./lib/load-engine');
const { runRendererRegression } = require('../tests/renderer-regression');
const { runInstallerRegression } = require('../tests/installer-regression');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.sh', '.ps1', '.command']);
const TEXT_BASENAMES = new Set(['.gitattributes']);
const SKIPPED_DIRECTORIES = new Set(['.git', '_temp_asar', 'node_modules', 'showimg']);

function printUsage() {
    console.log(`用法：
  node scripts/verify.js
  node scripts/verify.js --preload "/absolute/path/to/preload.js"
  node scripts/verify.js --acknowledge-version-entry-changes

该命令只执行非安装式验证，不会运行 localization_engine.js 的 main()，
不会解包、重包或修改 Antigravity 客户端。`);
}

function parseArguments(argv) {
    const options = { preloadPath: null, acknowledgeVersionEntryChanges: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            options.help = true;
            continue;
        }
        if (argument === '--preload') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error('--preload 缺少文件路径');
            options.preloadPath = path.resolve(value);
            index++;
            continue;
        }
        if (argument.startsWith('--preload=')) {
            const value = argument.slice('--preload='.length);
            if (!value) throw new Error('--preload 缺少文件路径');
            options.preloadPath = path.resolve(value);
            continue;
        }
        if (argument === '--acknowledge-version-entry-changes') {
            options.acknowledgeVersionEntryChanges = true;
            continue;
        }
        throw new Error(`未知参数：${argument}`);
    }
    return options;
}

function assertCondition(condition, message) {
    if (!condition) throw new Error(message);
}

function verifyVersionReferences(audit) {
    assertCondition(audit.versionFiles.length === 1, '无法确定唯一的当前版本字典');
    const versionFile = audit.versionFiles[0];
    const version = versionFile.slice(0, -'.json'.length);
    const agentsPath = path.join(ROOT_DIR, 'AGENTS.md');
    const readmePath = path.join(ROOT_DIR, 'README.md');
    const agents = fs.readFileSync(agentsPath, 'utf8');
    const readme = fs.readFileSync(readmePath, 'utf8');
    const expectedClient = `Antigravity ${version}`;
    const expectedDictionaryPath = `dicts/${versionFile}`;

    const checks = [
        [agents.includes(`release is **${version}**`), `AGENTS.md 当前汉化版本不是 ${version}`],
        [agents.includes(`official **${expectedClient}** client`), `AGENTS.md 官方客户端版本不是 ${expectedClient}`],
        [agents.includes(`\`${expectedDictionaryPath}\``), `AGENTS.md 当前字典不是 ${expectedDictionaryPath}`],
        [readme.includes(`**汉化版本**：${version}`), `README.md 汉化版本不是 ${version}`],
        [readme.includes(`**匹配版本**：${expectedClient}`), `README.md 匹配版本不是 ${expectedClient}`],
        [readme.includes(`\`${expectedDictionaryPath}\``), `README.md 未引用 ${expectedDictionaryPath}`],
        [readme.includes(`\`${versionFile}\``), `README.md 词典指南未引用 ${versionFile}`]
    ];
    const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
    if (failures.length) throw new Error(failures.join('\n'));

    return { version, versionFile, checks: checks.length };
}

function verifyEngineSyntax() {
    const enginePath = path.join(ROOT_DIR, 'localization_engine.js');
    const result = spawnSync(process.execPath, ['--check', enginePath], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || 'node --check 失败').trim());
    }
}

function collectTextFiles(directory, result = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                collectTextFiles(path.join(directory, entry.name), result);
            }
            continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(extension) || TEXT_BASENAMES.has(entry.name)) {
            result.push(path.join(directory, entry.name));
        }
    }
    return result;
}

function verifyRepositoryText() {
    const issues = [];
    const files = collectTextFiles(ROOT_DIR);
    for (const filePath of files) {
        const relativePath = path.relative(ROOT_DIR, filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/^(<<<<<<<|=======|>>>>>>>)($|\s)/.test(line)) {
                issues.push(`${relativePath}:${index + 1} 包含冲突标记`);
            }
            if (/[ \t]+$/.test(line)) {
                issues.push(`${relativePath}:${index + 1} 包含行尾空白`);
            }
        });
        if (content.length > 0 && !content.endsWith('\n')) {
            issues.push(`${relativePath} 缺少文件末尾换行`);
        }
    }
    if (issues.length) throw new Error(issues.join('\n'));
    return { files: files.length };
}

function verifyGitDiff() {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
        return { available: false, status: [] };
    }

    const diffCheck = spawnSync('git', ['diff', '--check'], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (diffCheck.status !== 0) {
        throw new Error((diffCheck.stdout || diffCheck.stderr || 'git diff --check 失败').trim());
    }

    const stagedDiffCheck = spawnSync('git', ['diff', '--cached', '--check'], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (stagedDiffCheck.status !== 0) {
        throw new Error(
            (stagedDiffCheck.stdout || stagedDiffCheck.stderr || 'git diff --cached --check 失败').trim()
        );
    }

    const status = spawnSync('git', ['status', '--short', '--untracked-files=all'], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (status.status !== 0) {
        throw new Error((status.stderr || 'git status --short 失败').trim());
    }
    const statusLines = status.stdout.split(/\r?\n/).filter(Boolean);
    return {
        available: true,
        status: statusLines,
        untracked: statusLines.filter(line => line.startsWith('?? ')).map(line => line.slice(3))
    };
}

function verifyVersionDictionaryMigration(audit, acknowledged) {
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
        return { available: false, migrated: false };
    }

    const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'dicts'], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (tree.status !== 0) {
        throw new Error((tree.stderr || '无法读取 HEAD 中的版本字典').trim());
    }
    const previousVersionFiles = tree.stdout.split(/\r?\n/)
        .filter(file => /^dicts\/v\d+\.\d+\.\d+\.json$/.test(file));
    if (previousVersionFiles.length !== 1) {
        throw new Error(
            `HEAD 中必须且只能有一个版本字典，当前检测到：` +
            `${previousVersionFiles.length ? previousVersionFiles.join(', ') : '无'}`
        );
    }

    const currentPath = `dicts/${audit.versionFiles[0]}`;
    const previousPath = previousVersionFiles[0];
    if (previousPath === currentPath) {
        return { available: true, migrated: false, currentPath };
    }

    const previousFile = spawnSync('git', ['show', `HEAD:${previousPath}`], {
        cwd: ROOT_DIR,
        encoding: 'utf8'
    });
    if (previousFile.status !== 0) {
        throw new Error((previousFile.stderr || `无法读取 HEAD:${previousPath}`).trim());
    }
    let previousDictionary;
    let currentDictionary;
    try {
        previousDictionary = JSON.parse(previousFile.stdout);
        currentDictionary = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, currentPath), 'utf8'));
    } catch (error) {
        throw new Error(`版本字典迁移比较失败：${error.message}`);
    }

    const previousKeys = Object.keys(previousDictionary);
    const currentKeys = new Set(Object.keys(currentDictionary));
    const missing = previousKeys.filter(key => !currentKeys.has(key));
    const changed = previousKeys.filter(
        key => currentKeys.has(key) && previousDictionary[key] !== currentDictionary[key]
    );
    const added = Object.keys(currentDictionary).filter(
        key => !Object.prototype.hasOwnProperty.call(previousDictionary, key)
    );

    if ((missing.length || changed.length) && !acknowledged) {
        const preview = [
            ...missing.slice(0, 10).map(key => `缺失：${JSON.stringify(key)}`),
            ...changed.slice(0, 10).map(key => `改译：${JSON.stringify(key)}`)
        ];
        throw new Error(
            `版本字典迁移包含 ${missing.length} 个缺失词条和 ${changed.length} 个现有词条改译。\n` +
            `${preview.join('\n')}\n` +
            '请先逐项复核；确认均为有意变更后，使用 --acknowledge-version-entry-changes 重新验证。'
        );
    }

    return {
        available: true,
        migrated: true,
        previousPath,
        currentPath,
        previousEntries: previousKeys.length,
        currentEntries: Object.keys(currentDictionary).length,
        missing: missing.length,
        changed: changed.length,
        added: added.length,
        acknowledged: acknowledged && (missing.length > 0 || changed.length > 0)
    };
}

function runStep(label, action) {
    const result = action();
    console.log(`[通过] ${label}`);
    return result;
}

function main() {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
    } catch (error) {
        console.error(`[失败] ${error.message}`);
        printUsage();
        process.exitCode = 1;
        return;
    }
    if (options.help) {
        printUsage();
        return;
    }

    console.log('Antigravity 汉化项目非安装式验证\n');
    try {
        const audit = runStep('所有字典均可解析且结构有效', () => {
            const result = auditDictionaries(ROOT_DIR);
            if (result.issues.length) throw new Error(result.issues.join('\n'));
            return result;
        });
        console.log(`       ${audit.files.length} 个文件，${audit.entries} 个词条`);

        const version = runStep('当前版本与字典引用一致', () => verifyVersionReferences(audit));
        console.log(`       ${version.version} / dicts/${version.versionFile}`);

        const migration = runStep('版本字典迁移完整性', () =>
            verifyVersionDictionaryMigration(audit, options.acknowledgeVersionEntryChanges)
        );
        if (!migration.available) {
            console.log('       当前目录不是 Git 工作树，跳过 HEAD 字典比较');
        } else if (!migration.migrated) {
            console.log(`       未检测到版本字典改名：${migration.currentPath}`);
        } else {
            console.log(`       ${migration.previousPath} → ${migration.currentPath}`);
            console.log(
                `       旧 ${migration.previousEntries} / 新 ${migration.currentEntries} / ` +
                `新增 ${migration.added} / 缺失 ${migration.missing} / 改译 ${migration.changed}`
            );
            if (migration.acknowledged) {
                console.log('       已通过命令行参数确认有意的缺失或改译');
            }
        }

        runStep('localization_engine.js 通过 node --check', verifyEngineSyntax);

        const generatedSource = runStep('generateJs() 已安全隔离 main() 并生成注入代码', () => {
            const source = generateInjection(ROOT_DIR);
            compileJavaScript(source, 'generated-localization-injection.js');
            return source;
        });
        console.log(`       ${generatedSource.length} 个字符`);

        if (options.preloadPath) {
            runStep('官方 preload.js 与生成注入代码合并编译', () => {
                assertCondition(fs.existsSync(options.preloadPath), `preload.js 不存在：${options.preloadPath}`);
                const stat = fs.statSync(options.preloadPath);
                assertCondition(stat.isFile(), `preload 路径不是文件：${options.preloadPath}`);
                const preloadSource = fs.readFileSync(options.preloadPath, 'utf8');
                compileJavaScript(`${preloadSource}\n${generatedSource}`, 'official-preload-with-localization.js');
            });
            console.log(`       ${options.preloadPath}`);
        } else {
            console.log('[跳过] 未提供 --preload，未执行官方 preload 合并编译');
        }

        const regression = runStep('渲染层核心安全契约', () => {
            const result = runRendererRegression(generatedSource);
            assertCondition(typeof result?.assertions === 'number' && result.assertions > 0, '回归测试未执行任何断言');
            return result;
        });
        console.log(`       ${regression.assertions} 项断言`);

        const installerRegression = runStep('安装器进程识别契约', () => {
            const result = runInstallerRegression(ROOT_DIR);
            assertCondition(typeof result?.assertions === 'number' && result.assertions > 0, '安装器回归测试未执行任何断言');
            return result;
        });
        console.log(`       ${installerRegression.assertions} 项断言`);

        const textReview = runStep('仓库文本无冲突标记、行尾空白或缺失末尾换行', verifyRepositoryText);
        console.log(`       检查 ${textReview.files} 个文本文件（包括未跟踪文件）`);

        const gitReview = runStep('Git 差异检查', verifyGitDiff);
        if (gitReview.available) {
            console.log(
                `       工作区和暂存区 diff --check 通过；` +
                `git status --short --untracked-files=all 共 ${gitReview.status.length} 项`
            );
            if (gitReview.untracked.length) {
                console.log(`       未跟踪文件 ${gitReview.untracked.length} 个：`);
                for (const file of gitReview.untracked) console.log(`         - ${file}`);
            }
        } else {
            console.log('       当前目录不是 Git 工作树，跳过 Git 命令');
        }

        console.log('\n全部非安装式验证通过。');
        console.log('未执行 localization_engine.js 的 main()，未修改 Antigravity 客户端。');
    } catch (error) {
        console.error(`\n[失败] ${error.message}`);
        process.exitCode = 1;
    }
}

main();

'use strict';

const assert = require('assert');
const path = require('path');
const { loadEngineExports } = require('../scripts/lib/load-engine');

function runInstallerRegression(rootDir) {
    const { isPosixAntigravityMainProcess } = loadEngineExports(rootDir);
    const uid = 501;
    let assertions = 0;

    function equal(actual, expected, message) {
        assert.strictEqual(actual, expected, message);
        assertions++;
    }

    equal(isPosixAntigravityMainProcess({
        uid,
        comm: '/Applications/An',
        args: '/Applications/Antigravity.app/Contents/MacOS/Antigravity'
    }, uid), true, 'macOS 截断的 comm 未能通过完整 argv 识别主进程');

    equal(isPosixAntigravityMainProcess({
        uid,
        comm: '/Applications/An',
        args: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=gpu-process'
    }, uid), false, 'macOS Helper 被误识别为主进程');

    equal(isPosixAntigravityMainProcess({
        uid: 0,
        comm: 'Antigravity',
        args: '/opt/Antigravity/Antigravity'
    }, uid), false, '其他用户的 Antigravity 进程被误识别');

    equal(isPosixAntigravityMainProcess({
        uid: 1000,
        comm: 'Antigravity',
        args: '/opt/Antigravity/Antigravity'
    }, 1000), true, 'Linux 标准主进程未能识别');

    equal(isPosixAntigravityMainProcess({
        uid: 1000,
        comm: 'antigravity',
        args: '/usr/bin/antigravity'
    }, 1000), true, 'Linux 小写主进程未能识别');

    equal(isPosixAntigravityMainProcess({
        uid: 1000,
        comm: 'antigravity',
        args: '/opt/Antigravity/Antigravity --type=renderer'
    }, 1000), false, 'Linux 子进程被误识别');

    equal(isPosixAntigravityMainProcess({
        uid: 501,
        comm: '/Users/test/Appl',
        args: '/Users/test/Applications/Antigravity.app/Contents/MacOS/Antigravity'
    }, 501), true, '用户目录 macOS 主进程未能识别');

    return { assertions };
}

if (require.main === module) {
    const rootDir = path.resolve(__dirname, '..');
    const result = runInstallerRegression(rootDir);
    console.log(`[通过] 安装器进程识别契约通过，共 ${result.assertions} 项断言`);
}

module.exports = { runInstallerRegression };

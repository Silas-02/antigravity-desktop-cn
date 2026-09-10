'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAIN_CALL_PATTERN = /\nmain\(\);\s*$/;

function loadEngineExports(rootDir) {
    const enginePath = path.join(rootDir, 'localization_engine.js');
    const source = fs.readFileSync(enginePath, 'utf8');
    if (!MAIN_CALL_PATTERN.test(source)) {
        throw new Error('无法安全隔离 localization_engine.js 的最终 main() 调用');
    }

    const nonInstallingSource = source.replace(
        MAIN_CALL_PATTERN,
        '\nmodule.exports = { generateJs, isPosixAntigravityMainProcess };\n'
    );
    const moduleBox = { exports: {} };
    const sandbox = {
        require,
        module: moduleBox,
        exports: moduleBox.exports,
        __dirname: rootDir,
        __filename: enginePath,
        console,
        process,
        Buffer,
        clearTimeout,
        setTimeout,
        clearInterval,
        setInterval
    };
    const context = vm.createContext(sandbox);
    const script = new vm.Script(nonInstallingSource, { filename: enginePath });
    script.runInContext(context);

    if (typeof moduleBox.exports.generateJs !== 'function' ||
        typeof moduleBox.exports.isPosixAntigravityMainProcess !== 'function') {
        throw new Error('未能从 localization_engine.js 获取所需函数');
    }
    return moduleBox.exports;
}

function loadGenerateJs(rootDir) {
    return loadEngineExports(rootDir).generateJs;
}

function generateInjection(rootDir) {
    const generateJs = loadGenerateJs(rootDir);
    const generatedSource = generateJs();
    if (typeof generatedSource !== 'string' || generatedSource.length === 0) {
        throw new Error('generateJs() 没有生成有效的注入代码');
    }
    return generatedSource;
}

function compileJavaScript(source, filename) {
    new vm.Script(source, { filename });
}

module.exports = {
    compileJavaScript,
    generateInjection,
    loadEngineExports,
    loadGenerateJs
};

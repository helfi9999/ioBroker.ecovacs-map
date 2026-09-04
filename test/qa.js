'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fail = [];
const ok = [];
const check = (condition, message) => (condition ? ok : fail).push(message);
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

const pkg = readJson('package.json');
const io = readJson('io-package.json');
const config = readJson('admin/jsonConfig.json');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

check(pkg.name === 'iobroker.ecovacs-map', 'package name is iobroker.ecovacs-map');
check(/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(pkg.version), `package.json version is valid semver-like (${pkg.version})`);
check(io.common && io.common.version === pkg.version, 'io-package common.version matches package.json');
check(io.common && io.common.name === 'ecovacs-map', 'io-package common.name is ecovacs-map');
check(pkg.main === 'main.js', 'package main points to main.js');
check(fs.existsSync(path.join(root, pkg.main)), 'main.js exists');
check(config.i18n === true, 'jsonConfig declares i18n=true');
check(fs.existsSync(path.join(root, 'admin/i18n/de/translations.json')), 'German admin translation exists');
check(fs.existsSync(path.join(root, 'admin/i18n/en/translations.json')), 'English admin translation exists');
check(fs.existsSync(path.join(root, 'admin/ecovacs-map.png')), 'adapter icon exists');
check(fs.existsSync(path.join(root, 'README.md')), 'README exists');
check(fs.existsSync(path.join(root, 'LICENSE')), 'LICENSE exists');
check(!main.includes('autoRefreshMap') && !main.includes('autoRefreshTimers') && !main.includes('scheduleMapRefresh'), 'removed AutoRefresh runtime code is absent (legacy cleanup is allowed)');
check(main.includes("control.selfTest"), 'runtime self-test button is implemented');
check(main.includes("control.rescan"), 'global rescan control is implemented');
check(main.includes("currentUsedSpotAreas"), 'official-app room selection source is handled');

const ids = (io.instanceObjects || []).map(o => o._id);
check(new Set(ids).size === ids.length, 'instance object IDs are unique');
for (const required of ['info.connection','info.devices','control.rescan','control.selfTest','info.selfTestStatus','info.selfTestReport','info.selfTestTimestamp']) {
    check(ids.includes(required), `instance object ${required} exists`);
}

for (const file of ['admin/jsonConfig.json','admin/i18n/de/translations.json','admin/i18n/en/translations.json','io-package.json','package.json']) {
    try { readJson(file); check(true, `${file} parses as JSON`); }
    catch (e) { check(false, `${file} parses as JSON: ${e.message}`); }
}

console.log(`QA: ${ok.length} checks passed.`);
for (const item of ok) console.log(`  OK  ${item}`);
if (fail.length) {
    console.error(`QA: ${fail.length} check(s) failed.`);
    for (const item of fail) console.error(`  FAIL ${item}`);
    process.exit(1);
}
console.log('QA result: PASS');

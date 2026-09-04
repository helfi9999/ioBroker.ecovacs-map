'use strict';

const utils = require('@iobroker/adapter-core');

class EcovacsMap extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'ecovacs-map' });
        this.devices = new Map();
        this.geometryTimer = null;
        this.positionTimer = null;
        this.rebuildTimers = new Map();
        this.selectionGuards = new Map();
        // Local room selection is authoritative for the visual map. Some Ecovacs
        // models/firmware (e.g. a second robot) do not reliably echo
        // markForNextSpotAreaCleaning, so foreign echoes must not undo the UI.
        this.localSelectionOverrides = new Map();
        // Manual deselection must not be re-enabled immediately by stale source
        // selection states or by the current-room fallback while a cleaning run is active.
        this.manualDeselections = new Map();
        // Temporary per-device recorder for discovering which ecovacs-deebot
        // states are actually changed by the official Ecovacs app.
        this.selectionCaptures = new Map();
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.ensureQaObjects();
        await this.setStateAsync('info.connection', false, true);
        this.subscribeStates('*');
        await this.discover();
        await this.runSelfTest('startup');

        const geometrySeconds = this.clampNumber(this.config.geometryRefreshInterval, 300, 30, 3600);
        this.geometryTimer = this.setInterval(() => {
            this.refreshAllGeometry().catch(error => this.log.warn(`Geometry refresh failed: ${error.message}`));
        }, geometrySeconds * 1000);

        const positionSeconds = this.clampNumber(this.config.positionRefreshInterval, 2, 1, 60);
        this.positionTimer = this.setInterval(() => {
            this.refreshAllPositions().catch(error => this.log.warn(`Position refresh failed: ${error.message}`));
        }, positionSeconds * 1000);

        this.log.info(`ecovacs-map ready: ${this.devices.size} device(s).`);
    }

    onUnload(callback) {
        try {
            if (this.geometryTimer) this.clearInterval(this.geometryTimer);
            if (this.positionTimer) this.clearInterval(this.positionTimer);
            for (const timer of this.rebuildTimers.values()) this.clearTimeout(timer);
            callback();
        } catch {
            callback();
        }
    }

    async ensureQaObjects() {
        await this.ensureState('control.selfTest', {
            name: 'Run ecovacs-map self test', type: 'boolean', role: 'button', read: false, write: true, def: false,
        });
        await this.ensureState('info.selfTestStatus', {
            name: 'Self test status', type: 'string', role: 'text', read: true, write: false, def: '',
        });
        await this.ensureState('info.selfTestReport', {
            name: 'Self test report', type: 'string', role: 'text', read: true, write: false, def: '',
        });
        await this.ensureState('info.selfTestTimestamp', {
            name: 'Self test timestamp', type: 'string', role: 'date', read: true, write: false, def: '',
        });
    }

    async runSelfTest(trigger = 'manual') {
        const lines = [];
        let warnings = 0;
        let errors = 0;
        const add = (level, text) => {
            if (level === 'WARN') warnings += 1;
            if (level === 'ERROR') errors += 1;
            lines.push(`${level}: ${text}`);
        };

        if (!this.devices.size) {
            add('ERROR', 'Keine ecovacs-deebot Quelle bzw. kein Gerät erkannt.');
        } else {
            add('OK', `${this.devices.size} Gerät(e) erkannt.`);
        }

        for (const device of this.devices.values()) {
            const prefix = `${device.name} (${device.prefix})`;
            if (device.mapId) add('OK', `${prefix}: Map-ID ${device.mapId}`);
            else add('WARN', `${prefix}: keine Map-ID erkannt.`);

            if (device.roomIds.length) add('OK', `${prefix}: ${device.roomIds.length} Raum/Räume erkannt.`);
            else add('WARN', `${prefix}: keine Räume erkannt.`);

            if (device.transform) add('OK', `${prefix}: Raumgeometrie/Transformation verfügbar.`);
            else add('WARN', `${prefix}: keine nutzbare Raumgeometrie/Transformation.`);

            if (device.positionSource) add('OK', `${prefix}: Positionsquelle ${device.positionSource}`);
            else add('WARN', `${prefix}: keine Live-Positionsquelle erkannt.`);

            const svg = await this.getStateAsync(`${device.key}.map.svg`);
            if (svg && typeof svg.val === 'string' && svg.val.includes('<svg')) add('OK', `${prefix}: SVG-Ausgabe vorhanden.`);
            else add('WARN', `${prefix}: SVG-Ausgabe noch leer.`);
        }

        const status = errors ? 'error' : warnings ? 'warning' : 'ok';
        const timestamp = new Date().toISOString();
        const report = [
            `ecovacs-map Self-Test 0.6.4 (${trigger})`,
            `Status: ${status} | Fehler: ${errors} | Warnungen: ${warnings}`,
            ...lines,
        ].join('\n');
        await this.setStateAsync('info.selfTestStatus', status, true);
        await this.setStateAsync('info.selfTestReport', report, true);
        await this.setStateAsync('info.selfTestTimestamp', timestamp, true);
        this.log.debug(`Self test finished: ${status}, ${errors} error(s), ${warnings} warning(s).`);
        return { status, errors, warnings, report };
    }

    clampNumber(value, fallback, min, max) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    escapeRegex(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    sanitizeName(name, fallback) {
        const result = String(name || fallback || 'robot')
            .trim()
            .replace(/[.\s]+/g, '_')
            .replace(/[^a-zA-Z0-9äöüÄÖÜß_-]/g, '')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
        return result || fallback || 'robot';
    }

    async getAllSourceStates() {
        const states = await this.getForeignStatesAsync('ecovacs-deebot.*');
        return states || {};
    }

    detectPrefixes(states) {
        const configured = String(this.config.sourceInstance || 'auto').trim();
        if (configured && configured !== 'auto') return [configured.replace(/\.$/, '')];

        const out = new Set();
        for (const id of Object.keys(states)) {
            const match = id.match(/^(ecovacs-deebot\.\d+)\./);
            if (match) out.add(match[1]);
        }
        return [...out].sort((a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop()));
    }

    stateValue(states, id, fallback = '') {
        const state = states[id];
        if (!state || state.val === null || state.val === undefined) return fallback;
        return state.val;
    }

    detectDeviceName(prefix, states) {
        const candidates = [
            `${prefix}.info.deviceName`, `${prefix}.info.name`, `${prefix}.info.nickName`,
            `${prefix}.info.nickname`, `${prefix}.deviceName`, `${prefix}.name`,
        ];
        for (const id of candidates) {
            const value = String(this.stateValue(states, id, '') || '').trim();
            if (value) return value;
        }
        return prefix.replace('ecovacs-deebot.', 'Sauger_');
    }

    detectMapId(prefix, states) {
        const counts = new Map();
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${escaped}\\.map\\.([^\\.]+)\\.spotAreas\\.`);
        for (const id of Object.keys(states)) {
            const match = id.match(re);
            if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
        }
        if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

        for (const id of [`${prefix}.map.mapId`, `${prefix}.map.currentMapId`, `${prefix}.map.currentMapID`]) {
            const value = String(this.stateValue(states, id, '') || '').trim();
            if (value) return value;
        }
        return '';
    }

    detectRoomIds(prefix, mapId, states) {
        if (!mapId) return [];
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedMap = mapId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${escapedPrefix}\\.map\\.${escapedMap}\\.spotAreas\\.([^\\.]+)\\.`);
        const out = new Set();
        for (const id of Object.keys(states)) {
            const match = id.match(re);
            if (match) out.add(match[1]);
        }
        return [...out].sort((a, b) => Number(a) - Number(b));
    }

    detectRoomNameDetails(prefix, mapId, roomId, states) {
        const base = `${prefix}.map.${mapId}.spotAreas.${roomId}`;
        const candidates = [];
        const add = (id, score) => {
            const value = String(this.stateValue(states, id, '') || '').trim();
            if (!value) return;
            let adjusted = score;
            if (/^[A-Z]$/i.test(value)) adjusted -= 250;
            if (/^Raum\s*\d+$/i.test(value)) adjusted -= 300;
            candidates.push({ id, name: value, score: adjusted });
        };

        const preferred = [
            ['userDefinedName', 1200], ['customName', 1150], ['displayName', 1100],
            ['roomName', 1050], ['areaName', 1000], ['name', 950], ['label', 900],
            ['spotAreaName', 700],
        ];
        for (const [suffix, score] of preferred) add(`${base}.${suffix}`, score);

        for (const id of Object.keys(states)) {
            if (!id.startsWith(`${base}.`)) continue;
            const suffix = id.slice(base.length + 1);
            if (!/(name|label|title|description)$/i.test(suffix)) continue;
            let score = 600;
            if (/custom|user/i.test(suffix)) score += 300;
            if (/room|area/i.test(suffix)) score += 150;
            add(id, score);
        }

        candidates.sort((a, b) => b.score - a.score || b.name.length - a.name.length);
        if (candidates.length) return candidates[0];
        return { name: `Raum ${roomId}`, id: '' };
    }

    detectRoomName(prefix, mapId, roomId, states) {
        return this.detectRoomNameDetails(prefix, mapId, roomId, states).name;
    }

    isGenericRoomName(name, roomId) {
        const value = String(name || '').trim();
        return !value || /^[A-Z]$/i.test(value) || new RegExp(`^Raum\s*${String(roomId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(value);
    }

    objectCommonName(obj) {
        if (!obj || !obj.common) return '';
        const name = obj.common.name;
        if (typeof name === 'string') return name.trim();
        if (name && typeof name === 'object') {
            return String(name.de || name.en || Object.values(name)[0] || '').trim();
        }
        return '';
    }

    async resolveRoomName(device, roomId, states) {
        const detected = this.detectRoomNameDetails(device.prefix, device.mapId, roomId, states);
        if (!this.isGenericRoomName(detected.name, roomId)) return detected;

        const base = `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}`;
        const objectIds = [base, `${base}.roomName`, `${base}.areaName`, `${base}.name`, `${base}.label`, `${base}.spotAreaName`];
        for (const id of objectIds) {
            try {
                const obj = await this.getForeignObjectAsync(id);
                const name = this.objectCommonName(obj);
                if (name && !this.isGenericRoomName(name, roomId) && !/^(name|label|room name|area name|spot area name)$/i.test(name)) {
                    return { name, id: `${id} [object.common.name]` };
                }
            } catch { /* optional metadata only */ }
        }
        return detected;
    }

    getUnifiedRoomConfigRows() {
        if (Array.isArray(this.config.roomConfig) && this.config.roomConfig.length) return this.config.roomConfig;

        // Backward-compatible migration view for 0.5.5/0.6.3 settings. The
        // persisted settings are converted by syncRoomNameConfig() after discovery.
        const rows = [];
        for (const row of (Array.isArray(this.config.roomNames) ? this.config.roomNames : [])) {
            rows.push({
                deviceName: row?.deviceName || '',
                sourceInstance: row?.sourceInstance || '',
                roomIds: String(row?.roomId ?? ''),
                ecovacsName: row?.ecovacsName || '',
                customName: row?.customName || '',
            });
        }
        for (const row of (Array.isArray(this.config.roomMerges) ? this.config.roomMerges : [])) {
            rows.push({
                deviceName: row?.deviceName || row?.device || '',
                sourceInstance: row?.sourceInstance || (/^ecovacs-deebot\.\d+$/.test(String(row?.device || '')) ? row.device : ''),
                roomIds: String(row?.roomIds || ''),
                ecovacsName: '',
                customName: row?.mergedName || row?.name || '',
            });
        }
        return rows;
    }

    getRoomNameOverride(device, roomId) {
        const rows = this.getUnifiedRoomConfigRows();
        const match = rows.find(row => {
            const targetMatches = String(row?.sourceInstance || '') === String(device.prefix) ||
                String(row?.deviceName || row?.device || '') === String(device.name) ||
                String(row?.deviceName || row?.device || '') === String(device.key);
            const ids = this.parseRoomMergeIds(row?.roomIds ?? row?.roomId);
            return targetMatches && ids.length === 1 && ids[0] === String(roomId);
        });
        return String(match?.customName || '').trim();
    }

    parseRoomMergeIds(value) {
        const ids = [];
        for (const token of String(value || '').split(/[;,\s]+/)) {
            const id = token.trim();
            if (!id || !/^-?\d+$/.test(id) || ids.includes(id)) continue;
            ids.push(id);
        }
        return ids;
    }

    getRoomMerges(device) {
        const rows = this.getUnifiedRoomConfigRows();
        const result = [];
        const used = new Set();
        for (const row of rows) {
            const targets = [row?.sourceInstance, row?.deviceName, row?.device].map(v => String(v || '').trim()).filter(Boolean);
            if (!targets.some(target => [device.name, device.key, device.prefix].some(value => String(value) === target))) continue;
            const ids = this.parseRoomMergeIds(row?.roomIds ?? row?.roomId).filter(id => device.roomIds.includes(id) && !used.has(id));
            if (ids.length < 2) continue;
            const name = String(row?.customName || row?.mergedName || row?.name || '').trim() || ids.map(id => device.rooms.get(id)?.name || `Raum ${id}`).join(' + ');
            ids.forEach(id => used.add(id));
            result.push({ name, ids });
        }
        return result;
    }

    roomMergeForId(device, roomId) {
        return this.getRoomMerges(device).find(group => group.ids.includes(String(roomId))) || null;
    }

    buildRoomMergeReport(device) {
        const groups = this.getRoomMerges(device);
        if (!groups.length) return 'Keine virtuelle Raum-Zusammenführung konfiguriert.';
        return groups.map(group => `${group.name}: ${group.ids.join(',')}`).join('\n');
    }

    async syncRoomNameConfig() {
        try {
            const instanceId = `system.adapter.${this.namespace}`;
            const obj = await this.getForeignObjectAsync(instanceId);
            if (!obj) return;

            const native = obj.native || {};
            let existing = Array.isArray(native.roomConfig) ? native.roomConfig : [];

            // First start after upgrading: convert the two former tables into one
            // unified table without losing custom names or virtual merge groups.
            if (!existing.length) {
                const migrated = [];
                for (const row of (Array.isArray(native.roomNames) ? native.roomNames : [])) {
                    migrated.push({
                        deviceName: row?.deviceName || '',
                        sourceInstance: row?.sourceInstance || '',
                        roomIds: String(row?.roomId ?? ''),
                        ecovacsName: row?.ecovacsName || '',
                        customName: row?.customName || '',
                    });
                }
                for (const row of (Array.isArray(native.roomMerges) ? native.roomMerges : [])) {
                    const target = String(row?.device || row?.deviceName || row?.sourceInstance || '').trim();
                    const dev = [...this.devices.values()].find(d => [d.name, d.key, d.prefix].includes(target));
                    migrated.push({
                        deviceName: dev?.name || (/^ecovacs-deebot\.\d+$/.test(target) ? '' : target),
                        sourceInstance: dev?.prefix || (/^ecovacs-deebot\.\d+$/.test(target) ? target : ''),
                        roomIds: String(row?.roomIds || ''),
                        ecovacsName: '',
                        customName: row?.mergedName || row?.name || '',
                    });
                }
                existing = migrated;
            }

            const rows = [];
            for (const device of this.devices.values()) {
                const covered = new Set();
                const candidates = existing.filter(row => {
                    const targets = [row?.sourceInstance, row?.deviceName, row?.device].map(v => String(v || '').trim()).filter(Boolean);
                    return targets.some(target => [device.name, device.key, device.prefix].includes(target));
                }).sort((a, b) =>
                    this.parseRoomMergeIds(b?.roomIds ?? b?.roomId).length - this.parseRoomMergeIds(a?.roomIds ?? a?.roomId).length
                );

                // Preserve configured groups first. This makes editing "2" to
                // "2,3" enough to merge rooms; the redundant old row for 3 is
                // automatically omitted on the next sync.
                for (const row of candidates) {
                    const ids = this.parseRoomMergeIds(row?.roomIds ?? row?.roomId)
                        .filter(id => device.roomIds.includes(id) && !covered.has(id));
                    if (!ids.length) continue;
                    if (ids.some(id => covered.has(id))) continue;
                    ids.forEach(id => covered.add(id));
                    const sourceNames = ids.map(id => {
                        const room = device.rooms.get(id);
                        return String(room?.sourceName || room?.name || `Spot area ${id}`);
                    });
                    rows.push({
                        deviceName: device.name,
                        sourceInstance: device.prefix,
                        roomIds: ids.join(','),
                        ecovacsName: sourceNames.join(' + '),
                        customName: String(row?.customName || row?.mergedName || row?.name || ''),
                    });
                }

                for (const roomId of device.roomIds) {
                    if (covered.has(String(roomId))) continue;
                    const room = device.rooms.get(roomId);
                    rows.push({
                        deviceName: device.name,
                        sourceInstance: device.prefix,
                        roomIds: String(roomId),
                        ecovacsName: String(room?.sourceName || room?.name || `Spot area ${roomId}`),
                        customName: '',
                    });
                }
            }

            rows.sort((a, b) =>
                a.sourceInstance.localeCompare(b.sourceInstance) ||
                Number(this.parseRoomMergeIds(a.roomIds)[0] || 0) - Number(this.parseRoomMergeIds(b.roomIds)[0] || 0)
            );

            if (JSON.stringify(native.roomConfig || []) === JSON.stringify(rows) && native.roomNames === undefined && native.roomMerges === undefined) return;
            obj.native = { ...native, roomConfig: rows };
            delete obj.native.roomNames;
            delete obj.native.roomMerges;
            await this.setForeignObjectAsync(instanceId, obj);
            this.config.roomConfig = rows;
            delete this.config.roomNames;
            delete this.config.roomMerges;
            this.log.debug(`Updated unified room settings table with ${rows.length} row(s).`);
        } catch (error) {
            this.log.debug(`Could not update unified room settings table: ${error.message}`);
        }
    }

    async discover() {
        const states = await this.getAllSourceStates();
        const prefixes = this.detectPrefixes(states);

        for (const old of this.devices.values()) this.unsubscribeForeignStates(`${old.prefix}.*`);
        this.devices.clear();

        for (const prefix of prefixes) {
            const mapId = this.detectMapId(prefix, states);
            const roomIds = this.detectRoomIds(prefix, mapId, states);
            const name = this.detectDeviceName(prefix, states);
            let key = this.sanitizeName(name, prefix.replace('ecovacs-deebot.', 'Sauger_'));
            if (this.devices.has(key)) key = `${key}_${prefix.split('.').pop()}`;

            const device = {
                key, name, prefix, mapId, roomIds,
                rooms: new Map(), bounds: null, transform: null, trail: [], rawTrail: [], lastRawPosition: null, wasCleaning: false,
                image: '', robotX: 0, robotY: 0, angle: 0, rotation: 0, robotSize: 4.5, labelSize: 7, labelColor: '#ffffff', labelStrokeColor: '#000000', labelStrokeWidth: 1.6,
                positionSource: '', rawPosition: '',
                reportInitialized: false, reportStatus: '', reportRoom: '', reportTargets: '', reportSequence: 0, historyEvents: [], historyMaxEntries: 100,
            };
            this.devices.set(key, device);
            await this.ensureDeviceObjects(device, states);
            this.subscribeForeignStates(`${prefix}.*`);
            await this.refreshDevice(device, states);
            this.log.debug(`${name}: source=${prefix}, mapId=${mapId || '-'}, rooms=${roomIds.length}`);
        }

        await this.syncRoomNameConfig();

        // Migration cleanup: remove obsolete object trees from pre-0.2.x versions.
        // Delete known child states explicitly first because some controller/admin
        // combinations keep legacy children after adapter upgrades.
        const legacyObjects = [
            'commands.rescan',
            'commands',
            'devices',
        ];
        for (const legacyId of legacyObjects) {
            try {
                const legacyObject = await this.getObjectAsync(legacyId);
                if (legacyObject) {
                    await this.delObjectAsync(legacyId, { recursive: true });
                    this.log.debug(`Removed legacy object ${legacyId}`);
                }
            } catch (error) {
                this.log.debug(`Could not remove legacy ${legacyId}: ${error.message}`);
            }
        }

        await this.setStateAsync('info.devices', this.devices.size, true);
        await this.setStateAsync('info.connection', this.devices.size > 0, true);
        if (!this.devices.size) this.log.warn('No ecovacs-deebot source instance/device detected.');
    }

    async ensureState(id, common) {
        await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
    }

    async ensureChannel(id, name) {
        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
    }

    async readOwnValue(ids, fallback) {
        for (const id of ids) {
            try {
                const state = await this.getStateAsync(id);
                if (state && state.val !== null && state.val !== undefined && state.val !== '') return state.val;
            } catch { /* migration fallback */ }
        }
        return fallback;
    }

    async ensureDeviceObjects(device, states) {
        const base = `${device.key}`;
        const legacyBase = `devices.${device.key}`;

        // Read user settings from both the new 0.2.x tree and the old 0.1.x tree
        // before the old tree is removed.
        const savedRotation = await this.readOwnValue([`${base}.map.rotation`, `${legacyBase}.map.rotation`], 0);
        const savedRobotSize = await this.readOwnValue([`${base}.appearance.robotSize`, `${legacyBase}.map.robotSize`], 4.5);
        const savedLabelSize = await this.readOwnValue([`${base}.appearance.labelSize`, `${legacyBase}.map.labelSize`], 7);
        const savedLabelColor = await this.readOwnValue([`${base}.appearance.labelColor`, `${legacyBase}.map.labelColor`], '#ffffff');
        const savedLabelStrokeColor = await this.readOwnValue([`${base}.appearance.labelStrokeColor`, `${legacyBase}.map.labelStrokeColor`], '#000000');
        const savedLabelStrokeWidth = await this.readOwnValue([`${base}.appearance.labelStrokeWidth`, `${legacyBase}.map.labelStrokeWidth`], 1.6);
        const savedHistoryMaxEntries = await this.readOwnValue([`${base}.history.maxEntries`], 100);
        const savedHistoryEvents = await this.readOwnValue([`${base}.history.events`], '');
        const savedReportSequence = await this.readOwnValue([`${base}.report.sequence`], 0);

        await this.setObjectNotExistsAsync(base, { type: 'device', common: { name: device.name }, native: {} });
        await this.ensureChannel(`${base}.status`, 'Status');
        await this.ensureChannel(`${base}.control`, 'Control');
        await this.ensureChannel(`${base}.map`, 'Map');
        await this.ensureChannel(`${base}.appearance`, 'Appearance');
        await this.ensureChannel(`${base}.report`, 'Live report');
        await this.ensureChannel(`${base}.history`, 'History');
        await this.ensureChannel(`${base}.rooms`, 'Rooms');

        const defs = [
            ['status.sourceInstance', { name: 'Source instance', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.mapId', { name: 'Map ID', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.deviceName', { name: 'Detected device name', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.sourceAdapterVersion', { name: 'ecovacs-deebot adapter version', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.roomsDetected', { name: 'Detected rooms', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            ['status.geometryDetected', { name: 'Room geometry detected', type: 'boolean', role: 'indicator', read: true, write: false, def: false }],
            ['status.positionDetected', { name: 'Live robot position detected', type: 'boolean', role: 'indicator', read: true, write: false, def: false }],
            ['status.mapDetected', { name: 'Map image source detected', type: 'boolean', role: 'indicator', read: true, write: false, def: false }],
            ['status.controlsDetected', { name: 'Cleaning controls detected', type: 'boolean', role: 'indicator', read: true, write: false, def: false }],
            ['status.compatibility', { name: 'Compatibility status', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.diagnosticReport', { name: 'Device compatibility diagnostic report', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.roomGeometryReport', { name: 'Room geometry source diagnostic report', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.roomMergeReport', { name: 'Configured virtual room merges', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.state', { name: 'Robot status', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.position', { name: 'Current room', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.positionSource', { name: 'Detected source state for robot position', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.rawPosition', { name: 'Raw robot position from source adapter', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.positionStatus', { name: 'Robot position update status', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['status.selectionCaptureActive', { name: 'App selection diagnostic capture active', type: 'boolean', role: 'indicator', read: true, write: false, def: false }],
            ['status.selectionCaptureReport', { name: 'Changed ecovacs-deebot states during app selection capture', type: 'string', role: 'text', read: true, write: false, def: '' }],

            ['control.clean', { name: 'Start full cleaning', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.stop', { name: 'Stop cleaning', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.pause', { name: 'Pause cleaning', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.home', { name: 'Return to charging station', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.cleanSelectedRooms', { name: 'Clean selected rooms', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.refreshMap', { name: 'Request fresh map image manually', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.rotateLeft', { name: 'Rotate map 90° left', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.rotateRight', { name: 'Rotate map 90° right', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.captureAppSelection', { name: 'Capture Ecovacs app room-selection changes for 30 seconds', type: 'boolean', role: 'button', read: false, write: true, def: false }],
            ['control.lastAction', { name: 'Last action', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['control.lastSource', { name: 'Last source command state', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['control.status', { name: 'Command status', type: 'string', role: 'text', read: true, write: false, def: '' }],

            ['map.svg', { name: 'SVG map without Ecovacs background', type: 'string', role: 'html', read: true, write: false, def: '' }],
            ['map.html', { name: 'HTML map for VIS without Ecovacs background image', type: 'string', role: 'html', read: true, write: false, def: '' }],
            ['map.robotX', { name: 'Robot X pixel', type: 'number', role: 'value', unit: 'px', read: true, write: false, def: 0 }],
            ['map.robotY', { name: 'Robot Y pixel', type: 'number', role: 'value', unit: 'px', read: true, write: false, def: 0 }],
            ['map.angle', { name: 'Robot angle', type: 'number', role: 'value.direction', unit: '°', read: true, write: false, def: 0 }],
            ['map.trail', { name: 'Cleaning trail SVG points', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['map.coordinateMode', { name: 'Coordinate transform mode', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['map.viewBox', { name: 'Automatic SVG viewBox', type: 'string', role: 'text', read: true, write: false, def: '0 0 540 231' }],
            ['map.rotation', { name: 'Map rotation', type: 'number', role: 'level', unit: '°', read: true, write: true, def: 0, states: { '0': '0°', '90': '90°', '180': '180°', '270': '270°' } }],
            ['map.bounds.minX', { name: 'Map min X', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            ['map.bounds.maxX', { name: 'Map max X', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            ['map.bounds.minY', { name: 'Map min Y', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            ['map.bounds.maxY', { name: 'Map max Y', type: 'number', role: 'value', read: true, write: false, def: 0 }],

            ['report.current', { name: 'Current live report', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['report.lastEvent', { name: 'Last report event', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['report.lastEventTime', { name: 'Last report event time', type: 'string', role: 'date', read: true, write: false, def: '' }],
            ['report.sequence', { name: 'Report event sequence number', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            ['history.events', { name: 'Cleaning event history', type: 'string', role: 'text', read: true, write: false, def: '' }],
            ['history.count', { name: 'Number of stored history events', type: 'number', role: 'value', read: true, write: false, def: 0 }],
            ['history.maxEntries', { name: 'Maximum number of history events', type: 'number', role: 'level', read: true, write: true, def: 100, min: 10, max: 500, step: 10 }],
            ['history.clear', { name: 'Clear cleaning event history', type: 'boolean', role: 'button', read: false, write: true, def: false }],

            ['appearance.robotSize', { name: 'Robot marker radius', type: 'number', role: 'level', unit: 'px', read: true, write: true, def: 4.5, min: 2, max: 20, step: 0.5 }],
            ['appearance.labelSize', { name: 'Room label font size', type: 'number', role: 'level', unit: 'px', read: true, write: true, def: 7, min: 4, max: 24, step: 0.5 }],
            ['appearance.labelColor', { name: 'Room label text color (CSS: hex/rgb/rgba/name)', type: 'string', role: 'text', read: true, write: true, def: '#ffffff' }],
            ['appearance.labelStrokeColor', { name: 'Room label outline color (CSS: hex/rgb/rgba/name)', type: 'string', role: 'text', read: true, write: true, def: '#000000' }],
            ['appearance.labelStrokeWidth', { name: 'Room label outline width', type: 'number', role: 'level', unit: 'px', read: true, write: true, def: 1.6, min: 0, max: 10, step: 0.1 }],
        ];
        for (const [suffix, common] of defs) await this.ensureState(`${base}.${suffix}`, common);

        await this.setStateAsync(`${base}.status.sourceInstance`, device.prefix, true);
        await this.setStateAsync(`${base}.status.mapId`, device.mapId, true);
        await this.setStateAsync(`${base}.status.deviceName`, device.name, true);
        await this.setStateAsync(`${base}.status.roomsDetected`, device.roomIds.length, true);

        device.rotation = this.normalizeRotation(savedRotation);
        device.robotSize = this.normalizeRobotSize(savedRobotSize);
        device.labelSize = this.normalizeLabelSize(savedLabelSize);
        device.labelColor = this.normalizeCssColor(savedLabelColor, '#ffffff');
        device.labelStrokeColor = this.normalizeCssColor(savedLabelStrokeColor, '#000000');
        device.labelStrokeWidth = this.normalizeLabelStrokeWidth(savedLabelStrokeWidth);
        device.historyMaxEntries = this.normalizeHistoryMaxEntries(savedHistoryMaxEntries);
        device.historyEvents = String(savedHistoryEvents || '').split('\n').map(line => line.trim()).filter(Boolean).slice(-device.historyMaxEntries);
        device.reportSequence = Number.isFinite(Number(savedReportSequence)) ? Number(savedReportSequence) : 0;

        await this.setStateAsync(`${base}.map.rotation`, device.rotation, true);
        await this.setStateAsync(`${base}.appearance.robotSize`, device.robotSize, true);
        await this.setStateAsync(`${base}.appearance.labelSize`, device.labelSize, true);
        await this.setStateAsync(`${base}.appearance.labelColor`, device.labelColor, true);
        await this.setStateAsync(`${base}.appearance.labelStrokeColor`, device.labelStrokeColor, true);
        await this.setStateAsync(`${base}.appearance.labelStrokeWidth`, device.labelStrokeWidth, true);
        await this.setStateAsync(`${base}.history.maxEntries`, device.historyMaxEntries, true);
        await this.setStateAsync(`${base}.history.events`, device.historyEvents.join('\n'), true);
        await this.setStateAsync(`${base}.history.count`, device.historyEvents.length, true);
        await this.setStateAsync(`${base}.report.sequence`, device.reportSequence, true);

        // Cleanup legacy states from earlier development versions.
        // The SVG/HTML map does not use the original Ecovacs image and there is
        // deliberately no automatic loadMapImage polling anymore.
        for (const obsolete of [`${base}.map.image`, `${base}.map.imageSource`, `${base}.map.autoRefresh`]) {
            try {
                const obj = await this.getObjectAsync(obsolete);
                if (obj) await this.delObjectAsync(obsolete);
            } catch (error) {
                this.log.debug(`Could not remove obsolete ${obsolete}: ${error.message}`);
            }
        }

        for (const roomId of device.roomIds) {
            const rb = `${base}.rooms.${roomId}`;
            await this.ensureChannel(rb, this.detectRoomName(device.prefix, device.mapId, roomId, states));
            await this.ensureState(`${rb}.name`, { name: 'Room name', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.ecovacsName`, { name: 'Original Ecovacs room name', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.label`, { name: 'Short room label used on map', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.selected`, { name: 'Selected for spot-area cleaning', type: 'boolean', role: 'switch', read: true, write: true, def: false });
            await this.ensureState(`${rb}.toggle`, { name: 'Toggle room selection', type: 'boolean', role: 'button', read: false, write: true, def: false });
            await this.ensureState(`${rb}.selectionSource`, { name: 'Source state(s) used for room selection sync', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.syncStatus`, { name: 'Room selection synchronization status', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.clean`, { name: 'Clean this room', type: 'boolean', role: 'button', read: false, write: true, def: false });
            await this.ensureState(`${rb}.polygon`, { name: 'Scaled room polygon', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.centerX`, { name: 'Room label X pixel', type: 'number', role: 'value', unit: 'px', read: true, write: false, def: 0 });
            await this.ensureState(`${rb}.centerY`, { name: 'Room label Y pixel', type: 'number', role: 'value', unit: 'px', read: true, write: false, def: 0 });
            await this.ensureState(`${rb}.rawGeometry`, { name: 'Raw room geometry', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.geometrySource`, { name: 'Source state of room geometry', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.sourceState`, { name: 'Source room channel', type: 'string', role: 'text', read: true, write: false, def: '' });
            await this.ensureState(`${rb}.nameSource`, { name: 'Source state/object of room name', type: 'string', role: 'text', read: true, write: false, def: '' });
        }
    }

    normalizeImage(raw) {
        let value = String(raw || '').trim();
        if (!value) return '';
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (value.startsWith('data:image/')) return value;
        if (/^https?:\/\//i.test(value) || value.startsWith('/files/')) return value;
        if (value.length > 500 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) return `data:image/png;base64,${value}`;
        return '';
    }

    findMapImage(device, states) {
        const preferred = device.mapId ? `${device.prefix}.map.${device.mapId}.map64` : '';
        if (preferred) {
            const image = this.normalizeImage(this.stateValue(states, preferred, ''));
            if (image) return { id: preferred, image };
        }
        const candidates = [];
        for (const [id, state] of Object.entries(states)) {
            if (!id.startsWith(`${device.prefix}.`)) continue;
            if (!/(map64|map.*image|image.*map|cleaning.*image)/i.test(id)) continue;
            const image = this.normalizeImage(state && state.val);
            if (!image) continue;
            let score = 0;
            if (/\.map64$/i.test(id)) score += 1000;
            if (/map.*image|image.*map/i.test(id)) score += 500;
            if (/cleaninglog/i.test(id)) score -= 300;
            candidates.push({ id, image, score });
        }
        candidates.sort((a, b) => b.score - a.score || b.image.length - a.image.length);
        return candidates[0] || { id: '', image: '' };
    }

    flattenNumbers(value) {
        const out = [];
        const walk = v => {
            if (v === null || v === undefined) return;
            if (typeof v === 'number') { if (Number.isFinite(v)) out.push(v); return; }
            if (typeof v === 'string') {
                const s = v.trim();
                if (!s) return;
                if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
                    try { walk(JSON.parse(s)); return; } catch { /* parse fallback below */ }
                }
                const nums = s.match(/-?\d+(?:\.\d+)?/g);
                if (nums) for (const n of nums) { const x = Number(n); if (Number.isFinite(x)) out.push(x); }
                return;
            }
            if (Array.isArray(v)) { for (const x of v) walk(x); return; }
            if (typeof v === 'object') {
                if (Object.prototype.hasOwnProperty.call(v, 'x') && Object.prototype.hasOwnProperty.call(v, 'y')) { walk(v.x); walk(v.y); return; }
                for (const x of Object.values(v)) walk(x);
            }
        };
        walk(value);
        return out;
    }

    pairsFromNumbers(id, nums) {
        if (!nums || nums.length < 4) return [];
        if (nums.length === 4 && /bounds|rectangle|rect/i.test(id)) {
            const [x1, y1, x2, y2] = nums;
            return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
        }
        if (nums.length < 6) return [];
        const out = [];
        for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
        return out.length >= 3 ? out : [];
    }

    geometryScore(id, nums) {
        const n = id.toLowerCase();
        let score = 0;
        if (/polygon/.test(n)) score += 1000;
        if (/boundar(y|ies)/.test(n)) score += 900;
        if (/vertices|vertex/.test(n)) score += 850;
        if (/outline|contour/.test(n)) score += 800;
        if (/coordinates|coords/.test(n)) score += 700;
        if (/points/.test(n)) score += 650;
        if (/bounds|rectangle|rect/.test(n)) score += 500;
        if (/area/.test(n)) score += 100;
        if (/name|label|selected|markfornext|cleaning|id$/.test(n)) score -= 1000;
        if (/center|centroid|position/.test(n)) score -= 700;
        if (/customarea/.test(n)) score -= 500;
        if (nums.length >= 6) score += Math.min(300, nums.length * 5);
        if (nums.length === 4 && /bounds|rectangle|rect/.test(n)) score += 200;
        return score;
    }

    findRoomGeometry(device, roomId, states) {
        const roomBase = `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}.`;
        const candidates = [];
        for (const [id, state] of Object.entries(states)) {
            if (!id.startsWith(roomBase)) continue;
            const nums = this.flattenNumbers(state && state.val);
            const pairs = this.pairsFromNumbers(id, nums);
            if (pairs.length < 3) continue;
            const score = this.geometryScore(id, nums);
            if (score > 0) candidates.push({ id, pairs, score });
        }
        candidates.sort((a, b) => b.score - a.score || b.pairs.length - a.pairs.length);
        return candidates[0] || null;
    }

    buildRoomGeometryReport(device, states) {
        const lines = [
            `Gerät: ${device.name}`,
            `Quelle: ${device.prefix}`,
            `Map-ID: ${device.mapId || 'nicht erkannt'}`,
            `Erkannte Räume: ${device.roomIds.length}`,
        ];

        for (const roomId of device.roomIds) {
            const roomBase = `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}.`;
            const entries = Object.entries(states || {}).filter(([id]) => id.startsWith(roomBase));
            const usable = [];
            lines.push('');
            lines.push(`Raum ${roomId}: ${entries.length} Unterstates`);

            if (!entries.length) {
                lines.push('  keine Unterstates gefunden');
                continue;
            }

            for (const [id, state] of entries) {
                const suffix = id.slice(roomBase.length);
                const nums = this.flattenNumbers(state && state.val);
                const pairs = this.pairsFromNumbers(id, nums);
                const score = pairs.length >= 3 ? this.geometryScore(id, nums) : 0;
                if (pairs.length >= 3 && score > 0) usable.push({ suffix, pairs: pairs.length, score });

                let preview;
                try {
                    const raw = typeof state?.val === 'string' ? state.val : JSON.stringify(state?.val);
                    preview = String(raw ?? '').replace(/\s+/g, ' ').slice(0, 180);
                } catch {
                    preview = String(state?.val ?? '').slice(0, 180);
                }
                const geometryHint = /(polygon|boundar|vertices|vertex|outline|contour|coordinates|coords|points|bounds|rectangle|rect)/i.test(suffix);
                if (geometryHint || pairs.length >= 3) {
                    lines.push(`  ${suffix}: nums=${nums.length}, pairs=${pairs.length}, score=${score}, Wert=${preview}`);
                }
            }

            if (usable.length) {
                usable.sort((a, b) => b.score - a.score || b.pairs - a.pairs);
                lines.push(`  verwendbar: ${usable.map(x => `${x.suffix} (${x.pairs} Punkte, Score ${x.score})`).join(', ')}`);
            } else {
                lines.push('  verwendbar: keine Geometrie erkannt');
                lines.push(`  vorhandene States: ${entries.map(([id]) => id.slice(roomBase.length)).join(', ')}`);
            }
        }
        return lines.join('\n');
    }

    calculateBounds(roomData) {
        const pts = roomData.flatMap(room => room.pairs || []);
        if (!pts.length) return null;
        const minX = Math.min(...pts.map(p => p.x));
        const maxX = Math.max(...pts.map(p => p.x));
        const minY = Math.min(...pts.map(p => p.y));
        const maxY = Math.max(...pts.map(p => p.y));
        if (![minX, maxX, minY, maxY].every(Number.isFinite) || minX === maxX || minY === maxY) return null;
        return { minX, maxX, minY, maxY };
    }

    isPixelLike(pairs) {
        return pairs.length >= 3 && pairs.every(p => p.x >= -5 && p.x <= 545 && p.y >= -5 && p.y <= 236);
    }

    createTransform(roomData, bounds) {
        const allPairs = roomData.flatMap(room => room.pairs || []);
        if (!allPairs.length || !bounds) return null;
        const imgW = 540, imgH = 231, pad = 8;
        const pixelMode = allPairs.every(p => p.x >= -5 && p.x <= 545 && p.y >= -5 && p.y <= 236);
        if (pixelMode) return { mode: 'pixel', imgW, imgH, pad };

        const rawW = bounds.maxX - bounds.minX;
        const rawH = bounds.maxY - bounds.minY;
        if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) return null;
        const scale = Math.min((imgW - pad * 2) / rawW, (imgH - pad * 2) / rawH);
        const drawnW = rawW * scale;
        const drawnH = rawH * scale;
        return {
            mode: 'world', imgW, imgH, pad, scale,
            offX: (imgW - drawnW) / 2,
            offY: (imgH - drawnH) / 2,
            minX: bounds.minX, maxX: bounds.maxX,
            minY: bounds.minY, maxY: bounds.maxY,
        };
    }

    mapPoint(device, x, y) {
        const t = device.transform;
        if (!t || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return { x: 0, y: 0 };
        x = Number(x); y = Number(y);
        if (t.mode === 'pixel') return { x, y };
        return {
            x: t.offX + (x - t.minX) * t.scale,
            y: t.offY + (t.maxY - y) * t.scale,
        };
    }

    scalePairs(device, pairs) {
        if (!pairs.length || !device.transform) return [];
        return pairs.map(p => this.mapPoint(device, p.x, p.y));
    }

    cleanPolygonPairs(pairs) {
        const out = [];
        for (const p of pairs || []) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const prev = out[out.length - 1];
            if (prev && Math.abs(prev.x - p.x) < 0.01 && Math.abs(prev.y - p.y) < 0.01) continue;
            out.push({ x: p.x, y: p.y });
        }
        if (out.length > 2) {
            const first = out[0], last = out[out.length - 1];
            if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) out.pop();
        }
        return out;
    }

    polygonCentroid(pairs) {
        if (!pairs || pairs.length < 3) return { x: 0, y: 0 };
        let area2 = 0, cx = 0, cy = 0;
        for (let i = 0; i < pairs.length; i++) {
            const a = pairs[i], b = pairs[(i + 1) % pairs.length];
            const cross = a.x * b.y - b.x * a.y;
            area2 += cross;
            cx += (a.x + b.x) * cross;
            cy += (a.y + b.y) * cross;
        }
        if (Math.abs(area2) < 0.0001) {
            return {
                x: pairs.reduce((sum, p) => sum + p.x, 0) / pairs.length,
                y: pairs.reduce((sum, p) => sum + p.y, 0) / pairs.length,
            };
        }
        return { x: cx / (3 * area2), y: cy / (3 * area2) };
    }

    mapRoomLabel(name, roomId) {
        const value = String(name || '').trim();
        if (!value) return String(roomId);
        let match = value.match(/^spot\s*area\s*\d+\s*\(([^)]+)\)\s*$/i);
        if (match && match[1].trim()) return match[1].trim();
        match = value.match(/^spot\s*area\s*\d+\s*[-:]\s*(.+)$/i);
        if (match && match[1].trim()) return match[1].trim();
        if (/^spot\s*area\s*\d+$/i.test(value) || /^raum\s*\d+$/i.test(value)) return String(roomId);
        return value;
    }

    async syncProjectedRuntime(device) {
        if (device.lastRawPosition) {
            const p = this.mapPoint(device, device.lastRawPosition.x, device.lastRawPosition.y);
            device.robotX = p.x;
            device.robotY = p.y;
        }
        device.trail = (device.rawTrail || []).map(p => this.mapPoint(device, p.x, p.y));
        const base = `${device.key}.map`;
        await this.setStateAsync(`${base}.robotX`, Number(device.robotX.toFixed(1)), true);
        await this.setStateAsync(`${base}.robotY`, Number(device.robotY.toFixed(1)), true);
        await this.setStateAsync(`${base}.trail`, device.trail.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '), true);
        await this.setStateAsync(`${base}.coordinateMode`, device.transform ? device.transform.mode : '', true);
    }

    parsePosition(value) {
        if (!value) return null;
        if (typeof value === 'object' && value.x !== undefined && value.y !== undefined) {
            return { x: Number(value.x), y: Number(value.y), angle: Number(value.angle || value.a || 0) };
        }
        const nums = String(value).match(/-?\d+(?:\.\d+)?/g);
        if (!nums || nums.length < 2) return null;
        const p = nums.map(Number);
        if (p.some(Number.isNaN)) return null;
        return { x: p[0], y: p[1], angle: p[2] || 0 };
    }

    async refreshDevice(device, states = null) {
        states = states || await this.getAllSourceStates();
        await this.refreshGeometry(device, states);
        await this.refreshMapImage(device, states);
        await this.refreshRuntime(device, states);
        await this.refreshRoomSelections(device, states);
        await this.updateCompatibilityStatus(device, states);
        await this.rebuildView(device);
    }


    async updateCompatibilityStatus(device, states = null) {
        states = states || await this.getAllSourceStates();
        const base = `${device.key}.status`;

        let sourceVersion = '';
        try {
            const obj = await this.getForeignObjectAsync(`system.adapter.${device.prefix}`);
            sourceVersion = String(obj?.common?.version || '');
        } catch { /* diagnostic metadata only */ }

        const geometryDetected = [...device.rooms.values()].some(room => Array.isArray(room.rawPairs) && room.rawPairs.length >= 3);
        const positionSource = this.detectPositionSource(device, states);
        const positionDetected = !!(states[positionSource] && this.parsePosition(states[positionSource].val));
        const mapDetected = !!this.findMapImage(device, states).image;
        const controlIds = [
            `${device.prefix}.control.clean`,
            `${device.prefix}.control.stop`,
            `${device.prefix}.control.pause`,
            `${device.prefix}.control.charge`,
            `${device.prefix}.control.extended.cleanMarkedSpotAreas`,
        ];
        let controlsDetected = false;
        for (const id of controlIds) {
            if (Object.prototype.hasOwnProperty.call(states, id)) { controlsDetected = true; break; }
            try {
                if (await this.getForeignObjectAsync(id)) { controlsDetected = true; break; }
            } catch { /* continue */ }
        }

        let compatibility = 'ready';
        const issues = [];
        if (!device.mapId) issues.push('keine Map-ID');
        if (!device.roomIds.length) issues.push('keine Räume');
        if (!geometryDetected) issues.push('keine Raumgeometrie');
        if (!positionDetected) issues.push('keine Live-Position');
        if (!controlsDetected) issues.push('keine Steuerstates');
        if (issues.length) compatibility = (device.mapId && device.roomIds.length && geometryDetected) ? 'partial' : 'limited';

        const report = [
            `Gerät: ${device.name}`,
            `Quelle: ${device.prefix}`,
            `ecovacs-deebot Version: ${sourceVersion || 'unbekannt'}`,
            `Map-ID: ${device.mapId || 'nicht erkannt'}`,
            `Räume: ${device.roomIds.length}`,
            `Raumgeometrie: ${geometryDetected ? 'ja' : 'nein'}`,
            `Live-Position: ${positionDetected ? 'ja' : 'nein'}${positionSource ? ` (${positionSource})` : ''}`,
            `Map-Bildquelle: ${mapDetected ? 'ja' : 'nein'}`,
            `Steuerung: ${controlsDetected ? 'ja' : 'nein'}`,
            `Kompatibilität: ${compatibility}${issues.length ? ` - ${issues.join(', ')}` : ''}`,
        ].join('\n');

        await this.setStateAsync(`${base}.deviceName`, device.name, true);
        await this.setStateAsync(`${base}.sourceAdapterVersion`, sourceVersion, true);
        await this.setStateAsync(`${base}.roomsDetected`, device.roomIds.length, true);
        await this.setStateAsync(`${base}.geometryDetected`, geometryDetected, true);
        await this.setStateAsync(`${base}.positionDetected`, positionDetected, true);
        await this.setStateAsync(`${base}.mapDetected`, mapDetected, true);
        await this.setStateAsync(`${base}.controlsDetected`, controlsDetected, true);
        await this.setStateAsync(`${base}.compatibility`, compatibility, true);
        await this.setStateAsync(`${base}.diagnosticReport`, report, true);
    }

    async refreshGeometry(device, states = null) {
        states = states || await this.getAllSourceStates();
        const roomData = [];
        for (const roomId of device.roomIds) {
            const found = this.findRoomGeometry(device, roomId, states);
            if (found) roomData.push({ roomId, ...found });
        }
        const bounds = this.calculateBounds(roomData);
        device.bounds = bounds;
        device.transform = this.createTransform(roomData, bounds);
        if (bounds) {
            const base = `${device.key}.map.bounds`;
            await this.setStateAsync(`${base}.minX`, bounds.minX, true);
            await this.setStateAsync(`${base}.maxX`, bounds.maxX, true);
            await this.setStateAsync(`${base}.minY`, bounds.minY, true);
            await this.setStateAsync(`${base}.maxY`, bounds.maxY, true);
        }

        for (const roomId of device.roomIds) {
            const rb = `${device.key}.rooms.${roomId}`;
            const roomNameInfo = await this.resolveRoomName(device, roomId, states);
            const sourceRoomName = roomNameInfo.name;
            const customRoomName = this.getRoomNameOverride(device, roomId);
            const roomName = customRoomName || sourceRoomName;
            const roomLabel = this.mapRoomLabel(roomName, roomId);
            await this.setStateAsync(`${rb}.name`, roomName, true);
            await this.setStateAsync(`${rb}.ecovacsName`, sourceRoomName, true);
            await this.setStateAsync(`${rb}.label`, roomLabel, true);
            await this.setStateAsync(`${rb}.sourceState`, `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}`, true);
            await this.setStateAsync(`${rb}.nameSource`, customRoomName ? 'ecovacs-map settings' : roomNameInfo.id, true);
            try { await this.extendObjectAsync(rb, { common: { name: roomName } }); } catch { /* cosmetic only */ }
            const found = roomData.find(room => room.roomId === roomId);
            if (!found) {
                device.rooms.set(roomId, { name: roomName, sourceName: sourceRoomName, label: roomLabel, rawPairs: [], scaledPairs: [], points: '', source: '', selected: device.rooms.get(roomId)?.selected || false, center: { x: 0, y: 0 } });
                continue;
            }
            const rawPairs = this.cleanPolygonPairs(found.pairs);
            const scaled = this.cleanPolygonPairs(this.scalePairs(device, rawPairs));
            const center = this.polygonCentroid(scaled);
            const points = scaled.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
            const raw = rawPairs.map(p => `${p.x},${p.y}`).join(' ');
            device.rooms.set(roomId, {
                name: roomName, sourceName: sourceRoomName, label: roomLabel, rawPairs, scaledPairs: scaled, points, source: found.id,
                selected: device.rooms.get(roomId)?.selected || false, center,
            });
            await this.setStateAsync(`${rb}.polygon`, points, true);
            await this.setStateAsync(`${rb}.rawGeometry`, raw, true);
            await this.setStateAsync(`${rb}.geometrySource`, found.id, true);
            await this.setStateAsync(`${rb}.centerX`, Number(center.x.toFixed(1)), true);
            await this.setStateAsync(`${rb}.centerY`, Number(center.y.toFixed(1)), true);
        }
        await this.syncProjectedRuntime(device);
        await this.setStateAsync(`${device.key}.status.roomGeometryReport`, this.buildRoomGeometryReport(device, states), true);
        await this.setStateAsync(`${device.key}.status.roomMergeReport`, this.buildRoomMergeReport(device), true);
    }

    async refreshMapImage(device, states = null) {
        // The original Ecovacs image is intentionally NOT copied into ecovacs-map.
        // SVG/HTML rendering is based on room geometry, position and trail only.
        // Keeping only the detected source internally avoids duplicating large base64
        // images in the ioBroker object/state database.
        states = states || await this.getAllSourceStates();
        const result = this.findMapImage(device, states);
        device.imageSource = result.id || '';
        return result;
    }

    detectPositionSource(device, states) {
        const exact = `${device.prefix}.map.deebotPosition`;
        if (states[exact] && this.parsePosition(states[exact].val)) return exact;

        const candidates = [];
        for (const [id, state] of Object.entries(states || {})) {
            if (!id.startsWith(`${device.prefix}.`)) continue;
            const lower = id.toLowerCase();
            if (!/(deebot.*position|robot.*position|position.*deebot|position.*robot|map.*position)/i.test(id)) continue;
            if (/spotarea|room|name|current.*area|charger|charge.*position/i.test(id)) continue;
            if (!this.parsePosition(state && state.val)) continue;
            let score = 0;
            if (lower.endsWith('.map.deebotposition')) score += 1000;
            if (lower.includes('deebotposition')) score += 700;
            if (lower.includes('.map.')) score += 300;
            if (lower.includes('position')) score += 100;
            candidates.push({ id, score });
        }
        candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        return candidates[0]?.id || exact;
    }

    async refreshAllPositions() {
        if (!this.devices.size) return;
        const states = await this.getAllSourceStates();
        for (const device of this.devices.values()) {
            const source = this.detectPositionSource(device, states);
            device.positionSource = source;
            await this.setStateAsync(`${device.key}.status.positionSource`, source, true);
            const state = states[source];
            if (!state || !this.parsePosition(state.val)) {
                await this.setStateAsync(`${device.key}.status.positionStatus`, `Keine gültige Position in ${source}`, true);
                continue;
            }
            await this.updatePosition(device, state.val);
            await this.setStateAsync(`${device.key}.status.positionStatus`, `Aktualisiert: ${source}`, true);
            const selectionChanged = await this.refreshRoomSelections(device, states);
            await this.refreshLiveReport(device, states);
            await this.updateCompatibilityStatus(device, states);
            if (selectionChanged) this.log.debug(`${device.name}: room selection mirrored from ecovacs-deebot/app`);
            this.scheduleRebuild(device);
        }
    }

    async refreshRuntime(device, states = null) {
        states = states || await this.getAllSourceStates();
        const statusId = `${device.prefix}.info.deviceStatus`;
        const posNameId = `${device.prefix}.map.deebotPositionCurrentSpotAreaName`;
        const posId = this.detectPositionSource(device, states);
        device.positionSource = posId;
        const status = String(this.stateValue(states, statusId, '') || '');
        await this.setStateAsync(`${device.key}.status.state`, status, true);
        await this.setStateAsync(`${device.key}.status.position`, String(this.stateValue(states, posNameId, '') || ''), true);
        await this.setStateAsync(`${device.key}.status.positionSource`, posId, true);
        await this.updateCleaningState(device, status);
        const rawPos = this.stateValue(states, posId, '');
        await this.updatePosition(device, rawPos);
        await this.setStateAsync(`${device.key}.status.positionStatus`, this.parsePosition(rawPos) ? `Aktualisiert: ${posId}` : `Keine gültige Position in ${posId}`, true);
        await this.refreshLiveReport(device, states);
    }

    async updateCleaningState(device, value) {
        const s = String(value || '').toLowerCase();
        const cleaning = s.includes('clean') || s.includes('spot') || s.includes('auto') || s.includes('edge');
        const finished = s.includes('charging') || s.includes('charge') || s.includes('dock') || s.includes('idle') || s.includes('stop') || s.includes('finish') || s.includes('complete') || s.includes('standby');

        if (cleaning && !device.wasCleaning) {
            device.trail = [];
            device.rawTrail = [];
            device.wasCleaning = true;
            // At the beginning of a run, release local VIS selection locks. This lets
            // room choices made in the Ecovacs app become visible in VIS immediately.
            for (const key of [...this.localSelectionOverrides.keys()]) {
                if (key.startsWith(`${device.key}:`)) this.localSelectionOverrides.delete(key);
            }
            for (const key of [...this.manualDeselections.keys()]) {
                if (key.startsWith(`${device.key}:`)) this.manualDeselections.delete(key);
            }
        }

        // Reset every selected room only on the transition from an active
        // cleaning run to a finished/idle/docked state. This is deliberately
        // device-agnostic and therefore works for every detected Deebot.
        if (finished && device.wasCleaning) {
            device.wasCleaning = false;
            await this.resetRoomSelections(device);
            this.scheduleRebuild(device);
        }
    }

    normalizeHistoryMaxEntries(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 100;
        return Math.max(10, Math.min(500, Math.round(n / 10) * 10));
    }

    reportTimestamp(date = new Date()) {
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    classifyRobotStatus(value) {
        const s = String(value || '').toLowerCase();
        if (/return|returning|go.?home|homing|back.?to.?charge/.test(s)) return 'returning';
        if (/charg|dock/.test(s)) return 'charging';
        if (/pause/.test(s)) return 'paused';
        if (/clean|spot|auto|edge/.test(s)) return 'cleaning';
        if (/idle|standby|stop|finish|complete/.test(s)) return 'idle';
        return s || 'unknown';
    }

    displayRoomName(device, rawName) {
        const raw = String(rawName || '').trim();
        if (!raw) return '';
        const normalized = this.normalizeRoomText(raw);
        for (const [roomId, room] of device.rooms.entries()) {
            const candidates = [room?.name, room?.sourceName, room?.label, roomId]
                .map(value => this.normalizeRoomText(value));
            if (candidates.includes(normalized)) {
                const merge = this.roomMergeForId(device, roomId);
                return merge?.name || room?.name || room?.label || raw;
            }
        }
        return raw;
    }

    currentTargetRoomNames(device, states) {
        const state = states?.[`${device.prefix}.map.currentUsedSpotAreas`];
        if (!state || state.val === null || state.val === undefined || state.val === '') return [];
        const raw = typeof state.val === 'string' ? state.val : JSON.stringify(state.val);
        const ids = [];
        for (const match of String(raw || '').matchAll(/-?\d+/g)) {
            const id = String(Number(match[0]));
            if (!ids.includes(id) && device.rooms.has(id)) ids.push(id);
        }
        const names = ids.map(id => {
            const merge = this.roomMergeForId(device, id);
            return merge?.name || device.rooms.get(id)?.name || device.rooms.get(id)?.label || `Raum ${id}`;
        });
        return [...new Set(names)];
    }

    async setReportCurrent(device, text) {
        const value = String(text || '');
        if (device.reportCurrent === value) return;
        device.reportCurrent = value;
        await this.setStateAsync(`${device.key}.report.current`, value, true);
    }

    async appendHistoryEvent(device, text) {
        const message = String(text || '').trim();
        if (!message) return;
        const now = new Date();
        const line = `${this.reportTimestamp(now)}  ${message}`;
        const last = device.historyEvents[device.historyEvents.length - 1] || '';
        if (last.endsWith(`  ${message}`)) return;
        device.historyEvents.push(line);
        device.historyEvents = device.historyEvents.slice(-device.historyMaxEntries);
        device.reportSequence = Number(device.reportSequence || 0) + 1;
        await this.setStateAsync(`${device.key}.report.lastEvent`, message, true);
        await this.setStateAsync(`${device.key}.report.lastEventTime`, now.toISOString(), true);
        await this.setStateAsync(`${device.key}.report.sequence`, device.reportSequence, true);
        await this.setStateAsync(`${device.key}.history.events`, device.historyEvents.join('\n'), true);
        await this.setStateAsync(`${device.key}.history.count`, device.historyEvents.length, true);
    }

    async refreshLiveReport(device, states = null) {
        states = states || await this.getAllSourceStates();
        const statusRaw = String(this.stateValue(states, `${device.prefix}.info.deviceStatus`, '') || '');
        const statusClass = this.classifyRobotStatus(statusRaw);
        const roomRaw = this.stateValue(states, `${device.prefix}.map.deebotPositionCurrentSpotAreaName`, '');
        const room = this.displayRoomName(device, roomRaw);
        const targets = this.currentTargetRoomNames(device, states);
        const targetKey = targets.join('|');

        let current;
        if (statusClass === 'cleaning') {
            current = room ? `${device.name} reinigt ${room}` : targets.length ? `${device.name} fährt zu ${targets.join(', ')}` : `${device.name} reinigt`;
        } else if (statusClass === 'returning') {
            current = `${device.name} fährt zur Ladestation zurück`;
        } else if (statusClass === 'charging') {
            current = `${device.name} lädt an der Ladestation`;
        } else if (statusClass === 'paused') {
            current = `${device.name}: Reinigung pausiert`;
        } else if (statusClass === 'idle') {
            current = `${device.name} ist bereit`;
        } else {
            current = statusRaw ? `${device.name}: ${statusRaw}` : `${device.name}: Status unbekannt`;
        }
        await this.setReportCurrent(device, current);

        if (!device.reportInitialized) {
            device.reportInitialized = true;
            device.reportStatus = statusClass;
            device.reportRoom = room;
            device.reportTargets = targetKey;
            return;
        }

        const previousStatus = device.reportStatus;
        const previousRoom = device.reportRoom;
        const previousTargets = device.reportTargets;

        if (statusClass !== previousStatus) {
            if (statusClass === 'cleaning') {
                await this.appendHistoryEvent(device, targets.length ? `Reinigung gestartet – fährt zu ${targets.join(', ')}` : 'Reinigung gestartet');
            } else if (statusClass === 'returning') {
                await this.appendHistoryEvent(device, 'Fährt zur Ladestation zurück');
            } else if (statusClass === 'charging') {
                if (previousStatus === 'returning' || previousStatus === 'cleaning') await this.appendHistoryEvent(device, 'An der Ladestation angekommen – lädt');
                else await this.appendHistoryEvent(device, 'Lädt an der Ladestation');
            } else if (statusClass === 'paused') {
                await this.appendHistoryEvent(device, 'Reinigung pausiert');
            } else if (statusClass === 'idle' && ['cleaning', 'returning', 'paused'].includes(previousStatus)) {
                await this.appendHistoryEvent(device, 'Reinigung beendet');
            }
        }

        if (statusClass === 'cleaning' && room && room !== previousRoom) {
            await this.appendHistoryEvent(device, previousRoom ? `Raumwechsel – reinigt jetzt ${room}` : `Reinigt ${room}`);
        } else if (statusClass === 'cleaning' && !room && targetKey && targetKey !== previousTargets) {
            await this.appendHistoryEvent(device, `Fährt zu ${targets.join(', ')}`);
        }

        device.reportStatus = statusClass;
        device.reportRoom = room;
        device.reportTargets = targetKey;
    }

    async resetRoomSelections(device) {
        for (const [roomId, room] of device.rooms.entries()) {
            room.selected = false;
            const key = `${device.key}:${roomId}`;
            this.localSelectionOverrides.delete(key);
            this.selectionGuards.delete(key);
            this.manualDeselections.delete(key);

            await this.setStateAsync(`${device.key}.rooms.${roomId}.selected`, false, true);

            // Also clear the corresponding source-adapter selection when it
            // exists, so ecovacs-map and ecovacs-deebot stay in sync.
            const source = `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}.markForNextSpotAreaCleaning`;
            try {
                const object = await this.getForeignObjectAsync(source);
                if (object) await this.setForeignStateAsync(source, false, false);
            } catch (error) {
                this.log.debug(`${device.name}: could not reset ${source}: ${error.message || error}`);
            }
        }
    }

    async updatePosition(device, value) {
        const pos = this.parsePosition(value);
        if (!pos) return;
        device.rawPosition = typeof value === 'string' ? value : JSON.stringify(value);
        await this.setStateAsync(`${device.key}.status.rawPosition`, device.rawPosition, true);
        device.lastRawPosition = { x: pos.x, y: pos.y };
        const pixel = this.mapPoint(device, pos.x, pos.y);
        device.robotX = pixel.x;
        device.robotY = pixel.y;
        device.angle = pos.angle;

        const lastRaw = device.rawTrail[device.rawTrail.length - 1];
        const lastPixel = lastRaw ? this.mapPoint(device, lastRaw.x, lastRaw.y) : null;
        if (!lastPixel || Math.abs(lastPixel.x - pixel.x) > 1 || Math.abs(lastPixel.y - pixel.y) > 1) {
            device.rawTrail.push({ x: pos.x, y: pos.y });
            const limit = this.clampNumber(this.config.trailLimit, 500, 10, 5000);
            while (device.rawTrail.length > limit) device.rawTrail.shift();
        }
        device.trail = device.rawTrail.map(p => this.mapPoint(device, p.x, p.y));
        const base = `${device.key}.map`;
        await this.setStateAsync(`${base}.robotX`, Number(pixel.x.toFixed(1)), true);
        await this.setStateAsync(`${base}.robotY`, Number(pixel.y.toFixed(1)), true);
        await this.setStateAsync(`${base}.angle`, pos.angle, true);
        await this.setStateAsync(`${base}.trail`, device.trail.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '), true);
        await this.setStateAsync(`${base}.coordinateMode`, device.transform ? device.transform.mode : '', true);
    }

    isTrue(value) {
        return value === true || value === 1 || value === '1' || value === 'true';
    }

    normalizeRoomText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .replace(/[^a-z0-9äöüß]+/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    detectAppSelectedRoomIds(device, states) {
        const selected = new Set();
        const roomIds = new Set(device.roomIds.map(String));

        // Strongest/authoritative source for an app-started spot-area cleaning:
        // ecovacs-deebot publishes exactly the room id(s) that are currently used.
        // IMPORTANT: do not UNION this with older markForNext... states. Those can
        // remain true/stale on some models and previously caused every room to be
        // highlighted even though only one room was selected in the Ecovacs app.
        const currentUsedId = `${device.prefix}.map.currentUsedSpotAreas`;
        const currentUsedState = states[currentUsedId];
        const cleanStatus = String(this.stateValue(states, `${device.prefix}.info.cleanstatus`, '') || '').toLowerCase();
        const spotAreaRun = /spot|area|room/.test(cleanStatus);

        if (spotAreaRun && currentUsedState && currentUsedState.val !== null && currentUsedState.val !== undefined) {
            const raw = typeof currentUsedState.val === 'string'
                ? currentUsedState.val
                : JSON.stringify(currentUsedState.val);
            for (const m of String(raw || '').matchAll(/-?\d+/g)) {
                const idValue = String(Number(m[0]));
                if (roomIds.has(idValue)) selected.add(idValue);
            }
            // During a spot-area run currentUsedSpotAreas is authoritative even
            // when it currently contains no valid room id. Returning here prevents
            // stale per-room flags from re-selecting unrelated rooms.
            return selected;
        }

        // Fallback only when currentUsedSpotAreas is unavailable: use explicit
        // per-room selection states, but only when they changed recently. This
        // avoids stale true values surviving from an older cleaning cycle.
        const now = Date.now();
        for (const roomId of device.roomIds) {
            const roomBase = `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}.`;
            for (const [id, state] of Object.entries(states)) {
                if (!id.startsWith(roomBase) || !state) continue;
                const tail = id.slice(roomBase.length);
                if (!/(mark.*clean|selected|selection|isSelected|activeFor.*clean)/i.test(tail)) continue;
                const ts = Number(state.ts || state.lc || 0);
                if (this.isTrue(state.val) && ts > 0 && now - ts <= 15000) {
                    selected.add(String(roomId));
                }
            }
        }

        // Last-resort fallback while cleaning: highlight only the room the robot
        // is currently in. Never infer additional rooms from generic numeric
        // "clean/area/spot" states; that heuristic caused false positives.
        if (device.wasCleaning && selected.size === 0) {
            const currentName = this.normalizeRoomText(this.stateValue(states, `${device.prefix}.map.deebotPositionCurrentSpotAreaName`, ''));
            if (currentName) {
                for (const [roomId, room] of device.rooms.entries()) {
                    const candidates = [room?.name, room?.label]
                        .map(v => this.normalizeRoomText(v))
                        .filter(v => v.length > 0);
                    if (candidates.some(name => currentName === name || currentName.includes(name) || name.includes(currentName))) {
                        selected.add(String(roomId));
                    }
                }
            }
        }

        return selected;
    }

    async refreshRoomSelections(device, states = null) {
        states = states || await this.getAllSourceStates();
        let changed = false;
        const now = Date.now();
        const appSelected = this.detectAppSelectedRoomIds(device, states);

        for (const roomId of device.roomIds) {
            const localKey = `${device.key}:${roomId}`;
            const room = device.rooms.get(roomId);
            let override = this.localSelectionOverrides.get(localKey);

            if (typeof override === 'boolean') {
                override = { value: override, until: 0 };
                this.localSelectionOverrides.set(localKey, override);
            }
            if (override && Number(override.until || 0) > now) {
                const selected = override.value === true;
                if (room && room.selected !== selected) changed = true;
                if (room) room.selected = selected;
                await this.setStateAsync(`${device.key}.rooms.${roomId}.selected`, selected, true);
                continue;
            }
            if (override) this.localSelectionOverrides.delete(localKey);

            const source = `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}.markForNextSpotAreaCleaning`;
            const sourceState = states[source] || null;
            const sourceTs = Number(sourceState?.ts || sourceState?.lc || 0);
            const sourceSelected = sourceState
                ? this.isTrue(sourceState.val) && sourceTs > 0 && (now - sourceTs <= 15000)
                : false;
            const inferredSelected = appSelected.has(String(roomId));
            const currentUsedState = states[`${device.prefix}.map.currentUsedSpotAreas`];
            const cleanStatus = String(this.stateValue(states, `${device.prefix}.info.cleanstatus`, '') || '').toLowerCase();
            const currentUsedAuthoritative = /spot|area|room/.test(cleanStatus) && !!currentUsedState;

            // A manual VIS deselection is authoritative. Without this guard the
            // current-room fallback (or a stale true echo from ecovacs-deebot) can
            // flip selected back to true on the next 2-second poll.
            const manualBlock = this.manualDeselections.get(localKey);
            if (manualBlock) {
                const sourceTs = Number(sourceState?.ts || 0);
                const graceExpired = now >= Number(manualBlock.until || 0);
                const genuinelyNewExplicitSelection = sourceSelected && graceExpired && sourceTs > Number(manualBlock.at || 0);
                if (!genuinelyNewExplicitSelection) {
                    if (room && room.selected !== false) changed = true;
                    if (room) room.selected = false;
                    await this.setStateAsync(`${device.key}.rooms.${roomId}.selected`, false, true);
                    continue;
                }
                this.manualDeselections.delete(localKey);
            }

            // While cleaning, false source marks are often stale or not updated at
            // all for app-started runs. Never use those false values to erase a room
            // that was already inferred/selected during the current run. The normal
            // finished-state reset clears everything at the end.
            let selected;
            if (currentUsedAuthoritative) {
                // Exact app/runtime room list wins. Never merge stale per-room flags.
                selected = inferredSelected;
            } else if (inferredSelected || sourceSelected) {
                selected = true;
            } else if (device.wasCleaning) {
                selected = room?.selected === true;
            } else {
                selected = false;
            }

            if (room && room.selected !== selected) changed = true;
            if (room) room.selected = selected;
            await this.setStateAsync(`${device.key}.rooms.${roomId}.selected`, selected, true);
        }
        return changed;
    }

    normalizeRotation(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        const normalized = ((n % 360) + 360) % 360;
        return (Math.round(normalized / 90) * 90) % 360;
    }

    rotatedViewport(viewport, rotation) {
        const r = this.normalizeRotation(rotation);
        const w = viewport.width;
        const h = viewport.height;
        if (r === 90 || r === 270) {
            return { minX: 0, minY: 0, width: h, height: w, value: `0 0 ${h.toFixed(1)} ${w.toFixed(1)}`, rotation: r };
        }
        return { minX: 0, minY: 0, width: w, height: h, value: `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`, rotation: r };
    }

    rotationTransform(viewport, rotation) {
        const r = this.normalizeRotation(rotation);
        const w = viewport.width;
        const h = viewport.height;
        const localize = `translate(${-viewport.minX.toFixed(3)} ${-viewport.minY.toFixed(3)})`;
        if (r === 90) return `translate(${h.toFixed(3)} 0) rotate(90) ${localize}`;
        if (r === 180) return `translate(${w.toFixed(3)} ${h.toFixed(3)}) rotate(180) ${localize}`;
        if (r === 270) return `translate(0 ${w.toFixed(3)}) rotate(270) ${localize}`;
        return localize;
    }

    escapeXml(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    getSvgViewport(device) {
        const pts = [];
        for (const room of device.rooms.values()) {
            if (Array.isArray(room.scaledPairs)) pts.push(...room.scaledPairs);
        }
        if (Array.isArray(device.trail)) pts.push(...device.trail);
        if (Number.isFinite(device.robotX) && Number.isFinite(device.robotY)) {
            pts.push({ x: device.robotX, y: device.robotY });
        }
        if (!pts.length) return { minX: 0, minY: 0, width: 540, height: 231, value: '0 0 540 231' };

        let minX = Math.min(...pts.map(p => Number(p.x)).filter(Number.isFinite));
        let maxX = Math.max(...pts.map(p => Number(p.x)).filter(Number.isFinite));
        let minY = Math.min(...pts.map(p => Number(p.y)).filter(Number.isFinite));
        let maxY = Math.max(...pts.map(p => Number(p.y)).filter(Number.isFinite));
        if (![minX, maxX, minY, maxY].every(Number.isFinite) || minX === maxX || minY === maxY) {
            return { minX: 0, minY: 0, width: 540, height: 231, value: '0 0 540 231' };
        }

        // Tight per-device viewport. This is especially important for portrait maps
        // such as Sky; a fixed 540x231 viewBox leaves large empty side margins.
        const pad = 16;
        minX -= pad; maxX += pad; minY -= pad; maxY += pad;
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);
        const value = `${minX.toFixed(1)} ${minY.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`;
        return { minX, minY, width, height, value };
    }

    normalizeCssColor(value, fallback = '#ffffff') {
        const color = String(value || '').trim();
        if (!color) return fallback;
        if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
        if (/^[a-zA-Z]{3,32}$/.test(color)) return color;

        const rgb = color.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
        if (rgb) {
            const values = rgb.slice(1).map(Number);
            if (values.every(v => v >= 0 && v <= 255)) return color;
        }

        const rgba = color.match(/^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/i);
        if (rgba) {
            const rgbValues = rgba.slice(1, 4).map(Number);
            const alpha = Number(rgba[4]);
            if (rgbValues.every(v => v >= 0 && v <= 255) && alpha >= 0 && alpha <= 1) return color;
        }
        return fallback;
    }

    normalizeLabelStrokeWidth(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 1.6;
        return Math.round(Math.max(0, Math.min(10, n)) * 10) / 10;
    }

    normalizeRobotSize(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 4.5;
        return Math.round(Math.max(2, Math.min(20, n)) * 2) / 2;
    }

    normalizeLabelSize(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 7;
        return Math.round(Math.max(4, Math.min(24, n)) * 2) / 2;
    }

    lightenHex(color, amount = 0.42) {
        const m = String(color || '').trim().match(/^#([0-9a-f]{6})$/i);
        if (!m) return color;
        const hex = m[1];
        const parts = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
        const a = Math.max(0, Math.min(1, Number(amount) || 0));
        const out = parts.map(v => Math.max(0, Math.min(255, Math.round(v + (255 - v) * a))));
        return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`;
    }

    buildSvg(device, options = {}) {
        const inheritWidgetTextStyle = options.inheritWidgetTextStyle === true;
        const colors = ['#ff9800', '#4caf50', '#ab47bc', '#26c6da', '#ef5350', '#42a5f5', '#ffee58', '#8d6e63', '#ec407a', '#7e57c2'];
        const polygons = [];
        const labels = [];
        let index = 0;
        const merges = this.getRoomMerges(device);
        const mergedIds = new Set(merges.flatMap(group => group.ids));

        const clickScript = (roomIds, selected) => {
            const target = selected ? 'false' : 'true';
            return roomIds.map(roomId => {
                const stateId = `${this.namespace}.${device.key}.rooms.${roomId}.selected`;
                return `if(window.vis&&typeof vis.setValue==='function'){vis.setValue('${stateId}',${target});}else if(window.socket&&typeof socket.emit==='function'){socket.emit('setState','${stateId}',{val:${target},ack:false});}`;
            }).join('');
        };
        const addLabel = (name, center, click) => {
            if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return;
            const labelRotation = -this.normalizeRotation(device.rotation);
            const labelTransform = labelRotation ? ` transform="rotate(${labelRotation} ${center.x.toFixed(1)} ${center.y.toFixed(1)})"` : '';
            const labelStyle = inheritWidgetTextStyle
                ? 'cursor:pointer;pointer-events:auto;user-select:none;fill:currentColor;stroke:none;font-family:inherit;font-style:inherit;font-variant:inherit;font-weight:inherit;font-size:inherit;line-height:inherit;letter-spacing:inherit;word-spacing:inherit;text-shadow:inherit'
                : `cursor:pointer;pointer-events:auto;user-select:none;font-family:sans-serif;font-weight:600;font-size:${this.normalizeLabelSize(device.labelSize)}px;fill:${this.escapeXml(device.labelColor || '#ffffff')};stroke:${this.escapeXml(device.labelStrokeColor || '#000000')};stroke-width:${this.normalizeLabelStrokeWidth(device.labelStrokeWidth)};paint-order:stroke`;
            labels.push(`<text class="ecovacs-room-label" x="${center.x.toFixed(1)}" y="${center.y.toFixed(1)}"${labelTransform} text-anchor="middle" dominant-baseline="middle" vector-effect="non-scaling-stroke" style="${labelStyle}" onclick="${this.escapeXml(click)}">${this.escapeXml(name)}</text>`);
        };

        // Configured virtual rooms keep the original Ecovacs spotAreas intact. Their
        // polygons are only grouped for display and selection. Drawing all member
        // polygons with the same fill and a near-invisible same-colour edge removes
        // the visual divider without changing the source geometry.
        for (const group of merges) {
            const members = group.ids.map(id => device.rooms.get(id)).filter(room => room?.points);
            if (!members.length) continue;
            const color = colors[index++ % colors.length];
            const selected = members.some(room => room.selected === true);
            const fillColor = selected ? this.lightenHex(color, 0.48) : color;
            const fillOpacity = selected ? 0.92 : 0.30;
            const click = clickScript(group.ids, selected);
            for (const room of members) {
                polygons.push(`<polygon points="${this.escapeXml(room.points)}" fill="${fillColor}" fill-opacity="${fillOpacity}" stroke="${fillColor}" stroke-width="0.35" vector-effect="non-scaling-stroke" style="cursor:pointer;pointer-events:auto" onclick="${this.escapeXml(click)}"><title>${this.escapeXml(group.name)}</title></polygon>`);
            }
            const centers = members.map(room => room.center).filter(c => c && Number.isFinite(c.x) && Number.isFinite(c.y));
            const center = centers.length ? { x: centers.reduce((a,c)=>a+c.x,0)/centers.length, y: centers.reduce((a,c)=>a+c.y,0)/centers.length } : null;
            addLabel(group.name, center, click);
        }

        for (const [roomId, room] of device.rooms.entries()) {
            if (!room.points || mergedIds.has(String(roomId))) continue;
            const color = colors[index++ % colors.length];
            const selected = room.selected === true;
            const fillColor = selected ? this.lightenHex(color, 0.48) : color;
            const fillOpacity = selected ? 0.92 : 0.30;
            const strokeColor = selected ? this.lightenHex(color, 0.72) : color;
            const strokeWidth = selected ? 4.0 : 1.5;
            const click = clickScript([String(roomId)], selected);
            polygons.push(`<polygon points="${this.escapeXml(room.points)}" fill="${fillColor}" fill-opacity="${fillOpacity}" stroke="${strokeColor}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke" style="cursor:pointer;pointer-events:auto" onclick="${this.escapeXml(click)}"><title>${this.escapeXml(room.name)}</title></polygon>`);
            addLabel(room.label || room.name, room.center, click);
        }
        const trail = device.trail.length ? `<polyline points="${device.trail.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#ff3b30" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" style="pointer-events:none"/>` : '';
        const robotSize = this.normalizeRobotSize(device.robotSize);
        const robotStroke = Math.max(1, Math.min(2, robotSize * 0.28));
        const noseStart = Math.max(1, robotSize - 1);
        const noseEnd = robotSize + Math.max(2, robotSize * 0.65);
        const robot = `<g transform="translate(${device.robotX.toFixed(1)} ${device.robotY.toFixed(1)}) rotate(${Number(device.angle) || 0})" style="pointer-events:none"><circle cx="0" cy="0" r="${robotSize}" fill="#fff" stroke="#222" stroke-width="${robotStroke.toFixed(1)}" vector-effect="non-scaling-stroke"/><line x1="0" y1="-${noseStart.toFixed(1)}" x2="0" y2="-${noseEnd.toFixed(1)}" stroke="#222" stroke-width="${robotStroke.toFixed(1)}" vector-effect="non-scaling-stroke"/></g>`;
        const sourceViewport = this.getSvgViewport(device);
        const rotation = this.normalizeRotation(device.rotation);
        const viewport = this.rotatedViewport(sourceViewport, rotation);
        const transform = this.rotationTransform(sourceViewport, rotation);
        device.svgViewport = viewport;
        device.sourceSvgViewport = sourceViewport;
        const content = `${polygons.join('')}${labels.join('')}${trail}${robot}`;
        const inheritedTextCss = inheritWidgetTextStyle
            ? ';color:inherit;font-family:inherit;font-style:inherit;font-variant:inherit;font-weight:inherit;font-size:inherit;line-height:inherit;letter-spacing:inherit;word-spacing:inherit;text-shadow:inherit'
            : '';
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewport.value}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%" style="display:block;background:transparent${inheritedTextCss}"><g transform="${transform}">${content}</g></svg>`;
    }

    async rebuildView(device) {
        // Keep map.svg self-contained for direct SVG users. map.html intentionally
        // inherits text styling from the surrounding VIS/inventwo widget so font,
        // size, weight, color, spacing and text-shadow can be configured there.
        const svg = this.buildSvg(device);
        const viewport = device.svgViewport || { width: 540, height: 231, value: '0 0 540 231' };
        const htmlSvg = this.buildSvg(device, { inheritWidgetTextStyle: true });
        const html = `<div class="ecovacs-map-widget" style="display:block;width:100%;aspect-ratio:${viewport.width.toFixed(1)}/${viewport.height.toFixed(1)};overflow:hidden;box-sizing:border-box;color:inherit;font-family:inherit;font-style:inherit;font-variant:inherit;font-weight:inherit;font-size:inherit;line-height:inherit;letter-spacing:inherit;word-spacing:inherit;text-shadow:inherit">${htmlSvg}</div>`;
        await this.setStateAsync(`${device.key}.map.viewBox`, viewport.value, true);
        await this.setStateAsync(`${device.key}.map.svg`, svg, true);
        await this.setStateAsync(`${device.key}.map.html`, html, true);
    }

    scheduleRebuild(device) {
        if (this.rebuildTimers.has(device.key)) this.clearTimeout(this.rebuildTimers.get(device.key));
        this.rebuildTimers.set(device.key, this.setTimeout(() => {
            this.rebuildTimers.delete(device.key);
            this.rebuildView(device).catch(error => this.log.warn(`${device.name}: view rebuild failed: ${error.message}`));
        }, 150));
    }

    async requestMap(device, reason = 'manual') {
        if (!device.mapId) return false;
        const id = `${device.prefix}.map.${device.mapId}.loadMapImage`;
        const object = await this.getForeignObjectAsync(id);
        if (!object) {
            this.log.debug(`${device.name}: no loadMapImage state at ${id}`);
            return false;
        }
        await this.setForeignStateAsync(id, true, false);
        this.log.debug(`${device.name}: requested fresh map image (${reason})`);
        return true;
    }

    async refreshAllGeometry() {
        const states = await this.getAllSourceStates();
        for (const device of this.devices.values()) {
            await this.refreshGeometry(device, states);
            await this.refreshMapImage(device, states);
            await this.updateCompatibilityStatus(device, states);
            await this.rebuildView(device);
        }
    }

    findDeviceByOwnId(id) {
        const prefix = `${this.namespace}.`;
        if (!id.startsWith(prefix)) return null;
        const rest = id.slice(prefix.length);
        const key = rest.split('.')[0];
        return this.devices.get(key) || null;
    }

    async resetOwnButton(id) {
        try { await this.setStateAsync(id.slice(this.namespace.length + 1), false, true); } catch { /* ignore */ }
    }

    async forwardButton(device, action, sourceId) {
        const object = await this.getForeignObjectAsync(sourceId);
        const base = `${device.key}.control`;
        if (!object) {
            const msg = `Nicht unterstützt: ${sourceId}`;
            await this.setStateAsync(`${base}.status`, msg, true);
            this.log.warn(`${device.name}: ${msg}`);
            return false;
        }
        await this.setForeignStateAsync(sourceId, true, false);
        await this.setStateAsync(`${base}.lastAction`, action, true);
        await this.setStateAsync(`${base}.lastSource`, sourceId, true);
        await this.setStateAsync(`${base}.status`, `Gesendet: ${action}`, true);
        return true;
    }

    async findRoomSelectionSources(device, roomId) {
        const roomBase = `${device.prefix}.map.${device.mapId}.spotAreas.${roomId}.`;
        const preferred = `${roomBase}markForNextSpotAreaCleaning`;
        const states = await this.getForeignStatesAsync(`${roomBase}*`) || {};
        const candidates = [];

        for (const id of new Set([preferred, ...Object.keys(states)])) {
            if (!id.startsWith(roomBase)) continue;
            const tail = id.slice(roomBase.length);
            if (id !== preferred && !/(mark.*clean|selected|selection|isSelected|activeFor.*clean)/i.test(tail)) continue;
            try {
                const object = await this.getForeignObjectAsync(id);
                if (!object || object.type !== 'state') continue;
                if (object.common && object.common.write === false) continue;
                candidates.push(id);
            } catch { /* ignore */ }
        }
        return [...new Set(candidates)];
    }

    async syncRoomSelectionToSource(device, roomId, selected) {
        const ownBase = `${device.key}.rooms.${roomId}`;
        const sources = await this.findRoomSelectionSources(device, roomId);
        await this.setStateAsync(`${ownBase}.selectionSource`, sources.join(', '), true);

        if (!sources.length) {
            const msg = 'Keine beschreibbare Ecovacs-Raumauswahl gefunden';
            await this.setStateAsync(`${ownBase}.syncStatus`, msg, true);
            this.log.warn(`${device.name} Raum ${roomId}: ${msg}`);
            return false;
        }

        let sent = 0;
        for (const source of sources) {
            try {
                await this.setForeignStateAsync(source, selected, false);
                sent++;
            } catch (error) {
                this.log.debug(`${device.name} Raum ${roomId}: Auswahl konnte nicht an ${source} geschrieben werden: ${error.message}`);
            }
        }

        const action = selected ? 'ausgewählt' : 'abgewählt';
        await this.setStateAsync(`${ownBase}.syncStatus`, `An Ecovacs gesendet: ${action} (${sent}/${sources.length})`, true);

        // Give the source adapter a short chance to acknowledge the write. This is
        // diagnostic only; VIS keeps the local selection even when cloud/app sync is
        // not supported by a particular ecovacs-deebot version/model.
        this.setTimeout(async () => {
            try {
                let confirmed = false;
                for (const source of sources) {
                    const st = await this.getForeignStateAsync(source);
                    if (st && this.isTrue(st.val) === selected) {
                        confirmed = true;
                        break;
                    }
                }
                await this.setStateAsync(
                    `${ownBase}.syncStatus`,
                    confirmed ? `Ecovacs bestätigt: ${action}` : `Gesendet, aber nicht bestätigt: ${action}`,
                    true,
                );
            } catch { /* ignore */ }
        }, 1000);
        return sent > 0;
    }

    async cleanSingleRoom(device, roomId) {
        for (const otherId of device.roomIds) {
            await this.syncRoomSelectionToSource(device, otherId, otherId === roomId);
        }
        const start = `${device.prefix}.control.extended.cleanMarkedSpotAreas`;
        return this.forwardButton(device, `cleanRoom:${roomId}`, start);
    }

    formatCaptureValue(value) {
        try {
            let text = typeof value === 'string' ? value : JSON.stringify(value);
            if (text === undefined) text = String(value);
            text = String(text).replace(/\s+/g, ' ').trim();
            return text.length > 240 ? `${text.slice(0, 237)}...` : text;
        } catch {
            return String(value);
        }
    }

    async startSelectionCapture(device) {
        const existing = this.selectionCaptures.get(device.key);
        if (existing?.timer) this.clearTimeout(existing.timer);
        const capture = { started: Date.now(), events: new Map(), timer: null };
        this.selectionCaptures.set(device.key, capture);
        await this.setStateAsync(`${device.key}.status.selectionCaptureActive`, true, true);
        await this.setStateAsync(`${device.key}.status.selectionCaptureReport`, 'Aufzeichnung läuft 30 Sekunden – jetzt in der Ecovacs-App Raum/Räume auswählen.', true);
        capture.timer = this.setTimeout(() => {
            this.finishSelectionCapture(device).catch(error => this.log.warn(`${device.name}: selection capture finish failed: ${error.message}`));
        }, 30000);
    }

    async finishSelectionCapture(device) {
        const capture = this.selectionCaptures.get(device.key);
        if (!capture) return;
        if (capture.timer) this.clearTimeout(capture.timer);
        this.selectionCaptures.delete(device.key);
        const rows = [...capture.events.values()].sort((a, b) => a.first - b.first);
        const report = rows.length
            ? rows.map(row => `${row.id} = ${this.formatCaptureValue(row.val)} | ack=${row.ack} | Änderungen=${row.count}`).join('\n')
            : 'Keine ecovacs-deebot-Stateänderung während der 30-Sekunden-Aufzeichnung erkannt.';
        await this.setStateAsync(`${device.key}.status.selectionCaptureReport`, report, true);
        await this.setStateAsync(`${device.key}.status.selectionCaptureActive`, false, true);
        this.log.debug(`${device.name}: App-Auswahl-Diagnose beendet, ${rows.length} geänderte States erkannt.`);
    }

    recordSelectionCapture(device, id, state) {
        const capture = this.selectionCaptures.get(device.key);
        if (!capture || !state || !id.startsWith(`${device.prefix}.`)) return;
        const old = capture.events.get(id);
        capture.events.set(id, {
            id,
            val: state.val,
            ack: state.ack === true,
            first: old?.first || Date.now(),
            count: (old?.count || 0) + 1,
        });
    }

    async handleOwnState(id, state) {
        if (id === `${this.namespace}.control.selfTest`) {
            if (!this.isTrue(state.val)) return;
            await this.runSelfTest('manual');
            await this.resetOwnButton(id);
            return;
        }
        if (id === `${this.namespace}.control.rescan`) {
            if (!this.isTrue(state.val)) return;
            await this.discover();
            await this.resetOwnButton(id);
            return;
        }
        const device = this.findDeviceByOwnId(id);
        if (!device) return;

        if (id === `${this.namespace}.${device.key}.control.refreshMap`) {
            if (!this.isTrue(state.val)) return;
            await this.requestMap(device, 'manual');
            await this.resetOwnButton(id);
            return;
        }
        if (id === `${this.namespace}.${device.key}.control.captureAppSelection`) {
            if (!this.isTrue(state.val)) return;
            await this.startSelectionCapture(device);
            await this.resetOwnButton(id);
            return;
        }


        if (id === `${this.namespace}.${device.key}.map.rotation`) {
            device.rotation = this.normalizeRotation(state.val);
            await this.setStateAsync(`${device.key}.map.rotation`, device.rotation, true);
            this.scheduleRebuild(device);
            return;
        }
        if (id === `${this.namespace}.${device.key}.appearance.robotSize`) {
            device.robotSize = this.normalizeRobotSize(state.val);
            await this.setStateAsync(`${device.key}.appearance.robotSize`, device.robotSize, true);
            this.scheduleRebuild(device);
            return;
        }
        if (id === `${this.namespace}.${device.key}.appearance.labelSize`) {
            device.labelSize = this.normalizeLabelSize(state.val);
            await this.setStateAsync(`${device.key}.appearance.labelSize`, device.labelSize, true);
            this.scheduleRebuild(device);
            return;
        }
        if (id === `${this.namespace}.${device.key}.appearance.labelColor`) {
            device.labelColor = this.normalizeCssColor(state.val, '#ffffff');
            await this.setStateAsync(`${device.key}.appearance.labelColor`, device.labelColor, true);
            this.scheduleRebuild(device);
            return;
        }
        if (id === `${this.namespace}.${device.key}.appearance.labelStrokeColor`) {
            device.labelStrokeColor = this.normalizeCssColor(state.val, '#000000');
            await this.setStateAsync(`${device.key}.appearance.labelStrokeColor`, device.labelStrokeColor, true);
            this.scheduleRebuild(device);
            return;
        }
        if (id === `${this.namespace}.${device.key}.appearance.labelStrokeWidth`) {
            device.labelStrokeWidth = this.normalizeLabelStrokeWidth(state.val);
            await this.setStateAsync(`${device.key}.appearance.labelStrokeWidth`, device.labelStrokeWidth, true);
            this.scheduleRebuild(device);
            return;
        }
        if (id === `${this.namespace}.${device.key}.history.maxEntries`) {
            device.historyMaxEntries = this.normalizeHistoryMaxEntries(state.val);
            device.historyEvents = device.historyEvents.slice(-device.historyMaxEntries);
            await this.setStateAsync(`${device.key}.history.maxEntries`, device.historyMaxEntries, true);
            await this.setStateAsync(`${device.key}.history.events`, device.historyEvents.join('\n'), true);
            await this.setStateAsync(`${device.key}.history.count`, device.historyEvents.length, true);
            return;
        }
        if (id === `${this.namespace}.${device.key}.history.clear`) {
            if (!this.isTrue(state.val)) return;
            device.historyEvents = [];
            await this.setStateAsync(`${device.key}.history.events`, '', true);
            await this.setStateAsync(`${device.key}.history.count`, 0, true);
            await this.resetOwnButton(id);
            return;
        }
        if (id === `${this.namespace}.${device.key}.control.rotateLeft` || id === `${this.namespace}.${device.key}.control.rotateRight`) {
            if (!this.isTrue(state.val)) return;
            const delta = id.endsWith('.rotateLeft') ? -90 : 90;
            device.rotation = this.normalizeRotation((device.rotation || 0) + delta);
            await this.setStateAsync(`${device.key}.map.rotation`, device.rotation, true);
            this.scheduleRebuild(device);
            await this.resetOwnButton(id);
            return;
        }

        const commandMap = {
            [`${this.namespace}.${device.key}.control.clean`]: `${device.prefix}.control.clean`,
            [`${this.namespace}.${device.key}.control.stop`]: `${device.prefix}.control.stop`,
            [`${this.namespace}.${device.key}.control.pause`]: `${device.prefix}.control.pause`,
            [`${this.namespace}.${device.key}.control.home`]: `${device.prefix}.control.charge`,
            [`${this.namespace}.${device.key}.control.cleanSelectedRooms`]: `${device.prefix}.control.extended.cleanMarkedSpotAreas`,
        };
        if (commandMap[id]) {
            if (!this.isTrue(state.val)) return;
            const action = id.split('.').pop();
            await this.forwardButton(device, action, commandMap[id]);
            await this.resetOwnButton(id);
            return;
        }

        const ns = this.escapeRegex(this.namespace);
        const key = this.escapeRegex(device.key);
        const roomMatch = id.match(new RegExp(`^${ns}\\.${key}\\.rooms\\.([^\\.]+)\\.(selected|toggle|clean)$`));
        if (roomMatch) {
            const roomId = roomMatch[1];
            const action = roomMatch[2];
            if (action === 'clean') {
                if (!this.isTrue(state.val)) return;
                await this.cleanSingleRoom(device, roomId);
                await this.resetOwnButton(id);
                return;
            }
            const room = device.rooms.get(roomId);
            const isSelected = action === 'toggle' ? !(room?.selected === true) : this.isTrue(state.val);
            if (action === 'toggle') await this.resetOwnButton(id);
            const localKey = `${device.key}:${roomId}`;
            const now = Date.now();
            this.localSelectionOverrides.set(localKey, { value: isSelected, until: now + 5000 });
            if (isSelected) {
                this.manualDeselections.delete(localKey);
            } else {
                // Keep an explicit deselection stable through stale source echoes and
                // the current-room inference. A genuinely new source selection after
                // the grace period can still re-enable the room later.
                this.manualDeselections.set(localKey, { at: now, until: now + 10000 });
            }
            if (room) room.selected = isSelected;
            // Acknowledge our own selection immediately and redraw the SVG. This makes
            // the visual selection independent from whether the source adapter echoes
            // markForNextSpotAreaCleaning back as a stateChange event.
            await this.setStateAsync(`${device.key}.rooms.${roomId}.selected`, isSelected, true);
            // Protect the user selection briefly against a stale echo from the source
            // adapter. Some Ecovacs versions publish the old value again immediately
            // before they acknowledge the new markForNextSpotAreaCleaning value.
            this.selectionGuards.set(`${device.key}:${roomId}`, { value: isSelected, until: Date.now() + 5000 });
            this.scheduleRebuild(device);

            // Synchronize the local VIS selection back to every writable room-
            // selection state exposed by ecovacs-deebot. This gives the official app
            // the best possible chance to reflect the same selection when that source
            // adapter/firmware supports bidirectional room marking.
            await this.syncRoomSelectionToSource(device, roomId, isSelected);
        }
    }

    async handleForeignState(id, state) {
        for (const device of this.devices.values()) {
            if (!id.startsWith(`${device.prefix}.`)) continue;
            this.recordSelectionCapture(device, id, state);
            const base = `${device.key}`;
            if (id === device.positionSource || id === `${device.prefix}.map.deebotPosition` || /(?:deebot|robot).*position|position.*(?:deebot|robot)/i.test(id)) {
                await this.updatePosition(device, state.val);
                this.scheduleRebuild(device);
                return;
            }
            if (id === `${device.prefix}.info.deviceStatus`) {
                const status = String(state.val || '');
                await this.updateCleaningState(device, status);
                await this.setStateAsync(`${base}.status.state`, status, true);
                const states = await this.getAllSourceStates();
                await this.refreshLiveReport(device, states);
                this.scheduleRebuild(device);
                return;
            }
            if (id === `${device.prefix}.map.deebotPositionCurrentSpotAreaName`) {
                await this.setStateAsync(`${base}.status.position`, String(state.val || ''), true);
                const states = await this.getAllSourceStates();
                const selectionChanged = await this.refreshRoomSelections(device, states);
                await this.refreshLiveReport(device, states);
                if (selectionChanged) this.scheduleRebuild(device);
                return;
            }
            if (id === `${device.prefix}.map.currentUsedSpotAreas`) {
                // Official-app room cleaning is reported here by ecovacs-deebot.
                // Re-evaluate all room selections immediately instead of waiting
                // for the 2-second polling fallback.
                const states = await this.getAllSourceStates();
                const selectionChanged = await this.refreshRoomSelections(device, states);
                await this.refreshLiveReport(device, states);
                if (selectionChanged) this.scheduleRebuild(device);
                return;
            }
            const selected = id.match(new RegExp(`^${device.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.map\\.${device.mapId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.spotAreas\\.([^\\.]+)\\.markForNextSpotAreaCleaning$`));
            if (selected) {
                const roomId = selected[1];
                const isSelected = this.isTrue(state.val);
                const guardKey = `${device.key}:${roomId}`;
                const manualBlock = this.manualDeselections.get(guardKey);
                if (manualBlock) {
                    const now = Date.now();
                    const stateTs = Number(state.ts || 0);
                    const genuinelyNewExplicitSelection = isSelected && now >= Number(manualBlock.until || 0) && stateTs > Number(manualBlock.at || 0);
                    if (!genuinelyNewExplicitSelection) {
                        if (!isSelected) {
                            // False is the expected acknowledgement of our manual
                            // deselection; keep the block so position fallback cannot
                            // re-select the room during the same cleaning run.
                            const room = device.rooms.get(roomId);
                            if (room) room.selected = false;
                            await this.setStateAsync(`${base}.rooms.${roomId}.selected`, false, true);
                            this.scheduleRebuild(device);
                        }
                        return;
                    }
                    this.manualDeselections.delete(guardKey);
                }
                // A VIS choice is protected only for a few seconds against stale
                // echoes. Afterwards source-adapter/app changes are authoritative.
                let override = this.localSelectionOverrides.get(guardKey);
                if (typeof override === 'boolean') override = { value: override, until: 0 };
                if (override && Number(override.until || 0) > Date.now()) {
                    if (override.value !== isSelected) return;
                    // Matching echo confirms our write; release the local override so
                    // subsequent changes made in the Ecovacs app can flow back to VIS.
                    this.localSelectionOverrides.delete(guardKey);
                } else if (override) {
                    this.localSelectionOverrides.delete(guardKey);
                }
                const guard = this.selectionGuards.get(guardKey);
                if (guard && Date.now() < guard.until && guard.value !== isSelected) {
                    // Ignore a stale contradictory echo while the just-issued room
                    // selection is still being propagated by ecovacs-deebot.
                    return;
                }
                if (guard && guard.value === isSelected) this.selectionGuards.delete(guardKey);
                if (guard && Date.now() >= guard.until) this.selectionGuards.delete(guardKey);
                const room = device.rooms.get(roomId);
                if (room) room.selected = isSelected;
                await this.setStateAsync(`${base}.rooms.${roomId}.selected`, isSelected, true);
                this.scheduleRebuild(device);
                return;
            }
            if (id === `${device.prefix}.map.${device.mapId}.map64` || /(map64|map.*image|image.*map)/i.test(id)) {
                const states = await this.getAllSourceStates();
                await this.refreshMapImage(device, states);
                this.scheduleRebuild(device);
                return;
            }
            if (id.startsWith(`${device.prefix}.map.${device.mapId}.spotAreas.`) && /(polygon|boundar|vertices|vertex|outline|contour|coordinates|coords|points|bounds|rectangle|rect)/i.test(id)) {
                const states = await this.getAllSourceStates();
                await this.refreshGeometry(device, states);
                this.scheduleRebuild(device);
                return;
            }
        }
    }

    async onStateChange(id, state) {
        if (!state) return;
        try {
            // Own writable controls must only react to user writes (ack=false).
            // Foreign ecovacs-deebot telemetry is normally published with ack=true
            // and must therefore NOT be filtered out, otherwise live position/status
            // updates never reach the map.
            if (id.startsWith(`${this.namespace}.`)) {
                if (state.ack) return;
                await this.handleOwnState(id, state);
            } else {
                await this.handleForeignState(id, state);
            }
        } catch (error) {
            this.log.warn(`State handling failed for ${id}: ${error.message}`);
        }
    }
}

if (require.main !== module) {
    module.exports = options => new EcovacsMap(options);
} else {
    new EcovacsMap();
}

'use strict';

/**
 * Creates a synthetic ecovacs-deebot namespace in the isolated ioBroker
 * integration-test controller. The real ecovacs-deebot adapter is NOT needed.
 */

function stateObject(name, type, role = 'value', write = false) {
    return {
        type: 'state',
        common: { name, type, role, read: true, write },
        native: {},
    };
}

async function callDb(client, asyncName, callbackName, ...args) {
    if (client && typeof client[asyncName] === 'function') {
        return client[asyncName](...args);
    }
    if (client && typeof client[callbackName] === 'function') {
        return new Promise((resolve, reject) => {
            client[callbackName](...args, (err, result) => err ? reject(err) : resolve(result));
        });
    }
    throw new Error(`DB method missing: ${asyncName}/${callbackName}`);
}

async function setObject(harness, id, obj) {
    return callDb(harness.objects, 'setObjectAsync', 'setObject', id, obj);
}

async function setState(harness, id, val, ack = true) {
    return callDb(harness.states, 'setStateAsync', 'setState', id, { val, ack });
}

async function getState(harness, id) {
    return callDb(harness.states, 'getStateAsync', 'getState', id);
}

async function createMockEcovacs(harness, options = {}) {
    const prefix = options.prefix || 'ecovacs-deebot.0';
    const name = options.name || 'TestBot';
    const mapId = String(options.mapId || '123456789');
    const rooms = options.rooms || [
        { id: 0, name: 'Wohnzimmer', polygon: '0,0 4000,0 4000,3000 0,3000' },
        { id: 1, name: 'Küche', polygon: '4000,0 7000,0 7000,3000 4000,3000' },
        { id: 2, name: 'Flur', polygon: '0,3000 7000,3000 7000,4500 0,4500' },
    ];

    const defs = [
        [`${prefix}.info.deviceName`, name, stateObject('Device name', 'string', 'text')],
        [`${prefix}.info.deviceStatus`, options.deviceStatus || 'idle', stateObject('Device status', 'string', 'text')],
        [`${prefix}.info.cleanstatus`, options.cleanStatus || 'idle', stateObject('Clean status', 'string', 'text')],
        [`${prefix}.map.mapId`, mapId, stateObject('Map ID', 'string', 'text')],
        [`${prefix}.map.currentUsedSpotAreas`, options.currentUsedSpotAreas ?? '', stateObject('Current used spot areas', 'string', 'text')],
        [`${prefix}.map.deebotPosition`, options.position || '1000,1000,0', stateObject('Robot position', 'string', 'text')],
        [`${prefix}.map.deebotPositionCurrentSpotAreaName`, rooms[0].name, stateObject('Current room', 'string', 'text')],
        [`${prefix}.control.clean`, false, stateObject('Clean', 'boolean', 'button', true)],
        [`${prefix}.control.pause`, false, stateObject('Pause', 'boolean', 'button', true)],
        [`${prefix}.control.stop`, false, stateObject('Stop', 'boolean', 'button', true)],
        [`${prefix}.control.charge`, false, stateObject('Charge', 'boolean', 'button', true)],
        [`${prefix}.control.extended.cleanMarkedSpotAreas`, false, stateObject('Clean marked spot areas', 'boolean', 'button', true)],
    ];

    for (const room of rooms) {
        const base = `${prefix}.map.${mapId}.spotAreas.${room.id}`;
        defs.push(
            [`${base}.roomName`, room.name, stateObject(`Room ${room.id} name`, 'string', 'text')],
            [`${base}.polygon`, room.polygon, stateObject(`Room ${room.id} polygon`, 'string', 'text')],
            [`${base}.markForNextSpotAreaCleaning`, false, stateObject(`Room ${room.id} selected`, 'boolean', 'indicator', true)],
        );
    }

    for (const [id, value, obj] of defs) {
        await setObject(harness, id, obj);
        await setState(harness, id, value, true);
    }

    return { prefix, name, mapId, rooms };
}

module.exports = { createMockEcovacs, setState, getState };

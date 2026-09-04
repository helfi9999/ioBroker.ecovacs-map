'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { tests } = require('@iobroker/testing');
const { createMockEcovacs, getState } = require('./mock-source');

const adapterDir = path.join(__dirname, '..');

async function waitFor(check, timeout = 20000, interval = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error('Timed out waiting for condition');
}

/**
 * The ioBroker integration harness is intentionally used with one adapter
 * lifecycle in this suite. Repeated start/stop cycles inside the same harness
 * can stall on some js-controller/test-host combinations and would test the
 * harness lifecycle more than ecovacs-map itself.
 *
 * The synthetic source is fully prepared before adapter startup. This verifies
 * the important cold-start behavior without installing the real ecovacs-deebot
 * adapter: device discovery, rooms, app-selected spot area, robot telemetry and
 * SVG generation.
 */
tests.integration(adapterDir, {
    defineAdditionalTests({ suite }) {
        suite('ecovacs-map with synthetic ecovacs-deebot source', getHarness => {
            it('discovers the mock Deebot and imports rooms, app selection, position and SVG in one startup', async function () {
                this.timeout(90000);
                const harness = getHarness();
                const position = '6000,4000,90';

                await createMockEcovacs(harness, {
                    name: 'TestBot',
                    cleanStatus: 'spot_area',
                    deviceStatus: 'cleaning',
                    currentUsedSpotAreas: '2',
                    position,
                });

                try {
                    await harness.startAdapterAndWait();

                    const rooms = await waitFor(async () => {
                        const state = await getState(harness, 'ecovacs-map.0.TestBot.status.roomsDetected');
                        return state && Number(state.val) === 3 ? state : null;
                    });
                    assert.equal(Number(rooms.val), 3);

                    const selected = await waitFor(async () => {
                        const state = await getState(harness, 'ecovacs-map.0.TestBot.rooms.2.selected');
                        return state && state.val === true ? state : null;
                    });
                    assert.equal(selected.val, true);

                    const room0 = await getState(harness, 'ecovacs-map.0.TestBot.rooms.0.selected');
                    const room1 = await getState(harness, 'ecovacs-map.0.TestBot.rooms.1.selected');
                    assert.equal(room0?.val, false);
                    assert.equal(room1?.val, false);

                    const raw = await waitFor(async () => {
                        const state = await getState(harness, 'ecovacs-map.0.TestBot.status.rawPosition');
                        return state && state.val === position ? state : null;
                    });
                    assert.equal(raw.val, position);

                    const angle = await waitFor(async () => {
                        const state = await getState(harness, 'ecovacs-map.0.TestBot.map.angle');
                        return state && Number(state.val) === 90 ? state : null;
                    });
                    assert.equal(Number(angle.val), 90);

                    const x = await getState(harness, 'ecovacs-map.0.TestBot.map.robotX');
                    const y = await getState(harness, 'ecovacs-map.0.TestBot.map.robotY');
                    assert.ok(Number.isFinite(Number(x?.val)));
                    assert.ok(Number.isFinite(Number(y?.val)));

                    const svg = await waitFor(async () => {
                        const state = await getState(harness, 'ecovacs-map.0.TestBot.map.svg');
                        return state && typeof state.val === 'string' && state.val.includes('<svg') ? state : null;
                    });
                    assert.match(svg.val, /Wohnzimmer|Küche|Flur/);

                    const liveReport = await waitFor(async () => {
                        const state = await getState(harness, 'ecovacs-map.0.TestBot.report.current');
                        return state && typeof state.val === 'string' && state.val.includes('TestBot') ? state : null;
                    });
                    assert.match(liveReport.val, /reinigt|fährt|lädt|bereit/);

                    const historyMax = await getState(harness, 'ecovacs-map.0.TestBot.history.maxEntries');
                    assert.equal(Number(historyMax?.val), 100);

                    const deviceCount = await waitFor(async () => {
                          const state = await getState(harness, 'ecovacs-map.0.info.devices');
                          return Number(state?.val) === 1 ? state : null;
                    });
                    assert.equal(Number(deviceCount.val), 1);

                    const connection = await getState(harness, 'ecovacs-map.0.info.connection');
                    assert.equal(connection?.val, true);
                } finally {
                    if (harness.isAdapterRunning()) await harness.stopAdapter();
                }
            });
        });
    },
});

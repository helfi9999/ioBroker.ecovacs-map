# ioBroker.ecovacs-map

Companion adapter for [`ecovacs-deebot`](https://github.com/mrbungle64/ioBroker.ecovacs-deebot). It creates its own interactive SVG/HTML room map from the map and room data already exposed by `ecovacs-deebot` for use in ioBroker/VIS.

> This adapter does not connect to Ecovacs directly. Login, cloud communication and robot commands remain the responsibility of `ecovacs-deebot`.

## Features

- automatic discovery of `ecovacs-deebot.*` instances and devices
- automatic map ID and room detection
- self-rendered SVG/HTML room map without the original Ecovacs map image
- live robot position and trail
- map rotation (0/90/180/270 degrees)
- room selection directly in VIS
- single-room, multi-room and full cleaning controls
- mirroring of app-started room cleaning through `currentUsedSpotAreas`
- automatic selection reset when cleaning ends
- custom room display names
- device-independent virtual room merges, e.g. SpotAreas `2,3` as one VIS room
- per-robot live report and bounded event history
- geometry/source diagnostics and runtime self-test
- VIS HTML room labels can inherit text styling from the surrounding widget

## Requirements

- ioBroker
- installed and configured `ecovacs-deebot` adapter
- Node.js >= 22

Available functionality depends on the states and map information exposed by the specific robot model through `ecovacs-deebot`.

## Room configuration and virtual merges

Detected rooms are listed in the adapter settings. A row with one room ID represents a normal room. Multiple comma-separated IDs create one virtual VIS room while all original Ecovacs SpotArea states remain unchanged.

Example:

```text
Device: Luna
Room ID(s): 2,3
Custom display name: Kinderzimmer
```

Selecting this virtual room in VIS selects both original SpotAreas. Existing multi-room cleaning controls therefore continue to use the real Ecovacs room IDs.

## VIS

Use `<device>.map.html` in a VIS/inventwo HTML/text widget or `<device>.map.svg` where raw SVG is supported.

`map.html` inherits supported text properties from the surrounding widget, including color, font family, style, variant, weight, size, line height, letter spacing, word spacing and text shadow. Room labels remain geometrically centered in the SVG.

## Main object structure

```text
ecovacs-map.0
├── info
├── control
│   ├── rescan
│   └── selfTest
└── <DeviceName>
    ├── status
    ├── control
    ├── map
    ├── appearance
    ├── rooms
    ├── report
    └── history
```

Device names are discovered dynamically; names such as Luna or Sky are not hard-coded.

## Diagnostics

Useful diagnostic states include:

```text
<device>.status.roomGeometryReport
<device>.status.roomMergeReport
info.selfTestStatus
info.selfTestReport
info.selfTestTimestamp
```

Run `control.selfTest = true` to execute the runtime self-test.

## Development and tests

```bash
npm install
npm test
npm run test:integration
```

The integration tests use `@iobroker/testing` and create a synthetic `ecovacs-deebot` source, so a real vacuum is not required. See [TESTING.md](TESTING.md).

## Disclaimer

This is a community adapter and is not affiliated with or endorsed by Ecovacs. Ecovacs and DEEBOT are trademarks of their respective owners.

## Changelog

### 0.7.4 (2026-09-05)
- Improved cleaning completion detection and reliable trail reset after finished cleaning runs.
- Kept the cleaning trail during intermediate station stops between vacuuming and mopping.
- Added improved live reporting for mopping preparation, mopping start and mop drying.

### 0.7.3 (2026-09-05)
- Improved room transition reporting for target rooms, transit rooms and the return to the charging station.
- Prevented transit rooms from being marked as selected while returning to the charging station.

### 0.7.2 (2026-09-05)

- Improved live report formatting without date and time.
- Kept full timestamps in cleaning history.
- Added missing parent channels for object structure validation.

### 0.7.1 (2026-09-05)

- Improved CI and integration test reliability.
- Switched the release workflow to trusted npm publishing.

### 0.7.0
- Prepared the adapter for public GitHub/ioBroker publication, including repository metadata, documentation and CI preparation.

### 0.6.7
- Fixed Admin jsonConfig validation for the room configuration help text.

### 0.6.6
- Improved the Room ID(s) help text for single and merged room configuration.

### 0.6.5
- VIS HTML room labels can inherit text styling from the surrounding widget.

### 0.6.4
- Unified room naming and virtual room merges into one settings table.

### 0.6.3
- Added device-independent virtual room merges while preserving original Ecovacs SpotArea states and controls.

### 0.6.2
- Restored the proven 0.5.6 map detection behavior and added detailed room geometry diagnostics.

For older changes, see [CHANGELOG_OLD.md](CHANGELOG_OLD.md).
## License

MIT License. See [LICENSE](LICENSE).

Copyright (c) 2026 Helfi9999

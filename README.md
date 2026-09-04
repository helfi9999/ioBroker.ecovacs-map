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
- Node.js >= 20

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

## German quick start / Deutsche Kurzinfo

`ecovacs-map` ist ein Zusatzadapter für `ecovacs-deebot`. Er zeichnet aus den vorhandenen Raum- und Kartendaten eine eigene SVG/HTML-Karte für VIS. Der Adapter meldet sich nicht selbst bei Ecovacs an.

Mehrere Raum-IDs können in den Einstellungen kommagetrennt zusammengefasst werden, z. B. `2,3`. Die originalen Ecovacs-Räume bleiben dabei erhalten; in VIS werden sie gemeinsam dargestellt und ausgewählt.

## Disclaimer

This is a community adapter and is not affiliated with or endorsed by Ecovacs. Ecovacs and DEEBOT are trademarks of their respective owners.

## License

MIT License. See [LICENSE](LICENSE).

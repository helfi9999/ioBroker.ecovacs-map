# ioBroker.ecovacs-map QA checklist

## Automated package checks

Run before packing:

```bash
npm test
```

This verifies version consistency, required package/admin files, JSON parsing, removal of AutoRefresh runtime code, required root states and JavaScript syntax.

## Runtime self-test

Set `ecovacs-map.0.control.selfTest` to `true`. Results are written to:

- `info.selfTestStatus` (`ok`, `warning`, `error`)
- `info.selfTestReport`
- `info.selfTestTimestamp`

Warnings do not necessarily mean the adapter is broken. Some Ecovacs models simply do not expose every feature.

## Manual regression test

1. Fresh install with one `ecovacs-deebot` instance.
2. Upgrade from 0.4.5 and verify legacy `commands`/`devices` trees are gone.
3. Multiple robots: verify separate device trees and selections.
4. Open `map.svg`/`map.html` in VIS.
5. Change rotation, label size/colors and robot size.
6. Select/deselect rooms in VIS and verify highlighting.
7. Start one room, multiple rooms and full cleaning.
8. Start room cleaning in the Ecovacs app and verify `currentUsedSpotAreas` is reflected in VIS.
9. After cleaning ends, verify all `rooms.<id>.selected` return to `false`.
10. Verify live `robotX`, `robotY` and trail updates during cleaning.
11. Run for at least 30 minutes and verify there are no repeating `loadMapImage` requests.
12. Check ioBroker log for warnings/errors and Admin for `invalid jsonConfig`.

## Environments to test before public release

- Windows ioBroker
- Linux/Raspberry Pi
- Docker
- one robot and multiple robots
- at least two different Ecovacs models if available

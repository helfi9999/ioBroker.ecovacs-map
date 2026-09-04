# Testing ioBroker.ecovacs-map 0.5.0

The integration tests do **not** require the real `ecovacs-deebot` adapter.
`@iobroker/testing` starts an isolated temporary js-controller and `test/mock-source.js`
creates synthetic `ecovacs-deebot.0.*` objects and states only inside that temporary test database.
Your normal ioBroker installation is not used as the Ecovacs source.

## On a separate test machine

1. Extract the adapter source (or clone the repository once it exists).
2. Open a terminal in the adapter directory.
3. Install development dependencies:

   ```bash
   npm install
   ```

4. Run the quick package/QA tests:

   ```bash
   npm test
   ```

5. Run the full integration test with a temporary js-controller and synthetic Deebot:

   ```bash
   npm run test:integration
   ```

   Or everything together:

   ```bash
   npm run test:full
   ```

The integration test verifies at least:

- startup without a real `ecovacs-deebot` installation,
- automatic detection of a synthetic Deebot,
- automatic room creation,
- SVG map generation,
- `currentUsedSpotAreas` -> `rooms.<id>.selected`,
- live robot position updates.

`@iobroker/testing` may download/install a temporary js-controller on the first run, so the test machine needs internet access for the development dependencies and test controller setup.


## Integrationstest 0.5.3

Der synthetische `ecovacs-deebot.0` wird vollständig vor dem Adapterstart erzeugt. Der Test verwendet bewusst nur einen Adapter-Lebenszyklus, da wiederholte Start/Stop-Zyklen innerhalb desselben `@iobroker/testing`-Harness auf einzelnen Testhosts zu Timeouts führen können.

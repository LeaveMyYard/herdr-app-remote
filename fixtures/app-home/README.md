Fake app-home files for the installer tests (installer/test). Not protocol fixtures: the schema walk in packages/protocol/test/fixtures.test.ts skips this folder; the real-data scan does not. Shaped like herdr-app's shipped
`main` layout and panorama's layout, reduced, with no real data. Tests copy them into temp homes
and assert that they are left byte for byte unchanged.

# Instant Action maps

Maps offered only by Instant Action (`docs/INSTANT.md`, "Build, run, and ship"). Each `*.json` file uses the
same source format as `data/maps/*.json` and must pass `validateMapDef`.
`npm run pack:ia` packs them into `web/instant/instant.jsonl`; `build:web`
copies that to `web/btlib10x.ia.jsonl`, which the app loads as the `ia` pack
beside the engine maps. With no map here the app shows the engine maps only.

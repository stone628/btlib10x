# MTF → MechDef conversion

New 'Mechs are authored as **.mtf (MechTech File)** definitions and converted
into the library's `MechDef` JSON by `scripts/mtf.mjs`. The catalog is expected
to keep growing, and every routed-through entry is picked up automatically by
the catalog generator — no hand-wiring needed.

## Sources

The `.mtf` files are exported from **flechs.net** record sheets
(`https://sheets.flechs.net/`). Drop each exported `.mtf` into `docs/mtf/`
alongside the existing ones (Atlas AS7-D, Bushwacker BSW-X1, Centurion
CN9-YLW2, Cicada CDA-3MA, Enforcer ENF-4R, Griffin GRF-1N, Hatchetman HCT-5S,
Hermes II HER-5SA, Hollander BZK-F3, Hunchback HBK-4G, Mad Cat Mk II 2,
Mad Cat Prime, Masakari Prime, Wolverine WVR-6R).

## Workflow

1. Export the record sheet from flechs.net as `.mtf` and place it in
   `docs/mtf/`.
2. Run the converter:

   ```sh
   npm run mtf
   ```

   This runs `scripts/mtf.mjs` then repacks the catalog. Each new `.mtf`
   is written to `data/mechs/<model>.json`. The pack step
   (`npm run pack`) folds it into `data/btlib10x.jsonl` and validates it.

3. Validate and lock it in:

   ```sh
   npm run lint && npm run typecheck && npm test
   ```

### Notes

- **Existing 'Mechs are never clobbered.** The converter skips any output file
  that already exists unless you pass `--force` (`npm run mtf -- --force`).
  Hand-transcribed 'Mechs that differ from their source MTF stay as-is.
- **Validation.** A `.mtf` that fails to convert (unknown component, bad crit
  layout, etc.) is reported as a `SKIP` with the reasons; nothing is written
  for it.

## Conventions (must match `data/mechs/*.json`)

- **Flat armor per location**; torso values store the FRONT hit points under
  `armor.<location>`. Rear torso values are stored alongside under
  `centerTorsoRear` / `leftTorsoRear` / `rightTorsoRear`. The
  engine-facing `resolveMechDef` keeps front + rear as separate pools, and
  attacks from the rear arc drain the rear pool.
- **Clan weapons** use the catalog's `CL ` prefix, e.g. `CL Gauss Rifle`.
- **Ammo is per-mount in the schema.** A shared bin of N shots is written onto
  the single mount that carries an explicit `, Ammo:N`; sibling launchers omit
  `shots`.
- **Split weapons** (MTF `(Split)`, or a weapon's slots in a location with no
  mount of it) list the weapon once, in its primary location. `resolveMechDef`
  links the spilled slots to the same weapon's mount in the paired arm or side
  torso (only arm/side-torso splits are modeled) and records `splitLocation`;
  when the catalog lists the weapon's `crits`,
  both locations' slots must add up to it.
- **`running = ceil(walking * 1.5)`** (quick-start convention).
- **Critical slot table per location** (head/legs = 6 slots, torso/arms = 12)
  is parsed and validated by `scripts/mtf-crit.mjs`.

## Scripts

- `scripts/fetch-mtf.mjs` — dev-only downloader: fetches an MTF by designation
  from the Flechs Sheets catalog into `tmp/` (e.g. `node scripts/fetch-mtf.mjs
  "Atlas AS7-D"`); copy the result into `docs/mtf/` to convert it. Downloads
  are throttled to ≥5 s apart (also across runs, via `tmp/mtf/.last-download`).
  A query that isn't an exact name downloads only if it has exactly one match;
  otherwise the available names are printed (`--list` never downloads).
  `--roster [file]` downloads every roster entry that isn't `"N/A"` into
  `docs/mtf/sw/mtf/` (any other roster: beside that roster file),
  skipping files already present.
- `scripts/mtf-catalog.mjs` — shared manifest cache/lookup helpers for
  `fetch-mtf.mjs`.
- `scripts/mtf.mjs` — batch-converts `.mtf` → `MechDef` JSON into
  `data/mechs/` (skips existing unless `--force`).
- `scripts/mtf-crit.mjs` — shared crit-slot parser + construction validation,
  also used by `scripts/backfill-crits.mjs`.
- `scripts/mtf-tables.mjs` — MTF field/component token tables.
- `scripts/backfill-crits.mjs` — merges `critSlots` from MTFs into existing
  hand-transcribed JSONs, leaving every other field byte-identical.
- `scripts/pack-catalog.mjs` — packs every `data/mechs/*.json` and
  `data/maps/*.json` into `data/btlib10x.jsonl` (runs inside `npm run mtf`;
  run `npm run pack` by hand after adding JSON by other means).

See `docs/API.md` → *'Mech definitions* for the resulting `MechDef` /
`ResolvedMechDef` shapes.

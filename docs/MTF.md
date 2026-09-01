# MTF → MechDef conversion

New 'Mechs are authored as **.mtf (MechTech File)** definitions and converted
into the library's `MechDef` JSON by `scripts/mtf.mjs`. The catalog is expected
to keep growing, and every routed-through entry is picked up automatically by
the catalog generator — no hand-wiring needed.

## Sources

The `.mtf` files are exported from **flechs.net** record sheets
(`https://sheets.flechs.net/`). Drop each exported `.mtf` into `docs/mtf/`
alongside the existing ones (Atlas AS7-D, Cicada CDA-3MA, Enforcer ENF-4R,
Griffin GRF-1N, Hermes II HER-5SA, Hunchback HBK-4G, Mad Cat Mk II 2,
Mad Cat Prime, Masakari Prime, Wolverine WVR-6R).

## Workflow

1. Export the record sheet from flechs.net as `.mtf` and place it in
   `docs/mtf/`.
2. Run the converter:

   ```sh
   npm run mtf
   ```

   This runs `scripts/mtf.mjs` then regenerates the catalog. Each new `.mtf`
   is written to `src/data/mechs/<model>.json`. The catalog generator
   (`npm run gen:mechs`) auto-registers it into `MECH_DEFS` and validates it.

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

## Conventions (must match `src/data/mechs/*.json`)

- **Flat armor per location**; torso values store the FRONT hit points under
  `armor.<location>`. Rear torso values are stored alongside under
  `centerTorsoRear` / `leftTorsoRear` / `rightTorsoRear` (informational
  metadata; the flat damage model reads the eight front locations). The
  engine-facing `resolveMechDef` keeps front + rear as separate pools.
- **Clan weapons** use the catalog's `CL ` prefix, e.g. `CL Gauss Rifle`.
- **Ammo is per-mount in the schema.** A shared bin of N shots is written onto
  the single mount that carries an explicit `, Ammo:N`; sibling launchers omit
  `ammoShots`.
- **`running = ceil(walking * 1.5)`** (quick-start convention).
- **Critical slot table per location** (head/legs = 6 slots, torso/arms = 12)
  is parsed and validated by `scripts/mtf-crit.mjs`.

## Scripts

- `scripts/mtf.mjs` — batch-converts `.mtf` → `MechDef` JSON into
  `src/data/mechs/` (skips existing unless `--force`).
- `scripts/mtf-crit.mjs` — shared crit-slot parser + construction validation,
  also used by `scripts/backfill-crits.mjs`.
- `scripts/mtf-tables.mjs` — MTF field/component token tables.
- `scripts/backfill-crits.mjs` — merges `critSlots` from MTFs into existing
  hand-transcribed JSONs, leaving every other field byte-identical.
- `scripts/gen-mech-catalog.mjs` — regenerates `src/data/mechCatalog.generated.ts`
  from every `src/data/mechs/*.json` (runs inside `npm run mtf` and the
  `build`/`typecheck`/`test` commands).

See `docs/API.md` → *'Mech definitions* for the resulting `MechDef` /
`ResolvedMechDef` shapes.

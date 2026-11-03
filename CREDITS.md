# Third-party notices

btlib10x is an unofficial fan project. This file lists the third-party
material it uses or ships, the license or terms each comes under, and where it
is used. Where the terms are not yet known, the entry says **terms to be
confirmed**; nothing here should be read as a claim that a license was granted
when it is marked that way.

## Game rules, names and data

### BattleTech (Catalyst Game Labs / The Topps Company, Inc.)

- **What:** rules from *Total Warfare* (referenced by page), 'Mech names,
  weapon and equipment statistics, terrain and table values.
- **Where:** `src/rules/`, `src/data/`, `data/`, `docs/`, the web apps.
- **Terms:** BattleTech, BattleMech, 'Mech and MechWarrior are trademarks or
  registered trademarks of their respective owners. BattleTech is owned by
  The Topps Company, Inc.; the tabletop game is published under license by
  Catalyst Game Labs. Used for reference only in an unofficial,
  non-affiliated fan project; no claim to them is made. See the Legal section
  of `README.md`.

### Master Unit List (masterunitlist.battletech.com)

- **What:** Battle Value and introduction year for each unit, copied into each
  pack's `roster.json` and into the `BV:` / `Intro:` headers of the `.mtf`
  files; the gallery also links to unit pages on the site.
- **Where:** `docs/mtf/*/roster.json`, `scripts/mtf.mjs`, `data/mechs/`,
  `web/gallery.js` (outbound links only).
- **Terms:** official Catalyst Game Labs site; **terms to be confirmed** for
  reuse of its data.

### Flechs Sheets (sheets.flechs.net) and MegaMek-generated `.mtf` files

- **What:** BattleMech record sheets exported as `.mtf` (MechTech File). The
  files carry a `generator:MegaMek Suite …` header.
- **Where:** `docs/mtf/*.mtf` and `docs/mtf/{ci,fc,jh,sw,w39}/mtf/` (about 2,200
  files), the converted JSON in `docs/mtf/*/json/`, `data/mechs/*.json`, and the
  packed catalogs (`data/btlib10x.jsonl`, `docs/mtf/sw/sw.jsonl`, the
  `web/*.jsonl` builds). `scripts/fetch-mtf.mjs` (dev-only) downloads from the
  public Flechs Sheets catalog.
- **Terms:** **terms to be confirmed.** The license of the Flechs Sheets
  exports and of the MegaMek unit data they derive from has not been
  recorded here. The underlying unit statistics are BattleTech game data (see
  above).

### BattleTechWiki (sarna.net)

- **What:** statistics for weapons not covered by *Total Warfare*: Binary
  Laser Cannon, ER Small Laser, Heavy Gauss Rifle, Light Gauss Rifle, Laser
  Anti-Missile System.
- **Where:** `src/data/weapons.data.ts` (each entry is marked with a
  `Source: BattleTechWiki (Sarna)` comment).
- **Terms:** facts only, no text copied; **terms to be confirmed** (the wiki's
  own content license has not been checked).

## Fonts

### JuliaMono (as Bt10x Mono)

- **What:** Bt10x Mono, a subset of JuliaMono v0.63.2, renamed as the SIL OFL
  requires for Modified Versions of a font with a Reserved Font Name.
- **Where:** `web/fonts/bt10x-mono-0.63.2-regular.woff2`,
  `web/fonts/bt10x-mono-0.63.2-bold.woff2` (and their copies in `dist/web/`).
- **Copyright:** Copyright (c) 2020 - 2023, cormullion, with Reserved Font
  Name JuliaMono. Source: https://github.com/cormullion/juliamono
- **License:** SIL Open Font License 1.1. The full text ships beside the font
  in `web/fonts/OFL.txt`.

## Services used at runtime

### Cloudflare Turnstile

- **What:** bot check on the avatar gallery's submit form. The script is
  loaded from `challenges.cloudflare.com` at runtime and is not bundled.
- **Where:** `web/gallery.js`, `functions/api/`.
- **Terms:** Cloudflare's Turnstile terms of service.

## npm packages (development only)

The library has no runtime dependencies. These are `devDependencies` used to
build, type-check, lint and test; none of their code is bundled into `dist/`
or the web builds. Licenses are as declared in each installed package's
`package.json`.

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| `@biomejs/biome` | 2.5.10 | MIT OR Apache-2.0 | lint and format |
| `@types/node` | 26.6.4 | MIT | Node type definitions |
| `esbuild` | 0.28.2 | MIT | web bundles (`scripts/build-web.mjs`) |
| `rollup` | 4.62.5 | MIT | bundling `.d.ts` (`scripts/build-dts.mjs`) |
| `rollup-plugin-dts` | 6.2.3 | LGPL-3.0-only | bundling `.d.ts` (`scripts/build-dts.mjs`) |
| `typescript` | 5.9.3 | Apache-2.0 | compiler and type-check |
| `vitest` | 5.0.5 | MIT | tests |

Transitive dependencies are listed in `package-lock.json`.

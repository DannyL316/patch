# Strong Champions

A small personal League of Legends patch tracker focused on champions Riot has **directly buffed multiple times within the latest five patches**.

## What it does

- Main **Strong Champions** page with an adjustable 1–5 buff threshold.
- Counts at most one buff per champion per patch.
- Tracks `buff`, `nerf`, and conservative `adjustment` classifications.
- Five-patch discovery view with concise reasoning and a link to the official Riot patch notes.
- Excludes League Classic, ARAM, Arena, items, runes, and system-wide changes from the strong-champion count.
- Includes an updater and a GitHub Actions job that checks for patches twice per day.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by `serve`.

## Update patch data

```bash
npm run update
```

The updater reads Riot's patch-notes index, keeps the newest five patches, and parses only the first normal `Champions` section. Automatic classification is deliberately conservative. Anything ambiguous is marked `review`; add a classification to `data/overrides.json` and run the update again.

## Deploy

Because the site itself is static, GitHub Pages, Cloudflare Pages, Netlify, or any basic web host works. GitHub Pages is enough for a friends-only project: push this folder to a repository, enable Pages for the repository, and leave the included scheduled Action enabled.

## Data / copyright note

The seeded data contains original short summaries of Riot's balance intent and direct links to official patch notes. It does not mirror full Riot commentary. The updater should likewise be used to extract structure and build concise summaries rather than republishing entire patch-note text.

## Current seeded window

Patch 26.16 through 26.20, current as of October 7, 2026.

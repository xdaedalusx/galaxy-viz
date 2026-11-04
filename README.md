# paper-galaxy: data layer

Turns a collection of papers into the files a 3D, time-aware "galaxy" renderer loads:
`graph.json` (lean: positions, clusters, edges, voids) and `details.json` (abstracts, authors, DOIs).

Everything under `src/core` is free of Node APIs, so the same code runs in the CLI and in the browser
(read the user's dropped file there, pass the text to `importCollection`, then `buildGraph`).

## Commands

Requires Node >= 22.18 (runs the `.ts` files directly; no build step, no dependencies).

```sh
# Synthetic collection with planted structure, then its graph
npm run demo -- --papers 800 --topics 12 --seed 2 --voids 3

# Your own collection: .json / .jsonl, .csv (Zotero export), or .bib
node src/cli/build-graph.ts --in my-papers.bib --out public/data

npm test
```

`generate` writes only the synthetic collection (`data/synthetic/papers.json` plus `truth.json`, the planted
structure); `demo` also builds the graph. Each command takes `--help`.

## Viewer

```sh
npm run demo      # writes public/data/graph.json (skip if you already have one)
npm run view      # serves public/ at http://localhost:8080
```

`public/index.html` is a single file: three.js (pinned r147) loads from cdn.jsdelivr.net, so you need an
internet connection but no install. Opening it from disk will not work (browsers block `file://` fetches);
use `npm run view`, or drop a `graph.json` (and optionally `details.json`) onto the page.

- Stars are papers: brightness/size = citations, colour = year (or topic). Papers *ignite* as the time
  slider reaches them and new links flash. Press Space to play.
- Move: W/S forward/back, A/D strafe, Q/E down/up, Shift for 3x speed (speed scales with how zoomed in you
  are). Drag to look around, scroll to zoom. Left/right arrows step the timeline.
- Click a star, a topic, or a void in the left panel. Voids are dashed dark regions between topic pairs;
  their panel shows the evidence and says the gap is within this collection.
- The Glow slider is the bloom strength; 0 turns it off ("clarity mode") and renders directly.
- Cluster labels hide when they would overlap; zoom in to reveal more.

Not yet verified: the actual WebGL rendering. This was developed in a sandbox with no GPU and no CDN access.
The UI logic, picking, data loading and escaping were tested in a browser against a three.js stand-in, and the
shaders were compiled in a software WebGL context, but nobody has looked at the real picture yet. Expect to
tune sizes, glow and link opacity (constants at the top of the shaders and in `buildGraphObjects`).

## Input

Only `title` and a date are required. Everything else sharpens the result:

| Field | Used for |
|---|---|
| `date` (`YYYY`, `YYYY-MM`) | the time slider (year-only dates land in January) |
| `references` (ids or DOIs) | citation edges, and void detection |
| `abstract`, `keywords` | similarity edges, clustering, layout |
| `citationCount` | star brightness (else in-collection citations) |
| `category` | replaces auto-clustering when every paper has one |
| `embedding` | replaces the built-in TF-IDF projection when every paper has one |

## How the graph is made

- **Time:** every node has a month `t`; every edge has `t = max(endpoint t)`, so the slider is just `t <= now`.
  Similarity edges only link a paper back to *earlier* papers, so the graph grows rather than reshuffles.
- **Layout:** computed once, offline; positions ship in the JSON so playback never re-simulates.
- **Voids:** a pair of clusters whose papers read alike (many similarity links across them) but rarely cite
  each other (few citation links, against the count expected by chance). Computed from edge structure, not
  from the 3D layout, which distorts distances. Without citation data no voids are reported.

## Known limits

- Void thresholds were tuned on the synthetic generator only. On it (800+ papers) about 60-85% of reported
  voids are planted ones and about 60-75% of planted voids are found; at 400 papers it is much weaker, and
  it cannot find a gap between two clusters that share almost no vocabulary. Treat voids as candidates to
  review, not findings. Real collections have not been measured.
- A topic split across two clusters can yield two near-duplicate voids.
- "Void" means a gap within *this collection*, not in the field.

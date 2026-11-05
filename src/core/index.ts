// Public surface of the data layer. Everything under src/core is free of Node APIs, so the React app
// can import it directly (e.g. to build a graph from a file the user drops onto the page).
export * from './types.ts';
export { importCollection } from './import/index.ts';
export type { ImportFormat } from './import/index.ts';
export { buildGraph, DEFAULT_BUILD_OPTIONS } from './build/build.ts';
export { generateCollection, DEFAULT_GENERATE_OPTIONS } from './generate.ts';
export type { GenerateOptions, SyntheticTruth } from './generate.ts';
export { validateGraph } from './validate.ts';
export { monthIndex, fromMonthIndex, monthLabel } from './util/dates.ts';

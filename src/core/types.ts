/** Integer month index: year * 12 + (month - 1). Sortable, and the unit the time slider scrubs. */
export type MonthIndex = number;

export type Vec3 = [number, number, number];

/**
 * A claim a paper takes a stance on. Claims are matched across papers by their normalised text
 * (lowercase, collapsed whitespace), so papers must phrase the same claim identically. Producing such
 * normalised claims from full text is the hard part and is not done here (an LLM extraction step would).
 */
export interface Finding {
  /** The proposition, e.g. "Over-smoothing limits deep graph networks". */
  claim: string;
  /** Whether the paper's results support the claim or argue against it. */
  stance: 'for' | 'against';
  /** Optional verbatim sentence from the paper that states the finding. */
  quote?: string;
}

/** One paper as supplied by the user (or by the generator). Only `title` and `date` are required. */
export interface PaperInput {
  id: string;
  title: string;
  /** "YYYY", "YYYY-MM" or "YYYY-MM-DD". Year-only dates are placed in January. */
  date: string;
  abstract?: string;
  authors?: string[];
  venue?: string;
  keywords?: string[];
  /** Optional user-assigned grouping. If every paper has one, it replaces auto-clustering. */
  category?: string;
  /** Ids (or DOIs) of papers this paper cites. Anything outside the collection is ignored. */
  references?: string[];
  /** Total citations from an external source; drives brightness. Falls back to in-collection citations. */
  citationCount?: number;
  doi?: string;
  url?: string;
  /** Precomputed embedding. If every paper has one (same length) it replaces the built-in text embedding. */
  embedding?: number[];
  /** Claims this paper takes a stance on. Claims with papers on both sides become conflict regions. */
  findings?: Finding[];
}

export interface BuildOptions {
  seed: number;
  /** Each paper links back to at most this many similar *earlier* papers. */
  similarityK: number;
  /** Cosine floor (on TF-IDF) for a similarity edge. */
  minSimilarity: number;
  clusters: number | 'auto';
  layout: 'force' | 'pca';
  /** The layout is scaled so ~98% of papers fall inside a sphere of this radius. */
  radius: number;
  /** Dimension of the built-in random-projection text embedding. */
  embeddingDim: number;
}

export type EdgeType = 'citation' | 'similarity';

export interface GraphNode {
  id: string;
  title: string;
  year: number;
  /** Month the paper appears on the timeline. */
  t: MonthIndex;
  x: number;
  y: number;
  z: number;
  cluster: number;
  /** Citation count used for brightness (external count if supplied, else in-collection). */
  citations: number;
  /** 0..1, log-scaled citations. */
  mag: number;
}

export interface GraphEdge {
  /** Node index of the citing / newer paper. */
  source: number;
  /** Node index of the cited / older paper. */
  target: number;
  type: EdgeType;
  /** citation: 1. similarity: cosine similarity. */
  weight: number;
  /** Month the edge comes into existence: max(source.t, target.t). */
  t: MonthIndex;
}

export interface ClusterInfo {
  id: number;
  label: string;
  keywords: string[];
  size: number;
  centroid: Vec3;
  /** 90th-percentile distance of members from the centroid. */
  radius: number;
  /** Month the cluster's first paper appears. */
  firstT: MonthIndex;
}

/**
 * A named area of space. The builder emits two kinds:
 *   void      bridge gap: two related clusters that are barely linked (absence).
 *   conflict  papers that take opposite stances on the same claim (disagreement); centred on those papers.
 * `nebula` is reserved for the renderer.
 */
export interface Region {
  id: string;
  kind: 'void' | 'nebula' | 'conflict';
  center: Vec3;
  radius: number;
  /** Month the region becomes visible, and (optionally) the month it closes. */
  t0: MonthIndex;
  t1?: MonthIndex;
  label?: string;
  /** Bridge-gap voids: the two clusters the gap lies between. */
  between?: [number, number];
  /** Bridge-gap voids: relatedness x (1 - link ratio), higher = stronger gap. */
  score?: number;
  /** One-line, human-readable evidence for the gap or conflict. */
  evidence?: string;
  /** Conflicts: the disputed claim (as first written in the collection). */
  claim?: string;
  /** Conflicts: ids of the papers on each side. */
  sides?: { for: string[]; against: string[] };
}

export interface BuildStats {
  papersIn: number;
  papersKept: number;
  duplicateIds: number;
  yearOnlyDates: number;
  referencesTotal: number;
  referencesResolved: number;
  citationsToLaterPapers: number;
}

export interface GraphMeta {
  schemaVersion: 1;
  nodeCount: number;
  edgeCounts: { citation: number; similarity: number };
  timeline: { minT: MonthIndex; maxT: MonthIndex };
  hasCitationData: boolean;
  clusterMethod: 'category' | 'kmeans';
  layout: 'force' | 'pca';
  embedding: 'provided' | 'tfidf-projection';
  options: BuildOptions;
  stats: BuildStats;
  warnings: string[];
}

/** The lean file the renderer loads. Nodes are sorted by `t`; edge endpoints are indices into `nodes`. */
export interface GraphData {
  meta: GraphMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: ClusterInfo[];
  regions: Region[];
}

export interface PaperDetails {
  abstract?: string;
  authors?: string[];
  venue?: string;
  keywords?: string[];
  doi?: string;
  url?: string;
  /** References that resolved to papers in the collection. */
  references?: string[];
  findings?: Finding[];
}

/** Heavy per-paper fields, kept out of graph.json and loaded on selection. Keyed by node id. */
export type DetailsFile = Record<string, PaperDetails>;

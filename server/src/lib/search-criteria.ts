/** Normalized factory search criteria persisted on factory_searches.search_criteria (JSON). */

export type SearchCriteria = Record<string, unknown> & {
  category?: string;
  location_preference?: string;
  min_quantity?: string;
  certifications?: string[];
  keywords?: string[];
  ideal_factory_profile?: string;
};

type ProjectRow = {
  title: string;
  description: string;
  requirements: Record<string, unknown> | null;
  ai_summary: Record<string, unknown> | null;
};

type CompanyRow = {
  name: string;
  description: string | null;
  industry: string | null;
  location: string | null;
  ai_knowledge: Record<string, unknown> | null;
} | null;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function pushKeywords(set: Set<string>, text: string, max: number): void {
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && w.length < 40 && !STOPWORDS.has(w));
  for (const w of words) {
    if (set.size >= max) break;
    set.add(w);
  }
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "has",
  "have",
  "been",
  "will",
  "our",
  "your",
  "need",
  "want",
  "looking",
  "make",
  "made",
]);

/** Merge tool criteria with project + company so runFactorySearch always has signals. */
export function mergeSearchCriteriaFromSources(
  toolCriteria: Record<string, unknown> | undefined,
  project: ProjectRow,
  company: CompanyRow
): SearchCriteria {
  const merged: SearchCriteria = { ...(toolCriteria || {}) } as SearchCriteria;
  const req = project.requirements || {};
  const sum = project.ai_summary || {};

  const ideal = asString(merged.ideal_factory_profile) ?? asString(sum.ideal_factory_profile);
  if (ideal) merged.ideal_factory_profile = ideal;

  if (!merged.category) {
    const fromSummary = asString(sum.product) ?? ideal;
    if (fromSummary) merged.category = fromSummary;
  }

  if (!merged.location_preference) {
    const timeline = asString(sum.timeline);
    if (timeline && /asia|china|eu|europe|usa|vietnam|india|mexico|americas|shenzhen|dongguan|taiwan/i.test(timeline)) {
      merged.location_preference = timeline.slice(0, 80);
    }
  }

  if (!merged.min_quantity) {
    const q = asString(req.quantity) ?? asString(sum.quantity);
    if (q) merged.min_quantity = q;
  }

  if (!merged.certifications?.length) {
    const qr = asString(req.quality_requirements);
    if (qr && /iso|ce|ul|rohs|reach/i.test(qr)) merged.certifications = [qr.slice(0, 120)];
  }

  const kw = new Set<string>(Array.isArray(merged.keywords) ? (merged.keywords as string[]).map((k) => k.toLowerCase()) : []);
  pushKeywords(kw, `${project.title} ${project.description}`, 14);
  if (company?.description) pushKeywords(kw, company.description, 18);
  if (company?.industry) pushKeywords(kw, company.industry, 18);
  const product = asString(sum.product);
  if (product) pushKeywords(kw, product, 18);
  merged.keywords = Array.from(kw).slice(0, 12);

  return merged;
}

export function criteriaHasSearchSignals(c: SearchCriteria): boolean {
  if (asString(c.category)?.length) return true;
  if (asString(c.ideal_factory_profile)?.length) return true;
  if (Array.isArray(c.keywords) && c.keywords.length > 0) return true;
  if (asString(c.location_preference)?.length) return true;
  return false;
}

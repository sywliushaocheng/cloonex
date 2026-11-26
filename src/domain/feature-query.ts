import type { Db } from '../db/database.js';
import { getFeature, listDecisions, listFeatures, type DecisionView, type FeatureView } from './feature.js';
import { evidenceFor, toEvidenceRef } from './evidence.js';
import { statementFreshness, type Freshness } from './freshness.js';
import { searchTerms } from './search.js';

/**
 * Feature lookup for "what does this do, and why" questions (product doc §6.3).
 *
 * Search is deliberately simple: keyword matching over slugs, titles and
 * statements. FTS5 availability varies between SQLite builds, and a local
 * single-user database does not need a search engine to be useful.
 */
export interface FeatureHit {
  feature: FeatureView;
  score: number;
  matchedSections: string[];
}

function score(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term.length === 0) continue;
    if (haystack.includes(term)) total += 1;
  }
  return total;
}

export function searchFeatures(db: Db, projectId: string, query: string): FeatureHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  const hits: FeatureHit[] = [];
  for (const feature of listFeatures(db, projectId)) {
    const statements = db.all(
      "SELECT section, content FROM feature_statement WHERE feature_id = ? AND state = 'current'",
      [feature.id],
    );
    let best = score(`${feature.slug} ${feature.title} ${feature.aliases.join(' ')}`, terms) * 3;
    const matched = new Set<string>();
    for (const statement of statements) {
      const sectionScore = score(String(statement.content), terms);
      if (sectionScore > 0) {
        best += sectionScore;
        matched.add(String(statement.section));
      }
    }
    for (const decision of listDecisions(db, feature.id)) {
      best += score(`${decision.title} ${decision.choice} ${decision.reason ?? ''}`, terms);
    }
    if (best > 0) hits.push({ feature, score: best, matchedSections: [...matched] });
  }
  return hits.sort((a, b) => b.score - a.score);
}

export interface FeatureDossier {
  feature: FeatureView;
  statements: Array<{
    id: string;
    section: string;
    content: string;
    reviewState: string;
    reviewedAt: string | null;
    recordedReviewState: string;
    freshness: Freshness;
    evidence: ReturnType<typeof toEvidenceRef>[];
  }>;
  decisions: DecisionView[];
  history: Array<{ section: string; content: string; supersededBy: string | null; createdAt: string }>;
  reviews: Array<Record<string, unknown>>;
}

/**
 * Builds the answer material for a feature question. Historical statements are
 * returned separately from current ones so a stale note is never presented as
 * present-day behaviour.
 */
export function featureDossier(db: Db, featureId: string, includeHistory = false): FeatureDossier | null {
  const feature = getFeature(db, featureId);
  if (!feature) return null;

  const statements = db.all(
    "SELECT * FROM feature_statement WHERE feature_id = ? AND state = 'current' ORDER BY section",
    [featureId],
  );
  const historyRows = includeHistory
    ? db.all(
        "SELECT * FROM feature_statement WHERE feature_id = ? AND state = 'historical' ORDER BY updated_at DESC",
        [featureId],
      )
    : [];

  const cache = new Map<string, string | null>();
  return {
    feature,
    statements: statements.map((row) => {
      const freshness = statementFreshness(db, String(row.id), cache);
      return ({
      id: String(row.id),
      section: String(row.section),
      content: String(row.content),
      reviewState: ['unchanged', 'untracked'].includes(freshness.status) ? String(row.review_state) : 'stale',
      recordedReviewState: String(row.review_state),
      freshness,
      reviewedAt: (row.reviewed_at as string | null) ?? null,
      evidence: evidenceFor(db, 'statement_evidence', 'statement_id', String(row.id)).map(toEvidenceRef),
    }); }),
    reviews: includeHistory ? db.all(`SELECT r.* FROM statement_review r JOIN feature_statement s ON r.statement_id=s.id
      WHERE s.feature_id=? ORDER BY r.created_at DESC`, [featureId]) : [],
    decisions: listDecisions(db, featureId, includeHistory),
    history: historyRows.map((row) => ({
      section: String(row.section),
      content: String(row.content),
      supersededBy: (row.superseded_by as string | null) ?? null,
      createdAt: String(row.created_at),
    })),
  };
}

export interface Resolution {
  dossier: FeatureDossier;
  ambiguous: FeatureHit[];
}

/** Resolves free-text or a slug to a feature, reporting ambiguity instead of guessing. */
export function resolveFeature(db: Db, projectId: string, query: string, includeHistory = false): Resolution | null {
  const exact = listFeatures(db, projectId).find((f) => f.slug === query.trim());
  if (exact) {
    const dossier = featureDossier(db, exact.id, includeHistory);
    if (dossier) return { dossier, ambiguous: [] };
  }
  const hits = searchFeatures(db, projectId, query);
  if (hits.length === 0) return null;
  const dossier = featureDossier(db, hits[0].feature.id, includeHistory);
  if (!dossier) return null;
  // Report runner-ups so the caller can ask the user rather than silently picking.
  const ambiguous = hits.slice(1, 4).filter((hit) => hit.score === hits[0].score);
  return { dossier, ambiguous };
}

import type { Db } from '../db/database.js';
import { statementFreshness, type Freshness } from './freshness.js';

/** Full phrase plus language-aware words, with no external service. */
export function searchTerms(query: string): string[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)]
    .filter((part) => part.isWordLike).map((part) => part.segment);
  return [...new Set([text, ...words])];
}

export function searchRecords(db: Db, query: string, options: { projectId?: string; group?: string; limit?: number } = {}) {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const allowed = options.projectId ? new Set([options.projectId]) : options.group
    ? new Set(db.all('SELECT project_id FROM project_group WHERE name=?', [options.group]).map((r) => String(r.project_id))) : null;
  const hits: Array<{ type: string; id: string; projectId: string; title: string; excerpt: string; score: number; matchedFields: string[]; freshness?: Freshness }> = [];
  const sources = [
    { type: 'task', sql: 'SELECT id,project_id,title,intent,outcome,verification FROM task', fields: ['title','intent','outcome','verification'] },
    { type: 'feature', sql: `SELECT id,project_id,title,slug,purpose,boundary,
      (SELECT GROUP_CONCAT(alias,' ') FROM feature_alias WHERE feature_id=feature.id) aliases FROM feature`, fields: ['title','slug','purpose','boundary','aliases'] },
    { type: 'decision', sql: "SELECT id,project_id,title,choice,reason FROM decision WHERE status='active'", fields: ['title','choice','reason'] },
    { type: 'statement', sql: "SELECT s.id,f.project_id,f.title,s.content FROM feature_statement s JOIN feature f ON s.feature_id=f.id WHERE s.state='current'", fields: ['title','content'] },
  ];
  for (const source of sources) for (const row of db.all(source.sql)) {
    if (allowed && !allowed.has(String(row.project_id))) continue;
    const matchedFields = source.fields.filter((field) => terms.some((term) => String(row[field] ?? '').toLowerCase().includes(term)));
    if (!matchedFields.length) continue;
    const score = source.fields.reduce((total, field) => total + terms.reduce((sum, term) =>
      sum + (String(row[field] ?? '').toLowerCase().includes(term) ? (field === 'title' ? 3 : 1) * (term === terms[0] ? 3 : 1) : 0), 0), 0);
    const field = matchedFields.find((name) => name !== 'title') ?? 'title';
    const text = String(row[field] ?? '');
    const position = Math.max(0, text.toLowerCase().indexOf(terms.find((term) => text.toLowerCase().includes(term)) ?? ''));
    hits.push({ type: source.type, id: String(row.id), projectId: String(row.project_id), title: String(row.title),
      excerpt: text.slice(Math.max(0, position - 60), position + 240), score, matchedFields });
  }
  const selected = hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.limit ?? 30);
  const cache = new Map<string, string | null>();
  for (const hit of selected) if (hit.type === 'statement') hit.freshness = statementFreshness(db, hit.id, cache);
  return selected;
}

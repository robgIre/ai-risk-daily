/**
 * Provider abstractions (§23 prompt 2).
 *
 * Every external dependency sits behind one of these interfaces so it can be
 * replaced without touching the ingestion pipeline or the risk engine. The
 * concrete choices below are driven by one constraint: they must be free and
 * keyless. That rules out most commercial market-data vendors and is the reason
 * several pillars stay analyst-entered.
 */

export interface RawItem {
  /** Stable identity for deduplication. Hashed if absent. */
  externalId?: string
  url?: string
  title?: string
  publishedAt?: Date
  /** Plain text for extraction. Never the full article body of a paywalled source. */
  text?: string
  /** Structured payload when the source is an API rather than a document. */
  data?: unknown
  mediaType?: 'html' | 'json' | 'csv' | 'xml' | 'pdf' | 'txt'
}

/** A metric value a collector produced directly, no LLM involved. */
export interface DirectObservation {
  metricKey: string
  value: number
  unit?: string
  currency?: string
  periodStart?: Date
  periodEnd?: Date
  observationDate: Date
  publishedDate?: Date
  basis: 'reported' | 'guidance' | 'analyst_estimate' | 'model_inference'
  companySlug?: string
  sourceUrl: string
}

export interface CollectorContext {
  /** Only fetch items newer than this. */
  since?: Date
  /** Identifies us to APIs that require it, notably SEC EDGAR. */
  userAgent: string
  signal?: AbortSignal
}

export interface Collector {
  key: string
  label: string
  /** Structured values, for sources that need no interpretation. */
  collectObservations?(ctx: CollectorContext): Promise<DirectObservation[]>
  /** Documents for the extraction pipeline. */
  collectItems?(ctx: CollectorContext): Promise<RawItem[]>
}

// ---------------------------------------------------------------------------

export interface ExtractedMetric {
  metricName: string
  value: number
  unit?: string
  currency?: string
  period?: string
  previousValue?: number
}

export interface ExtractedEvent {
  headline: string
  summary: string
  publicationDate?: string
  eventDate?: string
  companies: string[]
  category: string
  /** Effect on system stability, not on share price. */
  direction: 'positive' | 'neutral' | 'negative'
  materiality: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  pillarsAffected: string[]
  metrics: ExtractedMetric[]
  /** Distinguishing these is the whole point of the extraction step (§6). */
  basis: 'reported' | 'guidance' | 'analyst_estimate' | 'journalist_claim' | 'rumour'
  supportingText?: string
}

export interface LLMProvider {
  key: string
  /** Cheap pass. Returns 0–100 relevance so expensive calls can be avoided. */
  classifyRelevance(title: string, text: string): Promise<number>
  /** Full pass. Returns null when the document yields nothing structured. */
  extractEvent(item: RawItem): Promise<ExtractedEvent | null>
  /** Free-text answer over supplied records, for Ask Risk Watch. */
  answer(question: string, context: string): Promise<string>
}

// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`)
    this.name = 'HttpError'
  }
}

/** Fetch with a timeout, one retry on 5xx, and a clear error otherwise. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  attempts = 2,
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init
  let lastError: unknown

  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...rest, signal: controller.signal })
      if (res.ok) return res
      // 4xx will not improve on retry.
      if (res.status < 500) throw new HttpError(res.status, url)
      lastError = new HttpError(res.status, url)
    } catch (e) {
      lastError = e
      if (e instanceof HttpError && e.status < 500) throw e
    } finally {
      clearTimeout(timer)
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

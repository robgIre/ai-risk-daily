import {
  fetchWithRetry,
  type Collector,
  type CollectorContext,
  type DirectObservation,
  type RawItem,
} from './types'

/**
 * Free, keyless collectors.
 *
 * Every endpoint here was tested before being written in. Stooq is bot-blocked
 * and the EIA API needs a key, so neither is used.
 */

// ---------------------------------------------------------------------------
// FRED — credit spreads and rates. CSV download needs no API key.
// ---------------------------------------------------------------------------

/**
 * FRED series → indicator.
 *
 * `direct` series are quoted in the units the indicator wants (after the scale
 * factor). `yoy` series are index levels, from which a year-on-year percentage
 * change is derived.
 *
 * Where a series is a proxy rather than the thing itself, basis is
 * `model_inference`, never `reported`. A CCC spread is not a private
 * data-centre lending rate; it moves with the same conditions and is labelled
 * as the substitution it is.
 */
interface FredMapping {
  metricKey: string
  unit: string
  mode: 'direct' | 'yoy'
  /** Multiplier applied to the raw value in `direct` mode. */
  scale?: number
  basis: DirectObservation['basis']
  note: string
}

export const FRED_SERIES: Record<string, FredMapping> = {
  // Percent → basis points.
  BAMLH0A0HYM2: {
    metricKey: 'hy_credit_spread',
    unit: 'bps',
    mode: 'direct',
    scale: 100,
    basis: 'reported',
    note: 'ICE BofA US High Yield Index OAS',
  },
  BAMLC0A0CM: {
    metricKey: 'ig_credit_spread',
    unit: 'bps',
    mode: 'direct',
    scale: 100,
    basis: 'reported',
    note: 'ICE BofA US Corporate Index OAS',
  },
  BAMLH0A3HYC: {
    metricKey: 'private_credit_dc_spread',
    unit: 'bps',
    mode: 'direct',
    scale: 100,
    basis: 'model_inference',
    note:
      'PROXY: ICE BofA CCC & lower OAS. Private data-centre lending is not ' +
      'publicly quoted; CCC is the closest observable risk tier.',
  },
  // PPI, electric power distribution → year-on-year change.
  PCU221122221122: {
    metricKey: 'power_price_chg',
    unit: '%',
    mode: 'yoy',
    basis: 'model_inference',
    note:
      'PROXY: producer price index for electric power distribution. Not a ' +
      'contracted industrial tariff, but a published producer-side measure.',
  },
  // PPI, construction materials → year-on-year change.
  WPUSI012011: {
    metricKey: 'construction_cost_per_mw_chg',
    unit: '%',
    mode: 'yoy',
    basis: 'model_inference',
    note:
      'PROXY: construction materials PPI. Economy-wide, not data-centre ' +
      'specific and excludes labour and electrical plant.',
  },
}

/** Parses a FRED CSV into dated values, skipping missing observations. */
function parseFredCsv(csv: string): { date: Date; value: number }[] {
  const out: { date: Date; value: number }[] = []
  for (const line of csv.trim().split('\n').slice(1)) {
    const [date, raw] = line.split(',')
    if (!date || !raw || raw === '.') continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    out.push({ date: new Date(date), value })
  }
  return out
}

/** Year-on-year percentage change, matched on the nearest prior observation. */
function toYoY(
  points: { date: Date; value: number }[],
): { date: Date; value: number }[] {
  const out: { date: Date; value: number }[] = []
  for (let i = 0; i < points.length; i++) {
    const target = points[i].date.getTime() - 365 * 86_400_000
    // Nearest observation at or before one year prior.
    let prior: { date: Date; value: number } | undefined
    for (let j = i - 1; j >= 0; j--) {
      if (points[j].date.getTime() <= target) {
        prior = points[j]
        break
      }
    }
    if (!prior || prior.value === 0) continue
    out.push({
      date: points[i].date,
      value: ((points[i].value - prior.value) / prior.value) * 100,
    })
  }
  return out
}

export const fredCollector: Collector = {
  key: 'fred',
  label: 'FRED — Federal Reserve Economic Data',

  async collectObservations(ctx: CollectorContext): Promise<DirectObservation[]> {
    const out: DirectObservation[] = []

    for (const [series, meta] of Object.entries(FRED_SERIES)) {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`
      const res = await fetchWithRetry(url, { headers: { 'User-Agent': ctx.userAgent } })
      const raw = parseFredCsv(await res.text())

      const points =
        meta.mode === 'yoy'
          ? toYoY(raw)
          : raw.map((p) => ({ date: p.date, value: p.value * (meta.scale ?? 1) }))

      for (const p of points) {
        if (ctx.since && p.date < ctx.since) continue
        out.push({
          metricKey: meta.metricKey,
          value: Number(p.value.toFixed(4)),
          unit: meta.unit,
          observationDate: p.date,
          publishedDate: p.date,
          basis: meta.basis,
          sourceUrl: url,
        })
      }
    }

    return out
  },
}

// ---------------------------------------------------------------------------
// Yahoo Finance — prices. Unofficial but keyless and stable in practice.
// ---------------------------------------------------------------------------

export const EQUITY_UNIVERSE = [
  'NVDA', 'AMD', 'AVGO', 'ANET', 'VRT', 'ETN', 'DELL', 'SMCI',
  'ORCL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'CRWV', 'NBIS', 'APLD',
  'DLR', 'EQIX',
] as const

interface YahooChart {
  chart: {
    result?: {
      meta: { symbol: string; regularMarketPrice?: number }
      timestamp?: number[]
      indicators: { quote: { close?: (number | null)[] }[] }
    }[]
    error?: { description?: string } | null
  }
}

export interface EquityBar {
  symbol: string
  date: Date
  close: number
}

export async function fetchEquityHistory(
  symbol: string,
  ctx: CollectorContext,
  range = '2y',
): Promise<EquityBar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=1d`

  const res = await fetchWithRetry(url, {
    headers: { 'User-Agent': ctx.userAgent, Accept: 'application/json' },
  })
  const json = (await res.json()) as YahooChart

  const result = json.chart.result?.[0]
  if (!result?.timestamp) return []

  const closes = result.indicators.quote[0]?.close ?? []

  return result.timestamp
    .map((t, i) => ({ symbol, date: new Date(t * 1000), close: closes[i] ?? NaN }))
    .filter((b) => Number.isFinite(b.close))
}

/**
 * Market pillar indicators derived from the equity universe.
 *
 * An equal-weighted basket is used rather than market-cap weighting, because
 * cap weighting would make the whole "AI infrastructure" signal a proxy for
 * Nvidia alone.
 */
export const yahooCollector: Collector = {
  key: 'yahoo',
  label: 'Yahoo Finance — AI infrastructure equity basket',

  async collectObservations(ctx: CollectorContext): Promise<DirectObservation[]> {
    const series = new Map<string, EquityBar[]>()

    for (const symbol of EQUITY_UNIVERSE) {
      try {
        const bars = await fetchEquityHistory(symbol, ctx)
        if (bars.length > 30) series.set(symbol, bars)
      } catch {
        // One dead ticker must not take down the collector. The gap shows up
        // as reduced coverage rather than a failed run.
      }
    }
    if (series.size === 0) return []

    // Align on dates present in every series.
    const dateSets = [...series.values()].map(
      (bars) => new Set(bars.map((b) => b.date.toISOString().slice(0, 10))),
    )
    const common = [...dateSets[0]]
      .filter((d) => dateSets.every((s) => s.has(d)))
      .sort()

    const indexed = new Map(
      [...series.entries()].map(([sym, bars]) => [
        sym,
        new Map(bars.map((b) => [b.date.toISOString().slice(0, 10), b.close])),
      ]),
    )

    // Equal-weighted index, rebased to 100 at the start of the window.
    const basket = common.map((d) => {
      const vals = [...indexed.values()].map((m) => m.get(d)!).filter(Number.isFinite)
      return { date: d, level: vals.reduce((s, v) => s + v, 0) / vals.length }
    })
    if (basket.length < 90) return []

    const out: DirectObservation[] = []
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'

    let peak = 0
    for (let i = 0; i < basket.length; i++) {
      const b = basket[i]
      peak = Math.max(peak, b.level)
      const date = new Date(b.date)
      if (ctx.since && date < ctx.since) continue

      out.push({
        metricKey: 'ai_infra_equity_drawdown',
        value: ((peak - b.level) / peak) * 100,
        unit: '%',
        observationDate: date,
        publishedDate: date,
        basis: 'reported',
        sourceUrl: url,
      })

      // 90-session change, used as a rough proxy for multiple re-rating.
      if (i >= 90) {
        const prior = basket[i - 90].level
        out.push({
          metricKey: 'ev_revenue_multiple_chg',
          value: ((b.level - prior) / prior) * 100,
          unit: '%',
          observationDate: date,
          publishedDate: date,
          // Price change stands in for the multiple; that is an inference, and
          // it is labelled as one rather than passed off as a reported figure.
          basis: 'model_inference',
          sourceUrl: url,
        })
      }
    }

    return out
  },
}

// ---------------------------------------------------------------------------
// SEC EDGAR — filings and XBRL facts. Keyless; requires an identifying UA.
// ---------------------------------------------------------------------------

export const EDGAR_COMPANIES: Record<string, { cik: string; slug: string }> = {
  Microsoft: { cik: '0000789019', slug: 'microsoft' },
  Alphabet: { cik: '0001652044', slug: 'alphabet' },
  Amazon: { cik: '0001018724', slug: 'amazon' },
  Meta: { cik: '0001326801', slug: 'meta' },
  Oracle: { cik: '0001341439', slug: 'oracle' },
  NVIDIA: { cik: '0001045810', slug: 'nvidia' },
}

interface XbrlConcept {
  units: Record<string, { end: string; val: number; fy?: number; fp?: string; form?: string; filed?: string }[]>
}

async function xbrlConcept(
  cik: string,
  tag: string,
  ctx: CollectorContext,
): Promise<XbrlConcept | null> {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`
  try {
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': ctx.userAgent, Accept: 'application/json' },
    })
    return (await res.json()) as XbrlConcept
  } catch {
    // Not every issuer tags every concept.
    return null
  }
}

/**
 * Hyperscaler CapEx from primary filings.
 *
 * This is the one pillar that can be fully automated from an authoritative
 * source, which is why it carries a `reported` basis while most of the model
 * is estimate-grade.
 */
export const edgarCollector: Collector = {
  key: 'edgar',
  label: 'SEC EDGAR — XBRL company facts',

  async collectObservations(ctx: CollectorContext): Promise<DirectObservation[]> {
    const out: DirectObservation[] = []

    // Annual CapEx and operating cash flow per issuer, from which the growth
    // and intensity indicators are derived.
    const capexByCompany = new Map<string, { end: Date; val: number }[]>()
    const ocfByCompany = new Map<string, { end: Date; val: number }[]>()

    for (const [name, { cik, slug }] of Object.entries(EDGAR_COMPANIES)) {
      const capex = await xbrlConcept(cik, 'PaymentsToAcquirePropertyPlantAndEquipment', ctx)
      const ocf = await xbrlConcept(cik, 'NetCashProvidedByUsedInOperatingActivities', ctx)

      const annual = (c: XbrlConcept | null) =>
        (c?.units?.USD ?? [])
          .filter((f) => f.form === '10-K' && f.fp === 'FY')
          .map((f) => ({ end: new Date(f.end), val: f.val }))
          .sort((a, b) => a.end.getTime() - b.end.getTime())

      const cx = annual(capex)
      const oc = annual(ocf)
      if (cx.length) capexByCompany.set(slug, cx)
      if (oc.length) ocfByCompany.set(slug, oc)

      // SEC asks for no more than 10 requests per second; this is well under.
      await new Promise((r) => setTimeout(r, 150))
      void name
    }

    // Aggregate across issuers, year by year.
    const years = new Set<number>()
    for (const rows of capexByCompany.values())
      for (const r of rows) years.add(r.end.getUTCFullYear())

    const sorted = [...years].sort()
    const totals = sorted.map((y) => {
      let capex = 0
      let ocf = 0
      // Which issuers actually reported this year. Fiscal years end on
      // different dates and the most recent year is usually incomplete, so the
      // set has to travel with the total.
      const reported = new Set<string>()

      for (const [slug, rows] of capexByCompany) {
        const hit = rows.find((r) => r.end.getUTCFullYear() === y)
        if (hit) {
          capex += hit.val
          reported.add(slug)
        }
      }
      for (const rows of ocfByCompany.values()) {
        const hit = rows.find((r) => r.end.getUTCFullYear() === y)
        if (hit) ocf += hit.val
      }
      return { year: y, capex, ocf, reported }
    })

    const url = 'https://data.sec.gov/api/xbrl/'

    for (let i = 1; i < totals.length; i++) {
      const cur = totals[i]
      const prev = totals[i - 1]
      if (!cur.capex || !prev.capex) continue

      // Only compare years covering the same issuers. Without this the latest
      // year — where several 10-Ks are still outstanding — reads as a large
      // fall in CapEx when in fact the filings simply have not landed yet.
      const sameCoverage =
        cur.reported.size === prev.reported.size &&
        [...cur.reported].every((s) => prev.reported.has(s))
      if (!sameCoverage) continue

      const observationDate = new Date(Date.UTC(cur.year, 11, 31))
      if (ctx.since && observationDate < ctx.since) continue

      out.push({
        metricKey: 'capex_growth_ttm',
        value: ((cur.capex - prev.capex) / prev.capex) * 100,
        unit: '%',
        observationDate,
        basis: 'reported',
        sourceUrl: url,
      })

      if (cur.ocf > 0) {
        out.push({
          metricKey: 'capex_to_ocf',
          value: (cur.capex / cur.ocf) * 100,
          unit: '%',
          observationDate,
          basis: 'reported',
          sourceUrl: url,
        })
      }
    }

    return out
  },

  /** New filings, which is the trigger the earnings watcher runs on (§11). */
  async collectItems(ctx: CollectorContext): Promise<RawItem[]> {
    const items: RawItem[] = []

    for (const [name, { cik }] of Object.entries(EDGAR_COMPANIES)) {
      const url =
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}` +
        `&type=10-&dateb=&owner=include&count=8&output=atom`

      try {
        const res = await fetchWithRetry(url, { headers: { 'User-Agent': ctx.userAgent } })
        const xml = await res.text()

        for (const entry of xml.split('<entry>').slice(1)) {
          const pick = (tag: string) =>
            entry.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim()
          const href = entry.match(/<link[^>]*href="([^"]+)"/)?.[1]
          const filed = pick('filing-date')
          const type = pick('filing-type')
          if (!filed || !href) continue

          const publishedAt = new Date(filed)
          if (ctx.since && publishedAt < ctx.since) continue

          items.push({
            externalId: `edgar:${cik}:${type}:${filed}`,
            url: href,
            title: `${name} ${type} filed ${filed}`,
            publishedAt,
            mediaType: 'html',
          })
        }
      } catch {
        // Skip this issuer; the run continues.
      }
      await new Promise((r) => setTimeout(r, 150))
    }

    return items
  },
}

// ---------------------------------------------------------------------------
// Google News RSS — keyless search-based discovery (§3 prompt 2).
// ---------------------------------------------------------------------------

export function googleNewsCollector(queries: string[]): Collector {
  return {
    key: 'google_news',
    label: 'Google News — query-driven discovery',

    async collectItems(ctx: CollectorContext): Promise<RawItem[]> {
      const items: RawItem[] = []
      const seen = new Set<string>()

      for (const q of queries) {
        const url =
          `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
          `&hl=en-GB&gl=GB&ceid=GB:en`

        try {
          const res = await fetchWithRetry(url, {
            headers: { 'User-Agent': ctx.userAgent },
          })
          const xml = await res.text()

          for (const raw of xml.split('<item>').slice(1)) {
            const pick = (tag: string) =>
              raw
                .match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))?.[1]
                ?.trim()

            const title = pick('title')
            const link = pick('link')
            const pub = pick('pubDate')
            const desc = pick('description')
            if (!title || !link) continue

            const publishedAt = pub ? new Date(pub) : undefined
            if (ctx.since && publishedAt && publishedAt < ctx.since) continue
            if (seen.has(link)) continue
            seen.add(link)

            items.push({
              externalId: link,
              url: link,
              title,
              publishedAt,
              // Headline and snippet only. The full article is not republished.
              text: desc?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1200),
              mediaType: 'html',
            })
          }
        } catch {
          // A failing query does not fail the run.
        }
        await new Promise((r) => setTimeout(r, 300))
      }

      return items
    },
  }
}

// ---------------------------------------------------------------------------
// Vast.ai — live GPU marketplace pricing
// ---------------------------------------------------------------------------

/**
 * Median rental price per GPU-hour from a public compute marketplace.
 *
 * This is a genuine transacted-market price, not an estimate. Two caveats that
 * belong with every value it produces:
 *
 * 1. Unauthenticated the API returns at most ~64 offers, so a given accelerator
 *    may be priced off a handful of listings. A free API key raises the cap
 *    substantially; set VAST_API_KEY.
 * 2. A decentralised marketplace prices differently from an enterprise contract.
 *    It is directionally useful and not a substitute for contracted rates.
 *
 * The indicator wants a 90-day change, which cannot be backfilled — the
 * marketplace exposes only current offers. The collector records today's level
 * and derives the change once enough history has accumulated, so it starts
 * producing a real figure roughly three months after first run.
 */
const VAST_TRACKED = ['H100 SXM', 'H100 NVL', 'H200', 'A100 SXM4', 'B200']

interface VastOffer {
  gpu_name?: string
  num_gpus?: number
  dph_total?: number
  rented?: boolean
}

export const vastCollector: Collector = {
  key: 'vast_ai',
  label: 'Vast.ai — GPU marketplace pricing',

  async collectObservations(ctx: CollectorContext): Promise<DirectObservation[]> {
    const key = process.env.VAST_API_KEY
    const url =
      'https://console.vast.ai/api/v0/bundles/?q=' +
      encodeURIComponent(JSON.stringify({ limit: 3000 }))

    const res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': ctx.userAgent,
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    })
    const json = (await res.json()) as { offers?: VastOffer[] }
    const offers = json.offers ?? []
    if (offers.length === 0) return []

    // Price per single GPU-hour, so multi-GPU hosts are comparable.
    const perGpu = new Map<string, number[]>()
    for (const o of offers) {
      const name = o.gpu_name
      const n = o.num_gpus ?? 1
      const dph = o.dph_total
      if (!name || !dph || n < 1) continue
      perGpu.set(name, [...(perGpu.get(name) ?? []), dph / n])
    }

    const median = (xs: number[]) => {
      const a = [...xs].sort((p, q) => p - q)
      const m = Math.floor(a.length / 2)
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
    }

    // Datacentre-class accelerators only; consumer cards price on a different
    // market and would drag the index somewhere meaningless.
    const samples = VAST_TRACKED.flatMap((g) => perGpu.get(g) ?? [])
    if (samples.length < 2) return []

    const today = new Date()
    return [
      {
        metricKey: 'gpu_rental_price_level',
        value: Number(median(samples).toFixed(4)),
        unit: '$/GPU/hr',
        observationDate: today,
        publishedDate: today,
        // A real transacted price, but a thin and non-enterprise sample.
        basis: 'model_inference',
        sourceUrl: 'https://console.vast.ai/api/v0/bundles/',
      },
    ]
  },
}

export const ALL_COLLECTORS = [
  fredCollector,
  yahooCollector,
  edgarCollector,
  vastCollector,
]

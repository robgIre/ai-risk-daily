/**
 * Generates a self-contained daily read as a single HTML file.
 *
 * The Next.js application needs a server and a database. This does not: it
 * fetches everything live, renders one page, and writes `docs/index.html` with
 * all styling inlined. Nothing to host beyond a static file, which is the same
 * pattern as the other single-file apps and the thing that was actually wanted.
 *
 * Every source here returns full history on each call, so there is no state to
 * carry between runs and nothing to persist.
 *
 *   tsx scripts/build-static.mts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  edgarCollector,
  fredCollector,
  googleNewsCollector,
  yahooCollector,
} from './lib/collectors'
import type { CollectorContext, DirectObservation } from './lib/types'

const OUT_DIR = join(process.cwd(), 'docs')

const ctx: CollectorContext = {
  since: new Date(Date.now() - 800 * 86_400_000),
  userAgent:
    process.env.COLLECTOR_USER_AGENT ??
    'AI-Infrastructure-Risk-Watch/0.1 (personal research)',
}

// ---------------------------------------------------------------------------
// Threshold commentary. Kept in step with lib/queries/today.ts.
// ---------------------------------------------------------------------------

interface Rule {
  label: string
  unit: string
  watch: number
  stress: number
  higherIsWorse: boolean
  calm: string
  watching: string
  stressed: string
  trigger: string
}

const RULES: Record<string, Rule> = {
  hy_credit_spread: {
    label: 'US high-yield credit spread',
    unit: 'bps',
    watch: 400, stress: 500, higherIsWorse: true,
    calm: 'High-yield credit is open and cheap. Leveraged buildout can refinance.',
    watching: 'High-yield spreads widening. Refinancing is getting dearer.',
    stressed: 'High-yield markets are pricing real distress. Marginal projects stop penciling.',
    trigger: 'Above 500bps is where leveraged infrastructure financing tightens materially.',
  },
  private_credit_dc_spread: {
    label: 'Deep credit spread (CCC and lower)',
    unit: 'bps',
    watch: 900, stress: 1100, higherIsWorse: true,
    calm: 'The riskiest credit tier is still functioning. Private lending stays available.',
    watching: 'The lowest credit tier is repricing. Private credit usually follows.',
    stressed: 'Deep credit is shut. Speculative data-centre lending would be first to close.',
    trigger: 'Above 1100bps has historically preceded private credit withdrawal.',
  },
  ig_credit_spread: {
    label: 'US investment-grade spread',
    unit: 'bps',
    watch: 130, stress: 175, higherIsWorse: true,
    calm: 'Investment-grade issuance is wide open. Hyperscalers fund at will.',
    watching: 'Investment-grade spreads drifting wider.',
    stressed: 'Even investment-grade borrowers are paying up. Broad risk-off.',
    trigger: 'Above 175bps signals stress reaching the strongest borrowers.',
  },
  capex_growth_ttm: {
    label: 'Hyperscaler CapEx growth',
    unit: '% YoY',
    watch: 50, stress: 80, higherIsWorse: true,
    calm: 'Hyperscaler capex growing at a digestible rate.',
    watching: 'Capex growth is running hot relative to any plausible revenue ramp.',
    stressed: 'Capex growth is extreme. Either demand is exceptional or this corrects.',
    trigger: 'Sustained growth above 80% with flat revenue is the classic overbuild signature.',
  },
  capex_to_ocf: {
    label: 'CapEx as share of operating cash flow',
    unit: '%',
    watch: 65, stress: 90, higherIsWorse: true,
    calm: 'Capex is comfortably funded from operating cash flow.',
    watching: 'Capex is consuming most of operating cash flow. Less buffer.',
    stressed: 'Capex exceeds what operations generate. The balance sheet is funding growth.',
    trigger: 'Above 90% means the buildout depends on debt or equity, not cash generation.',
  },
  construction_cost_per_mw_chg: {
    label: 'Construction input costs',
    unit: '% YoY',
    watch: 12, stress: 20, higherIsWorse: true,
    calm: 'Construction input costs broadly stable.',
    watching: 'Construction inflation ahead of general prices. Margin pressure on fixed-price work.',
    stressed: 'Construction inflation is severe. Fixed-price contracts are losing money.',
    trigger: 'Above 20% YoY erodes returns on capacity already committed.',
  },
  power_price_chg: {
    label: 'Industrial power prices',
    unit: '% YoY',
    watch: 10, stress: 20, higherIsWorse: true,
    calm: 'Power costs stable. Operating margin protected.',
    watching: 'Power costs rising faster than usual. Matters without pass-through terms.',
    stressed: 'Power costs rising sharply. The largest operating input is inflating.',
    trigger: 'Above 20% YoY without pass-through is a direct margin hit.',
  },
  ai_infra_equity_drawdown: {
    label: 'AI infrastructure equities, drawdown from peak',
    unit: '%',
    watch: 20, stress: 35, higherIsWorse: true,
    calm: 'AI infrastructure equities near highs. Capital markets remain receptive.',
    watching: 'The sector is off its highs. Equity issuance gets harder from here.',
    stressed: 'Deep sector drawdown. Equity funding is effectively shut for new entrants.',
    trigger: 'Beyond 35% closes the equity window for capital-hungry developers.',
  },
  ev_revenue_multiple_chg: {
    label: 'Sector re-rating, 90 sessions',
    unit: '%',
    watch: -15, stress: -30, higherIsWorse: false,
    calm: 'The sector is holding or expanding its rating.',
    watching: 'The sector is de-rating. Sentiment turning before fundamentals.',
    stressed: 'Sharp de-rating. The market is repricing the whole thesis.',
    trigger: 'A fall beyond 30% over a quarter signals a change in how the sector is valued.',
  },
}

const TOPICS = [
  { label: 'Cancellations and delays', q: 'data center cancelled' },
  { label: 'Power and grid', q: 'data center power grid' },
  { label: 'Financing and debt', q: 'AI infrastructure debt financing' },
  { label: 'GPU market', q: 'GPU rental price' },
  { label: 'Lab funding', q: 'OpenAI Anthropic compute' },
  { label: 'Hyperscaler capex', q: 'AI capex data center' },
]

// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const TONE_RANK: Record<'stress' | 'watch' | 'calm', number> = {
  stress: 0,
  watch: 1,
  calm: 2,
}

const fmt = (n: number) =>
  Math.abs(n) < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-GB')

async function main() {
  console.log('fetching live data...')

  const settle = async (name: string, p: Promise<DirectObservation[]>) => {
    try {
      const r = await p
      console.log(`  ${name}: ${r.length}`)
      return r
    } catch (e) {
      console.warn(`  ${name}: FAILED — ${(e as Error).message}`)
      return [] as DirectObservation[]
    }
  }

  const [fred, yahoo, edgar] = await Promise.all([
    settle('fred', fredCollector.collectObservations!(ctx)),
    settle('yahoo', yahooCollector.collectObservations!(ctx)),
    settle('edgar', edgarCollector.collectObservations!(ctx)),
  ])
  const observations = [...fred, ...yahoo, ...edgar]

  // Latest value per metric.
  const latest = new Map<string, DirectObservation>()
  for (const o of observations) {
    const cur = latest.get(o.metricKey)
    if (!cur || o.observationDate > cur.observationDate) latest.set(o.metricKey, o)
  }

  const readings = Object.entries(RULES)
    .map(([key, r]) => {
      const o = latest.get(key)
      if (!o) return null
      const stressed = r.higherIsWorse ? o.value >= r.stress : o.value <= r.stress
      const watching = r.higherIsWorse ? o.value >= r.watch : o.value <= r.watch
      const tone: 'stress' | 'watch' | 'calm' = stressed
        ? 'stress'
        : watching
          ? 'watch'
          : 'calm'
      const age = Math.round((Date.now() - o.observationDate.getTime()) / 86_400_000)
      return {
        ...r,
        key,
        value: o.value,
        tone,
        verdict: stressed ? r.stressed : watching ? r.watching : r.calm,
        date: o.observationDate.toISOString().slice(0, 10),
        age,
        basis: o.basis,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])

  console.log('fetching headlines...')
  const seen = new Set<string>()
  const topics: { label: string; items: { title: string; url: string; date: string }[] }[] = []

  for (const t of TOPICS) {
    const items = await googleNewsCollector([t.q]).collectItems!({
      since: new Date(Date.now() - 4 * 86_400_000),
      userAgent: ctx.userAgent,
    })
    const kept: { title: string; url: string; date: string }[] = []
    for (const i of items) {
      if (!i.title || !i.url) continue
      const norm = i.title.toLowerCase().replace(/ - [^-]+$/, '').replace(/[^a-z0-9 ]/g, '')
        .split(' ').slice(0, 8).join(' ')
      if (seen.has(norm)) continue
      seen.add(norm)
      kept.push({
        title: i.title,
        url: i.url,
        date: i.publishedAt?.toISOString().slice(0, 10) ?? '',
      })
      if (kept.length >= 6) break
    }
    if (kept.length) topics.push({ label: t.label, items: kept })
    console.log(`  ${t.label}: ${kept.length}`)
  }

  const counts = {
    stress: readings.filter((r) => r.tone === 'stress').length,
    watch: readings.filter((r) => r.tone === 'watch').length,
    calm: readings.filter((r) => r.tone === 'calm').length,
  }
  const verdict =
    counts.stress >= 2
      ? 'Multiple leading indicators are in stress. Conditions are tightening.'
      : counts.stress === 1
        ? 'One leading indicator is in stress. Worth understanding why before it spreads.'
        : counts.watch >= 3
          ? 'Several indicators are drifting the wrong way. Nothing is broken yet.'
          : 'Leading indicators are calm. No financing or pricing stress visible.'

  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16)

  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>AI Infrastructure Risk — the daily read</title>
<style>
  :root{--bg:#0a0c10;--panel:#12151c;--line:#222834;--soft:#1a1f28;
    --ink:#e7eaf0;--dim:#9aa3b5;--faint:#6b7385;
    --good:#34d399;--warn:#fbbf24;--bad:#f87171;--info:#60a5fa}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:22px 16px 60px}
  h1{font-size:19px;margin:0 0 4px;letter-spacing:-.2px}
  .verdict{font-size:14px;color:var(--dim);margin:0 0 6px}
  .meta{font-size:11px;color:var(--faint);margin:0}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;margin-top:14px}
  .head{padding:9px 14px;border-bottom:1px solid var(--soft);font-size:10.5px;
    letter-spacing:.09em;text-transform:uppercase;color:var(--faint);font-weight:500}
  .row{padding:11px 14px;border-bottom:1px solid var(--soft);display:flex;gap:11px}
  .row:last-child{border-bottom:0}
  .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;margin-top:5px}
  .grow{flex:1;min-width:0}
  .top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
  .name{font-size:12.5px}
  .val{font-variant-numeric:tabular-nums;font-size:14px;font-weight:600;white-space:nowrap}
  .unit{font-size:10px;color:var(--faint);margin-left:3px;font-weight:400}
  .say{font-size:12px;color:var(--dim);margin:3px 0 0}
  .trig{font-size:11px;color:var(--faint);margin:2px 0 0}
  .prov{font-size:10px;color:var(--faint);margin:5px 0 0;font-variant-numeric:tabular-nums}
  .grid{display:grid;grid-template-columns:1fr;gap:1px;background:var(--soft)}
  @media(min-width:760px){.grid{grid-template-columns:1fr 1fr}}
  .cell{background:var(--panel);padding:11px 14px}
  .cell h3{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
    color:var(--faint);font-weight:500;margin:0 0 7px}
  .cell ul{margin:0;padding:0;list-style:none}
  .cell li{margin:0 0 7px;font-size:12px;line-height:1.4}
  .cell a{color:var(--dim);text-decoration:none}
  .cell a:hover{color:var(--info);text-decoration:underline}
  .when{color:var(--faint);font-size:10px;margin-left:5px;font-variant-numeric:tabular-nums}
  footer{margin-top:16px;font-size:10.5px;color:var(--faint);line-height:1.6}
</style>
</head>
<body><div class="wrap">

<h1>AI Infrastructure Risk — the daily read</h1>
<p class="verdict">${esc(verdict)}</p>
<p class="meta">${readings.length} measured indicators ·
  <span style="color:var(--bad)">${counts.stress} stress</span> ·
  <span style="color:var(--warn)">${counts.watch} watch</span> ·
  <span style="color:var(--good)">${counts.calm} calm</span> ·
  ${topics.reduce((s, t) => s + t.items.length, 0)} headlines · generated ${generated} UTC</p>

<div class="panel">
  <div class="head">Leading indicators — what the numbers say</div>
  ${readings
    .map((r) => {
      const c = r.tone === 'stress' ? 'var(--bad)' : r.tone === 'watch' ? 'var(--warn)' : 'var(--good)'
      return `<div class="row">
    <div class="dot" style="background:${c}"></div>
    <div class="grow">
      <div class="top">
        <span class="name">${esc(r.label)}</span>
        <span class="val" style="color:${c}">${fmt(r.value)}<span class="unit">${esc(r.unit)}</span></span>
      </div>
      <p class="say">${esc(r.verdict)}</p>
      <p class="trig">${esc(r.trigger)}</p>
      <p class="prov">${esc(r.date)} · ${r.age === 0 ? 'today' : r.age + 'd old'} · ${esc(r.basis)}</p>
    </div>
  </div>`
    })
    .join('\n  ')}
</div>

<div class="panel">
  <div class="head">What is being reported — last 4 days</div>
  <div class="grid">
  ${topics
    .map(
      (t) => `<div class="cell"><h3>${esc(t.label)}</h3><ul>
      ${t.items
        .map(
          (i) =>
            `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a><span class="when">${esc(i.date)}</span></li>`,
        )
        .join('\n      ')}
    </ul></div>`,
    )
    .join('\n  ')}
  </div>
</div>

<footer>
Every figure is measured and every headline links to its source. The commentary
is threshold logic over real values, not model output. Indicators marked
model_inference are proxies — a CCC credit spread is not a private data-centre
lending rate, it is the closest observable tier.<br>
Sources: FRED (ICE BofA indices, producer price indices), SEC EDGAR XBRL,
Yahoo Finance, Google News.
</footer>

</div></body></html>`

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, 'index.html'), html, 'utf8')
  // Stops GitHub Pages running the output through Jekyll.
  await writeFile(join(OUT_DIR, '.nojekyll'), '', 'utf8')

  console.log(
    `\nwrote docs/index.html — ${(html.length / 1024).toFixed(0)}KB, ` +
      `${readings.length} indicators, ${topics.reduce((s, t) => s + t.items.length, 0)} headlines`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

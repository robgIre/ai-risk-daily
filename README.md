# AI Infrastructure Risk — the daily read

A single page answering: is stress building in AI infrastructure, and what are
the leading indicators saying.

**https://robgire.github.io/ai-risk-daily/**

Rebuilt twice a day from live sources. Everything on it is measured or quoted:

- **Nine indicators** with a plain-English verdict and the threshold that would
  make each one a problem. The commentary is threshold logic over real values,
  not model output, so it cannot hallucinate.
- **Headlines** from the last four days, grouped by theme and deduplicated
  across outlets, each linking to its source.

Sources: FRED (ICE BofA credit indices, producer price indices), SEC EDGAR
XBRL, Yahoo Finance, Google News. All free and keyless.

Where an indicator is a proxy it says so. A CCC credit spread is not a private
data-centre lending rate; it is the closest observable tier.

No database, no server, no accounts. `npm install && npm run build` regenerates
`docs/index.html` locally.

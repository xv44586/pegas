export type MetricLabels = Record<string, string>

interface CounterState {
  help: string
  values: Map<string, { labels: MetricLabels; value: number }>
}

interface HistogramState {
  help: string
  buckets: number[]
  values: Map<
    string,
    { labels: MetricLabels; counts: number[]; sum: number; count: number }
  >
}

const defaultDurationBuckets = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
]

/**
 * In-process Prometheus-style registry. Values are process-local operational
 * telemetry, never a source of product truth; durable facts stay in SQLite.
 */
export class MetricsRegistry {
  readonly #counters = new Map<string, CounterState>()
  readonly #histograms = new Map<string, HistogramState>()

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    let counter = this.#counters.get(name)
    if (!counter) {
      counter = { help: name, values: new Map() }
      this.#counters.set(name, counter)
    }
    const key = labelKey(labels)
    const existing = counter.values.get(key)
    if (existing) existing.value += value
    else counter.values.set(key, { labels, value })
  }

  observe(
    name: string,
    seconds: number,
    labels: MetricLabels = {},
    buckets: number[] = defaultDurationBuckets,
  ): void {
    let histogram = this.#histograms.get(name)
    if (!histogram) {
      histogram = { help: name, buckets, values: new Map() }
      this.#histograms.set(name, histogram)
    }
    const key = labelKey(labels)
    let series = histogram.values.get(key)
    if (!series) {
      series = {
        labels,
        counts: histogram.buckets.map(() => 0),
        sum: 0,
        count: 0,
      }
      histogram.values.set(key, series)
    }
    const target = series
    target.sum += seconds
    target.count += 1
    histogram.buckets.forEach((bucket, index) => {
      if (seconds <= bucket)
        target.counts[index] = (target.counts[index] ?? 0) + 1
    })
  }

  render(): string {
    const lines: string[] = []
    for (const [name, counter] of this.#counters) {
      lines.push(`# HELP ${name} ${counter.help}`)
      lines.push(`# TYPE ${name} counter`)
      for (const { labels, value } of counter.values.values()) {
        lines.push(`${name}${renderLabels(labels)} ${String(value)}`)
      }
    }
    for (const [name, histogram] of this.#histograms) {
      lines.push(`# HELP ${name} ${histogram.help}`)
      lines.push(`# TYPE ${name} histogram`)
      for (const series of histogram.values.values()) {
        histogram.buckets.forEach((bucket, index) => {
          lines.push(
            `${name}_bucket${renderLabels({
              ...series.labels,
              le: String(bucket),
            })} ${String(series.counts[index])}`,
          )
        })
        lines.push(
          `${name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${String(series.count)}`,
        )
        lines.push(
          `${name}_sum${renderLabels(series.labels)} ${String(series.sum)}`,
        )
        lines.push(
          `${name}_count${renderLabels(series.labels)} ${String(series.count)}`,
        )
      }
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : ''
  }
}

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map(key => `${key}=${labels[key] ?? ''}`)
    .join(',')
}

function renderLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  const rendered = keys
    .map(key => `${key}="${escapeLabel(labels[key] ?? '')}"`)
    .join(',')
  return `{${rendered}}`
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
}

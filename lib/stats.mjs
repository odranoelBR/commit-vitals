export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function spread(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0) return null;
  return { min: Math.min(...v), max: Math.max(...v) };
}

export function round(value, digits = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

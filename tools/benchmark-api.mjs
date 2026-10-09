const base = process.argv[2] || "http://127.0.0.1:18777";
for (const query of ["page=1&pageSize=30", "page=1&pageSize=30&query=dance", "page=1&pageSize=30&randomSample=1&randomSeed=backend-audit"]) {
  const values = []; let errors = 0, cursor = 0, total = null;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor++ < 40) {
      const started = performance.now();
      try { const response = await fetch(`${base}/playlist-data?${query}`); const data = await response.json(); if (!response.ok) errors++; total = data.total; }
      catch { errors++; }
      values.push(performance.now() - started);
    }
  }));
  values.sort((a, b) => a - b);
  console.log(JSON.stringify({ query, requests: values.length, total, errors, p50: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) }));
}

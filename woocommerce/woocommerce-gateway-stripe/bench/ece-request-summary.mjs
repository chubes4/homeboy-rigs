function countBy(items, callback) {
  const counts = {};
  for (const item of items) {
    const key = callback(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }

  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function requestHost(entry) {
  const url = entry.url || entry.request?.url || '';
  if (!url) {
    return 'unknown';
  }

  try {
    return new URL(url).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

function requestType(entry) {
  return entry.resourceType || entry.request?.resourceType || entry.type || 'unknown';
}

export function buildRequestSummary(responses) {
  return {
    total: responses.length,
    by_host: countBy(responses, requestHost),
    by_type: countBy(responses, requestType),
  };
}

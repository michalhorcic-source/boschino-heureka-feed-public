const apiKey = process.env.HEUREKA_REPORTS_API_KEY;

if (!apiKey) {
  throw new Error("Missing HEUREKA_REPORTS_API_KEY");
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

const requestedDate =
  process.env.HEUREKA_REPORT_DATE ||
  formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

const url = new URL("https://api.heureka.group/v1/reports/conversions");
url.searchParams.set("date", requestedDate);

const response = await fetch(url, {
  method: "GET",
  headers: {
    "x-heureka-api-key": apiKey,
    Accept: "application/json",
  },
});

const text = await response.text();

let json;

try {
  json = text ? JSON.parse(text) : {};
} catch {
  console.error("Heureka response is not valid JSON:");
  console.error(text);
  throw new Error(`Heureka Reports API returned non-JSON response, HTTP ${response.status}`);
}

if (!response.ok) {
  console.error(JSON.stringify(json, null, 2));
  throw new Error(`Heureka Reports API error: HTTP ${response.status}`);
}

const conversions = Array.isArray(json.conversions) ? json.conversions : [];

let visits = 0;
let orders = 0;
let revenue = 0;
let costsWithVat = 0;

for (const row of conversions) {
  visits += Number(row.visits?.total || 0);
  orders += Number(row.orders?.total || 0);
  revenue += Number(row.revenue?.total || 0);
  costsWithVat += Number(row.costs_with_vat?.total || 0);
}

console.log(`Heureka report date: ${requestedDate}`);
console.log(`Rows: ${conversions.length}`);
console.log(`Visits: ${visits}`);
console.log(`Orders: ${orders}`);
console.log(`Revenue: ${revenue}`);
console.log(`Costs with VAT: ${costsWithVat}`);

if (conversions.length > 0) {
  console.log("Sample rows:");
  console.log(JSON.stringify(conversions.slice(0, 5), null, 2));
}

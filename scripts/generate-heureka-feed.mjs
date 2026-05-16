import fs from "node:fs/promises";

const SHOP = "vvircm-fz.myshopify.com";
const STOREFRONT_DOMAIN = "https://boschino.cz";
const API_VERSION = "2026-04";

// Generujeme nejdřív do public/heureka.xml.
// Workflow ho potom zkopíruje do kořene repozitáře jako heureka.xml.
const OUT_DIR = "public";
const OUT_FILE = `${OUT_DIR}/heureka.xml`;

const MIN_PRICE = 499.99;

// Shopify product tag musí být například:
// CategoryText: Heureka.cz | Bílé zboží | Myčky nádobí | Příslušenství k myčkám nádobí
//
// Podporované tvary:
// CategoryText: ...
// categoryText: ...
// CATEGORYTEXT: ...
// CategoryText=...
// categoryText=...
// CATEGORYTEXT=...
const CATEGORYTEXT_TAG_PREFIXES = [
  "CategoryText:",
  "categoryText:",
  "CATEGORYTEXT:",
  "CategoryText=",
  "categoryText=",
  "CATEGORYTEXT=",
];

const token = process.env.SHOPIFY_ADMIN_TOKEN;

if (!token) {
  throw new Error("Missing SHOPIFY_ADMIN_TOKEN");
}

const endpoint = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function gidNumber(gid) {
  return String(gid ?? "").split("/").pop();
}

function priceToHeureka(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return null;

  return n.toFixed(2);
}

function categoryTextFromTags(product) {
  const tags = product.tags ?? [];

  for (const tag of tags) {
    const value = String(tag ?? "").trim();

    for (const prefix of CATEGORYTEXT_TAG_PREFIXES) {
      if (value.startsWith(prefix)) {
        const categoryText = value.slice(prefix.length).trim();
        return categoryText || null;
      }
    }
  }

  return null;
}

function isEligibleVariant(variant) {
  const price = Number(variant.price);

  if (!Number.isFinite(price)) return false;

  // 1. Price musí být větší než 499,99 Kč
  if (price <= MIN_PRICE) return false;

  // 2. Dostupnost musí být přesně "skladem".
  //
  // inventoryQuantity > 1 = skladem
  // inventoryQuantity === 1 = poslední kus skladem, vyloučeno
  // inventoryPolicy === CONTINUE bez skladu = lze objednat, vyloučeno
  if (variant.inventoryQuantity > 1) return true;

  return false;
}

function deliveryDate(variant) {
  // Do feedu vstupují jen produkty přesně "skladem",
  // takže Heureka DELIVERY_DATE = 0.
  if (variant.inventoryQuantity > 1) return "0";

  return null;
}

function productName(product, variant) {
  const productTitle = product.title ?? "";
  const variantTitle = variant.title ?? "";

  if (!variantTitle || variantTitle === "Default Title") {
    return productTitle;
  }

  return `${productTitle} ${variantTitle}`;
}

function imageUrl(product, variant) {
  return (
    variant.image?.url ??
    product.featuredMedia?.preview?.image?.url ??
    ""
  );
}

function productUrl(product, variant) {
  const variantId = gidNumber(variant.id);
  return `${STOREFRONT_DOMAIN}/products/${product.handle}?variant=${encodeURIComponent(variantId)}`;
}

async function shopifyGraphql(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (!res.ok || json.errors) {
    console.error(JSON.stringify(json, null, 2));
    throw new Error(`Shopify GraphQL error: HTTP ${res.status}`);
  }

  return json.data;
}

const query = `
query GetVariants($cursor: String) {
  productVariants(first: 100, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        title
        sku
        barcode
        price
        inventoryQuantity
        inventoryPolicy
        image {
          url
        }
        product {
          id
          title
          handle
          vendor
          descriptionHtml
          status
          onlineStoreUrl
          tags
          featuredMedia {
            preview {
              image {
                url
              }
            }
          }
        }
      }
    }
  }
}
`;

let cursor = null;
let totalVariants = 0;
let included = 0;
let skipped = 0;
let skippedInactive = 0;
let skippedNotEligible = 0;
let skippedMissingCategoryText = 0;
let skippedMissingRequiredData = 0;

const items = [];

do {
  const data = await shopifyGraphql(query, { cursor });
  const connection = data.productVariants;

  for (const edge of connection.edges) {
    const variant = edge.node;
    const product = variant.product;
    totalVariants += 1;

    if (product.status !== "ACTIVE") {
      skipped += 1;
      skippedInactive += 1;
      continue;
    }

    if (!isEligibleVariant(variant)) {
      skipped += 1;
      skippedNotEligible += 1;
      continue;
    }

    const categoryText = categoryTextFromTags(product);

    if (!categoryText) {
      skipped += 1;
      skippedMissingCategoryText += 1;
      continue;
    }

    const price = priceToHeureka(variant.price);
    const url = productUrl(product, variant);
    const img = imageUrl(product, variant);
    const delivery = deliveryDate(variant);
    const name = productName(product, variant);
    const description = stripHtml(product.descriptionHtml);

    if (!price || !url || !name || !delivery) {
      skipped += 1;
      skippedMissingRequiredData += 1;
      continue;
    }

    const itemId = gidNumber(variant.id);
    const itemGroupId = gidNumber(product.id);

    items.push(`  <SHOPITEM>
    <ITEM_ID>${xmlEscape(itemId)}</ITEM_ID>
    <PRODUCTNAME>${xmlEscape(name)}</PRODUCTNAME>
    <PRODUCT>${xmlEscape(name)}</PRODUCT>
    <DESCRIPTION>${xmlEscape(description)}</DESCRIPTION>
    <URL>${xmlEscape(url)}</URL>${img ? `
    <IMGURL>${xmlEscape(img)}</IMGURL>` : ""}
    <PRICE_VAT>${xmlEscape(price)}</PRICE_VAT>
    <CATEGORYTEXT>${xmlEscape(categoryText)}</CATEGORYTEXT>
    <MANUFACTURER>${xmlEscape(product.vendor || "Bosch")}</MANUFACTURER>${variant.barcode ? `
    <EAN>${xmlEscape(variant.barcode)}</EAN>` : ""}
    <DELIVERY_DATE>${xmlEscape(delivery)}</DELIVERY_DATE>
    <ITEMGROUP_ID>${xmlEscape(itemGroupId)}</ITEMGROUP_ID>
  </SHOPITEM>`);

    included += 1;
  }

  cursor = connection.pageInfo.endCursor;
} while (cursor);

const generatedAt = new Date().toISOString();

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated at ${generatedAt}; total variants: ${totalVariants}; included: ${included}; skipped: ${skipped}; min price: ${MIN_PRICE}; availability: skladem only -->
<SHOP>
${items.join("\n")}
</SHOP>
`;

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(OUT_FILE, xml, "utf8");

console.log(`Generated ${OUT_FILE}`);
console.log(`Total variants: ${totalVariants}`);
console.log(`Included: ${included}`);
console.log(`Skipped: ${skipped}`);
console.log(`Skipped inactive products: ${skippedInactive}`);
console.log(`Skipped not eligible by price/availability: ${skippedNotEligible}`);
console.log(`Skipped missing CategoryText tag: ${skippedMissingCategoryText}`);
console.log(`Skipped missing required data: ${skippedMissingRequiredData}`);

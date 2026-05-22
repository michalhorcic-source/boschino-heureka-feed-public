import fs from "node:fs/promises";

const SHOP = "vvircm-fz.myshopify.com";
const STOREFRONT_DOMAIN = "https://boschino.cz";
const API_VERSION = "2026-04";

const OUT_DIR = "public";
const OUT_FILE = `${OUT_DIR}/heureka.xml`;

const MIN_PRICE = 499.99;

const CATEGORY_NAMESPACE = "heureka";
const CATEGORY_KEY = "categorytext";

const SALES_VOUCHER_NAMESPACE = "custom";
const SALES_VOUCHER_KEY = "sales_voucher";

const token = process.env.SHOPIFY_ADMIN_TOKEN;

if (!token) {
  throw new Error("Missing SHOPIFY_ADMIN_TOKEN");
}

const endpoint = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  return n.toFixed(2);
}

function hasLetter(value) {
  return /\p{L}/u.test(String(value ?? ""));
}

function titleFromHandle(handle) {
  return String(handle ?? "")
    .split("-")
    .filter((part) => !/^\d+$/.test(part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryTextFromMetafield(product) {
  const value = product.categoryText?.value;

  if (!value || !String(value).trim()) {
    return null;
  }

  return String(value).trim();
}

function salesVoucherFromMetafield(product) {
  const value = product.salesVoucher?.value;

  if (!value || !String(value).trim()) {
    return null;
  }

  return String(value).trim();
}

function isEligibleVariant(variant) {
  const price = Number(variant.price);

  if (!Number.isFinite(price)) {
    return false;
  }

  // Cena musí být větší než 499,99 Kč.
  if (price <= MIN_PRICE) {
    return false;
  }

  // Skladem nebo poslední kus skladem.
  if (variant.inventoryQuantity > 0) {
    return true;
  }

  // Lze objednat / skladem v centrálním skladu.
  if (variant.inventoryPolicy === "CONTINUE") {
    return true;
  }

  return false;
}

function deliveryDate(variant) {
  // Skladem / poslední kus skladem.
  if (variant.inventoryQuantity > 0) {
    return "0";
  }

  // Lze objednat / skladem v centrálním skladu.
  if (variant.inventoryPolicy === "CONTINUE") {
    return "7";
  }

  return null;
}

function productName(product, variant) {
  const productTitle = String(product.title ?? "").trim();
  const variantTitle = String(variant.title ?? "").trim();

  let name = productTitle;

  if (variantTitle && variantTitle !== "Default Title" && hasLetter(variantTitle)) {
    name = `${productTitle} ${variantTitle}`.trim();
  }

  if (!hasLetter(name)) {
    name = titleFromHandle(product.handle);
  }

  if (!hasLetter(name)) {
    return null;
  }

  return name;
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

async function shopifyGraphql(query, variables = {}, options = {}) {
  const maxRetries = options.maxRetries ?? 10;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    let json;

    try {
      json = await res.json();
    } catch (error) {
      if (attempt < maxRetries) {
        const waitMs = Math.min(30000, 2000 * attempt);
        console.warn(
          `Shopify response JSON parse failed. Attempt ${attempt}/${maxRetries}. Waiting ${waitMs}ms.`
        );
        await sleep(waitMs);
        continue;
      }

      throw error;
    }

    if (res.ok && !json.errors) {
      const throttle = json.extensions?.cost?.throttleStatus;

      if (throttle) {
        const currentlyAvailable = Number(throttle.currentlyAvailable ?? 0);
        const restoreRate = Number(throttle.restoreRate ?? 100);

        if (currentlyAvailable < 300) {
          const waitMs = Math.ceil(((300 - currentlyAvailable) / restoreRate) * 1000);

          if (waitMs > 0) {
            console.log(
              `Shopify throttle buffer low: ${currentlyAvailable}. Waiting ${waitMs}ms.`
            );
            await sleep(waitMs);
          }
        }
      }

      return json.data;
    }

    const isThrottled =
      Array.isArray(json.errors) &&
      json.errors.some((error) => error?.extensions?.code === "THROTTLED");

    if (isThrottled && attempt < maxRetries) {
      const cost = json.extensions?.cost;
      const requested = Number(cost?.requestedQueryCost ?? 100);
      const throttle = cost?.throttleStatus;
      const currentlyAvailable = Number(throttle?.currentlyAvailable ?? 0);
      const restoreRate = Number(throttle?.restoreRate ?? 100);

      const missing = Math.max(0, requested - currentlyAvailable);
      const waitMs = Math.max(
        1500,
        Math.ceil((missing / restoreRate) * 1000) + 1000
      );

      console.warn(
        `Shopify GraphQL throttled. Attempt ${attempt}/${maxRetries}. ` +
        `Requested=${requested}, available=${currentlyAvailable}, restoreRate=${restoreRate}. ` +
        `Waiting ${waitMs}ms.`
      );

      await sleep(waitMs);
      continue;
    }

    const isTransientHttpError = res.status === 429 || res.status >= 500;

    if (isTransientHttpError && attempt < maxRetries) {
      const waitMs = Math.min(30000, 2000 * attempt);

      console.warn(
        `Shopify HTTP ${res.status}. Attempt ${attempt}/${maxRetries}. Waiting ${waitMs}ms.`
      );

      await sleep(waitMs);
      continue;
    }

    console.error(JSON.stringify(json, null, 2));
    throw new Error(`Shopify GraphQL error: HTTP ${res.status}`);
  }

  throw new Error("Shopify GraphQL error after max retries");
}

const query = `
query GetVariants($cursor: String) {
  productVariants(first: 50, after: $cursor) {
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
          categoryText: metafield(namespace: "${CATEGORY_NAMESPACE}", key: "${CATEGORY_KEY}") {
            value
          }
          salesVoucher: metafield(namespace: "${SALES_VOUCHER_NAMESPACE}", key: "${SALES_VOUCHER_KEY}") {
            value
          }
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
let hasNextPage = true;

let totalVariants = 0;
let included = 0;
let skipped = 0;
let skippedInactive = 0;
let skippedNotEligible = 0;
let skippedMissingCategoryText = 0;
let skippedMissingRequiredData = 0;
let skippedInvalidName = 0;

const items = [];

while (hasNextPage) {
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

    const categoryText = categoryTextFromMetafield(product);

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
    const salesVoucher = salesVoucherFromMetafield(product);

    if (!name) {
      skipped += 1;
      skippedInvalidName += 1;
      continue;
    }

    if (!price || !url || !delivery) {
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
    <SPECIAL_SERVICE>${xmlEscape("Nákup s jistotou podle modelu spotřebiče. Kompletní databáze BSH - Bosch Siemens Gaggenau Constructa Neff Balay atd.")}</SPECIAL_SERVICE>${salesVoucher ? `
    ${salesVoucher}` : ""}
    <ITEMGROUP_ID>${xmlEscape(itemGroupId)}</ITEMGROUP_ID>
  </SHOPITEM>`);
    included += 1;
  }

  cursor = connection.pageInfo.endCursor;
  hasNextPage = Boolean(connection.pageInfo.hasNextPage);

  console.log(
    `Processed variants: ${totalVariants}; included: ${included}; skipped: ${skipped}; next: ${hasNextPage}`
  );
}

const generatedAt = new Date().toISOString();

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated at ${generatedAt}; total variants: ${totalVariants}; included: ${included}; skipped: ${skipped}; min price: ${MIN_PRICE}; availability: in stock or orderable; categoryText: metafield ${CATEGORY_NAMESPACE}.${CATEGORY_KEY}; salesVoucher: metafield ${SALES_VOUCHER_NAMESPACE}.${SALES_VOUCHER_KEY} -->
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
console.log(`Skipped missing CategoryText metafield: ${skippedMissingCategoryText}`);
console.log(`Skipped invalid product name: ${skippedInvalidName}`);
console.log(`Skipped missing required data: ${skippedMissingRequiredData}`);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import { z } from "zod";

// Connection from env vars
let DB_CONFIG = {
  host: process.env.WP_DB_HOST || "localhost",
  port: parseInt(process.env.WP_DB_PORT || "3306"),
  user: process.env.WP_DB_USER || "root",
  password: process.env.WP_DB_PASSWORD || "",
  database: process.env.WP_DB_NAME || "wordpress",
};

let TABLE_PREFIX = process.env.WP_TABLE_PREFIX || "wp_";

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({ ...DB_CONFIG, waitForConnections: true, connectionLimit: 5 });
  }
  return pool;
}

async function query(sql, params = []) {
  const conn = getPool();
  const [rows] = await conn.execute(sql, params);
  return rows;
}

function t(table) {
  return `${TABLE_PREFIX}${table}`;
}

const server = new McpServer({
  name: "wp-db",
  version: "2.0.0",
});

// ═══════════════════════════════════════════════
// CONNECTION & SITE INFO
// ═══════════════════════════════════════════════

server.tool(
  "test_connection",
  "Test the WordPress database connection and show site overview",
  {},
  async () => {
    try {
      await query("SELECT 1 as ok");
      const [options] = await query(
        `SELECT option_value FROM ${t("options")} WHERE option_name = 'siteurl' LIMIT 1`
      );
      const [siteName] = await query(
        `SELECT option_value FROM ${t("options")} WHERE option_name = 'blogname' LIMIT 1`
      );
      const [productCount] = await query(
        `SELECT COUNT(*) as total FROM ${t("posts")} WHERE post_type = 'product'`
      );
      const [orderCount] = await query(
        `SELECT COUNT(*) as total FROM ${t("posts")} WHERE post_type = 'shop_order'`
      );
      const [userCount] = await query(
        `SELECT COUNT(*) as total FROM ${t("users")}`
      );
      const [wcVersion] = await query(
        `SELECT option_value FROM ${t("options")} WHERE option_name = 'woocommerce_version' LIMIT 1`
      );
      return {
        content: [{
          type: "text",
          text: `Connected!\nSite: ${siteName?.option_value || "unknown"}\nURL: ${options?.option_value || "unknown"}\nWooCommerce: ${wcVersion?.option_value || "not found"}\nDatabase: ${DB_CONFIG.database} @ ${DB_CONFIG.host}:${DB_CONFIG.port}\nProducts: ${productCount?.total || 0}\nOrders: ${orderCount?.total || 0}\nUsers: ${userCount?.total || 0}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Connection failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "switch_database",
  "Switch to a different WordPress database without restarting",
  {
    database: z.string().describe("Database name"),
    host: z.string().optional().describe("Database host"),
    port: z.number().optional().describe("Database port"),
    user: z.string().optional().describe("Database user"),
    password: z.string().optional().describe("Database password"),
    table_prefix: z.string().optional().describe("Table prefix (default: wp_)"),
  },
  async ({ database, host, port, user, password, table_prefix }) => {
    try {
      if (pool) { await pool.end(); pool = null; }
      DB_CONFIG = {
        host: host || DB_CONFIG.host,
        port: port || DB_CONFIG.port,
        user: user !== undefined ? user : DB_CONFIG.user,
        password: password !== undefined ? password : DB_CONFIG.password,
        database,
      };
      if (table_prefix !== undefined) TABLE_PREFIX = table_prefix;

      const conn = getPool();
      await conn.execute("SELECT 1 as ok");
      const [options] = await query(
        `SELECT option_value FROM ${t("options")} WHERE option_name = 'siteurl' LIMIT 1`
      );
      return {
        content: [{
          type: "text",
          text: `Switched to ${DB_CONFIG.database} @ ${DB_CONFIG.host}:${DB_CONFIG.port}\nPrefix: ${TABLE_PREFIX}\nSite URL: ${options?.option_value || "unknown"}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Switch failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "get_site_info",
  "Get WordPress site settings — name, URL, email, timezone, WooCommerce config, currency, etc.",
  {
    keys: z.array(z.string()).optional().describe("Specific option names to fetch (default: common WP + WC options)"),
  },
  async ({ keys }) => {
    const defaultKeys = [
      "blogname", "blogdescription", "siteurl", "home", "admin_email",
      "timezone_string", "date_format", "WPLANG",
      "woocommerce_version", "woocommerce_currency", "woocommerce_price_thousand_sep",
      "woocommerce_price_decimal_sep", "woocommerce_price_num_decimals",
      "woocommerce_default_country", "woocommerce_store_address",
      "woocommerce_weight_unit", "woocommerce_dimension_unit",
      "woocommerce_calc_taxes", "woocommerce_tax_display_shop",
    ];
    const lookupKeys = keys && keys.length > 0 ? keys : defaultKeys;
    const placeholders = lookupKeys.map(() => "?").join(",");
    const rows = await query(
      `SELECT option_name, option_value FROM ${t("options")} WHERE option_name IN (${placeholders})`,
      lookupKeys
    );
    const text = rows.map((r) => `${r.option_name}: ${r.option_value}`).join("\n");
    return { content: [{ type: "text", text: text || "No options found" }] };
  }
);

// ═══════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════

server.tool(
  "list_products",
  "List WooCommerce products. Ask things like 'show me all draft products', 'list products in category shoes', 'find products with laptop in the name'",
  {
    status: z.string().optional().describe("Post status: publish, draft, trash, any (default: publish)"),
    category: z.string().optional().describe("Category slug to filter by"),
    search: z.string().optional().describe("Search term for product title"),
    stock_status: z.string().optional().describe("Stock status: instock, outofstock, onbackorder"),
    product_type: z.string().optional().describe("Product type: simple, variable, grouped, external"),
    orderby: z.string().optional().describe("Order by: date, title, price, id (default: date)"),
    order: z.string().optional().describe("Sort direction: ASC or DESC (default: DESC)"),
    limit: z.number().optional().describe("Max results (default 25)"),
  },
  async ({ status, category, search, stock_status, product_type, orderby, order, limit }) => {
    const max = limit || 25;
    const postStatus = status || "publish";

    let sql = `
      SELECT p.ID, p.post_title, p.post_status, p.post_date,
        MAX(CASE WHEN pm.meta_key = '_price' THEN pm.meta_value END) as price,
        MAX(CASE WHEN pm.meta_key = '_regular_price' THEN pm.meta_value END) as regular_price,
        MAX(CASE WHEN pm.meta_key = '_sale_price' THEN pm.meta_value END) as sale_price,
        MAX(CASE WHEN pm.meta_key = '_sku' THEN pm.meta_value END) as sku,
        MAX(CASE WHEN pm.meta_key = '_stock_status' THEN pm.meta_value END) as stock_status,
        MAX(CASE WHEN pm.meta_key = '_stock' THEN pm.meta_value END) as stock_qty,
        MAX(CASE WHEN pm.meta_key = '_product_type' THEN pm.meta_value END) as product_type
      FROM ${t("posts")} p
      LEFT JOIN ${t("postmeta")} pm ON p.ID = pm.post_id
    `;
    const params = [];

    if (category) {
      sql += `
        JOIN ${t("term_relationships")} tr ON p.ID = tr.object_id
        JOIN ${t("term_taxonomy")} tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
        JOIN ${t("terms")} te ON tt.term_id = te.term_id
      `;
    }

    sql += ` WHERE p.post_type = 'product'`;

    if (postStatus !== "any") {
      sql += ` AND p.post_status = ?`;
      params.push(postStatus);
    }

    if (category) {
      sql += ` AND tt.taxonomy = 'product_cat' AND te.slug = ?`;
      params.push(category);
    }

    if (search) {
      sql += ` AND p.post_title LIKE ?`;
      params.push(`%${search}%`);
    }

    sql += ` GROUP BY p.ID`;

    if (stock_status) {
      sql += ` HAVING stock_status = ?`;
      params.push(stock_status);
    }

    if (product_type) {
      sql += stock_status ? ` AND product_type = ?` : ` HAVING product_type = ?`;
      params.push(product_type);
    }

    // Order
    const orderMap = { date: "p.post_date", title: "p.post_title", price: "price", id: "p.ID" };
    const orderCol = orderMap[orderby] || "p.post_date";
    const orderDir = order === "ASC" ? "ASC" : "DESC";
    sql += ` ORDER BY ${orderCol} ${orderDir} LIMIT ?`;
    params.push(max);

    const rows = await query(sql, params);
    const text = rows
      .map((r) => {
        let line = `[${r.ID}] ${r.post_title}`;
        line += ` | SKU: ${r.sku || "—"}`;
        line += ` | Price: ${r.price || "—"}`;
        if (r.sale_price) line += ` (sale: ${r.sale_price})`;
        line += ` | Stock: ${r.stock_status || "—"}`;
        if (r.stock_qty !== null) line += ` (${r.stock_qty})`;
        line += ` | Type: ${r.product_type || "simple"}`;
        line += ` | Status: ${r.post_status}`;
        return line;
      })
      .join("\n");

    return { content: [{ type: "text", text: `Found ${rows.length} product(s):\n\n${text}` || "No products found" }] };
  }
);

server.tool(
  "get_product",
  "Get full details about a single product by ID or SKU — meta, categories, tags, stock, pricing, everything",
  {
    product_id: z.number().optional().describe("Product ID"),
    sku: z.string().optional().describe("Product SKU"),
  },
  async ({ product_id, sku }) => {
    let pid = product_id;

    if (!pid && sku) {
      const rows = await query(
        `SELECT post_id FROM ${t("postmeta")} WHERE meta_key = '_sku' AND meta_value = ? LIMIT 1`,
        [sku]
      );
      if (rows.length === 0) return { content: [{ type: "text", text: `No product found with SKU: ${sku}` }] };
      pid = rows[0].post_id;
    }
    if (!pid) return { content: [{ type: "text", text: "Provide either product_id or sku" }] };

    // Product post data
    const [product] = await query(
      `SELECT ID, post_title, post_status, post_date, post_modified, post_excerpt, post_content
       FROM ${t("posts")} WHERE ID = ?`, [pid]
    );
    if (!product) return { content: [{ type: "text", text: `Product #${pid} not found` }] };

    // Key meta
    const meta = await query(
      `SELECT meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = ? ORDER BY meta_key`, [pid]
    );
    const metaMap = {};
    meta.forEach((m) => { metaMap[m.meta_key] = m.meta_value; });

    // Terms (categories, tags, attributes)
    const terms = await query(
      `SELECT t.name, t.slug, tt.taxonomy
       FROM ${t("term_relationships")} tr
       JOIN ${t("term_taxonomy")} tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
       JOIN ${t("terms")} t ON tt.term_id = t.term_id
       WHERE tr.object_id = ? ORDER BY tt.taxonomy, t.name`, [pid]
    );

    // Variations count
    const [varCount] = await query(
      `SELECT COUNT(*) as total FROM ${t("posts")} WHERE post_parent = ? AND post_type = 'product_variation'`, [pid]
    );

    // Build output
    let text = `Product: ${product.post_title}\n`;
    text += `${"─".repeat(60)}\n`;
    text += `ID: ${pid} | Status: ${product.post_status} | Created: ${product.post_date}\n`;
    text += `SKU: ${metaMap._sku || "—"} | Type: ${metaMap._product_type || "simple"}\n`;
    text += `Price: ${metaMap._price || "—"} | Regular: ${metaMap._regular_price || "—"} | Sale: ${metaMap._sale_price || "—"}\n`;
    text += `Stock: ${metaMap._stock_status || "—"} | Qty: ${metaMap._stock || "—"} | Manage stock: ${metaMap._manage_stock || "no"}\n`;
    text += `Weight: ${metaMap._weight || "—"} | Dimensions: ${metaMap._length || "—"}×${metaMap._width || "—"}×${metaMap._height || "—"}\n`;
    text += `Tax status: ${metaMap._tax_status || "—"} | Tax class: ${metaMap._tax_class || "—"}\n`;
    text += `Variations: ${varCount?.total || 0}\n`;

    if (product.post_excerpt) text += `\nShort description: ${product.post_excerpt.substring(0, 200)}\n`;

    // Categories & tags
    const cats = terms.filter((te) => te.taxonomy === "product_cat").map((te) => te.name);
    const tags = terms.filter((te) => te.taxonomy === "product_tag").map((te) => te.name);
    const attrs = terms.filter((te) => te.taxonomy.startsWith("pa_")).map((te) => `${te.taxonomy.replace("pa_", "")}: ${te.name}`);

    if (cats.length) text += `\nCategories: ${cats.join(", ")}`;
    if (tags.length) text += `\nTags: ${tags.join(", ")}`;
    if (attrs.length) text += `\nAttributes: ${attrs.join(", ")}`;

    // All other meta
    const skipMeta = ["_price", "_regular_price", "_sale_price", "_sku", "_stock_status", "_stock",
      "_manage_stock", "_product_type", "_weight", "_length", "_width", "_height",
      "_tax_status", "_tax_class", "_edit_lock", "_edit_last", "_wp_old_date"];
    const otherMeta = meta.filter((m) => !skipMeta.includes(m.meta_key) && m.meta_value);
    if (otherMeta.length) {
      text += `\n\nAll meta (${otherMeta.length} fields):\n`;
      text += otherMeta.map((m) => `  ${m.meta_key}: ${String(m.meta_value).substring(0, 200)}`).join("\n");
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "get_product_variations",
  "Get all variations of a variable product with attributes, pricing, and stock",
  {
    product_id: z.number().describe("Parent product ID"),
  },
  async ({ product_id }) => {
    const variations = await query(
      `SELECT p.ID, p.post_title, p.post_status, p.menu_order FROM ${t("posts")} p
       WHERE p.post_parent = ? AND p.post_type = 'product_variation'
       ORDER BY p.menu_order, p.ID`, [product_id]
    );

    if (variations.length === 0) {
      return { content: [{ type: "text", text: `No variations found for product ${product_id}` }] };
    }

    const results = [];
    for (const v of variations) {
      const meta = await query(
        `SELECT meta_key, meta_value FROM ${t("postmeta")}
         WHERE post_id = ? AND (meta_key LIKE 'attribute_%' OR meta_key IN ('_price', '_regular_price', '_sale_price', '_sku', '_stock_status', '_stock'))
         ORDER BY meta_key`, [v.ID]
      );
      const attrs = meta.filter((m) => m.meta_key.startsWith("attribute_")).map((m) => `${m.meta_key.replace("attribute_", "")}: ${m.meta_value || "Any"}`);
      const pricing = meta.filter((m) => !m.meta_key.startsWith("attribute_"));

      let line = `#${v.ID} (${v.post_status})`;
      if (attrs.length) line += ` | ${attrs.join(", ")}`;
      pricing.forEach((m) => { line += ` | ${m.meta_key.replace("_", "")}: ${m.meta_value}`; });
      results.push(line);
    }

    return { content: [{ type: "text", text: `${variations.length} variation(s) for product #${product_id}:\n\n${results.join("\n")}` }] };
  }
);

// ═══════════════════════════════════════════════
// META SEARCH & ANALYSIS
// ═══════════════════════════════════════════════

server.tool(
  "get_product_meta",
  "Get all meta fields for a product, or check if a specific meta key exists",
  {
    product_id: z.number().optional().describe("Product ID"),
    sku: z.string().optional().describe("Product SKU"),
    meta_key: z.string().optional().describe("Filter by specific meta key"),
  },
  async ({ product_id, sku, meta_key }) => {
    let pid = product_id;
    if (!pid && sku) {
      const rows = await query(
        `SELECT post_id FROM ${t("postmeta")} WHERE meta_key = '_sku' AND meta_value = ? LIMIT 1`, [sku]
      );
      if (rows.length === 0) return { content: [{ type: "text", text: `No product found with SKU: ${sku}` }] };
      pid = rows[0].post_id;
    }
    if (!pid) return { content: [{ type: "text", text: "Provide either product_id or sku" }] };

    let sql = `SELECT meta_id, meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = ?`;
    const params = [pid];
    if (meta_key) { sql += ` AND meta_key = ?`; params.push(meta_key); }
    sql += ` ORDER BY meta_key`;
    const rows = await query(sql, params);

    const [product] = await query(
      `SELECT post_title, post_status FROM ${t("posts")} WHERE ID = ?`, [pid]
    );

    const header = product
      ? `Product: ${product.post_title} (ID: ${pid}, Status: ${product.post_status})\n${"─".repeat(60)}\n`
      : `Product ID: ${pid}\n${"─".repeat(60)}\n`;

    if (meta_key && rows.length === 0) {
      return { content: [{ type: "text", text: `${header}Meta key "${meta_key}" does NOT exist for this product.` }] };
    }

    const text = header + `${rows.length} meta field(s):\n` + rows.map((r) => `${r.meta_key}: ${r.meta_value}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "search_product_meta",
  "Search across products for a specific meta key or value. Great for 'how many products have _sale_price', 'find all products with meta key X'",
  {
    meta_key: z.string().optional().describe("Meta key to search for (supports % wildcards)"),
    meta_value: z.string().optional().describe("Meta value to search for (supports % wildcards)"),
    count_only: z.boolean().optional().describe("Just return the count instead of listing products (default: false)"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ meta_key, meta_value, count_only, limit }) => {
    if (!meta_key && !meta_value) {
      return { content: [{ type: "text", text: "Provide at least meta_key or meta_value to search for" }] };
    }

    if (count_only) {
      let sql = `
        SELECT COUNT(DISTINCT pm.post_id) as product_count, COUNT(*) as meta_count
        FROM ${t("postmeta")} pm
        JOIN ${t("posts")} p ON p.ID = pm.post_id
        WHERE p.post_type IN ('product', 'product_variation')
      `;
      const params = [];
      if (meta_key) { sql += ` AND pm.meta_key LIKE ?`; params.push(meta_key); }
      if (meta_value) { sql += ` AND pm.meta_value LIKE ?`; params.push(meta_value); }

      const [row] = await query(sql, params);
      let desc = "";
      if (meta_key) desc += `meta_key matching "${meta_key}"`;
      if (meta_value) desc += `${meta_key ? " and " : ""}meta_value matching "${meta_value}"`;
      return { content: [{ type: "text", text: `${row.product_count} product(s) have ${desc} (${row.meta_count} total meta entries)` }] };
    }

    const max = limit || 50;
    let sql = `
      SELECT p.ID, p.post_title, pm.meta_key, pm.meta_value
      FROM ${t("postmeta")} pm
      JOIN ${t("posts")} p ON p.ID = pm.post_id
      WHERE p.post_type IN ('product', 'product_variation')
    `;
    const params = [];
    if (meta_key) { sql += ` AND pm.meta_key LIKE ?`; params.push(meta_key); }
    if (meta_value) { sql += ` AND pm.meta_value LIKE ?`; params.push(meta_value); }
    sql += ` ORDER BY p.ID DESC LIMIT ?`;
    params.push(max);

    const rows = await query(sql, params);
    const text = rows.map((r) => `[${r.ID}] ${r.post_title} → ${r.meta_key}: ${r.meta_value}`).join("\n");
    return { content: [{ type: "text", text: `Found ${rows.length} result(s):\n\n${text}` || "No results found" }] };
  }
);

server.tool(
  "get_product_terms",
  "Get categories, tags, and attributes for a product",
  {
    product_id: z.number().describe("Product ID"),
    taxonomy: z.string().optional().describe("Filter: product_cat, product_tag, pa_* (default: all)"),
  },
  async ({ product_id, taxonomy }) => {
    let sql = `
      SELECT t.name, t.slug, tt.taxonomy, tt.count
      FROM ${t("term_relationships")} tr
      JOIN ${t("term_taxonomy")} tt ON tr.term_taxonomy_id = tt.term_taxonomy_id
      JOIN ${t("terms")} t ON tt.term_id = t.term_id
      WHERE tr.object_id = ?
    `;
    const params = [product_id];
    if (taxonomy) { sql += ` AND tt.taxonomy = ?`; params.push(taxonomy); }
    sql += ` ORDER BY tt.taxonomy, t.name`;
    const rows = await query(sql, params);
    const text = rows.map((r) => `[${r.taxonomy}] ${r.name} (${r.slug}) — ${r.count} products`).join("\n");
    return { content: [{ type: "text", text: text || "No terms found" }] };
  }
);

// ═══════════════════════════════════════════════
// CATEGORIES & TAXONOMIES
// ═══════════════════════════════════════════════

server.tool(
  "list_categories",
  "List all product categories with product counts. Ask 'what categories exist', 'show me category tree'",
  {
    parent: z.number().optional().describe("Parent term ID to list children of (0 for top-level only)"),
    hide_empty: z.boolean().optional().describe("Hide categories with no products (default: false)"),
  },
  async ({ parent, hide_empty }) => {
    let sql = `
      SELECT t.term_id, t.name, t.slug, tt.count, tt.parent,
        (SELECT t2.name FROM ${t("terms")} t2 JOIN ${t("term_taxonomy")} tt2 ON t2.term_id = tt2.term_id WHERE tt2.term_id = tt.parent LIMIT 1) as parent_name
      FROM ${t("terms")} t
      JOIN ${t("term_taxonomy")} tt ON t.term_id = tt.term_id
      WHERE tt.taxonomy = 'product_cat'
    `;
    const params = [];

    if (parent !== undefined) {
      sql += ` AND tt.parent = ?`;
      params.push(parent);
    }
    if (hide_empty) {
      sql += ` AND tt.count > 0`;
    }
    sql += ` ORDER BY t.name`;

    const rows = await query(sql, params);
    const text = rows
      .map((r) => {
        let line = `[${r.term_id}] ${r.name} (${r.slug}) — ${r.count} products`;
        if (r.parent_name) line += ` | parent: ${r.parent_name}`;
        return line;
      })
      .join("\n");
    return { content: [{ type: "text", text: `${rows.length} categories:\n\n${text}` || "No categories found" }] };
  }
);

server.tool(
  "list_attributes",
  "List all product attributes (pa_color, pa_size, etc.) and their terms/values",
  {
    attribute: z.string().optional().describe("Specific attribute taxonomy (e.g., pa_color). If omitted, lists all attributes."),
  },
  async ({ attribute }) => {
    if (attribute) {
      const rows = await query(
        `SELECT t.term_id, t.name, t.slug, tt.count
         FROM ${t("terms")} t
         JOIN ${t("term_taxonomy")} tt ON t.term_id = tt.term_id
         WHERE tt.taxonomy = ?
         ORDER BY t.name`, [attribute]
      );
      const text = rows.map((r) => `  ${r.name} (${r.slug}) — ${r.count} products`).join("\n");
      return { content: [{ type: "text", text: `${attribute} — ${rows.length} values:\n${text}` }] };
    }

    // List all attribute taxonomies
    const rows = await query(
      `SELECT tt.taxonomy, COUNT(*) as term_count, SUM(tt.count) as usage_count
       FROM ${t("term_taxonomy")} tt
       WHERE tt.taxonomy LIKE 'pa_%'
       GROUP BY tt.taxonomy
       ORDER BY tt.taxonomy`
    );
    const text = rows.map((r) => `${r.taxonomy.replace("pa_", "")} (${r.taxonomy}) — ${r.term_count} values, used ${r.usage_count} times`).join("\n");
    return { content: [{ type: "text", text: `${rows.length} product attribute(s):\n\n${text}` }] };
  }
);

// ═══════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════

server.tool(
  "list_orders",
  "List WooCommerce orders. Ask 'show recent orders', 'orders from last week', 'orders with status processing'",
  {
    status: z.string().optional().describe("Order status: wc-processing, wc-completed, wc-on-hold, wc-pending, any (default: any)"),
    customer_email: z.string().optional().describe("Filter by customer email"),
    date_from: z.string().optional().describe("Orders from this date (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Orders until this date (YYYY-MM-DD)"),
    search: z.string().optional().describe("Search in order meta (email, name, etc.)"),
    limit: z.number().optional().describe("Max results (default 25)"),
  },
  async ({ status, customer_email, date_from, date_to, search, limit }) => {
    const max = limit || 25;

    let sql = `
      SELECT p.ID, p.post_status, p.post_date,
        MAX(CASE WHEN pm.meta_key = '_order_total' THEN pm.meta_value END) as total,
        MAX(CASE WHEN pm.meta_key = '_order_currency' THEN pm.meta_value END) as currency,
        MAX(CASE WHEN pm.meta_key = '_billing_email' THEN pm.meta_value END) as email,
        MAX(CASE WHEN pm.meta_key = '_billing_first_name' THEN pm.meta_value END) as first_name,
        MAX(CASE WHEN pm.meta_key = '_billing_last_name' THEN pm.meta_value END) as last_name,
        MAX(CASE WHEN pm.meta_key = '_payment_method_title' THEN pm.meta_value END) as payment
      FROM ${t("posts")} p
      LEFT JOIN ${t("postmeta")} pm ON p.ID = pm.post_id
      WHERE p.post_type = 'shop_order'
    `;
    const params = [];

    if (status && status !== "any") {
      sql += ` AND p.post_status = ?`;
      params.push(status.startsWith("wc-") ? status : `wc-${status}`);
    }
    if (date_from) { sql += ` AND p.post_date >= ?`; params.push(date_from); }
    if (date_to) { sql += ` AND p.post_date <= ?`; params.push(`${date_to} 23:59:59`); }

    sql += ` GROUP BY p.ID`;

    if (customer_email) {
      sql += ` HAVING email = ?`;
      params.push(customer_email);
    }
    if (search) {
      sql += customer_email ? ` AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)` : ` HAVING (email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY p.post_date DESC LIMIT ?`;
    params.push(max);

    const rows = await query(sql, params);
    const text = rows
      .map((r) => `#${r.ID} | ${r.post_status.replace("wc-", "")} | ${r.post_date} | ${r.first_name || ""} ${r.last_name || ""} (${r.email || "—"}) | ${r.currency || ""}${r.total || "0"} | ${r.payment || "—"}`)
      .join("\n");
    return { content: [{ type: "text", text: `${rows.length} order(s):\n\n${text}` || "No orders found" }] };
  }
);

server.tool(
  "get_order",
  "Get full details about a specific order — items, totals, customer info, shipping, meta",
  {
    order_id: z.number().describe("Order ID"),
  },
  async ({ order_id }) => {
    const [order] = await query(
      `SELECT ID, post_status, post_date, post_modified FROM ${t("posts")} WHERE ID = ? AND post_type = 'shop_order'`, [order_id]
    );
    if (!order) return { content: [{ type: "text", text: `Order #${order_id} not found` }] };

    // Order meta
    const meta = await query(
      `SELECT meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = ? ORDER BY meta_key`, [order_id]
    );
    const m = {};
    meta.forEach((r) => { m[r.meta_key] = r.meta_value; });

    // Order items
    const items = await query(
      `SELECT oi.order_item_id, oi.order_item_name, oi.order_item_type,
        MAX(CASE WHEN oim.meta_key = '_qty' THEN oim.meta_value END) as qty,
        MAX(CASE WHEN oim.meta_key = '_line_total' THEN oim.meta_value END) as line_total,
        MAX(CASE WHEN oim.meta_key = '_product_id' THEN oim.meta_value END) as product_id,
        MAX(CASE WHEN oim.meta_key = '_variation_id' THEN oim.meta_value END) as variation_id
       FROM ${t("woocommerce_order_items")} oi
       LEFT JOIN ${t("woocommerce_order_itemmeta")} oim ON oi.order_item_id = oim.order_item_id
       WHERE oi.order_id = ?
       GROUP BY oi.order_item_id
       ORDER BY oi.order_item_type, oi.order_item_id`, [order_id]
    );

    let text = `Order #${order_id}\n${"─".repeat(60)}\n`;
    text += `Status: ${order.post_status.replace("wc-", "")} | Date: ${order.post_date}\n`;
    text += `Customer: ${m._billing_first_name || ""} ${m._billing_last_name || ""} (${m._billing_email || "—"})\n`;
    text += `Phone: ${m._billing_phone || "—"}\n`;
    text += `\nBilling: ${m._billing_address_1 || ""} ${m._billing_address_2 || ""}, ${m._billing_city || ""} ${m._billing_state || ""} ${m._billing_postcode || ""} ${m._billing_country || ""}\n`;
    text += `Shipping: ${m._shipping_address_1 || ""} ${m._shipping_address_2 || ""}, ${m._shipping_city || ""} ${m._shipping_state || ""} ${m._shipping_postcode || ""} ${m._shipping_country || ""}\n`;
    text += `\nPayment: ${m._payment_method_title || "—"} (${m._payment_method || "—"})\n`;
    text += `Subtotal: ${m._order_total || "0"} ${m._order_currency || ""}\n`;
    text += `Shipping total: ${m._order_shipping || "0"}\n`;
    text += `Tax: ${m._order_tax || "0"}\n`;
    text += `Discount: ${m._cart_discount || "0"}\n`;
    text += `Total: ${m._order_total || "0"} ${m._order_currency || ""}\n`;

    // Line items
    const lineItems = items.filter((i) => i.order_item_type === "line_item");
    if (lineItems.length) {
      text += `\nItems (${lineItems.length}):\n`;
      lineItems.forEach((i) => {
        text += `  ${i.order_item_name} × ${i.qty || 1} = ${i.line_total || "0"}`;
        if (i.variation_id && i.variation_id !== "0") text += ` (variation #${i.variation_id})`;
        text += ` [product #${i.product_id}]\n`;
      });
    }

    // Shipping lines
    const shipping = items.filter((i) => i.order_item_type === "shipping");
    if (shipping.length) {
      text += `\nShipping method(s): ${shipping.map((s) => s.order_item_name).join(", ")}\n`;
    }

    // Coupons
    const coupons = items.filter((i) => i.order_item_type === "coupon");
    if (coupons.length) {
      text += `Coupons: ${coupons.map((c) => c.order_item_name).join(", ")}\n`;
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "get_order_meta",
  "Get raw meta fields for a WooCommerce order",
  {
    order_id: z.number().describe("Order ID"),
    meta_key: z.string().optional().describe("Filter by specific meta key"),
  },
  async ({ order_id, meta_key }) => {
    let sql = `SELECT meta_key, meta_value FROM ${t("postmeta")} WHERE post_id = ?`;
    const params = [order_id];
    if (meta_key) { sql += ` AND meta_key = ?`; params.push(meta_key); }
    sql += ` ORDER BY meta_key`;
    const rows = await query(sql, params);

    const [order] = await query(
      `SELECT post_status, post_date FROM ${t("posts")} WHERE ID = ? AND post_type = 'shop_order'`, [order_id]
    );
    if (!order) return { content: [{ type: "text", text: `Order #${order_id} not found` }] };

    const header = `Order #${order_id} (${order.post_status}) — ${order.post_date}\n${"─".repeat(60)}\n`;
    const text = header + rows.map((r) => `${r.meta_key}: ${r.meta_value}`).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ═══════════════════════════════════════════════
// CUSTOMERS / USERS
// ═══════════════════════════════════════════════

server.tool(
  "list_customers",
  "List WordPress users/customers. Ask 'show me all customers', 'find user by email'",
  {
    role: z.string().optional().describe("User role: customer, administrator, subscriber, etc. (default: all)"),
    search: z.string().optional().describe("Search by name, email, or username"),
    limit: z.number().optional().describe("Max results (default 25)"),
  },
  async ({ role, search, limit }) => {
    const max = limit || 25;

    let sql = `
      SELECT u.ID, u.user_login, u.user_email, u.user_registered, u.display_name,
        MAX(CASE WHEN um.meta_key = 'first_name' THEN um.meta_value END) as first_name,
        MAX(CASE WHEN um.meta_key = 'last_name' THEN um.meta_value END) as last_name,
        MAX(CASE WHEN um.meta_key = '${TABLE_PREFIX}capabilities' THEN um.meta_value END) as roles
      FROM ${t("users")} u
      LEFT JOIN ${t("usermeta")} um ON u.ID = um.user_id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      sql += ` AND (u.user_email LIKE ? OR u.user_login LIKE ? OR u.display_name LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` GROUP BY u.ID`;

    if (role) {
      sql += ` HAVING roles LIKE ?`;
      params.push(`%"${role}"%`);
    }

    sql += ` ORDER BY u.user_registered DESC LIMIT ?`;
    params.push(max);

    const rows = await query(sql, params);
    const text = rows
      .map((r) => {
        const roles = r.roles ? Object.keys(JSON.parse(r.roles) || {}).join(", ") : "—";
        return `[${r.ID}] ${r.first_name || ""} ${r.last_name || ""} (${r.user_email}) | ${roles} | joined: ${r.user_registered}`;
      })
      .join("\n");
    return { content: [{ type: "text", text: `${rows.length} user(s):\n\n${text}` || "No users found" }] };
  }
);

server.tool(
  "get_customer",
  "Get full details about a customer — profile, orders, total spend",
  {
    user_id: z.number().optional().describe("User ID"),
    email: z.string().optional().describe("User email"),
  },
  async ({ user_id, email }) => {
    let uid = user_id;
    if (!uid && email) {
      const [user] = await query(`SELECT ID FROM ${t("users")} WHERE user_email = ? LIMIT 1`, [email]);
      if (!user) return { content: [{ type: "text", text: `No user found with email: ${email}` }] };
      uid = user.ID;
    }
    if (!uid) return { content: [{ type: "text", text: "Provide either user_id or email" }] };

    const [user] = await query(
      `SELECT ID, user_login, user_email, user_registered, display_name FROM ${t("users")} WHERE ID = ?`, [uid]
    );
    if (!user) return { content: [{ type: "text", text: `User #${uid} not found` }] };

    const meta = await query(`SELECT meta_key, meta_value FROM ${t("usermeta")} WHERE user_id = ? ORDER BY meta_key`, [uid]);
    const m = {};
    meta.forEach((r) => { m[r.meta_key] = r.meta_value; });

    // Order summary
    const [orderStats] = await query(
      `SELECT COUNT(*) as order_count, COALESCE(SUM(pm.meta_value), 0) as total_spend
       FROM ${t("posts")} p
       JOIN ${t("postmeta")} pm ON p.ID = pm.post_id AND pm.meta_key = '_order_total'
       JOIN ${t("postmeta")} pm2 ON p.ID = pm2.post_id AND pm2.meta_key = '_customer_user' AND pm2.meta_value = ?
       WHERE p.post_type = 'shop_order' AND p.post_status IN ('wc-completed', 'wc-processing')`, [uid]
    );

    let text = `Customer: ${m.first_name || ""} ${m.last_name || ""}\n${"─".repeat(60)}\n`;
    text += `ID: ${uid} | Email: ${user.user_email} | Username: ${user.user_login}\n`;
    text += `Registered: ${user.user_registered}\n`;
    text += `Phone: ${m.billing_phone || "—"}\n`;
    text += `\nBilling: ${m.billing_address_1 || ""} ${m.billing_address_2 || ""}, ${m.billing_city || ""} ${m.billing_state || ""} ${m.billing_postcode || ""} ${m.billing_country || ""}\n`;
    text += `Shipping: ${m.shipping_address_1 || ""} ${m.shipping_address_2 || ""}, ${m.shipping_city || ""} ${m.shipping_state || ""} ${m.shipping_postcode || ""} ${m.shipping_country || ""}\n`;
    text += `\nOrders: ${orderStats?.order_count || 0} | Total spend: ${orderStats?.total_spend || 0}\n`;

    const roles = m[`${TABLE_PREFIX}capabilities`] ? Object.keys(JSON.parse(m[`${TABLE_PREFIX}capabilities`]) || {}).join(", ") : "—";
    text += `Roles: ${roles}\n`;

    return { content: [{ type: "text", text }] };
  }
);

// ═══════════════════════════════════════════════
// COUNTS & SUMMARIES
// ═══════════════════════════════════════════════

server.tool(
  "count_products",
  "Count products by various criteria. Ask 'how many products are out of stock', 'count products per category', 'how many variable products'",
  {
    group_by: z.string().optional().describe("Group by: status, stock_status, product_type, category (default: status)"),
  },
  async ({ group_by }) => {
    const mode = group_by || "status";

    if (mode === "status") {
      const rows = await query(
        `SELECT post_status, COUNT(*) as count FROM ${t("posts")} WHERE post_type = 'product' GROUP BY post_status ORDER BY count DESC`
      );
      const total = rows.reduce((sum, r) => sum + r.count, 0);
      const text = rows.map((r) => `  ${r.post_status}: ${r.count}`).join("\n");
      return { content: [{ type: "text", text: `Total products: ${total}\n\n${text}` }] };
    }

    if (mode === "stock_status") {
      const rows = await query(
        `SELECT pm.meta_value as stock_status, COUNT(DISTINCT pm.post_id) as count
         FROM ${t("postmeta")} pm
         JOIN ${t("posts")} p ON p.ID = pm.post_id
         WHERE p.post_type = 'product' AND pm.meta_key = '_stock_status'
         GROUP BY pm.meta_value ORDER BY count DESC`
      );
      const text = rows.map((r) => `  ${r.stock_status}: ${r.count}`).join("\n");
      return { content: [{ type: "text", text: `Products by stock status:\n\n${text}` }] };
    }

    if (mode === "product_type") {
      const rows = await query(
        `SELECT tt.taxonomy, te.name, tt.count
         FROM ${t("term_taxonomy")} tt
         JOIN ${t("terms")} te ON tt.term_id = te.term_id
         WHERE tt.taxonomy = 'product_type'
         ORDER BY tt.count DESC`
      );
      const text = rows.map((r) => `  ${r.name}: ${r.count}`).join("\n");
      return { content: [{ type: "text", text: `Products by type:\n\n${text}` }] };
    }

    if (mode === "category") {
      const rows = await query(
        `SELECT te.name, te.slug, tt.count
         FROM ${t("term_taxonomy")} tt
         JOIN ${t("terms")} te ON tt.term_id = te.term_id
         WHERE tt.taxonomy = 'product_cat'
         ORDER BY tt.count DESC`
      );
      const text = rows.map((r) => `  ${r.name} (${r.slug}): ${r.count}`).join("\n");
      return { content: [{ type: "text", text: `Products by category:\n\n${text}` }] };
    }

    return { content: [{ type: "text", text: `Unknown group_by: ${mode}. Use: status, stock_status, product_type, category` }] };
  }
);

server.tool(
  "sales_summary",
  "Get a sales summary — revenue, order count, average order value. Ask 'what were sales this month', 'revenue last week'",
  {
    date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    status: z.string().optional().describe("Order status to include (default: completed + processing)"),
  },
  async ({ date_from, date_to, status }) => {
    const statuses = status
      ? [status.startsWith("wc-") ? status : `wc-${status}`]
      : ["wc-completed", "wc-processing"];
    const statusPlaceholders = statuses.map(() => "?").join(",");

    let sql = `
      SELECT
        COUNT(DISTINCT p.ID) as order_count,
        COALESCE(SUM(CAST(pm_total.meta_value AS DECIMAL(10,2))), 0) as revenue,
        COALESCE(AVG(CAST(pm_total.meta_value AS DECIMAL(10,2))), 0) as avg_order,
        MIN(p.post_date) as first_order,
        MAX(p.post_date) as last_order
      FROM ${t("posts")} p
      JOIN ${t("postmeta")} pm_total ON p.ID = pm_total.post_id AND pm_total.meta_key = '_order_total'
      WHERE p.post_type = 'shop_order' AND p.post_status IN (${statusPlaceholders})
    `;
    const params = [...statuses];

    if (date_from) { sql += ` AND p.post_date >= ?`; params.push(date_from); }
    if (date_to) { sql += ` AND p.post_date <= ?`; params.push(`${date_to} 23:59:59`); }

    const [stats] = await query(sql, params);

    // Top products in period
    let topSql = `
      SELECT oim_pid.meta_value as product_id,
        oi.order_item_name,
        SUM(CAST(oim_qty.meta_value AS UNSIGNED)) as total_qty,
        SUM(CAST(oim_total.meta_value AS DECIMAL(10,2))) as total_revenue
      FROM ${t("woocommerce_order_items")} oi
      JOIN ${t("posts")} p ON oi.order_id = p.ID
      LEFT JOIN ${t("woocommerce_order_itemmeta")} oim_pid ON oi.order_item_id = oim_pid.order_item_id AND oim_pid.meta_key = '_product_id'
      LEFT JOIN ${t("woocommerce_order_itemmeta")} oim_qty ON oi.order_item_id = oim_qty.order_item_id AND oim_qty.meta_key = '_qty'
      LEFT JOIN ${t("woocommerce_order_itemmeta")} oim_total ON oi.order_item_id = oim_total.order_item_id AND oim_total.meta_key = '_line_total'
      WHERE oi.order_item_type = 'line_item' AND p.post_status IN (${statusPlaceholders})
    `;
    const topParams = [...statuses];
    if (date_from) { topSql += ` AND p.post_date >= ?`; topParams.push(date_from); }
    if (date_to) { topSql += ` AND p.post_date <= ?`; topParams.push(`${date_to} 23:59:59`); }
    topSql += ` GROUP BY oim_pid.meta_value, oi.order_item_name ORDER BY total_qty DESC LIMIT 10`;

    const topProducts = await query(topSql, topParams);

    let text = `Sales Summary\n${"═".repeat(40)}\n`;
    if (date_from || date_to) text += `Period: ${date_from || "start"} to ${date_to || "now"}\n`;
    text += `Orders: ${stats.order_count}\n`;
    text += `Revenue: ${parseFloat(stats.revenue).toFixed(2)}\n`;
    text += `Avg order value: ${parseFloat(stats.avg_order).toFixed(2)}\n`;
    if (stats.first_order) text += `First order: ${stats.first_order}\nLast order: ${stats.last_order}\n`;

    if (topProducts.length) {
      text += `\nTop products:\n`;
      topProducts.forEach((p, i) => {
        text += `  ${i + 1}. ${p.order_item_name} — ${p.total_qty} sold, revenue: ${parseFloat(p.total_revenue).toFixed(2)}\n`;
      });
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "stock_overview",
  "Get stock overview — out of stock products, low stock, backorders. Ask 'which products are out of stock', 'low stock report'",
  {
    status: z.string().optional().describe("Filter: outofstock, instock, onbackorder, low (for low stock)"),
    threshold: z.number().optional().describe("Low stock threshold (default: 5, only used with status=low)"),
  },
  async ({ status, threshold }) => {
    const lowThreshold = threshold || 5;
    const filter = status || "outofstock";

    let sql, params;

    if (filter === "low") {
      sql = `
        SELECT p.ID, p.post_title,
          MAX(CASE WHEN pm.meta_key = '_stock' THEN pm.meta_value END) as stock,
          MAX(CASE WHEN pm.meta_key = '_sku' THEN pm.meta_value END) as sku,
          MAX(CASE WHEN pm.meta_key = '_stock_status' THEN pm.meta_value END) as stock_status
        FROM ${t("posts")} p
        JOIN ${t("postmeta")} pm ON p.ID = pm.post_id
        WHERE p.post_type = 'product' AND p.post_status = 'publish'
        GROUP BY p.ID
        HAVING stock IS NOT NULL AND CAST(stock AS SIGNED) <= ? AND CAST(stock AS SIGNED) > 0
        ORDER BY CAST(stock AS SIGNED) ASC
      `;
      params = [lowThreshold];
    } else {
      sql = `
        SELECT p.ID, p.post_title,
          MAX(CASE WHEN pm.meta_key = '_stock' THEN pm.meta_value END) as stock,
          MAX(CASE WHEN pm.meta_key = '_sku' THEN pm.meta_value END) as sku,
          MAX(CASE WHEN pm.meta_key = '_stock_status' THEN pm.meta_value END) as stock_status
        FROM ${t("posts")} p
        JOIN ${t("postmeta")} pm ON p.ID = pm.post_id
        WHERE p.post_type = 'product' AND p.post_status = 'publish'
        GROUP BY p.ID
        HAVING stock_status = ?
        ORDER BY p.post_title
      `;
      params = [filter];
    }

    const rows = await query(sql, params);
    const label = filter === "low" ? `Low stock (≤${lowThreshold})` : filter;
    const text = rows
      .map((r) => `[${r.ID}] ${r.post_title} | SKU: ${r.sku || "—"} | Stock: ${r.stock || "—"} (${r.stock_status})`)
      .join("\n");
    return { content: [{ type: "text", text: `${label}: ${rows.length} product(s)\n\n${text}` || "None found" }] };
  }
);

// ═══════════════════════════════════════════════
// RAW QUERY (FALLBACK)
// ═══════════════════════════════════════════════

server.tool(
  "wp_query",
  "Run a read-only SQL SELECT query. Use this as a fallback when no other tool fits the question.",
  {
    sql: z.string().describe("SQL SELECT query (read-only)"),
  },
  async ({ sql: rawSql }) => {
    const trimmed = rawSql.trim();
    if (!/^SELECT\s/i.test(trimmed)) {
      return { content: [{ type: "text", text: "Only SELECT queries are allowed" }] };
    }
    if (/\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE)\b/i.test(trimmed)) {
      return { content: [{ type: "text", text: "Only read-only SELECT queries are allowed" }] };
    }

    const rows = await query(trimmed);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { content: [{ type: "text", text: "No results" }] };
    }

    const text = JSON.stringify(rows, null, 2);
    return { content: [{ type: "text", text: `${rows.length} row(s):\n\n${text}` }] };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

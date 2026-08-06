/**
 * Product search query construction.
 *
 * These exist because a search that returns nothing is indistinguishable from
 * a catalogue that contains nothing: the endpoint answers 200 with an empty
 * page either way, so no health check, no probe and no status code notices.
 * The only integration test covering search sent `q: ""`, which skips the
 * free-text branch entirely — so the branch that was broken was also the one
 * branch nothing exercised.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFilters, buildQuery, buildSort, buildTextQuery } from "../src/lib/query.js";
import { MAPPING_VERSION, buildIndexSettings } from "../src/lib/mapping.js";

/** Collects every value for `key` anywhere in a nested object. */
function collect(node, key, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, found);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) found.push(v);
      collect(v, key, found);
    }
  }
  return found;
}

const fieldsOf = (query) => collect(query, "fields").flat();

describe("free-text query", () => {
  it("never requires every term to be in a single field", () => {
    // The original bug. `best_fields` is the multi_match default, and with
    // operator "and" it demands all terms from one field, so a brand-plus-
    // product search ("Northwind hoodie") could not match anything.
    const clauses = collect(buildTextQuery("Northwind hoodie"), "multi_match");
    assert.ok(clauses.length > 0, "expected at least one multi_match");
    for (const clause of clauses) {
      // `type` must be read with the default applied. Asserting on the literal
      // property would have passed against the broken query, which never set
      // `type` at all and so inherited best_fields implicitly.
      const type = clause.type ?? "best_fields";
      assert.notEqual(
        `${type}:${clause.operator}`,
        "best_fields:and",
        "best_fields with operator 'and' requires all terms in one field",
      );
    }
  });

  it("searches brand and category through their analysed subfields", () => {
    // A `match` against a bare keyword field compares the entire query string
    // to the entire field value, so "northwind" cannot match "Northwind".
    const fields = fieldsOf(buildTextQuery("northwind"));
    const bare = fields.filter((f) => /^(brand|category)(\^|$)/.test(f));
    assert.deepEqual(bare, [], `keyword fields used for full text: ${bare.join(", ")}`);
    assert.ok(
      fields.some((f) => f.startsWith("brand.text")),
      "brand.text should be searchable",
    );
  });

  it("lets an exact phrase outrank a fuzzy match", () => {
    const query = buildTextQuery("Court Low Leather Sneaker");
    const phrase = collect(query, "match_phrase");
    assert.equal(phrase.length, 1, "expected one phrase clause");

    const phraseBoost = phrase[0].name.boost;
    const fuzzyClause = collect(query, "multi_match").find((m) => m.fuzziness);
    assert.ok(fuzzyClause, "expected a fuzzy strategy");
    // Whatever the fuzzy clause's field boosts are, the phrase must sit above
    // them, or a typo-match can displace the product actually being searched.
    const fuzzyMax = Math.max(...fuzzyClause.fields.map((f) => Number(f.split("^")[1] ?? 1)));
    assert.ok(
      phraseBoost > fuzzyMax,
      `phrase boost ${phraseBoost} should exceed fuzzy boost ${fuzzyMax}`,
    );
  });

  it("matches a document that satisfies any one strategy", () => {
    const { must } = buildTextQuery("wireless headphones");
    assert.equal(must.length, 1);
    assert.equal(must[0].bool.minimum_should_match, 1);
    assert.ok(must[0].bool.should.length >= 3, "expected several graded strategies");
  });

  it("bounds fuzzy expansion so a one-letter query cannot walk the term dictionary", () => {
    const fuzzy = collect(buildTextQuery("a"), "multi_match").find((m) => m.fuzziness);
    assert.ok(fuzzy.prefix_length >= 1, "fuzzy matching needs a prefix anchor");
    assert.ok(fuzzy.max_expansions <= 50, "unbounded fuzzy expansion is a performance trap");
  });

  it("keeps stock and rating as boosts, never as requirements", () => {
    const { should } = buildTextQuery("mug");
    // These sit alongside a `must`, so minimum_should_match defaults to 0 and
    // they only influence score. Promoting either to a filter would silently
    // hide every out-of-stock product from search.
    assert.ok(should.some((c) => c.term?.inStock));
    assert.ok(should.some((c) => c.range?.ratingAvg));
  });
});

describe("filters", () => {
  it("always restricts to active products", () => {
    assert.ok(buildFilters({}).some((f) => f.term?.isActive === true));
  });

  it("matches a facet value regardless of case", () => {
    const filters = buildFilters({ category: "apparel", brand: "northwind" });
    assert.ok(filters.some((f) => f.terms?.["category.folded"]?.includes("apparel")));
    assert.ok(filters.some((f) => f.terms?.["brand.folded"]?.includes("northwind")));
  });

  it("accepts one value or several", () => {
    const one = buildFilters({ category: "Home" });
    const many = buildFilters({ category: ["Home", "Apparel"] });
    assert.deepEqual(one.find((f) => f.terms)?.terms["category.folded"], ["Home"]);
    assert.deepEqual(many.find((f) => f.terms)?.terms["category.folded"], ["Home", "Apparel"]);
  });

  it("converts prices to the integer cents the index stores", () => {
    const [range] = buildFilters({ minPrice: 10.5, maxPrice: 99.99 }).filter(
      (f) => f.range?.priceCents,
    );
    assert.equal(range.range.priceCents.gte, 1050);
    assert.equal(range.range.priceCents.lte, 9999);
  });

  it("leaves an open-ended range open", () => {
    const [range] = buildFilters({ minPrice: 5 }).filter((f) => f.range?.priceCents);
    assert.equal(range.range.priceCents.gte, 500);
    assert.ok(!("lte" in range.range.priceCents));
  });

  it("does not filter on stock unless asked", () => {
    assert.ok(!buildFilters({ inStock: false }).some((f) => f.term?.inStock === true));
    assert.ok(buildFilters({ inStock: true }).some((f) => f.term?.inStock === true));
  });
});

describe("buildQuery", () => {
  it("skips the text clauses when there is no query", () => {
    for (const q of ["", "   ", undefined]) {
      const query = buildQuery({ q });
      assert.ok(!query.bool.must, `q=${JSON.stringify(q)} should produce a filter-only query`);
      assert.ok(query.bool.filter.length >= 1);
    }
  });

  it("keeps filters alongside the text query", () => {
    const query = buildQuery({ q: "lamp", category: "Home", inStock: true });
    assert.ok(query.bool.must, "text clause missing");
    assert.ok(query.bool.filter.some((f) => f.terms?.["category.folded"]));
    assert.ok(query.bool.filter.some((f) => f.term?.inStock === true));
  });
});

describe("sorting", () => {
  it("orders by score only when there is something to score", () => {
    assert.deepEqual(buildSort("relevance", "sneaker")[0], "_score");
    // Lucene doc order is arbitrary; an empty query needs a stable tiebreak.
    assert.deepEqual(buildSort("relevance", ""), [{ createdAt: "desc" }]);
  });

  it("honours explicit sorts over relevance", () => {
    assert.deepEqual(buildSort("price_asc", "x"), [{ priceCents: "asc" }]);
    assert.deepEqual(buildSort("newest", "x"), [{ createdAt: "desc" }]);
    assert.deepEqual(buildSort("rating", "x"), [{ ratingAvg: "desc" }, { ratingCount: "desc" }]);
  });
});

describe("index mapping", () => {
  const { settings, mappings } = buildIndexSettings();

  it("applies synonyms at search time only", () => {
    // synonym_graph is the only filter that handles a multi-word synonym
    // ("t-shirt" is two tokens), and Elasticsearch permits it solely as a
    // search analyzer. The plain `synonym` filter this replaced corrupted the
    // position graph, which is what made an exact product-name search return
    // nothing.
    const { analyzer, filter } = settings.analysis;
    assert.equal(filter.product_synonyms.type, "synonym_graph");
    assert.ok(
      !analyzer.product_index_analyzer.filter.includes("product_synonyms"),
      "synonym_graph is not valid as an index analyzer",
    );
    assert.ok(analyzer.product_search_analyzer.filter.includes("product_synonyms"));
  });

  it("keeps the index and search analyzers otherwise identical", () => {
    // Any divergence beyond synonyms means a term is stored one way and looked
    // up another, which fails silently rather than erroring.
    const { product_index_analyzer: idx, product_search_analyzer: srch } =
      settings.analysis.analyzer;
    assert.equal(idx.tokenizer, srch.tokenizer);
    assert.deepEqual(
      srch.filter.filter((f) => f !== "product_synonyms"),
      idx.filter,
    );
  });

  it("defaults to zero replicas so a single node is not permanently yellow", () => {
    assert.equal(settings.number_of_replicas, 0);
  });

  it("gives brand and category both an exact and an analysed form", () => {
    for (const field of ["brand", "category"]) {
      assert.equal(mappings.properties[field].type, "keyword", `${field} must stay filterable`);
      assert.equal(mappings.properties[field].fields.text.type, "text");
      assert.equal(mappings.properties[field].fields.folded.normalizer, "lowercase_normalizer");
    }
  });

  it("records the mapping version, so a stale index can be detected", () => {
    assert.equal(mappings._meta.mappingVersion, MAPPING_VERSION);
  });

  it("indexes every field the search query and facets reference", () => {
    const referenced = new Set(
      fieldsOf(buildTextQuery("x"))
        .map((f) => f.split("^")[0])
        .concat([
          "category",
          "brand",
          "priceCents",
          "isActive",
          "inStock",
          "ratingAvg",
          "createdAt",
        ]),
    );
    for (const path of referenced) {
      const [root, sub] = path.split(".");
      const property = mappings.properties[root];
      assert.ok(property, `query references unmapped field '${root}'`);
      if (sub) assert.ok(property.fields?.[sub], `query references unmapped subfield '${path}'`);
    }
  });
});

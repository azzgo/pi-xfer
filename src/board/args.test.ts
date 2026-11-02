import assert from "node:assert/strict";
import { test } from "node:test";
import { stripOuterQuotes } from "./args.ts";

test("stripOuterQuotes strips a matched pair of double quotes", () => {
  assert.equal(stripOuterQuotes('"my title"'), "my title");
});

test("stripOuterQuotes strips a matched pair of single quotes", () => {
  assert.equal(stripOuterQuotes("'my title'"), "my title");
});

test("stripOuterQuotes keeps unquoted text", () => {
  assert.equal(stripOuterQuotes("my title"), "my title");
});

test("stripOuterQuotes keeps mismatched quotes", () => {
  assert.equal(stripOuterQuotes('"my title'), '"my title');
  assert.equal(stripOuterQuotes("'my title\""), "'my title\"");
});

test("stripOuterQuotes keeps a lone quote character", () => {
  assert.equal(stripOuterQuotes('"'), '"');
});

test("stripOuterQuotes strips only one layer and trims", () => {
  assert.equal(stripOuterQuotes('  "my title"  '), "my title");
});

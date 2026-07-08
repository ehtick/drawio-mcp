import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pako from "pako";
import {
  assertPagePath,
  parseDiagrams,
  listPageMeta,
  decompressDiagram,
  findPage,
  readPageXml,
  writePageXml,
} from "../src/pages.js";

const PAGE1_XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const PAGE2_XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="2" parent="0" value="two"/></root></mxGraphModel>';

function compress(xml)
{
  return Buffer.from(pako.deflateRaw(encodeURIComponent(xml))).toString("base64");
}

function makeFile(name, content)
{
  const dir = mkdtempSync(join(tmpdir(), "drawio-pages-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

const MIXED_FILE =
  '<mxfile host="app.diagrams.net" modified="2026-01-01T00:00:00.000Z">' +
  `<diagram id="id-one" name="First">${PAGE1_XML}</diagram>` +
  `<diagram id="id-two" name="2">${compress(PAGE2_XML)}</diagram>` +
  '<diagram id="id-three" name="Empty"/>' +
  "</mxfile>";

test("listPageMeta returns index, id, name, size for every page", function ()
{
  const meta = listPageMeta(MIXED_FILE);

  assert.equal(meta.length, 3);
  assert.deepEqual(meta.map(function (m) { return m.id; }), ["id-one", "id-two", "id-three"]);
  assert.deepEqual(meta.map(function (m) { return m.name; }), ["First", "2", "Empty"]);
  assert.equal(meta[0].approxSizeBytes, Buffer.byteLength(PAGE1_XML, "utf8"));
  assert.equal(meta[2].approxSizeBytes, 0);
});

test("readPageXml resolves by index, name, and id", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);

  assert.equal(readPageXml(filePath, "0").xml, PAGE1_XML);
  assert.equal(readPageXml(filePath, "First").xml, PAGE1_XML);
  assert.equal(readPageXml(filePath, "id-one").xml, PAGE1_XML);
});

test("readPageXml decompresses a compressed page", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);

  assert.equal(readPageXml(filePath, "1").xml, PAGE2_XML);
});

test("a page with a numeric name is reachable via its id", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);

  // "2" is parsed as an index (the Empty page), but id still works.
  assert.equal(readPageXml(filePath, "2").xml, "");
  assert.equal(readPageXml(filePath, "id-two").xml, PAGE2_XML);
});

test("findPage errors on out-of-range index, unknown name, duplicate names", function ()
{
  const diagrams = parseDiagrams(MIXED_FILE);

  assert.throws(function () { findPage(diagrams, "3"); }, /out of range/);
  assert.throws(function () { findPage(diagrams, "Nope"); }, /No page with name or id/);

  const dupes = parseDiagrams(
    '<mxfile><diagram id="a" name="Same"/><diagram id="b" name="Same"/></mxfile>');
  assert.throws(function () { findPage(dupes, "Same"); }, /Multiple pages named "Same".*indices: 0, 1/);
});

test("writePageXml replaces one page and leaves the rest byte-identical", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);
  const newXml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="9" parent="0"/></root></mxGraphModel>';

  const result = writePageXml(filePath, "First", newXml);
  assert.equal(result.compressed, false);

  const text = readFileSync(filePath, "utf8");
  assert.equal(text, MIXED_FILE.replace(PAGE1_XML, newXml));
  assert.equal(readPageXml(filePath, "id-two").xml, PAGE2_XML);
});

test("writePageXml keeps a compressed page compressed", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);
  const newXml = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>';

  const result = writePageXml(filePath, "id-two", newXml);
  assert.equal(result.compressed, true);

  const page = parseDiagrams(readFileSync(filePath, "utf8"))[1];
  assert.ok(!page.body.startsWith("<"), "body should still be compressed");
  assert.equal(readPageXml(filePath, "id-two").xml, newXml);
});

test("writePageXml handles self-closing <diagram/> pages without corrupting the file", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);
  const newXml = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>';

  writePageXml(filePath, "Empty", newXml);

  const meta = listPageMeta(readFileSync(filePath, "utf8"));
  assert.equal(meta.length, 3);
  assert.equal(readPageXml(filePath, "Empty").xml, newXml);
  assert.equal(readPageXml(filePath, "First").xml, PAGE1_XML);
});

test("writePageXml rejects content that is not a single mxGraphModel", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);

  assert.throws(function ()
  {
    writePageXml(filePath, "First", "<mxfile><diagram>x</diagram></mxfile>");
  }, /must be plain <mxGraphModel> XML/);
});

test("writePageXml rejects content containing <diagram> tags (structure injection)", function ()
{
  const filePath = makeFile("mixed.drawio", MIXED_FILE);
  const injection = `${PAGE1_XML}</diagram><diagram name="evil">payload`;

  assert.throws(function ()
  {
    writePageXml(filePath, "First", injection);
  }, /must not contain <diagram> tags/);

  assert.equal(readFileSync(filePath, "utf8"), MIXED_FILE);
});

test("assertPagePath only allows .drawio and .xml files", function ()
{
  assertPagePath("/tmp/a.drawio");
  assertPagePath("/tmp/b.XML");
  assert.throws(function () { assertPagePath("/etc/passwd"); }, /Only .drawio and .xml/);
  assert.throws(function () { assertPagePath("notes.txt"); }, /Only .drawio and .xml/);
});

test("decompressDiagram enforces the inflated size cap", function ()
{
  const big = `<mxGraphModel>${"x".repeat(4096)}</mxGraphModel>`;

  assert.equal(decompressDiagram(compress(big)), big);
  assert.throws(function () { decompressDiagram(compress(big), 1024); }, /exceeds the 1024 byte limit/);
});

test("decompressDiagram reports invalid data as a clean error", function ()
{
  assert.throws(function () { decompressDiagram("not-base64-deflate!!"); }, /Failed to decompress/);
});

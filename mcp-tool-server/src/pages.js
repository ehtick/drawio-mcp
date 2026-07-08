import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import pako from "pako";

const DIAGRAM_RE = /<diagram\b([^>]*?)(?:\/>|>([\s\S]*?)<\/diagram>)/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;

// Cap on decompressed page size so a crafted deflate bomb in a local file
// can't OOM the server process.
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export function assertPagePath(filePath)
{
  const lower = String(filePath).toLowerCase();

  if (!lower.endsWith(".drawio") && !lower.endsWith(".xml"))
  {
    throw new Error(`Only .drawio and .xml files are supported: ${filePath}`);
  }
}

function parseAttrs(rawAttrs)
{
  const attrs = {};
  let match;

  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(rawAttrs)) !== null)
  {
    attrs[match[1]] = match[2];
  }

  return attrs;
}

export function parseDiagrams(mxfileText)
{
  const diagrams = [];
  let match;
  let index = 0;

  DIAGRAM_RE.lastIndex = 0;
  while ((match = DIAGRAM_RE.exec(mxfileText)) !== null)
  {
    diagrams.push({
      index: index++,
      attrs: parseAttrs(match[1]),
      body: match[2] || "",
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return diagrams;
}

export function listPageMeta(mxfileText)
{
  return parseDiagrams(mxfileText).map(function (diagram)
  {
    return {
      index: diagram.index,
      id: diagram.attrs.id || null,
      name: diagram.attrs.name || null,
      approxSizeBytes: Buffer.byteLength(diagram.body, "utf8"),
    };
  });
}

export function isLikelyCompressed(body)
{
  const trimmed = body.trim();
  return trimmed.length > 0 && !trimmed.startsWith("<");
}

function inflateRawCapped(input, maxBytes)
{
  const inflator = new pako.Inflate({ raw: true });
  const chunks = [];
  let total = 0;

  inflator.onData = function (chunk)
  {
    total += chunk.length;

    if (total > maxBytes)
    {
      throw new Error(`decompressed page exceeds the ${maxBytes} byte limit`);
    }

    chunks.push(Buffer.from(chunk));
  };

  inflator.push(input, true);

  if (inflator.err)
  {
    throw new Error(inflator.msg || "invalid compressed data");
  }

  return Buffer.concat(chunks).toString("utf8");
}

export function decompressDiagram(body, maxBytes = MAX_INFLATED_BYTES)
{
  const trimmed = body.trim();

  if (!isLikelyCompressed(trimmed))
  {
    return trimmed;
  }

  try
  {
    const inflated = inflateRawCapped(Buffer.from(trimmed, "base64"), maxBytes);
    return decodeURIComponent(inflated);
  }
  catch (e)
  {
    throw new Error(`Failed to decompress page content: ${e.message}`);
  }
}

function compressDiagram(xml)
{
  const encoded = encodeURIComponent(xml);
  const compressed = pako.deflateRaw(encoded);
  return Buffer.from(compressed).toString("base64");
}

export function findPage(diagrams, pageRef)
{
  const asString = String(pageRef);

  if (/^\d+$/.test(asString))
  {
    const idx = Number.parseInt(asString, 10);

    if (idx < 0 || idx >= diagrams.length)
    {
      throw new Error(`Page index ${idx} out of range (file has ${diagrams.length} page${diagrams.length === 1 ? "" : "s"})`);
    }

    return diagrams[idx];
  }

  let matches = diagrams.filter(function (diagram)
  {
    return diagram.attrs.name === asString;
  });

  if (matches.length === 0)
  {
    matches = diagrams.filter(function (diagram)
    {
      return diagram.attrs.id === asString;
    });
  }

  if (matches.length === 0)
  {
    const names = diagrams.map(function (diagram) { return diagram.attrs.name; }).join(", ");
    throw new Error(`No page with name or id "${asString}" found. Available page names: ${names}`);
  }

  if (matches.length > 1)
  {
    const indices = matches.map(function (diagram) { return diagram.index; }).join(", ");
    throw new Error(`Multiple pages named "${asString}" found (indices: ${indices}). Use an index or page id instead.`);
  }

  return matches[0];
}

function writeFileAtomic(filePath, data)
{
  const tmpPath = `${filePath}.${process.pid}.tmp`;

  try
  {
    writeFileSync(tmpPath, data, "utf8");
    renameSync(tmpPath, filePath);
  }
  catch (e)
  {
    try { unlinkSync(tmpPath); } catch (e2) { /* ignore */ }
    throw e;
  }
}

export function readPageXml(filePath, pageRef)
{
  assertPagePath(filePath);

  const text = readFileSync(filePath, "utf8");
  const diagrams = parseDiagrams(text);
  const page = findPage(diagrams, pageRef);
  const xml = decompressDiagram(page.body);

  return { xml, index: page.index, id: page.attrs.id || null, name: page.attrs.name || null };
}

export function writePageXml(filePath, pageRef, newXml)
{
  assertPagePath(filePath);

  const text = readFileSync(filePath, "utf8");
  const diagrams = parseDiagrams(text);
  const page = findPage(diagrams, pageRef);

  const trimmedXml = newXml.trim();

  if (!trimmedXml.startsWith("<mxGraphModel"))
  {
    throw new Error("set_page content must be plain <mxGraphModel> XML for a single page, not a full <mxfile> or non-XML content");
  }

  // A raw <diagram> tag in the content would escape the target page's body
  // and rewrite the file's page structure (escaped &lt;diagram&gt; is fine).
  if (/<\/?diagram\b/i.test(trimmedXml))
  {
    throw new Error("set_page content must not contain <diagram> tags — pass the inner mxGraphModel XML of a single page");
  }

  const compressed = isLikelyCompressed(page.body);
  const newBody = compressed ? compressDiagram(trimmedXml) : trimmedXml;

  const fullOriginal = text.slice(page.start, page.end);
  let replacement;

  if (fullOriginal.endsWith("/>"))
  {
    replacement = `${fullOriginal.slice(0, -2)}>${newBody}</diagram>`;
  }
  else
  {
    const bodyStartOffset = fullOriginal.indexOf(">") + 1;
    const bodyEndOffset = fullOriginal.lastIndexOf("</diagram>");
    replacement = fullOriginal.slice(0, bodyStartOffset) + newBody + fullOriginal.slice(bodyEndOffset);
  }

  const result = text.slice(0, page.start) + replacement + text.slice(page.end);
  writeFileAtomic(filePath, result);

  return { index: page.index, id: page.attrs.id || null, name: page.attrs.name || null, compressed };
}

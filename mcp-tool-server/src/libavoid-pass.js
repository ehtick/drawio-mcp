// Server-side libavoid edge-routing pass for open_drawio_xml.
//
// The app server runs libavoid in the browser against the live mxGraph model.
// The tool server has no renderer — it just compresses XML into a #create= URL
// — so here we parse the mxGraphModel XML, run the SAME shared routing core
// (computeLibavoidRoutes), and write the resulting waypoints back into the XML
// before it is compressed.
//
// Parsing is a deliberately small, targeted pass over `<mxCell>` / `<mxGeometry>`
// (draw.io XML is regular and the LLM is asked to emit well-formed XML with
// escaped attribute values). Anything unexpected -> return the original XML
// unrouted, so a parse hiccup never produces a broken diagram, only an
// un-routed one.

import { AvoidLib } from "../vendor/libavoid/libavoid-node.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "vendor", "libavoid", "libavoid.wasm");

// computeLibavoidRoutes is the single source shared with the app server. The
// canonical file is shared/libavoid-routing.js; the copy-shared npm script
// copies it into src/ for the published package (like the *.md references).
// Resolve the local copy first, fall back to the repo's shared/ for in-repo
// runs that skipped copy-shared — mirroring how index.js reads the references.
let routesFnPromise = null;

function getComputeRoutes()
{
  if (routesFnPromise == null)
  {
    routesFnPromise = import("./libavoid-routing.js")
      .catch(function() { return import("../../shared/libavoid-routing.js"); })
      .then(function(mod) { return mod.computeLibavoidRoutes; });
  }

  return routesFnPromise;
}

// Lazy, memoized — the wasm only loads when routing is actually requested.
let avoidPromise = null;

function getAvoid()
{
  if (avoidPromise == null)
  {
    avoidPromise = AvoidLib.load(WASM_PATH).then(function()
    {
      return AvoidLib.getInstance();
    });
  }

  return avoidPromise;
}

// Parse double-quoted attributes from a tag's attribute string into a map.
function parseAttrs(s)
{
  var attrs = {};
  var re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  var m;

  while ((m = re.exec(s)) !== null)
  {
    attrs[m[1]] = m[2];
  }

  return attrs;
}

// Find all <mxCell> blocks (self-closing or with a body).
function parseCells(xml)
{
  var cells = [];
  var re = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g;
  var m;

  while ((m = re.exec(xml)) !== null)
  {
    cells.push({
      full: m[0],
      rawAttrs: m[1],
      attrs: parseAttrs(m[1]),
      selfClosing: m[2] === "/>",
      body: m[3] || ""
    });
  }

  return cells;
}

// Pull the first <mxGeometry> tag's attributes from a cell body.
function parseGeometry(body)
{
  var m = /<mxGeometry\b([^>]*?)\/?>/.exec(body);
  if (m == null) return null;
  return parseAttrs(m[1]);
}

function num(v)
{
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// Apply the canonical libavoid edge style on an mxGraph style string, preserving
// every other key (stroke, arrows, colors, …). libavoidRouting=1 keeps the edge
// auto-routing via libavoid if the diagram is later opened and edited in the
// draw.io editor; rounded/orthogonalLoop/jettySize match what the editor's
// libavoid checkbox pairs with the flag.
function setEdgeStyle(style)
{
  var kept = [];
  var parts = (style || "").split(";");
  var managed = {
    edgeStyle: 1, rounded: 1, curved: 1,
    libavoidRouting: 1, orthogonalLoop: 1, jettySize: 1, html: 1
  };

  for (var i = 0; i < parts.length; i++)
  {
    var p = parts[i].trim();
    if (p === "") continue;
    var key = p.split("=")[0];
    if (managed[key]) continue;
    kept.push(p);
  }

  kept.push("edgeStyle=orthogonalEdgeStyle");
  kept.push("rounded=0");
  kept.push("libavoidRouting=1");
  kept.push("orthogonalLoop=1");
  kept.push("jettySize=auto");
  kept.push("html=1");
  return kept.join(";") + ";";
}

// Replace the style="..." attribute in a raw attribute string (or append it).
function withStyle(rawAttrs, newStyle)
{
  var escaped = newStyle.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  if (/\bstyle\s*=\s*"/.test(rawAttrs))
  {
    return rawAttrs.replace(/\bstyle\s*=\s*"[^"]*"/, 'style="' + escaped + '"');
  }

  return rawAttrs + ' style="' + escaped + '"';
}

// Rebuild an edge's <mxCell> block with the routed waypoints + orthogonal style.
function buildEdgeBlock(cell, wps)
{
  var rawAttrs = withStyle(cell.rawAttrs, setEdgeStyle(cell.attrs.style));

  // Preserve the existing geometry's attributes (relative, as, label x/y),
  // defaulting to a standard relative edge geometry.
  var geoAttrs = parseGeometry(cell.body) || {};
  if (geoAttrs.relative == null) geoAttrs.relative = "1";
  geoAttrs.as = "geometry";

  var geoAttrStr = Object.keys(geoAttrs).map(function(k)
  {
    return k + '="' + geoAttrs[k] + '"';
  }).join(" ");

  var pointsXml = wps.map(function(p)
  {
    return '<mxPoint x="' + p.x + '" y="' + p.y + '" />';
  }).join("");

  var geo = "<mxGeometry " + geoAttrStr + ">" +
    "<Array as=\"points\">" + pointsXml + "</Array>" +
    "</mxGeometry>";

  // Body minus any existing geometry, plus the new one.
  var body = cell.body
    .replace(/<mxGeometry\b[^>]*?\/>/g, "")
    .replace(/<mxGeometry\b[\s\S]*?<\/mxGeometry>/g, "");

  return "<mxCell" + rawAttrs + ">" + body + geo + "</mxCell>";
}

/**
 * Route the edges of a draw.io XML document with libavoid. Returns the XML with
 * orthogonal obstacle-avoiding waypoints written onto each edge, or the
 * original XML unchanged if there's nothing to route or anything goes wrong.
 *
 * @param {string} xml
 * @returns {Promise<string>}
 */
export async function routeXml(xml)
{
  try
  {
    if (typeof xml !== "string" || xml.indexOf("<mxCell") === -1) return xml;

    var cells = parseCells(xml);
    var byId = {};
    var i;

    for (i = 0; i < cells.length; i++)
    {
      var c = cells[i];
      if (c.attrs.id == null) continue;
      c.geo = parseGeometry(c.body);
      byId[c.attrs.id] = c;
    }

    // Absolute offset of a cell's parent chain (sum of ancestor vertex geos).
    function parentOffset(id)
    {
      var x = 0, y = 0;
      var cur = byId[id];
      var seen = {};

      while (cur != null && cur.attrs.parent != null && !seen[cur.attrs.parent])
      {
        seen[cur.attrs.parent] = true;
        var par = byId[cur.attrs.parent];
        if (par == null || par.attrs.vertex !== "1" || par.geo == null) break;
        x += num(par.geo.x);
        y += num(par.geo.y);
        cur = par;
      }

      return { x: x, y: y };
    }

    var vertices = [];
    var edges = [];
    var id;

    for (id in byId)
    {
      var cell = byId[id];

      if (cell.attrs.vertex === "1" && cell.geo != null)
      {
        var off = parentOffset(id);
        var w = num(cell.geo.width);
        var h = num(cell.geo.height);
        if (w > 0 && h > 0)
        {
          vertices.push({ id: id, x: num(cell.geo.x) + off.x, y: num(cell.geo.y) + off.y, w: w, h: h });
        }
      }
      else if (cell.attrs.edge === "1" && cell.attrs.source != null && cell.attrs.target != null)
      {
        edges.push({ id: id, source: cell.attrs.source, target: cell.attrs.target });
      }
    }

    if (edges.length === 0) return xml;

    var computeLibavoidRoutes = await getComputeRoutes();
    var Avoid = await getAvoid();
    var routes = computeLibavoidRoutes(Avoid, vertices, edges);
    var routedIds = Object.keys(routes);
    if (routedIds.length === 0) return xml;

    var out = xml;

    for (i = 0; i < routedIds.length; i++)
    {
      var eid = routedIds[i];
      var edgeCell = byId[eid];
      var eOff = parentOffset(eid);
      var wps = routes[eid].map(function(p)
      {
        return { x: p.x - eOff.x, y: p.y - eOff.y };
      });

      var block = buildEdgeBlock(edgeCell, wps);
      // split/join (not replace) so '$' in the replacement isn't special.
      out = out.split(edgeCell.full).join(block);
    }

    return out;
  }
  catch (e)
  {
    // Never break the diagram — fall back to the un-routed XML.
    return xml;
  }
}

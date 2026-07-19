import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchIcons,
  searchShapesAndIcons,
  resolveIconServiceUrl,
  DEFAULT_ICON_SERVICE_URL,
} from "../../shared/icon-search.js";
import { buildTagMap } from "../../shared/shape-search.js";

function fakeFetch(body, status)
{
  return async function(url)
  {
    fakeFetch.lastUrl = url;

    return {
      ok: (status || 200) >= 200 && (status || 200) <= 299,
      status: status || 200,
      json: async function() { return body; },
    };
  };
}

test("searchIcons maps images to the searchShapes result contract", async function ()
{
  const results = await searchIcons("slack", 5, {
    fetchFn: fakeFetch({
      images:
      [
        {
          url: "https://icons.diagrams.net/icon-cache1/Social-1/slack-1.svg",
          width: 48,
          height: 52,
          title: "social_media_logo_slack",
          set: { slug: "social-media", name: "Social Media" },
        },
      ],
    }),
  });

  assert.equal(results.length, 1);
  assert.equal(
    results[0].style,
    "shape=image;html=1;verticalAlign=top;verticalLabelPosition=bottom;" +
      "labelBackgroundColor=default;imageAspect=0;aspect=fixed;" +
      "image=https://icons.diagrams.net/icon-cache1/Social-1/slack-1.svg"
  );
  assert.equal(results[0].w, 48);
  assert.equal(results[0].h, 52);
  assert.equal(results[0].title, "social media logo slack (Social Media)");
});

test("searchIcons builds the service URL with encoded query and count", async function ()
{
  const fetchFn = fakeFetch({ images: [] });
  await searchIcons("aws lambda", 7, { fetchFn });

  assert.equal(
    fakeFetch.lastUrl,
    DEFAULT_ICON_SERVICE_URL + "/search?q=aws%20lambda&p=0&c=7"
  );
});

test("searchIcons skips entries whose URL would break style or XML parsing", async function ()
{
  const results = await searchIcons("x", 10, {
    fetchFn: fakeFetch({
      images:
      [
        { url: "https://icons.diagrams.net/a;b.svg", width: 10, height: 10, title: "semicolon" },
        { url: "https://icons.diagrams.net/a.svg?x=1&y=2", width: 10, height: 10, title: "ampersand" },
        { url: "http://icons.diagrams.net/plain.svg", width: 10, height: 10, title: "not https" },
        { url: "https://icons.diagrams.net/ok.svg", width: 10, height: 10, title: "ok" },
      ],
    }),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "ok");
});

test("searchIcons caps results at limit and defaults missing dimensions", async function ()
{
  const images = [];

  for (let i = 0; i < 5; i++)
  {
    images.push({ url: "https://icons.diagrams.net/i" + i + ".svg", title: "i" + i });
  }

  const results = await searchIcons("x", 3, { fetchFn: fakeFetch({ images }) });

  assert.equal(results.length, 3);
  assert.equal(results[0].w, 48);
  assert.equal(results[0].h, 48);
});

test("searchIcons returns [] on HTTP errors, bad payloads, and thrown fetch", async function ()
{
  assert.deepEqual(await searchIcons("x", 5, { fetchFn: fakeFetch({ images: [] }, 500) }), []);
  assert.deepEqual(await searchIcons("x", 5, { fetchFn: fakeFetch({ nope: true }) }), []);
  assert.deepEqual(await searchIcons("x", 5, { fetchFn: fakeFetch(null) }), []);

  const throwing = async function() { throw new Error("network down"); };
  assert.deepEqual(await searchIcons("x", 5, { fetchFn: throwing }), []);
});

test("searchIcons returns [] without fetching for empty query or limit", async function ()
{
  const fetchFn = async function()
  {
    throw new Error("should not be called");
  };

  assert.deepEqual(await searchIcons("", 5, { fetchFn }), []);
  assert.deepEqual(await searchIcons("x", 0, { fetchFn }), []);
});

// Tiny index: two genuine "shopping cart" stencils and two patch panels that
// only partially match "solar panel" (exact on "panel", nothing on "solar").
const SHAPE_INDEX =
[
  { style: "shape=cart1", w: 40, h: 40, title: "Shopping Cart", tags: "shopping cart basket" },
  { style: "shape=cart2", w: 40, h: 40, title: "Shopping Trolley", tags: "shopping cart trolley" },
  { style: "shape=patch1", w: 40, h: 40, title: "Patch Panel 24", tags: "rack patch panel network" },
  { style: "shape=patch2", w: 40, h: 40, title: "Patch Panel 48", tags: "rack patch panel network" },
];
const TAG_MAP = buildTagMap(SHAPE_INDEX);

function iconImages(n)
{
  const images = [];

  for (let i = 0; i < n; i++)
  {
    images.push({ url: "https://icons.diagrams.net/icon" + i + ".svg", width: 24, height: 24, title: "icon" + i });
  }

  return images;
}

test("searchShapesAndIcons: strong local match fills remainder with icons", async function ()
{
  const results = await searchShapesAndIcons(SHAPE_INDEX, TAG_MAP, "shopping cart", 5, {
    fetchFn: fakeFetch({ images: iconImages(10) }),
  });

  assert.equal(results.length, 5);
  assert.equal(results[0].title, "Shopping Cart");
  assert.equal(results[1].title, "Shopping Trolley");
  assert.equal(results.filter(function(r) { return r.style.startsWith("shape=image"); }).length, 3);
  assert.match(fakeFetch.lastUrl, /c=3$/);
});

test("searchShapesAndIcons: full strong page makes no icon request", async function ()
{
  const fetchFn = async function()
  {
    throw new Error("should not be called");
  };

  const results = await searchShapesAndIcons(SHAPE_INDEX, TAG_MAP, "shopping cart", 2, { fetchFn });

  assert.deepEqual(results.map(function(r) { return r.title; }),
    ["Shopping Cart", "Shopping Trolley"]);
});

test("searchShapesAndIcons: weak local match keeps at most half the budget", async function ()
{
  // "solar panel" only partially matches the patch panels — with a budget of
  // 4, the two weak local results keep 2 slots and icons fill the other 2.
  const results = await searchShapesAndIcons(SHAPE_INDEX, TAG_MAP, "solar panel", 4, {
    fetchFn: fakeFetch({ images: iconImages(10) }),
  });

  assert.equal(results.length, 4);
  assert.equal(results.filter(function(r) { return r.style.startsWith("shape=image"); }).length, 2);
  assert.match(fakeFetch.lastUrl, /c=2$/);
});

test("searchShapesAndIcons: weak local results reclaim unused icon slots", async function ()
{
  const results = await searchShapesAndIcons(SHAPE_INDEX, TAG_MAP, "solar panel", 4, {
    fetchFn: fakeFetch({ images: iconImages(1) }),
  });

  assert.equal(results.length, 3);
  assert.equal(results.filter(function(r) { return r.style.startsWith("shape=image"); }).length, 1);
  assert.equal(results[0].title, "Patch Panel 24");
});

test("searchShapesAndIcons: icon service failure degrades to local-only", async function ()
{
  const throwing = async function() { throw new Error("network down"); };
  const results = await searchShapesAndIcons(SHAPE_INDEX, TAG_MAP, "solar panel", 4, { fetchFn: throwing });

  assert.deepEqual(results.map(function(r) { return r.title; }),
    ["Patch Panel 24", "Patch Panel 48"]);
});

test("searchShapesAndIcons: no local match at all fills the page with icons", async function ()
{
  const results = await searchShapesAndIcons(SHAPE_INDEX, TAG_MAP, "slack", 3, {
    fetchFn: fakeFetch({ images: iconImages(10) }),
  });

  assert.equal(results.length, 3);
  assert.ok(results.every(function(r) { return r.style.startsWith("shape=image"); }));
  assert.match(fakeFetch.lastUrl, /c=3$/);
});

test("searchShapesAndIcons: serviceUrl null disables icon supplementation", async function ()
{
  const fetchFn = async function()
  {
    throw new Error("should not be called");
  };

  const results = await searchShapesAndIcons(SHAPE_INDEX, TAG_MAP, "solar panel", 4,
    { serviceUrl: null, fetchFn });

  assert.deepEqual(results.map(function(r) { return r.title; }),
    ["Patch Panel 24", "Patch Panel 48"]);
});

test("resolveIconServiceUrl handles default, disable, and override values", function ()
{
  assert.equal(resolveIconServiceUrl(undefined), DEFAULT_ICON_SERVICE_URL);
  assert.equal(resolveIconServiceUrl(""), DEFAULT_ICON_SERVICE_URL);
  assert.equal(resolveIconServiceUrl("off"), null);
  assert.equal(resolveIconServiceUrl("NONE"), null);
  assert.equal(resolveIconServiceUrl("0"), null);
  assert.equal(resolveIconServiceUrl("false"), null);
  assert.equal(resolveIconServiceUrl("https://example.com/api/icons"), "https://example.com/api/icons");
});

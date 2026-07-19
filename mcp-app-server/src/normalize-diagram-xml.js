export const INVALID_DIAGRAM_XML_MESSAGE =
  "Expected draw.io XML. If your host wrapped the payload as JSON text, pass the raw XML string to `xml`.";

/**
 * Rewrites editor-relative image paths in style attributes (image=img/lib/...
 * or image=/img/...) to absolute app.diagrams.net URLs. Those paths only
 * resolve inside the draw.io editor's own origin — in the sandboxed viewer
 * iframe they resolve against the sandbox domain and render broken. LLMs
 * emit them by copying older styles from chat context or from training
 * knowledge of draw.io's built-in libraries, so the rewrite is applied to
 * every incoming diagram, not just search_shapes results. Absolute
 * (http/https) and data: URI values are left untouched.
 *
 * NOTE: this function is inlined into the viewer HTML via toString(), so it
 * must stay self-contained (no imports, no outer-scope references).
 *
 * @param {string} xml - Diagram XML (mxGraphModel or mxfile).
 * @returns {string} XML with image paths absolutized.
 */
export function absolutizeImageUrls(xml)
{
  if (typeof xml !== "string")
  {
    return xml;
  }

  return xml.replace(/style="([^"]*)"/g, function(match, style)
  {
    return 'style="' + style.replace(/(^|;)image=(?!https?:|data:)\/?/g,
      "$1image=https://app.diagrams.net/") + '"';
  });
}

/**
 * Extracts raw draw.io XML from raw XML or common JSON-wrapped text payloads.
 *
 * Some MCP hosts (e.g. ChatGPT) wrap the XML string in a JSON envelope like
 * {"text": "<mxGraphModel ...>"} before sending it. This function peels off
 * up to 4 wrapper layers so the server and client can handle these payloads.
 *
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizeDiagramXml(input)
{
  function findFirstTextBlock(content)
  {
    if (!Array.isArray(content) || content.length === 0)
    {
      return null;
    }

    for (var i = 0; i < content.length; i++)
    {
      var block = content[i];

      if (typeof block === "string")
      {
        return block;
      }

      if (block && typeof block.text === "string")
      {
        return block.text;
      }
    }

    return null;
  }

  function getXmlCandidate(value)
  {
    if (typeof value === "string")
    {
      var trimmed = value.trim();

      if (
        trimmed.length > 0 &&
        trimmed.charAt(0) === "<" &&
        (trimmed.indexOf("<mxGraphModel") !== -1 || trimmed.indexOf("<mxfile") !== -1)
      )
      {
        return trimmed;
      }

      return null;
    }

    return null;
  }

  function unwrapOnce(value)
  {
    if (typeof value === "string")
    {
      var trimmed = value.trim();

      if (trimmed.length === 0)
      {
        return null;
      }

      if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[")
      {
        try
        {
          return JSON.parse(trimmed);
        }
        catch (error)
        {
          return null;
        }
      }

      return null;
    }

    if (Array.isArray(value))
    {
      return findFirstTextBlock(value);
    }

    if (!value || typeof value !== "object")
    {
      return null;
    }

    if (typeof value.text === "string")
    {
      return value.text;
    }

    if (Array.isArray(value.content))
    {
      return findFirstTextBlock(value.content);
    }

    return null;
  }

  var current = input;

  for (var depth = 0; depth < 4; depth++)
  {
    var xmlCandidate = getXmlCandidate(current);

    if (xmlCandidate)
    {
      return xmlCandidate;
    }

    current = unwrapOnce(current);

    if (current === null)
    {
      return null;
    }
  }

  return getXmlCandidate(current);
}

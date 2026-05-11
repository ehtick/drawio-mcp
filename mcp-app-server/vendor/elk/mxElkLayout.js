/**
 * Copyright (c) 2019-2024, JGraph Holdings Ltd
 *
 * mxElkLayout — drawio-mcp shim over the bundled drawio-elk bridge.
 *
 * Historically this file carried its own flat mxGraph → ELK adapter
 * (~400 lines). The mxGraph ↔ ELK bridge now lives inside
 * `drawio-elk.min.js` as `window.ElkLayout` / `window.ElkAdapter` /
 * `window.ElkApplier`, shared with drawio-dev. This file is now a thin
 * compatibility shim that preserves the `mxElkLayout` constructor /
 * `buildElkGraph` / `applyElkLayout` / `executeAsync` / `execute` API
 * that shared.js's postLayout flow expects, while delegating the work
 * to ElkAdapter + ElkApplier.
 *
 * The bridge does hierarchical (compound) conversion — containers
 * become ELK compound nodes whose children are laid out together,
 * matching drawio-dev's behavior. The old flat conversion (every cell
 * a top-level sibling, edges remapped via ancestor lookup) is gone.
 *
 * Requires drawio-elk.min.js to be loaded first (it provides
 * globalThis.ELK, ElkAdapter, ElkApplier).
 *
 * Usage (unchanged from the original):
 *
 *   var layout = new mxElkLayout(graph, options);
 *   layout.algorithm = 'layered';
 *   layout.direction = 'DOWN';
 *   var elkGraph = layout.buildElkGraph(parent);
 *   // optional: mutate elkGraph (e.g. pin layerConstraint=FIRST / LAST)
 *   new ELK().layout(elkGraph).then(function(result) {
 *     model.beginUpdate();
 *     try { layout.applyElkLayout(result); }
 *     finally { model.endUpdate(); }
 *   });
 */
function mxElkLayout(graph, options)
{
	mxGraphLayout.call(this, graph);
	this.options = options || {};
}

mxElkLayout.prototype = new mxGraphLayout();
mxElkLayout.prototype.constructor = mxElkLayout;

// Defaults preserved from the original flat adapter so shared.js can
// override imperatively (`layout.algorithm = 'mrtree'`, etc.).
mxElkLayout.prototype.algorithm = 'layered';
mxElkLayout.prototype.direction = 'DOWN';
mxElkLayout.prototype.nodeSpacing = 20;
mxElkLayout.prototype.rankSpacing = 50;
mxElkLayout.prototype.edgeSpacing = 10;
mxElkLayout.prototype.edgeRouting = 'ORTHOGONAL';
mxElkLayout.prototype.resetEdges = true;

// ─── Internal helpers ────────────────────────────────────────────

// ElkAdapter emits ELK node ids as 'n' + cell.id and edge ids as
// 'e' + cell.id to keep node / edge namespaces distinct. shared.js's
// start/end-node pinning compares ELK ids against raw mxGraph cell
// ids, so the shim strips the leading 'n'/'e' from the elkGraph the
// adapter produces and rebuilds the elkToCellMap with unprefixed
// keys. The applier reads from that re-keyed map, so the round trip
// works.
function _stripPrefix(id) { return id != null ? id.replace(/^[ne]/, '') : id; }

function _renameTree(node)
{
	if (node.id != null) node.id = _stripPrefix(node.id);

	if (node.children)
	{
		for (var i = 0; i < node.children.length; i++) _renameTree(node.children[i]);
	}

	if (node.edges)
	{
		for (var j = 0; j < node.edges.length; j++)
		{
			var edge = node.edges[j];
			edge.id = _stripPrefix(edge.id);

			if (edge.sources)
			{
				for (var s = 0; s < edge.sources.length; s++) edge.sources[s] = _stripPrefix(edge.sources[s]);
			}

			if (edge.targets)
			{
				for (var t = 0; t < edge.targets.length; t++) edge.targets[t] = _stripPrefix(edge.targets[t]);
			}
		}
	}
}

// ─── buildElkGraph ───────────────────────────────────────────────

mxElkLayout.prototype.buildElkGraph = function(parent)
{
	if (typeof ElkAdapter === 'undefined')
	{
		throw new Error('ElkAdapter not available. Load drawio-elk.min.js before mxElkLayout.js.');
	}

	var adapter = new ElkAdapter(this.graph);

	// Two behaviours the old flat adapter had — keep them on by default.
	// The bridge defaults are already `true`, so this is belt-and-braces.
	adapter.useViewStateSizing = true;
	adapter.respectFixedPosition = true;

	// Layout options: same defaults the old adapter had + caller overrides
	// from `this.options`. shared.js sets every option it cares about via
	// `this.options` (the second constructor arg), so per-instance
	// properties like `this.nodeSpacing` only fire when the caller mutated
	// them imperatively.
	var layoutOptions = {
		'elk.algorithm': this.algorithm,
		'elk.direction': this.direction,
		'elk.spacing.nodeNode': String(this.nodeSpacing),
		'elk.layered.spacing.nodeNodeBetweenLayers': String(this.rankSpacing),
		'elk.layered.spacing.edgeEdgeBetweenLayers': String(this.edgeSpacing),
		'elk.layered.edgeRouting': this.edgeRouting,
		'elk.mrtree.spacing.nodeNode': String(this.nodeSpacing),
		'elk.radial.compactor': 'NONE',
		'elk.force.iterations': '300'
	};

	for (var key in this.options) layoutOptions[key] = this.options[key];

	var elkGraph = adapter.convert(parent, layoutOptions);

	// Strip 'n'/'e' prefix from every node / edge id in the tree and
	// rebuild elkToCellMap with unprefixed keys so shared.js's pinning
	// (which uses raw cell ids) and the applier (which looks up by
	// stripped id) both work.
	_renameTree(elkGraph);

	var origMap = adapter.getElkToCellMap();
	var rawMap = {};
	for (var k in origMap) rawMap[_stripPrefix(k)] = origMap[k];

	// For the `layered` algorithm, apply mermaid-elk's hierarchyHandling
	// policy — the same pass drawio-dev's ElkLayout facade runs by default.
	// On a flat mermaid flowchart it does only two things:
	//   1. drops elk.layered.crossingMinimization.forceNodeModelOrder and
	//      elk.layered.considerModelOrder.strategy at the root so
	//      crossing-minimization is free to pick a "natural" within-layer
	//      ordering instead of preserving mermaid's declaration order
	//      (which causes mirrored or top-stacked layouts for flowcharts
	//      with multiple branches off decision diamonds);
	//   2. sets spacing.baseValue=35 + elk.layered.unnecessaryBendpoints=true.
	// On compound graphs it additionally flips per-subgraph hierarchyHandling
	// to SEPARATE_CHILDREN by default and walks the LCA of each cross-
	// boundary edge to flip ancestors back to INCLUDE_CHILDREN — a no-op for
	// drawio-mcp today since mermaid flowcharts are flat, but harmless if
	// compound diagrams start showing up here.
	if (this.algorithm === 'layered' && typeof ElkLayout !== 'undefined'
			&& typeof ElkLayout.applyMermaidElkPolicy === 'function')
	{
		ElkLayout.applyMermaidElkPolicy(elkGraph);
	}

	this._adapter = adapter;
	this._elkToCellMap = rawMap;
	this._portCells = adapter.getPortCells();
	this._reversedEdges = adapter.getReversedEdges();

	return elkGraph;
};

// ─── applyElkLayout ──────────────────────────────────────────────

mxElkLayout.prototype.applyElkLayout = function(elkGraph)
{
	if (typeof ElkApplier === 'undefined')
	{
		throw new Error('ElkApplier not available. Load drawio-elk.min.js before mxElkLayout.js.');
	}

	if (this._adapter == null)
	{
		throw new Error('applyElkLayout called before buildElkGraph.');
	}

	var applier = new ElkApplier(this.graph,
		this._elkToCellMap,
		this._portCells,
		{
			reversedEdges: this._reversedEdges,
			// applyEdgeRouting=true makes the applier overwrite exitX/Y
			// and entryX/Y on each edge with ELK's computed endpoint
			// (snapped to the next waypoint so the first segment stays
			// orthogonal). Without it, mermaid's pre-set fractional values
			// (e.g. exitX=0.69) survive and drawio's orthogonal router
			// produces visibly off-axis terminals.
			//
			// resetEdgePoints=true clears any stale mxPoint waypoints on
			// the edge geometry before writing ELK's new bend points, so
			// pre-existing routing from the mermaid import or a previous
			// layout run doesn't leak through.
			applyEdgeRouting: true,
			resetEdgePoints: true,
			// drawio-mcp doesn't grow compounds to fit children — the
			// mermaid import already sized subgraph containers correctly.
			resizeParent: false
		});

	applier.apply(elkGraph);
};

// ─── executeAsync / execute (unchanged from the original) ───────

mxElkLayout.prototype.executeAsync = function(parent)
{
	if (typeof ELK === 'undefined')
	{
		return Promise.reject(new Error('ELK library not loaded. Include drawio-elk.min.js before mxElkLayout.js.'));
	}

	var self = this;
	var model = this.graph.getModel();
	var elkGraph = this.buildElkGraph(parent);

	if (elkGraph.children == null || elkGraph.children.length === 0)
	{
		return Promise.resolve();
	}

	return new ELK().layout(elkGraph).then(function(result)
	{
		model.beginUpdate();
		try { self.applyElkLayout(result); }
		finally { model.endUpdate(); }
	});
};

mxElkLayout.prototype.execute = function(parent)
{
	this.executeAsync(parent).catch(function(err)
	{
		if (typeof mxLog !== 'undefined') mxLog.warn('mxElkLayout error: ' + err.message);
		else console.warn('mxElkLayout error:', err);
	});
};

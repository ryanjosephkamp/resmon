---
title: "Map Regions"
summary: "How the map groups and names papers, what its colors mean, and how to find a region."
order: 23
---
A **region** is a group of papers with similar vectors in one collection's map. It is computed from the papers that collection holds, rather than taken from a publisher's subject categories. A paper held in two collections can belong to a different region in each.

## How Regions Are Made

The map uses the embedding model's vectors once that model has embedded at least 90% of the collection. Until then, it uses word statistics from titles and abstracts: words and adjacent word pairs, weighted for how distinctive they are, and reduced to a smaller vector. The map's heading states which basis it used. A map based on wording does not claim to place papers by meaning.

Spherical k-means groups unit vectors into roughly the square root of half the number of papers, capped at 240 regions. With fewer than four placeable papers there is one region. The region centers are arranged in two dimensions, then their discs are pushed apart. A disc's area follows its paper count. Papers are placed inside their region using the region's main directions of variation and their distance from its center.

A region's name and supporting terms come from words particularly distinctive of its papers, even when embeddings supplied the positions. The label is lexical, not a model's summary. A new fit can change membership, labels, and positions. Papers with insufficient text or unavailable embeddings can be unplaced; the map counts them.

The drawing preserves useful neighborhoods while flattening many dimensions into two. It does not preserve every distance, and two far-apart points do not provide a numerical measure of how different the papers are.

## Colors, Sorting, and Filtering

On Today, **Color › Region** gives neighboring regions different colors. A run's map is colored by source, and its **Regions** list still shows each region's name and count. The palette is checked in both light and dark themes. Colors are assigned from the spatial arrangement of region centers, rather than region numbers; distant regions can reuse a color. A color is not a subject identifier and can change after a new fit.

**Regions** opens the region list with each region's name, color, and paper count on this map. **Sort Regions** orders it by **Most Papers** or **Name**. **Find a Region** filters names as you type. Tick regions to light their papers and dim the others, combining that choice with the map's other filters and find. **Clear Regions** removes this restriction. These region choices last in the current window; they are not permanent classifications of the papers.

A run's map retains the whole collection's region identities and names, while framing the papers in that run. The counts in its Regions list cover that run's mapped papers. See [Today](/resmon/guide/today/) for the rest of the map controls.

/**
 * J18 Reports and exports — the five report tabs are reachable, and two runs
 * selected together export one entry per paper.
 *
 * The second half is PR113's defect, which is why it is in this slice: the
 * BibTeX export used to give a paper one entry per run it appeared in, with a
 * duplicated citation key, so a reference manager silently kept one of them.
 * Two dives over the same authored source produce two runs that found the same
 * two papers, which is the exact shape that broke — and a per-run count would
 * say four.
 */
import { expect, journey } from './driver';

journey.describe('J18 Reports and exports', () => {
  journey('the report tabs are there, and two runs export one entry per paper', async ({ resmon }) => {
    const first = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.waitForRunToSettle(first)).status).toBe('completed');
    const second = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.waitForRunToSettle(second)).status).toBe('completed');

    // The corpus holds each paper once; the two runs both point at them.
    const papers = (await resmon.backend.corpusCounts()).documents;
    expect(papers, 'the authored source stored no papers to export').toBeGreaterThan(0);

    await resmon.openReport(first);
    const tabs = await resmon.readReportTabs();
    // The register names five: report, log, metadata, events and the search
    // record. Asserted by name rather than by count, because the viewer has
    // since grown a sixth (Papers) and a count would have gone red for a
    // feature being added.
    for (const wanted of ['Report', 'Log', 'Metadata', 'Search record']) {
      expect(tabs, `the report viewer has no ${wanted} tab`).toContain(wanted);
    }
    expect(
      tabs.some((t) => t === 'Progress' || t.startsWith('Progress')),
      'the report viewer has no events/progress tab',
    ).toBe(true);
    console.log(`[J18] report tabs: ${tabs.join(' | ')}`);

    const bibtex = await resmon.exportReferences([first, second], 'bibtex');
    const keys = [...bibtex.matchAll(/^@\w+\{([^,]+),/gm)].map((m) => m[1]);
    expect(
      keys.length,
      `two runs over ${papers} papers exported ${keys.length} entries`,
    ).toBe(papers);
    expect(new Set(keys).size, 'a citation key was reused').toBe(keys.length);

    await resmon.takePicture('J18-reports-and-exports');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});

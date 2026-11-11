"""A run's map groups recorded DOI copies and keeps every source attribution."""
from implementation_scripts.run_map import membership


def test_shared_doi_is_one_mark_with_every_source_and_all_stored_ids():
    rows = [dict(id=1, source_repository='arxiv', doi='https://doi.org/10.1/GRAPH'),
            dict(id=2, source_repository='plos', doi='10.1/graph'),
            dict(id=3, source_repository='plos', doi=None),
            dict(id=4, source_repository='arxiv', doi=None)]
    said = membership(rows, {'repositories': ['plos', 'arxiv', 'hal']})
    assert said['ids'] == [1, 2, 3, 4]
    assert said['sources'] == ['plos', 'arxiv', 'hal']
    assert said['papers'] == [dict(id=1, copies=[1, 2], sources=['arxiv', 'plos']),
                              dict(id=3, copies=[3], sources=['plos']),
                              dict(id=4, copies=[4], sources=['arxiv'])]

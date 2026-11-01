---
title: "Acknowledgments"
summary: "The open-access repository providers, the open-source foundations and the standards bodies resmon is built on."
order: 16
readmeLines:
  - "1567-1609"
---
## Acknowledgments

resmon is built on top of a broad ecosystem of open-access scholarly repositories and open-source software. The project gratefully acknowledges:

### Open-Access Repository Providers

The scholarly sources registered in the repository catalog, whose public APIs make automated literature surveillance possible:

- **arXiv** — Cornell University / arXiv.org, for the Atom XML API and the decades-long commitment to open preprint distribution in physics, mathematics, computer science, quantitative biology, statistics, electrical engineering, and economics.
- **bioRxiv** and **medRxiv** — openRxiv, for the date-range JSON API serving the life- and health-sciences communities.
- **CORE** — The Open University / Jisc, for the aggregated open-access JSON API spanning tens of thousands of repositories worldwide.
- **CrossRef** — Crossref, for the DOI-indexed REST API and the "polite pool" that rewards well-behaved clients with priority rate limits.
- **DataCite** — DataCite, for the public DOI metadata REST API. Metadata from DataCite.
- **DBLP** — Schloss Dagstuhl / University of Trier, for the computer-science bibliography REST API.
- **Dryad** — Dryad, for the dataset search API and its ORCID-bearing author records.
- **DOAJ** — Directory of Open Access Journals / Infrastructure Services for Open Access C.I.C., for the journal- and article-level JSON API covering open-access journals across disciplines.
- **ERIC** — Institute of Education Sciences, U.S. Department of Education, for the public education-research API.
- **EuropePMC** — EMBL-EBI on behalf of the Europe PMC Consortium, for the biomedical and life-sciences REST API.
- **GovInfo** — U.S. Government Publishing Office, for the GovInfo Search Service and its official bibliographic fields.
- **HAL** — CCSD / CNRS, for the Solr-backed multi-disciplinary JSON API.
- **INSPIRE-HEP** — CERN and the INSPIRE collaboration, for the curated high-energy-physics literature API.
- **NASA ADS** — Smithsonian Astrophysical Observatory / NASA Astrophysics Data System, for the Solr-backed astronomy, astrophysics, and planetary-science API.
- **NDL Search** — National Diet Library, Japan, for the SRU open-metadata API. Powered by NDL Search API. Metadata provided by the National Diet Library and its contributing databases and institutions.
- **NIST Resource Metadata Management** — National Institute of Standards and Technology, for the RMM paper-search API. Data created by NIST (National Institute of Standards and Technology).
- **OpenAIRE** — the OpenAIRE partnership, for the multi-disciplinary scholarly-graph Search API.
- **OpenAlex** — OurResearch, for the free, comprehensive scholarly-works REST API and the mailto-based polite-pool rate tier.
- **Open Library** — Internet Archive, for the public work-metadata search API.
- **OSTI.GOV** — Office of Scientific and Technical Information, U.S. Department of Energy, for the public research-record API. Courtesy of OSTI.GOV, U.S. Department of Energy.
- **PLOS** — Public Library of Science, for the Solr-backed JSON API over the PLOS journal family.
- **PubMed / NCBI E-utilities** — U.S. National Library of Medicine / National Center for Biotechnology Information, for the E-utilities suite that underpins biomedical literature retrieval.
- **Semantic Scholar** — Allen Institute for AI (AI2), for the cross-disciplinary scholarly-graph REST API.
- **Springer Nature** — Springer Nature, for the Meta API covering STM, humanities, and social-sciences content.
- **Zenodo** — CERN and OpenAIRE, for the multi-disciplinary research-output records API.

### Open-Source Foundations

resmon depends on and is grateful for the following open-source projects (non-exhaustive): **Python**, **FastAPI**, **Starlette**, **Uvicorn**, **Pydantic**, **httpx**, **lxml**, **BeautifulSoup**, **SQLAlchemy**, **APScheduler**, **cryptography**, **keyring**, **NLTK**, **tiktoken**, **pytest**, **Electron**, **Node.js**, **React**, **React Router**, **TypeScript**, **Vite**, **electron-builder**, and **ollama**. The maintainers and contributors of these projects make a desktop-class literature surveillance tool buildable by a single developer.

### Standards and Identifiers

resmon relies on the **DOI** system administered by the International DOI Foundation and the **ORCID** identifier system — both of which underpin the deduplication and citation-graphing pipeline.

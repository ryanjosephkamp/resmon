# resmon_scripts/implementation_scripts/api_pubmed.py
"""PubMed / NCBI E-utilities API client — two-step esearch → efetch, XML parsing."""

import logging
import xml.etree.ElementTree as ET

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)

_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

# 3 req/s without API key, 10 req/s with key
_RATE_LIMITER = RateLimiter(requests_per_second=3.0)


class PubmedClient(BaseAPIClient):
    """PubMed / NCBI E-utilities repository API client."""

    def get_name(self) -> str:
        return "PubMed"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        # Step 1: esearch to get PMIDs
        pmids = self._esearch(query, date_from, date_to, max_results)
        if not pmids:
            return []

        # Step 2: efetch to get full records
        return self._efetch(pmids)

    def _esearch(
        self, query: str, date_from: str | None, date_to: str | None, max_results: int
    ) -> list[str]:
        params: dict = {
            "db": "pubmed",
            "term": query,
            "retmax": max_results,
            "retmode": "json",
            "sort": "pub_date",
        }
        if date_from:
            params["mindate"] = date_from.replace("-", "/")
            params["datetype"] = "pdat"
        if date_to:
            params["maxdate"] = date_to.replace("-", "/")
            params["datetype"] = "pdat"
        api_key = get_credential_for(self._exec_id, "pubmed_api_key")
        if api_key:
            params["api_key"] = api_key

        try:
            response = safe_request(
                "GET", _ESEARCH_URL,
                params=params,
                rate_limiter=_RATE_LIMITER,
            )
            if response.status_code != 200:
                logger.error("PubMed esearch returned %d", response.status_code)
                return []
        except Exception:
            logger.exception("PubMed esearch request failed")
            return []

        data = response.json()
        return data.get("esearchresult", {}).get("idlist", [])

    def _efetch(self, pmids: list[str]) -> list[NormalizedResult]:
        results: list[NormalizedResult] = []
        api_key = get_credential_for(self._exec_id, "pubmed_api_key")
        # Fetch in batches of 200
        batch_size = 200
        for i in range(0, len(pmids), batch_size):
            batch = pmids[i : i + batch_size]
            params: dict = {
                "db": "pubmed",
                "id": ",".join(batch),
                "rettype": "xml",
                "retmode": "xml",
            }
            if api_key:
                params["api_key"] = api_key

            try:
                response = safe_request(
                    "GET", _EFETCH_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("PubMed efetch returned %d", response.status_code)
                    continue
            except Exception:
                logger.exception("PubMed efetch request failed")
                continue

            results.extend(self._parse_xml(response.text))

        return results

    @staticmethod
    def _parse_xml(xml_text: str) -> list[NormalizedResult]:
        results: list[NormalizedResult] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            logger.error("Failed to parse PubMed XML response")
            return results

        for article_el in root.findall(".//PubmedArticle"):
            medline = article_el.find("MedlineCitation")
            if medline is None:
                continue

            pmid_el = medline.find("PMID")
            pmid = pmid_el.text.strip() if pmid_el is not None and pmid_el.text else ""

            article = medline.find("Article")
            if article is None:
                continue

            # Title
            title_el = article.find("ArticleTitle")
            title = title_el.text.strip() if title_el is not None and title_el.text else ""
            if not title:
                continue

            # DOI
            doi = None
            article_data = article_el.find("PubmedData")
            if article_data is not None:
                for id_el in article_data.findall(".//ArticleId"):
                    if id_el.get("IdType") == "doi" and id_el.text:
                        doi = id_el.text.strip()
                        break

            # Authors
            authors = []
            author_list = article.find("AuthorList")
            if author_list is not None:
                for author_el in author_list.findall("Author"):
                    last = author_el.findtext("LastName", "").strip()
                    first = author_el.findtext("ForeName", "").strip()
                    name = f"{first} {last}".strip()
                    if name:
                        authors.append(name)

            # Abstract
            abstract_el = article.find("Abstract/AbstractText")
            abstract = abstract_el.text.strip() if abstract_el is not None and abstract_el.text else None

            # Publication date
            pub_date = article.find("Journal/JournalIssue/PubDate")
            publication_date = None
            if pub_date is not None:
                year = pub_date.findtext("Year", "")
                month = pub_date.findtext("Month", "01")
                day = pub_date.findtext("Day", "01")
                # Month may be textual (e.g. "Jan")
                month_map = {
                    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
                    "may": "05", "jun": "06", "jul": "07", "aug": "08",
                    "sep": "09", "oct": "10", "nov": "11", "dec": "12",
                }
                month = month_map.get(month.lower()[:3], month.zfill(2))
                if year:
                    publication_date = f"{year}-{month}-{day.zfill(2)}"

            url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"

            # MeSH terms as categories
            categories = []
            mesh_list = medline.find("MeshHeadingList")
            if mesh_list is not None:
                for mesh in mesh_list.findall("MeshHeading/DescriptorName"):
                    if mesh.text:
                        categories.append(mesh.text.strip())

            results.append(NormalizedResult(
                source_repository="pubmed",
                external_id=pmid,
                doi=doi,
                title=title,
                authors=authors,
                abstract=abstract,
                publication_date=publication_date,
                url=url,
                categories=categories[:10],
            ))

        return results


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("pubmed", PubmedClient)

_register()

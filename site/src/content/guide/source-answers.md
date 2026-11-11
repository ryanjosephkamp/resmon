---
title: "What a Source's Answer Means"
summary: "Each outcome a source can have on a run, what resmon does before it records one, and what each HTTP status code means."
order: 21
---
Every run asks each of its sources and records what came back. resmon says each source's outcome in a few words on the run's page, the Runs list, the run monitor, Today, the Source Wall, the finished-run notification, and the run's report, and the same words mean the same thing everywhere. This page says what each outcome means, what resmon does before it records one, and what each HTTP status code a source can send says about a search.

## The Outcomes

Only **answered, zero** says that a source has nothing for your search. Every outcome below it, except **answered; none had every term**, which is an answer the terms filtered out, is a source resmon could not count an answer from, and a run never treats one of those as an empty field.

| Outcome | What it means |
|---|---|
| **answered** | The source replied with papers. The count is what it returned, not what was new to your collection. |
| **answered, zero** | The source replied (HTTP 200), and its reply held no papers: nothing matched your search. A quiet field, not a fault. |
| **answered; nothing storable** | The source replied with records resmon may not keep, because of their rights statement, or that were too incomplete to keep. The sentence gives the counts. |
| **answered; none had every term** | With **All Terms**, a source that ranks by relevance (Crossref, Semantic Scholar) replied with records, and none had every term in its title or abstract, so resmon kept none. The sentence gives how many it sent. |
| **answered in part** | The source answered every page resmon asked for, and resmon stopped at its own time budget for the search or at the run's cap. The sentence says which stretch of the window was read. Only bioRxiv and medRxiv, which resmon reads in date order, can be answered in part. |
| **answered, partial** | The source returned papers, and then a later request failed. The papers it returned are kept, and the set may be incomplete. |
| **reply unreadable** | The source replied (HTTP 200), and resmon could not read the reply: it was empty, broken, or an access-challenge page. Not a zero. |
| **rate-limited** | The source answered HTTP 429, too many requests: it is up, and asked resmon to slow down. Or resmon held back because the source had told an earlier request to wait, and that wait had not run out. Where the source said when it may be asked again, resmon says "try again after about 3:40 PM" in your computer's time while that time is still ahead. Not a zero. |
| **did not answer** | The source was asked, and resmon got no answer it could count: an error status (see the table below), a request that timed out, a connection that could not be opened, an error in place of results, or resmon's own time limit for the search running out. The sentence says which, and how many times resmon asked. Not a zero. |
| **read part of the window** | The source answered the pages resmon read, in date order, and a later request failed before the whole window was read. The sentence says how far it got. |
| **stopped by you** | You stopped this source with **Stop This Source** or **Stop Unfinished Sources**. The papers it had returned are kept. It is neither an answer nor a failure, and the rest of the run went on. |
| **canceled before it answered** | You stopped the whole run while this source was being asked. |
| **not asked** | resmon never put the question to this source. The run's selection did not include it, the run ended before reaching it, it needs an API key you have not added (**no API key configured**), it has been withdrawn from resmon (**withdrawn**), it cannot answer a window that short (**could not answer this window**), or it has no way to be asked about a person (**entity unsupported**). |
| **outcome not recorded** | resmon did not observe what happened. It is never counted as an answer or as a failure. A source that returned nothing with no reason on record reads **zero, reason not recorded**. |

On the Source Wall the same outcomes are drawn as eight marks. **could not be asked** gathers the sources that were not asked for a key, a withdrawal, a window, or a person; **not asked on this run** is a source the run's selection left out; and **failed** gathers **did not answer** and **reply unreadable**.

## What resmon Does Before It Records a Non-Answer

- **Most sources.** A request answered 429, 500, 502, 503, or 504, one that timed out, and one whose connection could not be opened is asked again up to three more times, after 1, 2, and 4 seconds. Any other status is recorded at once.
- **When a source says how long to wait.** A source's Retry-After holds every request to that source, from every run, until it has passed. A search that cannot wait that long records the source as **rate-limited**, with the time.
- **arXiv.** arXiv's 429 and 503 are waited out: 5 seconds, then twice as long each time, or longer when arXiv's Retry-After asks for longer. A search you start waits up to 3 minutes in all. A watch's scheduled run, which nobody is waiting on, waits up to 15 minutes, and no single wait is longer than 5 minutes.
- **Sources with rules of their own.** bioRxiv, medRxiv, ERIC, and DBLP share one 45-second budget for a search, with one bounded retry; see [Source response reliability](/resmon/source-response-reliability/). HAL, INSPIRE-HEP, and Zenodo also set their own retries.

## The Codes a Source Can Send

The number a source sends with each reply is its HTTP status code. This is what each says about a search, and what resmon records.

| Code | What it means for a search | resmon records |
|---|---|---|
| 200 | The source answered. The answer can still hold no papers: nothing matched. | **answered**, or **answered, zero** |
| 200, unreadable | The source answered with an empty or broken page, or a challenge page. | **reply unreadable** |
| 301, 302, 307, 308 | The address moved. resmon follows it on its own and records the answer from the new address. | the answer from the new address |
| 400 | The source could not read the query, usually its syntax or length. A source can also refuse an empty search, from a run with no terms. | **did not answer** |
| 401, 403 | A key is missing or wrong, or the site refuses automated requests. | **did not answer** |
| 404 | Not found: a wrong address, or a record that is gone. When resmon asks Crossref, OpenAlex, DataCite, or Semantic Scholar for one record by its identifier, a 404 is that source saying it holds no such record. | **did not answer**; **answered, zero** for one record asked for by its identifier |
| 409 | The source refused the request as it was written. | **did not answer** |
| 413, 414 | The request, or its address, was too long. | **did not answer** |
| 429 | Too many requests: slow down. The source may say when to try again. | **rate-limited** |
| 500 | The source's own error. | **did not answer**, after asking again |
| 502, 504 | A server in front of the source got no answer from it in time. | **did not answer**, after asking again |
| 503 | The source is overloaded or down for maintenance. arXiv also uses it to ask for a slower pace. | **did not answer**, after asking again |
| No code | No reply at all: the request timed out (resmon waits 30 seconds for a reply by default), or no connection could be opened, often because of your own network. | **did not answer**, after asking again |

## Where to Read More

- A run's page gives each source's outcome with its own sentence, under **Sources**.
- [**Health › Source Wall**](/resmon/guide/health/) puts each source's outcomes side by side across the last runs, and **Health › Watchdog** says when a source has failed run after run.
- [Source response reliability](/resmon/source-response-reliability/) covers the sources whose replies can be unreadable, and what a failed search records.

---
title: "Today"
summary: "The collection as a map, and the papers that arrived since you last marked all read."
order: 4
---
**Today** is the first screen in the top bar, and the one resmon opens on, unless you change either in **Settings › Top Bar**. On the left is a map of every paper in the collection the window shows. On the right is the list of papers that arrived in it since you last looked.

## What Counts as New

A paper is new when a run **put it in the collection** after the last time you pressed **Mark All Read** there. That is a fact about your database, not about the paper: a paper published years ago and found last night is new, and a paper published last night that the collection already held is not. Each collection has its own Today and its own **Mark All Read**. A paper resmon held in another collection that a watch found again for this one is new here, because it was not here before; a paper you moved or copied in is not.

Opening Today records nothing, so an accidental open does not empty tomorrow's list. Before you have ever pressed **Mark All Read**, Today shows the last seven days and says so (**New This Week**). **Mark All Read** is the only thing that moves the line, and it deletes nothing. **Settings › Danger Zone › Reset All Settings** clears the mark.

Today reads the newest 1,000 new papers first. When there are more, the list says "The newest 1,000 of M are listed and ringed on the plate", and **List the 1,000 Before Them** reads the next ones, as many times as it takes to list every one. The map covers the whole collection, including papers outside the list, and counts papers it cannot place.

Each listed paper has **Open Its Page**, which opens the paper’s own page without saving it to the reading queue, and **Paper Actions**, which saves it to read, adds it to a project, or gets or reads its PDF. A paper already saved to read shows a bookmark beside them, so you can see it at a glance.

## The Map

The map is called the plate. Each paper is a point, and papers near each other have similar text. The heading card on the plate says how many papers are new, how many you hold in all, and **how the map placed them**:

- **"placed by how close their meaning is, as your embedding model (name) reads it."** The positions come from the embedding model you set in **Settings › AI**. resmon uses it only once the model has embedded at least 90% of the collection.
- **"placed by how much wording they share, worked out on this computer."** Until then, positions come from word statistics over titles and abstracts, with no network and no key. The card says what share your embedding model has read so far, and the map is redrawn by meaning at 90%.

A map flattens many dimensions into two, so it is a drawing of similarities, not a measurement. Papers in one region are similar to one another, and neighboring regions are more alike than distant ones. The exact distance between two far-apart papers is not kept. Regions are named by the words most distinctive of their papers, whichever way the papers were placed, so a region's name is always made of words. Papers with too little text to place are not on the map, and the card counts them.

See [Map Regions](/resmon/guide/regions/) for the grouping method, neighboring colors, and the **Regions** list with sorting and filtering.

### Reading the Plate

- **Rings and numbers.** A listed new paper is ringed, and its number is the order it was collected in, counted over every new paper: 1 is the first to arrive, so a paper keeps its number as earlier ones are listed. The same number is on its entry in the list.
- **Size and brightness** show how long ago resmon collected a paper. The key under the plate steps through 0, 7, 30, 90, and 180 days since collected.
- **A dashed outline** encloses one watch's papers.
- **Shading** marks where more papers sit nearby.
- **Pointing at a paper** shows its title, authors, source, its grid cell (such as B3), and when it was collected.
- **From the keyboard**, with the map focused, **Enter** chooses the paper nearest the middle and **Shift** with an arrow key the nearest one that way. The chosen paper is named in the same tip, and **Escape** clears the choice.
- **Clicking a paper** opens it beside the map, with **Back to the list** to return.

Scroll or pinch to zoom, and drag to move. The buttons at the corner zoom in, zoom out, and show the whole collection again.

### Find, Filter, and Color

The bar above the map has four controls: find, **Filters**, **Regions** (see [Map Regions](/resmon/guide/regions/)), and **Color**. They change what is lit, not what exists. Papers the filters leave out are dimmed, so the map keeps its shape.

- **Find a title or author** lights papers whose title or authors contain what you typed, once you have typed two letters. **Enter** and **Shift+Enter** step through the matches.
- **Filters** narrow by **Watch**, **Source**, **Dates**, and **Your reading**. Under **Dates** you choose whether to read the dates as when resmon found a paper or when it was published. The published date is the one each source recorded, and a paper with no publication date is dimmed once either day is set.
- **Color** colors the papers by **Region**, **Watch**, **Source**, or **Age**. For a watch or a source it colors the four with the most papers here, each its own color.

While a find or a filter leaves some papers dimmed, **Save N to Read** after the count saves the papers lit, and nothing the map dims, to your **Library** at once. The same bar on a run's map does the same for the run's papers (a run's map has no **Color**; it colors by source).

resmon keeps the filters and colors you chose in its database and restores them the next time you open Today.

## The List

The list's heading names the window (**New Since** a day, or **New This Week**) with a count. **By Watch** and **By Region** regroup it. A paper belongs to every watch whose runs returned it, so it can sit under two watches. Papers no watch returned came from your own searches and are under **From Your Own Searches**.

Under each watch's name is its last run: when it ran, how long it took, how many papers it found, and how many of its sources answered. If any source did not answer, one line names each source by what happened to it, with one mark for a failure and another for an unknown, and **Why** opens each source's own sentence. A source that rate-limited the run is said to have been rate-limited, with "try again after about 3:40 PM" where it gave a time that is still ahead. **Open run** and its number lead to the run's whole record. A watch that found nothing new is listed under **Nothing new from**, with its last run, so a quiet watch and a broken one are told apart here too.

Each paper shows its number, its title, any retraction or correction recorded against it, its authors, its source, and its grid cell. Choosing the cell shows the paper on the map. A saved paper is in your **Library**, under **To Read**. **Select**, beside **Mark All Read**, puts a box beside each paper: pick some, or **Select All** (with the count) for every new paper, listed yet or not, and **Save to Read** saves them at once. Below the title, **From the abstract** is the opening of the abstract as the source gave it. It is not a summary: resmon keeps model-written summaries only inside run reports.

Each group lists 25 papers at first, and **Show 50 More** lists the next 50.

## The Footer

The strip under the list says when your last backup was made ("No backup made yet." if none), and when the next runs are due (up to two times, with a count where several watches share one). It says "Next:" only for a watch something will actually run. If the only thing that could run it is a background service that may not be running, it says "if the background service is running". If nothing will run an active watch, it says why:

- no background service is set up
- the service is stopped
- the service did not answer
- the service is another version of resmon
- scheduling is off in this process

**Settings › In the Background** shows the state of the service. See [Install and Launch](/resmon/guide/install/).

## Without the Window

`resmon today` prints the newest 20 papers in a terminal, by watch, with the sources that did not answer on each watch's last run. `--all` prints the whole first page, up to 1,000; older pages are available in the app. Reading it marks nothing. `resmon today mark-read` does what **Mark All Read** does. Add `--collection` with a name or number for another collection; without it the command reads the default one.

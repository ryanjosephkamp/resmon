---
title: "Today"
summary: "The collection as a map, and the papers that arrived since you last marked all read."
order: 4
---
**Today** is the first screen in the top bar, and the one resmon opens on, unless you change either in **Settings › Top bar**. On the left is a map of every paper in the collection the window shows. On the right is the list of papers that arrived in it since you last looked.

## What counts as new

A paper is new when a run **put it in the collection** after the last time you pressed **Mark all read** there. That is a fact about your database, not about the paper: a paper published years ago and found last night is new, and a paper published last night that the collection already held is not. Each collection has its own Today and its own **Mark all read**. A paper resmon held in another collection that a watch found again for this one is new here, because it was not here before; a paper you moved or copied in is not.

Opening Today records nothing, so an accidental open does not empty tomorrow's list. Before you have ever pressed **Mark all read**, Today shows the last seven days and says so ("New this week"). **Mark all read** is the only thing that moves the line, and it deletes nothing. **Settings › Danger zone › Reset all settings** clears the mark.

Today reads the newest 1,000 new papers first. When there are more, the list says "The newest 1,000 of M are listed and ringed on the plate", and **List the 1,000 before them** reads the next ones, as many times as it takes to list every one. The map always shows every paper in the collection.

## The map

The map is called the plate. Each paper is a point, and papers near each other have similar text. The heading card on the plate says how many papers are new, how many you hold in all, and **how the map placed them**:

- **"placed by how close their meaning is, as your embedding model (name) reads it."** The positions come from the embedding model you set in **Settings › AI**. resmon uses it only once the model has embedded at least 90% of the collection.
- **"placed by how much wording they share, worked out on this computer."** Until then, positions come from word statistics over titles and abstracts, with no network and no key. The card says what share your embedding model has read so far, and the map is redrawn by meaning at 90%.

A map flattens many dimensions into two, so it is a drawing of similarities, not a measurement. Papers in one region are similar to one another, and neighboring regions are more alike than distant ones. The exact distance between two far-apart papers is not kept. Regions are named by the words most distinctive of their papers, whichever way the papers were placed, so a region's name is always made of words. Papers with too little text to place are not on the map, and the card counts them.

### Reading the plate

- **Rings and numbers.** A listed new paper is ringed, and its number is the order it was collected in, counted over every new paper: 1 is the first to arrive, so a paper keeps its number as earlier ones are listed. The same number is on its entry in the list.
- **Size and brightness** show how long ago resmon collected a paper. The key under the plate steps through 0, 7, 30, 90, and 180 days since collected.
- **A dashed outline** encloses one watch's papers.
- **Shading** marks where more papers sit nearby.
- **Pointing at a paper** shows its title, authors, source, its grid cell (such as B3), and when it was collected.
- **From the keyboard**, with the map focused, **Enter** chooses the paper nearest the middle and **Shift** with an arrow key the nearest one that way. The chosen paper is named in the same tip, and **Escape** clears the choice.
- **Clicking a paper** opens it beside the map, with **Back to the list** to return.

Scroll or pinch to zoom, and drag to move. The buttons at the corner zoom in, zoom out, and show the whole collection again.

### Find, filter, and color

The bar above the map has three controls. They change what is lit, not what exists. Papers the filters leave out are dimmed, so the map keeps its shape.

- **Find a title or author** lights papers whose title or authors contain what you typed, once you have typed two letters. **Enter** and **Shift+Enter** step through the matches.
- **Filters** narrow by **Watch**, **Source**, **Dates**, and **Your reading**. Under **Dates** you choose whether to read the dates as when resmon found a paper or when it was published. The published date is the one each source recorded, and a paper with no publication date is dimmed once either day is set.
- **Color** colors the papers by **Region**, **Watch**, **Source**, or **Age**. For a watch or a source it colors the four with the most papers here, each its own color.

While a find or a filter leaves some papers dimmed, **Save N to read** after the count saves the papers lit, and nothing the map dims, to your **Library** at once. The same bar on a run's map does the same for the run's papers.

resmon keeps the filters and colors you chose in its database and restores them the next time you open Today.

## The list

The list's heading names the window ("New since" a day, or "New this week") with a count. **By watch** and **By region** regroup it. A paper belongs to every watch whose runs returned it, so it can sit under two watches. Papers no watch returned came from your own searches and are under **From your own searches**.

Under each watch's name is its last run: when it ran, how long it took, how many papers it found, and how many of its sources answered. If any source did not answer, one line names each source by what happened to it, with one mark for a failure and another for an unknown, and **Why** opens each source's own sentence. **Open run** leads to the run's whole record. A watch that found nothing new is listed under **Nothing new from**, with its last run, so a quiet watch and a broken one are told apart here too.

Each paper shows its number, its title, any retraction or correction recorded against it, its authors, its source, and its grid cell. Choosing the cell shows the paper on the map. The bookmark saves a paper to your **Library**, under **To read**, and the arrow opens it at its source. **Select**, beside **Mark all read**, puts a box beside each paper: pick some, or **Select all** for every new paper, listed yet or not, and **Save to read** saves them at once. Below the title, **From the abstract** is the opening of the abstract as the source gave it. It is not a summary: resmon keeps model-written summaries only inside run reports.

Each group lists 25 papers at first, and **Show 50 more** lists the next 50.

## The footer

The strip under the list says when your last backup was made ("No backup made yet." if none), and when your next watch is due. It says "Next:" only for a watch something will actually run. If the only thing that could run it is a background service that may not be running, it says "if the background service is running". If nothing will run an active watch, it says why:

- no background service is set up
- the service is stopped
- the service did not answer
- the service is another version of resmon
- scheduling is off in this process

**Settings › In the background** shows the state of the service. See [Install and launch](/resmon/guide/install/).

## Without the window

`resmon today` prints the same list in a terminal, by watch, with the sources that did not answer on each watch's last run. Reading it marks nothing. `resmon today mark-read` does what **Mark all read** does.

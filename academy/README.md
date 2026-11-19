# Academy plugin

Learn Cubewise software the way you learn a language on Duolingo: one short lesson a day instead of a long training manual.

* Each lesson takes about 2 minutes: a one-line tip, then 5 quick exercises (multiple choice, true or false, fill in the blank, match the pairs, put the steps in order).
* Wrong answers come back at the end of the lesson until you get them right.
* Earn XP, keep your daily streak going, and climb the team leaderboard.
* Every lesson is open: start anywhere. "Today's lesson" suggests the first one you have not done yet, and finished lessons can be replayed to practise.
* Keyboard friendly: **1-9** picks an answer, **Enter** checks and continues.
* Each group of lessons starts with a one-sentence objective, and a search bar finds lessons by any word in their title, tip, questions or answers (**Esc** clears it).

There is one course per product, each written from that product's Confluence User Manual: **Slice** (SUM), **Arc** (AUM), **Pulse** (PUM) and **PowerConnect** (PUM1). A row of product buttons at the top switches between them and shows how many lessons of each you have done. Each lesson links back to the manual page it comes from.

The Slice course has a dedicated unit, **Building fast reports (best practices)**, based on *Building Fast Excel Reports with Slice*.

Open it from **Tools > Academy** on any TM1 instance.

## Edit the lessons: `lessons.json`

All the content is in [`lessons.json`](lessons.json), next to `plugin.js`. Change the file and press **Try again** (or reopen the tab): no code change and no Arc restart are needed.

```json
{
  "courses": [
    {
      "id": "slice",
      "title": "Slice",
      "icon": "fa-file-excel-o",
      "sourceUrl": "https://cubewisecare.atlassian.net/wiki/spaces/SUM/pages/{source}",
      "units": [
        {
          "id": "slice-basics",
          "title": "Slice basics",
          "icon": "fa-play",
          "objective": "One sentence: what the user can do after this group of lessons.",
          "lessons": [
            {
              "id": "slice-basics-1",
              "title": "What is Slice?",
              "tip": "One sentence shown before the exercises.",
              "source": 642875393,
              "exercises": [ ... ]
            }
          ]
        }
      ]
    }
  ]
}
```

* **Add a course** (for example Arc or Arc+) by adding an object to `courses`. With more than one course, the page shows a button per course.
* **`id`s must be unique and should not change**: progress is stored by lesson `id`. Renaming an `id` makes that lesson "not done" again for everyone. Do not put a comma in an `id`.
* **`icon`** is a Font Awesome 4 class, as used by Arc (`fa-play`, `fa-table`, `fa-search`...).
* **`color`** (optional, on a course) is the product colour, as `#RRGGBB`. The selected product button, the next-lesson button, the progress bars and the selected answers take it. Text on it turns dark on light colours. Current colours: Arc `#F08287`, Slice `#53B476`, Pulse `#5EA7DC`, PowerConnect `#F2C816`.
* **`objective`** (optional) is shown under the unit title. Keep it to one sentence.
* **`sources`** (optional, on a unit) lists the Confluence pages the unit's content comes from, as `[{ "title": "Building Fast Excel Reports with Slice", "source": 797179905 }]`. They are shown under the objective as links, after a book icon, built like a lesson's `source`.
* **`source`** is optional. With the course's `sourceUrl`, `{source}` is replaced by it to build the "Read more in the manual" link. A full `https://...` URL also works.
* An exercise that is not valid is skipped (and logged in the browser console); a lesson with no valid exercise is not shown.
* If the file is not valid JSON, the page says so and gives the line and column of the error.

### Exercise types

| type | Fields | Notes |
|---|---|---|
| `choice` | `q`, `options` (2+), `answer` | `answer` is the index of the right option, starting at 0 |
| `truefalse` | `q`, `answer` | `answer` is `true` or `false` |
| `fill` | `q`, `options`, `answer` | `q` contains one `___` where the chosen word goes |
| `match` | `q`, `pairs` | `[["DBRW", "Reads and writes a cell"], ...]`, 3 or 4 pairs work best. Pairs are matched one by one, so a slip only costs the XP |
| `order` | `q`, `items` | List the items **in the right order**; the plugin shuffles them |

Every type also takes `explain`: one sentence shown after the answer, right or wrong.

## Points

| | XP |
|---|---|
| Exercise right at the first try | 10 (5 when replaying a finished lesson) |
| Finishing a lesson for the first time | +10 |
| Perfect lesson, no mistakes | +10 |

The streak counts the days in a row with at least one finished lesson. The values are at the top of `plugin.js` (`ACADEMY_META`).

## Where progress is stored

The first time Academy opens on an instance, it creates three control objects:

| Object | What it is |
|---|---|
| `}Academy Measure` | Dimension: XP, Lessons, Streak, BestStreak, LastDay, Completed, DisplayName |
| `}Academy` | Cube: `}Clients` x `}Academy Measure`, one row per user |
| `}Academy.SaveProgress` | Process that saves a user's progress |

The process writes the row of the user who runs it (`TM1User()`), never a row passed as a parameter, so nobody can change someone else's score.

**Set-up for users who are not administrators.** Creating the objects needs an administrator: open Academy once as an admin on each instance. Then give the groups that should take the training:

* **READ** on the cube `}Academy` (to see their progress and the leaderboard), and
* **READ** on the process `}Academy.SaveProgress` (to run it and save their progress).

If a user cannot read the cube or run the process, Academy still works: progress is saved in that user's browser only, the leaderboard is hidden, and a message says to ask an administrator.

To reset everyone, clear the `}Academy` cube. To remove Academy, delete the cube, then the dimension and the process.

## Requirements

* Arc: tested on Arc 6.1.
* A TM1 instance with the REST API (TM1 11 or Planning Analytics).

## Developing it

Arc reads plugins when it starts: after adding the `academy` folder to Arc's `plugins` folder (and to `plugins.yml`), restart Arc once. After that, Arc rebuilds its plugin bundle when `plugin.js` changes, so a browser refresh is enough (clear the cache if the old page is still shown). Arc does not follow a folder link (junction or symlink) in its `plugins` folder: copy the folder.

<div align="center">
  <img src="static/images/logo_transparent.png" alt="BornoChinho" width="320">
  <p><em>Annotate. Preserve. Understand.</em></p>
</div>

# User Guide

How to use BornoChinho to review and correct document-layout annotations. For installation, see the [README](README.md).

## The workspace

Open `http://localhost:2828`. The window has four parts:

| Area | What it does |
| --- | --- |
| **Toolbar** (top left) | Load images, toggle the box overlay, clear boxes, switch theme, open About |
| **Image pane** (left) | Shows the page image; draw boxes here, zoom and page through images |
| **JSON pane** (right) | The annotation file as editable text, with find & replace and Save |
| **Status bar** (bottom) | Annotation count, image size, overlay state, and JSON validity |

Drag the divider between the two panes to resize them. Double-click it to return to the default 60/40 split. Your theme and split position are remembered between sessions.

## Two ways to load work

### Single files

- **Image** — loads one image into the left pane.
- **Load** (JSON pane) — loads one annotation file into the editor.

Use this for a quick look at one page.

### Mounted folders — recommended

- **Mount Images** — pick a folder of images.
- **Mount JSON** — pick a folder of `.json` annotation files.

BornoChinho pairs the two folders **by filename**, so `page_0003.png` pairs with `page_0003.json`. Pages sort naturally, meaning `page_2` comes before `page_10`. Once mounted, a page navigator appears in the JSON editor's header and a pager under each pane so you can step through the whole set (see [Paging through a set](#paging-through-a-set)), and **Save writes back to the original file in place** — no downloads, no re-filing.

You can mount just one folder and browse it alone, and re-mount either side later to switch folders.

> **Browser requirement:** Mounting needs the File System Access API — use **Chrome or Edge**, and open the app on `localhost`. A LAN address like `http://192.168.x.x` is not a secure context and mounting will be refused. Firefox and Safari can still use the single-file buttons, where Save falls back to a download.

The first time you save into a mounted folder, the browser asks for write permission. Grant it, or the file will not be written.

## Reviewing annotations

Click **Show Boxes** to draw every box from the JSON editor onto the image. Each box is colored by category and labeled with its category and entry number — its position in the file, the same number validation errors use:

| | | | | |
| --- | --- | --- | --- | --- |
| 🟩 Text | 🟩 List-item | 🟦 Page-header | 🟦 Page-footer | 🟪 Picture |
| 🟧 Table | 🟥 Title | 🟦 Section-header | 🟨 Caption | 🟪 Footnote |
| 🟩 Page-number | | | | |

The overlay is **live** — it redraws from whatever is in the editor right now, so fixing a coordinate in the text immediately moves the box on the image. It also works the other way: you can drag a box's sides on the image (see below). Entries with a missing or unusable `bbox` are skipped, so a partly-annotated file draws only the boxes it has.

Use the zoom controls (or `Ctrl` `+` / `-`) to inspect tight regions, and the reset button to fit the page back to the pane height.

## Editing boxes on the image

With **Show Boxes** on, you can adjust a box by dragging its sides instead of typing numbers.

1. **Click inside a box** to select it. It turns solid with a handle on each side, and its coordinates appear in the **Selected Rectangle** panel. The JSON editor highlights the box's entry and scrolls just far enough to show it (an entry taller than the editor shows its `bbox` lines). Where boxes overlap, the smallest box under the pointer is selected, so a box nested inside a larger one can still be picked.
2. **Drag a side.** Over the left or right side the cursor becomes ↔, over the top or bottom side ↕. Only the side you drag moves, and the panel shows its coordinates as you go.
3. **Release** to write the new coordinate into the JSON editor. Only that one number changes; the other three, and the rest of the entry, stay as they were. The entry stays in view.
4. **Save** to write the file to disk. Editing a box never saves on its own, and Save validates first as usual.

It works the other way too: put the cursor anywhere in an entry in the JSON editor — by clicking, with the arrow keys, or through Find — and that entry is highlighted and its box selected, ready to drag. On a zoomed-in page the image scrolls to show the box. An entry without a usable `bbox` is highlighted with no box selected.

Scrolled the editor away? Click inside the selected box again to bring its entry back. Clicking outside every box lets go of the selection and starts drawing a rectangle, as before. `Escape` also lets go. In the JSON editor, `Ctrl`+`Z` undoes a whole drag in one step.

- Dragged coordinates are whole pixels. A side stops 1 px short of the opposite side and at the edge of the image — never below 1, since validation requires every coordinate to be above zero.
- A press inside a box always selects it, so a rectangle cannot be drawn starting inside one. Hide the boxes first if you need to.
- Editing a box rewrites the editor text in the same two-space layout files are loaded with.

## Paging through a set

The **page navigator**, in the JSON editor's header beside its title, moves both panes together. `‹` and `›` step to the previous or next page, and the count between them (`3 / 120`) shows where you are. When the two panes are on different pages, the navigator follows the image: with the image on page 10 and the JSON on page 14, `›` puts both on page 11.

To jump straight to a page, click the count, type, and press `Enter`. `Escape`, or clicking elsewhere, cancels.

- **A number** goes to that position in the list, the number the count shows: `57` is the 57th file, whatever its name. A number past the end goes to the last page.
- **Anything else** is a file name, with or without its extension and in any case: `page_0057` or `page_0057.png`. A name that matches no page is outlined in red and the box stays open.

Positions and the numbers in file names part ways once a file is missing: without `page_0005`, position 5 is `page_0006`. A file named with digits alone, such as `0057.png`, is reached by its full name `0057.png`, because `0057` on its own is read as a position.

Each pane also has its own pager, so you can hold an image still while scrolling through neighbouring annotation files. When the two panes drift apart, both pagers highlight and a **Sync** button appears — click it to snap the JSON pane back to the image's page.

- Moving the JSON pane to another page discards unsaved edits in the editor, so save first. A pane the navigator finds already on the target page is left as it is.
- On a narrow JSON pane the header makes room by dropping, in turn, the font's name, the **Load** and **Mount JSON** labels, and last the **Save** label, leaving each button's icon — hover over one to see what it does.

## Editing the JSON

The editor is plain text, so you can fix anything by hand. The status bar tells you whether the JSON currently parses and how many entries it holds.

- **Find & replace** — `Ctrl`+`H` opens the bar; a counter shows how many matches were found. Use Replace for one match or Replace All for every match.
- **Right-to-left view** — the pilcrow button switches the editor to RTL, for annotating Arabic, Urdu, or other RTL scripts.
- **Text font** — the font button (marked **T**, and showing the current font's name) picks the font for the values of `text` keys, so Bengali, Arabic, or Urdu reads the way it should. Everything else — keys, numbers, brackets, and other values such as `category` — stays monospace. The same font is used for the text excerpts in the validation dialog. See [Text fonts](#text-fonts) below.
- **Zoom** — the floating controls in the editor scale the text independently of the image.

### Text fonts

| Group | Fonts |
| --- | --- |
| Default | Monospace |
| Bengali | Noto Sans Bengali, Noto Serif Bengali, Hind Siliguri, Tiro Bangla |
| Arabic & Urdu | Noto Naskh Arabic, Noto Sans Arabic, Amiri, Scheherazade New, Noto Nastaliq Urdu, Sakkal Majalla, Simplified Arabic, Traditional Arabic, KFGQPC HAFS Uthmanic Script |

- Your choice is remembered between sessions, like the theme and text direction.
- The Bengali fonts and the first five Arabic & Urdu fonts come from Google Fonts and download the first time you pick them, so they need an internet connection. Until the download finishes, or without a connection, the text shows in a fallback font.
- **Sakkal Majalla**, **Simplified Arabic**, **Traditional Arabic**, and **KFGQPC HAFS Uthmanic Script** cannot be downloaded, so they only work on a computer where they are installed. Where one is missing, the menu shows it greyed out as *Not installed*. On Linux, copy the font files into `~/.local/share/fonts/`, run `fc-cache -f`, and restart the browser.
  - Sakkal Majalla, Simplified Arabic, and Traditional Arabic come with Windows: `majalla.ttf` and `majallab.ttf`, `simpo.ttf` and `simpbdo.ttf`, `trado.ttf` and `tradbdo.ttf`.
  - KFGQPC HAFS Uthmanic Script is free from the King Fahd Glorious Qur'an Printing Complex (`UthmanicHafs_V22.ttf`). Older versions, which call the font *KFGQPC Uthmanic Script HAFS*, are not recognised.
- Sakkal Majalla draws about 30% smaller than the other Arabic fonts at the same size, so the editor shows it enlarged by 30% to match them.
- Noto Nastaliq Urdu makes lines taller than the other fonts do.
- On a narrow JSON pane the font's name is shortened, and on a very narrow one the button shows only the **T** — hover over it to see the name.

## Drawing new boxes

Drag on the image to draw a rectangle — while **Show Boxes** is on, start the drag outside every box. Very small drags (under a few pixels) are ignored so a stray click does not create a box. The new rectangle is selected automatically and its coordinates appear in the **Selected Rectangle** panel.

- `Delete` or `Backspace` removes the selected rectangle.
- The **trash** button clears all drawn rectangles, after a confirmation.

> **Note:** Drawn rectangles live in the image pane and are all created with the category `text`. They are a measuring aid for reading off coordinates — they are not written into the JSON file by Save. To add an annotation to the file, read the coordinates from the Selected Rectangle panel and type the entry into the editor.

## Saving

**Save** validates before it writes. The file is only written if validation passes with zero errors.

If problems are found, a dialog lists each one with the offending entry. Validation checks:

- **Schema** — exactly the required keys for the category, no missing or extra ones (`Picture` needs `bbox` and `category`; everything else also needs `text`)
- **Category** — must be one of the eleven known categories
- **Bounding box** — all coordinates positive, with `x1 < x2` and `y1 < y2`

Fix the entries the dialog names, then save again. On success the button briefly turns green and reads *Saved!*

Where the file goes depends on how it was loaded: a mounted file is **overwritten in place**; a single-file load is **downloaded** to your Downloads folder.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl`+`H` | Open find & replace |
| `Ctrl`+`+` / `Ctrl`+`-` | Zoom the image in / out |
| `Ctrl`+`0` | Reset image zoom |
| `Delete` / `Backspace` | Delete the selected rectangle |
| `Escape` | Close a dialog, or deselect the box being edited |
| `←` / `→` | Resize the panes (when the divider has focus) |
| `Home` | Reset the split (when the divider has focus) |

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| *Mount buttons show an error* | Browser lacks the File System Access API. Use Chrome or Edge on `localhost`. |
| *"No matching pairs found"* | Image and JSON filenames must match apart from the extension, e.g. `page_0003.png` / `page_0003.json`. |
| *"That folder contains no images / .json files"* | Wrong folder picked, or the files use an extension outside `png, jpg, jpeg, webp, bmp, gif` / `json`. |
| *Save says permission was declined* | The browser's write prompt was dismissed. Save again and allow it. |
| *"Invalid JSON format"* | The editor text is not valid JSON — check the status bar and look for a stray comma or bracket. |
| *Boxes do not appear* | **Show Boxes** is off, or entries lack a valid `bbox`. The status bar reports how many boxes are drawn. |
| *Dragging on the image selects a box instead of drawing* | With **Show Boxes** on, a press inside a box selects it. Start the drag outside every box, or hide the boxes. |
| *A dragged box did not change the file* | Box edits go into the editor only. Click **Save** to write them to disk. |
| *Some images have no annotations* | Images without a matching `.json` are skipped from the pairing; the browser console lists them. |

## Getting help

Click the **info** button in the toolbar for a quick in-app reference, or open an issue on [GitHub](https://github.com/mhshesher/borno_chinho).

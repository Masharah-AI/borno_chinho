<div align="center">
  <img src="static/images/logo_transparent.png" alt="BornoChinho" width="320">
  <p><em>Annotate. Preserve. Understand.</em></p>
</div>

# BornoChinho

A web-based image annotation tool for document layout datasets. Draw bounding boxes over a page image, then review and edit the resulting annotations as JSON in a side-by-side editor — with built-in validation for schema, categories, and bounding-box geometry.

## Features

- **Draw and edit boxes** over an uploaded image, with zoom, pan, and multi-image paging
- **Drag box sides on the image** — select a box from the JSON and move its sides; the coordinates update in the editor, ready to Save. Selecting a box highlights its entry in the editor, and putting the cursor in an entry selects its box
- **Live JSON editor** beside the canvas, with find & replace (`Ctrl`+`H`)
- **Validation** of annotation schema, category names, and bbox coordinates
- **HTML table style checking** for `Table` annotations (CSS property validation)
- **Light and dark themes**, resizable split view

## Project structure

```
app.py                  FastAPI app and routes
config.py               Host, port, schemas, categories, style rules
logger.py               Rotating file logging setup
services/
  supervisor.py         Annotation validation logic
  html_parser.py        HTML tag and CSS extraction for tables
templates/index.html    UI
static/                 Frontend JS, CSS, and images
```


## Requirements

- Python 3.10+

## Installation

```bash
git clone https://github.com/mhshesher/borno_chinho.git
cd borno_chinho

python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate

pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Then open `http://localhost:2828`. Host and port are set in [config.py](config.py).

New to the tool? See the [User Guide](USER_GUIDE.md) for how to load, review, and save annotations.

## Annotation format

Annotations are a JSON array of objects. Required keys depend on the category:

```json
[
  { "bbox": [120, 80, 640, 210], "category": "Title", "text": "Chapter One" },
  { "bbox": [100, 240, 700, 900], "category": "Picture" }
]
```

- `bbox` — `[x1, y1, x2, y2]`, positive integers with `x1 < x2` and `y1 < y2`
- `category` — one of `Picture`, `Title`, `Page-header`, `Section-header`, `Text`, `List-item`, `Table`, `Caption`, `Footnote`, `Page-footer`
- `text` — required for every category except `Picture`

Categories, expected font sizes, and allowed CSS styles are configurable in [config.py](config.py).


## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl`+`H` | Find & replace in the JSON editor |
| `Ctrl`+`+` / `Ctrl`+`-` | Zoom in / out |
| `Ctrl`+`0` | Reset zoom |
| `Delete` | Remove the selected drawn rectangle |
| `Escape` | Deselect the box being edited |
| `←` / `→` | Resize panes (when the divider is focused) |

Drag the divider between panes to resize; double-click it to restore the 60/40 split.

## Author

**Md. Mehedi Hasan** — Machine Learning Engineer
[GitHub](https://github.com/mhshesher) · [LinkedIn](https://www.linkedin.com/in/mehedi-shesher/)

## License

Released under the [MIT License](LICENSE).

© 2025–2026 Md. Mehedi Hasan.

// ---------------------------------------------------------------------------
// JSON editor
// Backed by CodeMirror so RTL mode can isolate each string VALUE as its own
// bidi run (see applyJsonDirection). The rest of the app predates that change
// and talks to the editor as if it were the original <textarea>, so this
// returns a shim exposing the same surface: .value, .setSelectionRange(),
// .focus(), .style.fontSize and addEventListener('input', ...).
//
// If CodeMirror fails to load the shim degrades to the real <textarea>, which
// keeps the app fully usable minus the per-value RTL isolation.
// ---------------------------------------------------------------------------
let jsonCM = null;
// True while the app itself replaces the editor text (loading a file, writing
// a dragged box side). The cursor moves then too, but it is not the user
// moving it, so the cursor -> box selection ignores it.
let jsonTextIsBeingSet = false;

function createJsonEditor(textarea) {
    if (!textarea || typeof CodeMirror === 'undefined') return textarea;

    jsonCM = CodeMirror.fromTextArea(textarea, {
        mode: { name: 'javascript', json: true },
        lineNumbers: false,
        lineWrapping: true,
        viewportMargin: Infinity,
    });

    // fromTextArea leaves the original <textarea> in the DOM, hidden. Move the
    // id onto the wrapper so #jsonEditor styling and getElementById reach the
    // visible editor - two elements sharing an id would silently resolve to the
    // hidden textarea and every style/class toggle would go nowhere.
    const wrapper = jsonCM.getWrapperElement();
    textarea.removeAttribute('id');
    wrapper.id = 'jsonEditor';

    return {
        cm: jsonCM,
        el: wrapper,

        get value() { return jsonCM.getValue(); },
        set value(v) {
            // Preserve the cursor so programmatic refreshes (updateJSON on every
            // box edit) don't yank the caret to the top while the user types.
            const cursor = jsonCM.getCursor();
            jsonTextIsBeingSet = true;
            try {
                jsonCM.setValue(v == null ? '' : String(v));
                jsonCM.setCursor(cursor);
            } finally {
                jsonTextIsBeingSet = false;
            }
        },

        get classList() { return wrapper.classList; },
        get style() { return wrapper.style; },

        focus() { jsonCM.focus(); },

        // Character offsets in / line-ch out, so find-and-replace keeps working.
        setSelectionRange(start, end) {
            jsonCM.setSelection(jsonCM.posFromIndex(start), jsonCM.posFromIndex(end));
        },

        addEventListener(type, handler) {
            if (type === 'input') jsonCM.on('change', handler);
            else wrapper.addEventListener(type, handler);
        },
    };
}

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const fileInput = document.getElementById('fileInput');
const jsonFileInput = document.getElementById('jsonFileInput');
const jsonEditor = createJsonEditor(document.getElementById('jsonEditor'));
const imagePlaceholder = document.getElementById('imagePlaceholder');
const annotationsList = document.getElementById('annotationsList');
const annotationCount = document.getElementById('annotationCount');
const cooridnatesPanel = document.getElementById('coordinatePanel');

let image = null;
let zoomLevel = 1.0;
let rectangles = [];
let isDrawing = false;
let startX, startY;
let currentImageFile = null;
let currentJsonFile = null;
// Handle for a JSON opened through the Load button, so saving can overwrite it
// in place. Null when the browser lacks the File System Access API and the
// hidden file input was used instead.
let loadedJsonHandle = null;
let selectedAnnotation = null;
let currentCategory = 'text';
// JSON editor zoom state
let jsonZoomLevel = 1.0;
const baseJsonFontSize = 13; // matches #jsonEditor font-size in style.css

// Category colors mapping
// Rectangle colours, drawn from the logo palette.
const categoryColors = {
    'text': '#4faf7f',
    'section': '#24647a',
    'image': '#a99bd4',
    'table': '#d3a06a'
};

fileInput.addEventListener('change', uploadImage);
jsonFileInput.addEventListener('change', uploadJSONFile);
canvas.addEventListener('mousedown', onCanvasMouseDown);
canvas.addEventListener('mousemove', onCanvasMouseMove);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseleave', stopDrawing);

// Category selection
document.querySelectorAll('.category-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        currentCategory = this.dataset.category;
    });
});

async function uploadImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    // FastAPI endpoint expects field name 'uploaded_file'
    formData.append('uploaded_file', file);
    
    try {
        const response = await fetch('/upload_image', {
            method: 'POST',
            body: formData
        });
        
        if (response.ok) {
            const data = await response.json();
            // Backend returns { name: <filename>, content: <base64> }
            currentImageFile = data.name || file.name;

            // Use the returned base64 content to display the image
            const mime = file.type || 'image/png';
            const src = `data:${mime};base64,${data.content}`;
            loadImage(src);
        } else {
            showToast('error', 'Failed to upload the image.');
        }
    } catch (error) {
        showToast('error', 'Error uploading the image: ' + (error.message || error));
    }
}

// Sends the file through /upload_json and shows the result in the editor.
async function displayJSONFile(file) {
    const formData = new FormData();
    // FastAPI endpoint expects field name 'uploaded_file'
    formData.append('uploaded_file', file);

    const response = await fetch('/upload_json', {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        let detail = 'Failed to load the JSON file.';
        try {
            const err = await response.json();
            if (err.detail) detail = file.name + ': ' + err.detail;
        } catch (e) { /* keep the generic message */ }
        showToast('error', detail);
        return false;
    }

    const data = await response.json();
    currentJsonFile = data.name || file.name;
    // A selection points into the old file's entries.
    clearBoxSelection();
    jsonEditor.value = JSON.stringify(data.content, null, 2);
    // A freshly loaded file starts clean.
    noteJsonDocumentLoaded();
    refreshBoundingBoxes();
    return true;
}

// The Load button. Uses the file picker where available so the chosen file can
// be overwritten in place on save; otherwise falls back to the hidden input,
// where saving can only download.
async function openJsonFile() {
    // Loading a file replaces the editor; don't drop unsaved edits silently.
    if (isJsonDirty()) {
        const name = currentJsonFile || 'the current file';
        if (!confirm('Unsaved changes in ' + name + ' will be LOST.\n\nDiscard the changes and load another file?')) {
            return;
        }
    }

    if (typeof window.showOpenFilePicker !== 'function') {
        jsonFileInput.click();
        return;
    }

    let handle;
    try {
        const picked = await window.showOpenFilePicker({
            id: 'bornochinho-single-json',
            multiple: false,
            types: [{
                description: 'JSON',
                accept: { 'application/json': ['.json'] }
            }]
        });
        handle = picked[0];
    } catch (e) {
        return; // dismissed
    }

    try {
        const file = await handle.getFile();
        if (await displayJSONFile(file)) {
            loadedJsonHandle = handle;
        }
    } catch (error) {
        showToast('error', 'Error opening the JSON file: ' + (error.message || error));
    }
}

async function uploadJSONFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Came through the plain input, so there is no handle to write back to.
    loadedJsonHandle = null;

    try {
        await displayJSONFile(file);
    } catch (error) {
        showToast('error', 'Error loading the JSON file: ' + (error.message || error));
    }
}

function loadImage(src) {
    image = new Image();
    image.onload = function() {
        rectangles = [];
        // Swap in the canvas before measuring, so the placeholder cannot
        // influence the available height.
        imagePlaceholder.style.display = 'none';
        canvas.style.display = 'block';
        zoomLevel = getFitToHeightZoom();
        displayImage();
        updateAnnotationsList();
        enableButtons();
        
        // Re-initialize Lucide icons if new elements were added
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    };
    // `src` can be a data URL or a path
    image.src = src;
}

// Zoom level at which the image height matches the visible canvas area.
function getFitToHeightZoom() {
    if (!image || !image.height) return 1.0;

    const area = document.querySelector('.canvas-area');
    if (!area) return 1.0;

    const styles = getComputedStyle(area);
    // getBoundingClientRect() ignores any horizontal scrollbar the *current*
    // zoom may have produced, so the fit does not depend on the zoom it
    // replaces. Subtract the border-box padding to get the usable height.
    const available = area.getBoundingClientRect().height
        - parseFloat(styles.paddingTop)
        - parseFloat(styles.paddingBottom)
        - parseFloat(styles.borderTopWidth)
        - parseFloat(styles.borderBottomWidth);

    if (!(available > 0)) return 1.0;
    return available / image.height;
}

function fitToHeight() {
    if (!image) return;
    zoomLevel = getFitToHeightZoom();
    displayImage();
}

function displayImage() {
    if (!image) return;
    
    canvas.width = image.width * zoomLevel;
    canvas.height = image.height * zoomLevel;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    
    rectangles.forEach((rect, index) => {
        const color = categoryColors[rect.category] || '#4faf7f';
        const isSelected = selectedAnnotation === index;
        drawRectangle(
            rect.original.x1 * zoomLevel,
            rect.original.y1 * zoomLevel,
            rect.original.x2 * zoomLevel,
            rect.original.y2 * zoomLevel,
            color,
            isSelected
        );
    });

    // Layer from the loaded JSON, drawn on top of the hand-drawn rectangles.
    // No-op while the toggle is off.
    drawBoundingBoxes();

    document.getElementById('zoomLevel').textContent = `${Math.round(zoomLevel * 100)}%`;
}

function zoomIn() {
    zoomLevel *= 1.2;
    displayImage();
}

function zoomOut() {
    zoomLevel /= 1.2;
    displayImage();
}

// Returns to the default view, which is fit-to-height.
function resetZoom() {
    zoomLevel = getFitToHeightZoom();
    displayImage();
}

function clearRectangles() {
    if (rectangles.length === 0) return;
    
    if (confirm('Are you sure you want to clear all annotations?')) {
        rectangles = [];
        selectedAnnotation = null;
        displayImage();
        updateAnnotationsList();
    }
}

function enableButtons() {
    document.getElementById('zoomInBtn').disabled = false;
    document.getElementById('zoomOutBtn').disabled = false;
    document.getElementById('resetBtn').disabled = false;
    document.getElementById('clearBtn').disabled = false;
}

function getMousePos(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY
    };
}

// A press inside a JSON box selects or edits it; anywhere else draws as before.
function onCanvasMouseDown(event) {
    if (startBoxEdit(event)) return;
    startDrawing(event);
}

function onCanvasMouseMove(event) {
    // A side drag is tracked on the window, so it can run past the canvas edge.
    if (bboxDrag) return;
    if (isDrawing) {
        draw(event);
        return;
    }
    updateCanvasCursor(event);
}

function startDrawing(event) {
    if (!image) return;
    
    const pos = getMousePos(event);
    startX = pos.x;
    startY = pos.y;
    isDrawing = true;
}

function draw(event) {
    if (!isDrawing) return;
    
    const pos = getMousePos(event);
    displayImage();
    const color = categoryColors[currentCategory] || '#4faf7f';
    drawRectangle(startX, startY, pos.x, pos.y, color, false);
}

function stopDrawing(event) {
    if (!isDrawing) return;
    
    const pos = getMousePos(event);
    isDrawing = false;
    
    const x1 = Math.min(startX, pos.x) / zoomLevel;
    const y1 = Math.min(startY, pos.y) / zoomLevel;
    const x2 = Math.max(startX, pos.x) / zoomLevel;
    const y2 = Math.max(startY, pos.y) / zoomLevel;
    
    if (Math.abs(pos.x - startX) > 2 && Math.abs(pos.y - startY) > 2) {
        rectangles.push({
            original: {
                x1: Math.round(x1),
                y1: Math.round(y1),
                x2: Math.round(x2),
                y2: Math.round(y2)
            },
            category: currentCategory
        });
        
        // Auto-select the latest rectangle
        selectedAnnotation = rectangles.length - 1;
        updateCoordinatesDisplay();
        // Refresh annotations list and ensure coordinates panel visibility
        updateAnnotationsList();
    }
    
    // ensure coordinates panel is visible if there are annotations
    if (cooridnatesPanel) cooridnatesPanel.style.display = rectangles.length > 0 ? 'block' : 'none';

    displayImage();
}

function drawRectangle(x1, y1, x2, y2, color, isSelected) {
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 4 : 3;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

// ---------------------------------------------------------------------------
// Bounding box overlay
// A layer drawn from whatever is currently in the JSON editor, so it follows
// both the single-file Load and the mounted-folder pager, and picks up manual
// edits to the text. Entries without a usable bbox are skipped, which makes a
// partially-annotated file draw only the boxes it actually has.
//
// Boxes are editable: clicking inside one selects it, and dragging a side of
// the selected box writes the new coordinate back into the editor (see
// "Bounding box editing" below). Nothing reaches the disk until Save.
// ---------------------------------------------------------------------------
let showBoundingBoxes = false;

// Per-category colours for the overlay. Keys are compared case-insensitively so
// the config's "Section-header" matches regardless of how the file spells it.
const bboxColors = {
    'picture': '#a99bd4',
    'table': '#d3a06a',
    'title': '#c96a6a',
    'page-header': '#7a9ec9',
    'section-header': '#24647a',
    'text': '#4faf7f',
    'list-item': '#6fbf9f',
    'caption': '#c9a227',
    'footnote': '#9a8fb8',
    'page-footer': '#7a9ec9'
};
const bboxFallbackColor = '#4faf7f';

// Pulls [x1, y1, x2, y2] out of one entry, or null when it has no drawable box.
// Accepts the flat 4-number list the validator expects, and tolerates nesting
// (some exporters wrap it) plus reversed corners.
function parseBBox(entry) {
    if (!entry || typeof entry !== 'object') return null;

    let raw = entry.bbox;
    // A nested single box, e.g. "bbox": [[x1, y1, x2, y2]].
    if (Array.isArray(raw) && raw.length === 1 && Array.isArray(raw[0])) {
        raw = raw[0];
    }
    if (!Array.isArray(raw) || raw.length < 4) return null;

    // Number(null) and Number([]) are both 0, so reject anything that is not a
    // number or a numeric string before converting.
    const coords = raw.slice(0, 4);
    const usable = coords.every(function (c) {
        return (typeof c === 'number' && isFinite(c))
            || (typeof c === 'string' && c.trim() !== '' && isFinite(Number(c)));
    });
    if (!usable) return null;

    const nums = coords.map(Number);

    const x1 = Math.min(nums[0], nums[2]);
    const y1 = Math.min(nums[1], nums[3]);
    const x2 = Math.max(nums[0], nums[2]);
    const y2 = Math.max(nums[1], nums[3]);

    // A zero-area box would render as an invisible line; treat it as absent.
    if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;

    return { x1: x1, y1: y1, x2: x2, y2: y2, category: entry.category };
}

// Keys a wrapper object may hold the entries array under, in priority order.
const JSON_ENTRY_KEYS = ['entries', 'annotations', 'elements', 'rectangles', 'data'];

// Where the entries array sits in parsed JSON: [] for a top-level array,
// [key] inside a wrapper object, or null for a single bare entry.
function getEntriesPath(parsed) {
    if (Array.isArray(parsed)) return [];
    if (parsed && typeof parsed === 'object') {
        // The first key holding anything wins, even if that is not an array.
        const key = JSON_ENTRY_KEYS.find(function (k) { return parsed[k]; });
        if (key && Array.isArray(parsed[key])) return [key];
    }
    return null;
}

// The array of entries inside parsed JSON. Top level is normally that array;
// also accept a wrapper object holding it under a common key, or a single
// bare entry. Returns references into `parsed`, so edits to an entry land in
// `parsed` itself.
function getJsonEntries(parsed) {
    const path = getEntriesPath(parsed);
    if (path === null) return [parsed];
    return path.length ? parsed[path[0]] : parsed;
}

// Path from the document root to one entry, for locateJsonValue().
function getEntryPath(parsed, entryIndex) {
    const path = getEntriesPath(parsed);
    return path === null ? [] : path.concat(entryIndex);
}

// Character range { start, end } (end exclusive) of the value at `path`, a
// list of object keys and array indexes, inside the JSON `text`. Null when the
// path does not exist.
function locateJsonValue(text, path) {
    const scanner = createJsonScanner(text);
    return scanner.descend(path) ? scanner.readValue() : null;
}

// Character ranges of every element of the array at `path`, in one pass.
// Null when the path does not exist or is not an array.
function locateJsonElements(text, path) {
    const scanner = createJsonScanner(text);
    return scanner.descend(path) ? scanner.readElements() : null;
}

// Index of the entry at character `offset` in the JSON `text`, or null when
// the offset is outside every entry or the text does not parse. A line an
// entry starts or ends on counts as that entry's, so a click in the indent
// before "{" or after "}," still lands on it.
function findEntryAt(text, offset) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return null;
    }

    const base = getEntriesPath(parsed);
    if (base === null) return 0; // A single bare entry is the whole document.

    const ranges = locateJsonElements(text, base);
    if (!ranges) return null;

    for (let index = 0; index < ranges.length; index++) {
        if (offset >= ranges[index].start && offset <= ranges[index].end) return index;
    }

    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    let lineEnd = text.indexOf('\n', offset);
    if (lineEnd < 0) lineEnd = text.length;

    // Several entries can share a line in compact JSON; the nearest wins.
    let best = null;
    let bestDistance = Infinity;
    ranges.forEach(function (range, index) {
        if (range.start > lineEnd || range.end < lineStart) return;
        const distance = offset < range.start ? range.start - offset : offset - range.end;
        if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
        }
    });
    return best;
}

// A cursor over JSON text that steps over values without parsing them, so
// the offsets it reports hold whatever formatting the editor has. Expects
// valid JSON.
function createJsonScanner(text) {
    let i = 0;

    function skipSpace() {
        while (i < text.length) {
            const c = text[i];
            if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') return;
            i++;
        }
    }

    function skipString() {
        i++; // opening quote
        while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        i++; // closing quote
    }

    function skipValue() {
        const c = text[i];
        if (c === '"') {
            skipString();
        } else if (c === '{' || c === '[') {
            let depth = 0;
            while (i < text.length) {
                const ch = text[i];
                if (ch === '"') {
                    skipString();
                    continue;
                }
                i++;
                if (ch === '{' || ch === '[') depth++;
                else if ((ch === '}' || ch === ']') && --depth === 0) return;
            }
        } else {
            // Number, true, false or null.
            while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
        }
    }

    // Moves onto the value at `path` (object keys and array indexes) from the
    // top of the document. False when the path does not exist.
    function descend(path) {
        i = 0;
        skipSpace();
        for (const step of path) {
            if (typeof step === 'number') {
                if (text[i] !== '[') return false;
                i++;
                for (let n = 0; ; n++) {
                    skipSpace();
                    if (i >= text.length || text[i] === ']') return false;
                    if (n === step) break;
                    skipValue();
                    skipSpace();
                    if (text[i] !== ',') return false;
                    i++;
                }
            } else {
                if (text[i] !== '{') return false;
                i++;
                // JSON.parse keeps the last of duplicate keys, so this does too.
                let match = -1;
                for (;;) {
                    skipSpace();
                    if (i >= text.length || text[i] !== '"') break;
                    const keyStart = i;
                    skipString();
                    let key;
                    try {
                        key = JSON.parse(text.slice(keyStart, i));
                    } catch (e) {
                        return false;
                    }
                    skipSpace();
                    if (text[i] !== ':') return false;
                    i++;
                    skipSpace();
                    if (key === step) match = i;
                    skipValue();
                    skipSpace();
                    if (text[i] === ',') i++;
                }
                if (match < 0) return false;
                i = match;
            }
        }
        return true;
    }

    // Range of the value at the current position.
    function readValue() {
        const start = i;
        skipValue();
        return { start: start, end: i };
    }

    // Ranges of the elements of the array at the current position, or null
    // when it is not an array.
    function readElements() {
        if (text[i] !== '[') return null;
        i++;
        const ranges = [];
        for (;;) {
            skipSpace();
            if (i >= text.length || text[i] === ']') return ranges;
            ranges.push(readValue());
            skipSpace();
            if (text[i] !== ',') return ranges;
            i++;
        }
    }

    return { descend: descend, readValue: readValue, readElements: readElements };
}

// Every drawable box in the editor's current contents. Returns [] for empty,
// malformed, or bbox-free JSON, so the caller never has to special-case them.
// Each box carries `entryIndex`, its position in the file, which differs from
// its position in this list whenever an earlier entry has no usable bbox.
function getJsonBoundingBoxes() {
    const raw = jsonEditor ? jsonEditor.value.trim() : '';
    if (!raw) return [];

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return []; // Mid-edit or malformed - nothing to draw.
    }

    const boxes = [];
    getJsonEntries(parsed).forEach(function (entry, entryIndex) {
        const box = parseBBox(entry);
        if (box) {
            box.entryIndex = entryIndex;
            boxes.push(box);
        }
    });
    return boxes;
}

function getBBoxColor(box) {
    const key = typeof box.category === 'string' ? box.category.toLowerCase() : '';
    return bboxColors[key] || bboxFallbackColor;
}

// Draws the overlay at the current zoom. Called from displayImage(), so it
// stays in step with zooming, paging and window resizes.
function drawBoundingBoxes() {
    if (!showBoundingBoxes || !image) return;

    const boxes = getJsonBoundingBoxes();
    if (boxes.length === 0) return;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;

    let selected = null;
    boxes.forEach(function (box) {
        // The selected box is drawn last, so it sits on top of its neighbours.
        if (box.entryIndex === selectedBoxEntry) {
            selected = box;
            return;
        }

        const color = getBBoxColor(box);
        const x = box.x1 * zoomLevel;
        const y = box.y1 * zoomLevel;
        const w = (box.x2 - box.x1) * zoomLevel;
        const h = (box.y2 - box.y1) * zoomLevel;

        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);

        // Numbered by entry, matching the "Entry N" of validation errors.
        drawBBoxLabel(x, y, color, box.category || 'Box', box.entryIndex + 1);
    });

    if (selected) drawSelectedBBox(selected);

    ctx.restore();
}

// The box being edited: a solid outline with a handle on each draggable side.
// While a side is mid-drag the live coordinates replace the editor's, which
// are only updated when the drag ends.
function drawSelectedBBox(box) {
    const live = bboxDrag ? bboxDrag.box : box;
    const color = getBBoxColor(box);

    const x1 = live.x1 * zoomLevel;
    const y1 = live.y1 * zoomLevel;
    const x2 = live.x2 * zoomLevel;
    const y2 = live.y2 * zoomLevel;

    ctx.setLineDash([]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const size = 8;
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 2;
    [[x1, midY], [x2, midY], [midX, y1], [midX, y2]].forEach(function (point) {
        ctx.fillRect(point[0] - size / 2, point[1] - size / 2, size, size);
        ctx.strokeRect(point[0] - size / 2, point[1] - size / 2, size, size);
    });

    drawBBoxLabel(x1, y1, color, box.category || 'Box', box.entryIndex + 1);
}

// A small tag above each box; tucked inside the box when it would fall off the
// top edge of the canvas.
function drawBBoxLabel(x, y, color, category, number) {
    const text = number + '. ' + category;

    ctx.setLineDash([]);
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'top';

    const padX = 4;
    const padY = 2;
    const textWidth = ctx.measureText(text).width;
    const boxW = textWidth + padX * 2;
    const boxH = 16;
    const labelY = y - boxH >= 0 ? y - boxH : y;

    ctx.fillStyle = color;
    ctx.fillRect(x, labelY, boxW, boxH);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + padX, labelY + padY);

    ctx.setLineDash([6, 4]);
}

// Redraws the overlay after the editor's contents change. Cheap no-op while
// the toggle is off, so callers can fire it unconditionally.
function refreshBoundingBoxes() {
    if (!showBoundingBoxes) return;
    displayImage();
    updateBoundingBoxStatus();
}

function toggleBoundingBoxes() {
    showBoundingBoxes = !showBoundingBoxes;
    // Hidden boxes cannot be edited.
    if (!showBoundingBoxes) clearBoxSelection();

    const btn = document.getElementById('showBoxesBtn');
    if (btn) {
        btn.classList.toggle('is-active', showBoundingBoxes);
        btn.setAttribute('aria-pressed', String(showBoundingBoxes));
        btn.title = showBoundingBoxes
            ? 'Hide bounding boxes'
            : 'Show bounding boxes from the loaded JSON';
    }

    displayImage();
    updateBoundingBoxStatus();
}

// Reports how many boxes the overlay found, so an empty result reads as "this
// JSON has none" rather than as a silent failure.
function updateBoundingBoxStatus() {
    const el = document.getElementById('footerBoxes');
    if (!el) return;

    if (!showBoundingBoxes) {
        el.textContent = 'Boxes hidden';
        el.style.color = '';
        return;
    }

    const n = getJsonBoundingBoxes().length;
    if (n === 0) {
        el.textContent = 'No bounding boxes in JSON';
        el.style.color = 'var(--text-secondary)';
    } else {
        let label = '<strong>' + n + '</strong> ' + (n === 1 ? 'box' : 'boxes') + ' shown';
        if (selectedBoxEntry !== null) label += ' · editing entry ' + (selectedBoxEntry + 1);
        el.innerHTML = label;
        el.style.color = '';
    }
}

// ---------------------------------------------------------------------------
// Bounding box editing
// Clicking inside a JSON box selects it; a click inside several picks the
// smallest, so a box nested in a larger one can still be reached. Dragging a
// side of the selected box moves only that side, and on release writes the
// one coordinate back into the editor. Saving to disk stays with Save, which
// validates first.
// ---------------------------------------------------------------------------
let selectedBoxEntry = null;  // entryIndex of the selected JSON box
let bboxDrag = null;          // { entryIndex, side, key, box, original, offset }

// How close, in canvas pixels, the pointer must be to a side to grab it.
// Measured on screen so the sides stay easy to grab at any zoom.
const BBOX_SIDE_REACH = 6;

// The bbox coordinate each side controls.
const BBOX_SIDE_KEYS = { left: 'x1', right: 'x2', top: 'y1', bottom: 'y2' };

function findJsonBox(boxes, entryIndex) {
    for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].entryIndex === entryIndex) return boxes[i];
    }
    return null;
}

// The smallest box containing the image-space point, or null.
function hitTestJsonBoxes(boxes, x, y) {
    let best = null;
    let bestArea = Infinity;
    boxes.forEach(function (box) {
        if (x < box.x1 || x > box.x2 || y < box.y1 || y > box.y2) return;
        const area = (box.x2 - box.x1) * (box.y2 - box.y1);
        if (area < bestArea) {
            best = box;
            bestArea = area;
        }
    });
    return best;
}

// Which side of `box` lies under the canvas-space point, or null. Near a
// corner, the closer of the two sides wins.
function hitTestBoxSide(box, px, py) {
    const reach = BBOX_SIDE_REACH;
    const x1 = box.x1 * zoomLevel;
    const y1 = box.y1 * zoomLevel;
    const x2 = box.x2 * zoomLevel;
    const y2 = box.y2 * zoomLevel;

    const candidates = [];
    if (py >= y1 - reach && py <= y2 + reach) {
        candidates.push({ side: 'left', distance: Math.abs(px - x1) });
        candidates.push({ side: 'right', distance: Math.abs(px - x2) });
    }
    if (px >= x1 - reach && px <= x2 + reach) {
        candidates.push({ side: 'top', distance: Math.abs(py - y1) });
        candidates.push({ side: 'bottom', distance: Math.abs(py - y2) });
    }

    let best = null;
    candidates.forEach(function (c) {
        if (c.distance <= reach && (!best || c.distance < best.distance)) best = c;
    });
    return best ? best.side : null;
}

function sideCursor(side) {
    return side === 'left' || side === 'right' ? 'ew-resize' : 'ns-resize';
}

// The selected box as it currently stands: live while a side is mid-drag,
// otherwise as the editor has it. Null when nothing is selected.
function getSelectedJsonBox() {
    if (selectedBoxEntry === null) return null;
    if (bboxDrag) return bboxDrag.box;
    return findJsonBox(getJsonBoundingBoxes(), selectedBoxEntry);
}

// `fromEditor` is set when the selection came from the cursor in the JSON
// editor: the entry is already in front of the user, so it is highlighted
// but the editor is not scrolled.
function selectJsonBox(entryIndex, fromEditor) {
    selectedBoxEntry = entryIndex;
    // One selection at a time: the hand-drawn rectangle lets go.
    selectedAnnotation = null;
    if (cooridnatesPanel) cooridnatesPanel.style.display = 'block';
    displayImage();
    updateCoordinatesDisplay();
    updateBoundingBoxStatus();
    if (fromEditor) highlightJsonEntry(entryIndex);
    else revealJsonEntry(entryIndex);
}

// Lines of the editor highlighted as the selected box's entry.
let entryHighlightLines = [];

// Breathing room, in pixels, kept around an entry scrolled into view.
const ENTRY_REVEAL_MARGIN = 24;

function clearEntryHighlight() {
    if (!jsonCM) return;
    entryHighlightLines.forEach(function (handle) {
        // Lines replaced since (every box edit rewrites the text) are gone.
        if (jsonCM.getLineNumber(handle) !== null) {
            jsonCM.removeLineClass(handle, 'background', 'cm-selected-entry');
        }
    });
    entryHighlightLines = [];
}

// Highlights an entry's lines in the editor, replacing any earlier highlight.
// Returns where the entry sits, for scrolling, or null when it cannot be found.
// Needs CodeMirror; the textarea fallback is left be.
function highlightJsonEntry(entryIndex) {
    if (!jsonCM) return null;
    clearEntryHighlight();

    const text = jsonCM.getValue();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return null;
    }

    const path = getEntryPath(parsed, entryIndex);
    const range = locateJsonValue(text, path);
    if (!range) return null;

    const from = jsonCM.posFromIndex(range.start);
    const to = jsonCM.posFromIndex(range.end);
    for (let line = from.line; line <= to.line; line++) {
        entryHighlightLines.push(jsonCM.addLineClass(line, 'background', 'cm-selected-entry'));
    }
    return { text: text, path: path, from: from, to: to };
}

// Highlights an entry and scrolls the editor the least distance that brings
// it into view - not at all when it is already showing. An entry taller than
// the editor brings its bbox into view instead, since those are the numbers
// being edited.
function revealJsonEntry(entryIndex) {
    const entry = highlightJsonEntry(entryIndex);
    if (!entry) return;

    let target = { from: entry.from, to: entry.to };
    const height = jsonCM.charCoords(entry.to, 'local').bottom
        - jsonCM.charCoords(entry.from, 'local').top;
    if (height > jsonCM.getScrollInfo().clientHeight - 2 * ENTRY_REVEAL_MARGIN) {
        const bbox = locateJsonValue(entry.text, entry.path.concat('bbox'));
        if (bbox) {
            target = { from: jsonCM.posFromIndex(bbox.start), to: jsonCM.posFromIndex(bbox.end) };
        }
    }
    jsonCM.scrollIntoView(target, ENTRY_REVEAL_MARGIN);
}

// Scrolls the image the least distance that shows `box`, so a box selected
// from the editor is not left off-screen on a zoomed-in page. The top-left
// corner wins when the box is larger than the view.
function revealBoxOnCanvas(box) {
    const area = document.querySelector('.canvas-area');
    if (!area) return;

    const view = area.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const scale = (c.width / canvas.width) * zoomLevel; // image px -> screen px
    const margin = ENTRY_REVEAL_MARGIN;

    function offset(start, end, viewStart, viewSize) {
        const viewEnd = viewStart + viewSize;
        if (start < viewStart + margin) return start - viewStart - margin;
        if (end > viewEnd - margin) return Math.min(end - viewEnd + margin, start - viewStart - margin);
        return 0;
    }

    area.scrollBy(
        offset(c.left + box.x1 * scale, c.left + box.x2 * scale, view.left + area.clientLeft, area.clientWidth),
        offset(c.top + box.y1 * scale, c.top + box.y2 * scale, view.top + area.clientTop, area.clientHeight)
    );
}

// The editor -> image direction. With the boxes showing, putting the cursor
// in an entry (click, arrow keys, find) highlights it and selects its box; an
// entry without a usable bbox is highlighted with no box selected. Text the
// app rewrites itself is not the user's cursor and is skipped (see
// jsonTextIsBeingSet).
function onEditorCursorActivity() {
    if (jsonTextIsBeingSet || !showBoundingBoxes || bboxDrag) return;

    const entryIndex = findEntryAt(jsonCM.getValue(), jsonCM.indexFromPos(jsonCM.getCursor()));
    if (entryIndex === null) return; // e.g. on the opening "[" line

    // Selecting can show or hide the coordinates panel above the editor, which
    // resizes the editor from the top and would shift the text under the
    // user's pointer. Note where the cursor's line sits so it can stay put.
    const anchor = jsonCM.cursorCoords(null, 'window').top;

    const box = findJsonBox(getJsonBoundingBoxes(), entryIndex);
    if (!box) {
        clearBoxSelection();
        highlightJsonEntry(entryIndex);
    } else if (entryIndex !== selectedBoxEntry) {
        selectJsonBox(entryIndex, true);
        revealBoxOnCanvas(box);
    } else {
        // Same entry: refresh, so lines typed into it pick up the highlight.
        highlightJsonEntry(entryIndex);
    }

    const shift = jsonCM.cursorCoords(null, 'window').top - anchor;
    if (shift) jsonCM.scrollTo(null, jsonCM.getScrollInfo().top + shift);
}

// Drops the selection, abandoning any drag in progress without writing it.
// Safe to call when nothing is selected.
function clearBoxSelection() {
    if (bboxDrag) {
        stopBoxDragTracking();
        bboxDrag = null;
    }
    // An entry can be highlighted with no box selected (the cursor sits in an
    // entry without a bbox), so this goes before the early return.
    clearEntryHighlight();
    if (selectedBoxEntry === null) return;

    selectedBoxEntry = null;
    if (cooridnatesPanel) cooridnatesPanel.style.display = rectangles.length > 0 ? 'block' : 'none';
    canvas.style.cursor = '';
    displayImage();
    updateCoordinatesDisplay();
    updateBoundingBoxStatus();
}

// Handles a press on the canvas. Returns true when it was meant for a JSON box
// (a side grab or a selection), false when the caller should start drawing.
function startBoxEdit(event) {
    if (!showBoundingBoxes || !image || event.button !== 0) return false;

    const pos = getMousePos(event);
    const boxes = getJsonBoundingBoxes();

    // A side of the selected box takes priority over anything beneath it.
    const selected = findJsonBox(boxes, selectedBoxEntry);
    const side = selected ? hitTestBoxSide(selected, pos.x, pos.y) : null;
    if (side) {
        event.preventDefault(); // no text selection while dragging
        const key = BBOX_SIDE_KEYS[side];
        const pointer = (key[0] === 'x' ? pos.x : pos.y) / zoomLevel;
        bboxDrag = {
            entryIndex: selected.entryIndex,
            side: side,
            key: key,
            box: { x1: selected.x1, y1: selected.y1, x2: selected.x2, y2: selected.y2 },
            original: selected[key],
            // Where on the side it was grabbed, so the side does not jump to
            // the pointer on the first move.
            offset: selected[key] - pointer
        };
        document.body.style.cursor = sideCursor(side);
        window.addEventListener('mousemove', onBoxDragMove);
        window.addEventListener('mouseup', onBoxDragEnd);
        return true;
    }

    const hit = hitTestJsonBoxes(boxes, pos.x / zoomLevel, pos.y / zoomLevel);
    if (hit) {
        // Clicking the selected box again brings its entry back into view, in
        // case the editor has been scrolled away from it.
        if (hit.entryIndex !== selectedBoxEntry) selectJsonBox(hit.entryIndex);
        else revealJsonEntry(hit.entryIndex);
        return true;
    }

    // Outside every box: let go of the selection and draw instead.
    clearBoxSelection();
    return false;
}

function onBoxDragMove(event) {
    if (!bboxDrag) return;

    const pos = getMousePos(event);
    const box = bboxDrag.box;
    const pointer = (bboxDrag.key[0] === 'x' ? pos.x : pos.y) / zoomLevel;
    const value = Math.round(pointer + bboxDrag.offset);

    // Keep the box at least 1px across and on the image. The validator needs
    // every coordinate above zero, so 1 is the floor rather than 0.
    switch (bboxDrag.side) {
        case 'left':   box.x1 = clamp(value, 1, box.x2 - 1); break;
        case 'right':  box.x2 = clamp(value, box.x1 + 1, Math.max(image.width, box.x1 + 1)); break;
        case 'top':    box.y1 = clamp(value, 1, box.y2 - 1); break;
        case 'bottom': box.y2 = clamp(value, box.y1 + 1, Math.max(image.height, box.y1 + 1)); break;
    }

    displayImage();
    updateCoordinatesDisplay();
}

function onBoxDragEnd() {
    if (!bboxDrag) return;

    stopBoxDragTracking();
    const drag = bboxDrag;
    bboxDrag = null;

    const value = drag.box[drag.key];
    if (value !== drag.original) writeBBoxSide(drag.entryIndex, drag.key, value);

    displayImage();
    updateCoordinatesDisplay();
    // Rewriting the text drops the highlight and scrolls the editor back to
    // its cursor, so put the entry back in view.
    revealJsonEntry(drag.entryIndex);
}

function stopBoxDragTracking() {
    window.removeEventListener('mousemove', onBoxDragMove);
    window.removeEventListener('mouseup', onBoxDragEnd);
    document.body.style.cursor = '';
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// Writes one coordinate of an entry's bbox back into the editor, leaving the
// other three exactly as they were. `key` is the side's normalised name
// (x1 = left, x2 = right, ...); in a file with swapped corners the left edge
// is stored at index 2, so the stored order decides which slot it maps to.
function writeBBoxSide(entryIndex, key, value) {
    let parsed;
    try {
        parsed = JSON.parse(jsonEditor.value);
    } catch (e) {
        return false; // The text changed under the drag; nothing safe to write.
    }

    const entry = getJsonEntries(parsed)[entryIndex];
    if (!entry || !Array.isArray(entry.bbox)) return false;

    // A nested single box, e.g. "bbox": [[x1, y1, x2, y2]], keeps its nesting.
    const target = entry.bbox.length === 1 && Array.isArray(entry.bbox[0])
        ? entry.bbox[0]
        : entry.bbox;
    if (target.length < 4) return false;

    const pair = key[0] === 'x' ? [0, 2] : [1, 3];
    const lowFirst = Number(target[pair[0]]) <= Number(target[pair[1]]);
    const wantsLow = key[1] === '1';
    target[wantsLow === lowFirst ? pair[0] : pair[1]] = value;

    // One change per drag, so a single undo in the editor reverts it.
    jsonEditor.value = JSON.stringify(parsed, null, 2);
    return true;
}

// Hints what a press would do at the pointer: grab a side, select a box, or
// (the stylesheet's crosshair) draw.
function updateCanvasCursor(event) {
    let cursor = '';

    if (showBoundingBoxes && image) {
        const pos = getMousePos(event);
        const boxes = getJsonBoundingBoxes();
        const selected = findJsonBox(boxes, selectedBoxEntry);
        const side = selected ? hitTestBoxSide(selected, pos.x, pos.y) : null;

        if (side) {
            cursor = sideCursor(side);
        } else {
            const hit = hitTestJsonBoxes(boxes, pos.x / zoomLevel, pos.y / zoomLevel);
            if (hit) cursor = hit.entryIndex === selectedBoxEntry ? 'default' : 'pointer';
        }
    }

    canvas.style.cursor = cursor;
}

function updateAnnotationsList() {
    if (!annotationCount) return;
    
    annotationCount.textContent = `(${rectangles.length})`;
    
    if (!annotationsList) return;
    
    if (rectangles.length === 0) {
        annotationsList.innerHTML = `
            <div class="empty-state">
                <i data-lucide="layers"></i>
                <p>No annotations yet</p>
                <small>Draw rectangles on the image</small>
            </div>
        `;
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        // hide coordinates panel when no annotations exist
        if (cooridnatesPanel) cooridnatesPanel.style.display = 'none';
        return;
    }
    
    let html = '';
    rectangles.forEach((rect, index) => {
        const color = categoryColors[rect.category] || '#4faf7f';
        const isSelected = selectedAnnotation === index;
        html += `
            <div class="annotation-item ${isSelected ? 'selected' : ''}" 
                 onclick="selectAnnotation(${index})"
                 style="border-left-color: ${color};">
                <div class="annotation-header">
                    <span class="annotation-category">${capitalizeFirst(rect.category)}</span>
                    <span class="annotation-number">#${index + 1}</span>
                </div>
                <div class="annotation-coords">
                    [${rect.original.x1}, ${rect.original.y1}] → [${rect.original.x2}, ${rect.original.y2}]
                </div>
            </div>
        `;
    });
    
    annotationsList.innerHTML = html;
    // show coordinates panel because there are annotations
    if (cooridnatesPanel) cooridnatesPanel.style.display = rectangles.length > 0 ? 'block' : 'none';
}

function closeCoordinatesPanel() {
    if (cooridnatesPanel) cooridnatesPanel.style.display = 'none';
}

function selectAnnotation(index) {
    selectedAnnotation = index;
    updateAnnotationsList();
    updateCoordinatesDisplay();
    displayImage();
}

function updateCoordinatesDisplay() {
    const coordinatesDisplay = document.getElementById('coordinatesDisplay');

    // A selected JSON box takes the panel, live while one of its sides moves.
    const jsonBox = getSelectedJsonBox();
    if (jsonBox) {
        coordinatesDisplay.innerHTML = `
            <div class="coord-item">
                <div class="coord-label">Upper-Left Point</div>
                <div class="coord-value">X: ${jsonBox.x1}, Y: ${jsonBox.y1}</div>
            </div>
            <div class="coord-item">
                <div class="coord-label">Bottom-Right Point</div>
                <div class="coord-value">X: ${jsonBox.x2}, Y: ${jsonBox.y2}</div>
            </div>
        `;
        return;
    }

    if (selectedAnnotation === null || !rectangles[selectedAnnotation]) {
        coordinatesDisplay.innerHTML = `
            <div class="coord-empty">
                <p>No rectangle selected</p>
            </div>
        `;
        return;
    }
    
    const rect = rectangles[selectedAnnotation];
    coordinatesDisplay.innerHTML = `
        <div class="coord-item">
            <div class="coord-label">Upper-Left Point</div>
            <div class="coord-value">X: ${rect.original.x1}, Y: ${rect.original.y1}</div>
        </div>
        <div class="coord-item">
            <div class="coord-label">Bottom-Right Point</div>
            <div class="coord-value">X: ${rect.original.x2}, Y: ${rect.original.y2}</div>
        </div>
    `;
}

function syntaxHighlightJSON(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        var cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            } else {
                cls = 'string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
        } else if (/null/.test(match)) {
            cls = 'null';
        }
        return '<span class="json-' + cls + '">' + match + '</span>';
    });
}

function displayColorfulJSON(jsonData) {
    const jsonString = JSON.stringify(jsonData, null, 2);
    jsonEditor.value = jsonString;
    
    // Create a styled version for display
    const highlighted = syntaxHighlightJSON(jsonString);
    const jsonDisplay = document.getElementById('jsonEditorDisplay');
    if (jsonDisplay) {
        jsonDisplay.innerHTML = highlighted;
    }
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function updateJSON() {
    const annotations = {
        image: currentImageFile || "no_image_loaded",
        rectangles: rectangles.map((rect, index) => ({
            id: index + 1,
            category: rect.category,
            top_left: {
                x: rect.original.x1,
                y: rect.original.y1
            },
            bottom_right: {
                x: rect.original.x2,
                y: rect.original.y2
            }
        }))
    };
    
    jsonEditor.value = JSON.stringify(annotations, null, 2);
}

// ---------------------------------------------------------------------------
// Toasts
// Non-blocking notifications, stacked bottom-right above the footer. Errors
// stay longer than confirmations; every toast can be dismissed by hand.
// ---------------------------------------------------------------------------
const TOAST_ICONS = {
    success: 'circle-check',
    error: 'circle-alert',
    warning: 'triangle-alert',
    info: 'info'
};

function toastContainer() {
    let el = document.getElementById('toastContainer');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toastContainer';
        el.className = 'toast-container';
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    return el;
}

function showToast(type, message, duration) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', TOAST_ICONS[type] || 'info');
    toast.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    toast.appendChild(text);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.title = 'Dismiss';
    closeBtn.textContent = '×';
    closeBtn.onclick = function () { dismissToast(toast); };
    toast.appendChild(closeBtn);

    toastContainer().appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    const ms = duration || (type === 'error' ? 8000 : type === 'warning' ? 6000 : 3500);
    toast._timer = setTimeout(function () { dismissToast(toast); }, ms);
    return toast;
}

function dismissToast(toast) {
    if (!toast || toast._dismissed) return;
    toast._dismissed = true;
    clearTimeout(toast._timer);
    toast.classList.add('toast-out');
    setTimeout(function () { toast.remove(); }, 250);
}

// ---------------------------------------------------------------------------
// Save state
// jsonBaseline is the editor's contents as of the last load or save, so
// dirty = (current !== baseline). jsonDocEpoch increments whenever a different
// document is put on screen; a save that finishes after the user has paged
// away compares epochs and leaves the new page's state alone.
// ---------------------------------------------------------------------------
let jsonBaseline = '';
let jsonDocEpoch = 0;
let isSaving = false;
let savedFlashTimer = null;

function isJsonDirty() {
    return !!jsonEditor && jsonEditor.value !== jsonBaseline;
}

// The save button is a tiny state machine: idle / saving / saved. 'saved'
// flashes briefly and falls back to idle; every transition cancels the
// previous flash so a page change can never inherit a stale "Saved".
function setSaveButton(state) {
    const btn = document.getElementById('saveJsonBtn');
    if (!btn) return;

    clearTimeout(savedFlashTimer);
    btn.classList.remove('is-saving', 'is-saved');
    btn.disabled = false;

    if (state === 'saving') {
        btn.disabled = true;
        btn.classList.add('is-saving');
        btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
    } else if (state === 'saved') {
        btn.classList.add('is-saved');
        btn.innerHTML = '<i data-lucide="check"></i> Saved';
        savedFlashTimer = setTimeout(function () { setSaveButton('idle'); }, 1600);
    } else {
        btn.innerHTML = '<i data-lucide="save"></i> Save';
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
    updateSaveIndicators();
}

// The amber "unsaved" dot on the save button plus the footer status line.
function updateSaveIndicators() {
    const btn = document.getElementById('saveJsonBtn');
    if (btn) btn.classList.toggle('has-unsaved', isJsonDirty() && !isSaving);
    if (typeof updateFooter === 'function') updateFooter();
}

// Called whenever a different document lands in the editor: it starts clean,
// and any save feedback from the previous document no longer applies.
function noteJsonDocumentLoaded() {
    jsonDocEpoch++;
    jsonBaseline = jsonEditor ? jsonEditor.value : '';
    // While a save of the previous page is still in flight the button keeps
    // its "Saving…" state; it resolves to idle when that save finishes.
    if (!isSaving) setSaveButton('idle');
    else updateSaveIndicators();
}

// Closing the tab with unsaved edits loses them - let the browser ask.
window.addEventListener('beforeunload', function (e) {
    if (isJsonDirty() || isSaving) {
        e.preventDefault();
        e.returnValue = '';
    }
});

function triggerSaveDialog(content, filename) {
    try {
        const jsonData = JSON.parse(content != null ? content : jsonEditor.value);
        const name = filename || currentJsonFile || 'annotations.json';

        const dataStr = JSON.stringify(jsonData, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);

        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', name);
        linkElement.click();
    } catch (error) {
        showToast('error', 'Could not prepare the download: ' + (error.message || error));
    }
}

// The handle for the JSON file currently shown in the editor, or null when it
// arrived through the plain file input (which yields no handle). A mounted
// folder wins, since the pager is then what drives the editor's contents.
function currentJsonHandle() {
    if (mounted) {
        const page = mounted.pages[jsonIndex];
        if (page && page.annotation) return page.annotation;
    }
    return loadedJsonHandle;
}

// Directory handles are granted read-only, so the first overwrite has to ask.
async function ensureWritePermission(handle) {
    if (typeof handle.queryPermission !== 'function') return true;
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
}

// Overwrites the given file in place. Returns 'written' on success,
// 'no-handle' when there is nothing to write through (the caller then falls
// back to a download), or 'denied' when write access was refused. Handle and
// content are passed in, captured when the save was requested, so paging to
// another file mid-save can neither redirect the write nor change the payload.
async function writeToMountedFile(handle, content) {
    if (!handle) return 'no-handle';

    if (!await ensureWritePermission(handle)) return 'denied';

    const dataStr = JSON.stringify(JSON.parse(content), null, 2);
    const writable = await handle.createWritable();
    try {
        await writable.write(dataStr);
        await writable.close();
    } catch (e) {
        await writable.abort();
        throw e;
    }
    return 'written';
}
async function saveJSON() {
    // A second click while a save is running would race the first write.
    if (isSaving) return;

    // Capture the document being saved NOW. currentJsonHandle() and the editor
    // both follow the pager, so resolving them after an await would save the
    // wrong page if the user navigates while a request is in flight.
    const content = jsonEditor.value;
    const fileName = currentJsonFile || 'annotations.json';
    const handle = currentJsonHandle();
    const epoch = jsonDocEpoch;

    let jsonData;
    try {
        jsonData = JSON.parse(content);
    } catch (error) {
        showToast('error', 'Not saved — the JSON is invalid: ' + (error.message || error));
        return;
    }

    isSaving = true;
    setSaveButton('saving');
    let savedShown = false;

    try {
        // Ensure payload is an array when submitting to validate_json
        const payload = Array.isArray(jsonData) ? jsonData : [jsonData];

        const response = await fetch('/validate_json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            showToast('error', fileName + ' was NOT saved: the validation request failed (HTTP ' + response.status + ').');
            return;
        }

        const result = await response.json();
        if (result.error_count !== 0) {
            // The modal states "Nothing was saved" and lists what to fix.
            const details = Array.isArray(result.error_detail) ? result.error_detail : [String(result.error_detail)];
            showValidationErrors(details);
            return;
        }

        // Overwrite the mounted file in place; fall back to a download when
        // the JSON came from the single-file upload button.
        const outcome = await writeToMountedFile(handle, content);
        if (outcome === 'denied') {
            showToast('warning', fileName + ' was NOT saved: write permission to the folder was declined.');
            return;
        }
        if (outcome === 'no-handle') {
            triggerSaveDialog(content, fileName);
            showToast('success', fileName + ' downloaded — mount a folder to save in place.');
        } else {
            showToast('success', 'Saved ' + fileName);
        }

        // Mark clean and flash "Saved" only if the same document is still on
        // screen; edits typed while the save was in flight stay dirty because
        // the baseline is the content that was actually written.
        if (epoch === jsonDocEpoch) {
            jsonBaseline = content;
            setSaveButton('saved');
            savedShown = true;
        }
    } catch (error) {
        showToast('error', fileName + ' was NOT saved: ' + (error.message || error));
    } finally {
        isSaving = false;
        if (!savedShown) setSaveButton('idle');
        else updateSaveIndicators();
    }
}

// Builds one error card. `err` is the structured object from /validate_json;
// a plain string is still accepted so an older backend degrades to one line.
function buildValidationCard(err) {
    const card = document.createElement('li');
    card.className = 'validation-error';

    if (typeof err === 'string') {
        const line = document.createElement('p');
        line.className = 'validation-problem';
        line.textContent = err;
        card.appendChild(line);
        return card;
    }

    // Headline: which entry, and what kind it claims to be.
    const head = document.createElement('div');
    head.className = 'validation-head';

    const where = document.createElement('span');
    where.className = 'validation-index';
    // 1-based, matching the overlay labels and the "N entries" footer count.
    where.textContent = 'Entry ' + (err.index + 1);
    head.appendChild(where);

    if (err.category) {
        const cat = document.createElement('span');
        cat.className = 'validation-category';
        cat.textContent = err.category;
        head.appendChild(cat);
    }

    card.appendChild(head);

    (err.problems || []).forEach(function (problem) {
        const line = document.createElement('p');
        line.className = 'validation-problem';
        line.textContent = problem;
        card.appendChild(line);
    });

    // The excerpt is a landmark for locating the entry, not the entry itself,
    // so it stays clamped to one line however long the text is.
    if (err.preview) {
        const preview = document.createElement('p');
        preview.className = 'validation-preview';
        preview.textContent = err.preview;
        // Let the browser lay the excerpt out by its own script, so Arabic and
        // Bengali previews read correctly inside the LTR dialog.
        preview.setAttribute('dir', 'auto');
        card.appendChild(preview);
    }

    return card;
}

function showValidationErrors(errors) {
    // Remove any existing modal
    const existing = document.getElementById('validationErrorsModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'validationErrorsModal';
    // Reuse the About dialog's chrome so both dialogs look like one app.
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', function (event) {
        if (event.target === overlay) overlay.remove();
    });

    const box = document.createElement('div');
    box.className = 'modal validation-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('h2');
    title.className = 'modal-title';
    const n = errors.length;
    title.textContent = n === 1
        ? '1 entry needs fixing'
        : n + ' entries need fixing';
    header.appendChild(title);
    box.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';

    const intro = document.createElement('p');
    intro.className = 'validation-intro';
    intro.textContent = 'Nothing was saved. Fix these entries in the editor, then save again.';
    body.appendChild(intro);

    const list = document.createElement('ul');
    list.className = 'validation-list';
    errors.forEach(function (err) {
        list.appendChild(buildValidationCard(err));
    });
    body.appendChild(list);
    box.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer validation-footer';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'small-btn primary';
    closeBtn.onclick = function () { overlay.remove(); };
    footer.appendChild(closeBtn);

    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    closeBtn.focus();
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
    // Typing in a text field must never trigger annotation shortcuts
    const target = e.target;
    const isEditing = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
    );

    // Delete selected annotation with the Delete key
    // (Backspace is intentionally excluded so it keeps its default text-editing behavior)
    if (e.key === 'Delete' && selectedAnnotation !== null && !isEditing) {
        e.preventDefault();
        rectangles.splice(selectedAnnotation, 1);
        selectedAnnotation = null;
        displayImage();
        updateAnnotationsList();
        updateCoordinatesDisplay();
    }
    
    // Zoom shortcuts
    if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            if (image) zoomIn();
        } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            if (image) zoomOut();
        } else if (e.key === '0') {
            e.preventDefault();
            if (image) resetZoom();
        } else if (e.key === 's') {
            // Ctrl/Cmd+S saves the annotation instead of the web page.
            e.preventDefault();
            if (jsonEditor && jsonEditor.value.trim()) saveJSON();
        }

        // Find and Replace toggle (Ctrl+H or Cmd+H)
        if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
            e.preventDefault();
            const container = document.getElementById('findReplaceContainer');
            if (container.style.display === 'none') {
                container.style.display = 'flex';
                document.getElementById('findInput').focus();
            } else {
                closeFindReplace();
            }
        }
    }
});

// Initialize on page load
window.addEventListener('load', function() {
    jsonEditor.value = '';
    // initialize JSON editor font-size based on zoom
    if (jsonEditor) {
        jsonEditor.style.fontSize = `${baseJsonFontSize * jsonZoomLevel}px`;
    }
    // initialize JSON zoom display
    const zEl = document.getElementById('jsonZoomLevel');
    if (zEl) zEl.textContent = `${Math.round(jsonZoomLevel * 100)}%`;
});

// JSON zoom functions
function updateJsonZoomDisplay() {
    const zEl = document.getElementById('jsonZoomLevel');
    if (zEl) zEl.textContent = `${Math.round(jsonZoomLevel * 100)}%`;
    if (jsonEditor) jsonEditor.style.fontSize = `${baseJsonFontSize * jsonZoomLevel}px`;
    // CodeMirror measures character width once; re-measure after a size change.
    if (jsonCM) jsonCM.refresh();
}

function zoomJsonIn() {
    jsonZoomLevel = Math.min(3.0, jsonZoomLevel * 1.15);
    updateJsonZoomDisplay();
}

function zoomJsonOut() {
    jsonZoomLevel = Math.max(0.5, jsonZoomLevel / 1.15);
    updateJsonZoomDisplay();
}

function resetJsonZoom() {
    jsonZoomLevel = 1.0;
    updateJsonZoomDisplay();
}

// Find and Replace Functions
let findIndex = 0;

function closeFindReplace() {
    document.getElementById('findReplaceContainer').style.display = 'none';
    jsonEditor.focus();
}

function findMatches(searchTerm) {
    const text = jsonEditor.value;
    const matches = [];
    let start = 0;
    
    while ((start = text.indexOf(searchTerm, start)) !== -1) {
        matches.push(start);
        start += searchTerm.length;
    }
    
    return matches;
}

function updateFindCounter() {
    const findInput = document.getElementById('findInput').value;
    const counter = document.getElementById('findCounter');
    
    if (!findInput) {
        counter.textContent = '';
        return;
    }
    
    const matches = findMatches(findInput);
    counter.textContent = matches.length > 0 ? `${findIndex + 1} of ${matches.length}` : 'No matches';
}

function findNext() {
    const findInput = document.getElementById('findInput').value;
    if (!findInput) return;
    
    const matches = findMatches(findInput);
    if (matches.length === 0) return;
    
    findIndex = (findIndex + 1) % matches.length;
    const start = matches[findIndex];
    
    jsonEditor.setSelectionRange(start, start + findInput.length);
    jsonEditor.focus();
    updateFindCounter();
}

function findPrev() {
    const findInput = document.getElementById('findInput').value;
    if (!findInput) return;
    
    const matches = findMatches(findInput);
    if (matches.length === 0) return;
    
    findIndex = (findIndex - 1 + matches.length) % matches.length;
    const start = matches[findIndex];
    
    jsonEditor.setSelectionRange(start, start + findInput.length);
    jsonEditor.focus();
    updateFindCounter();
}

function replaceOne() {
    const findInput = document.getElementById('findInput').value;
    const replaceInput = document.getElementById('replaceInput').value;
    
    if (!findInput) return;
    
    const matches = findMatches(findInput);
    if (matches.length === 0) return;
    
    const start = matches[findIndex];
    const before = jsonEditor.value.substring(0, start);
    const after = jsonEditor.value.substring(start + findInput.length);
    
    jsonEditor.value = before + replaceInput + after;
    updateFindCounter();
    findNext();
}

function replaceAll() {
    const findInput = document.getElementById('findInput').value;
    const replaceInput = document.getElementById('replaceInput').value;
    
    if (!findInput) return;
    
    jsonEditor.value = jsonEditor.value.replaceAll(findInput, replaceInput);
    findIndex = 0;
    updateFindCounter();
}

// Theme toggle. Light is the default; the initial theme is applied in index.html
// before first paint, so this only handles switching and persisting.
function toggleTheme() {
    const root = document.documentElement;
    const isDark = root.getAttribute('data-theme') === 'dark';

    if (isDark) {
        root.removeAttribute('data-theme');
    } else {
        root.setAttribute('data-theme', 'dark');
    }

    try {
        localStorage.setItem('theme', isDark ? 'light' : 'dark');
    } catch (e) {
        // localStorage unavailable - the theme still switches for this session
    }
}

// Set up find input listener for counter update
document.addEventListener('DOMContentLoaded', function() {
    const findInput = document.getElementById('findInput');
    if (findInput) {
        findInput.addEventListener('input', function() {
            findIndex = 0;
            updateFindCounter();
        });
    }
});
// ---------------------------------------------------------------------------
// Split resizer: drag the divider to rebalance the preview / annotation panes.
// The ratio is stored as the --panel-width custom property on :root.
// ---------------------------------------------------------------------------
const DEFAULT_PANEL_PERCENT = 40;
const MIN_PANEL_PERCENT = 20;
const MAX_PANEL_PERCENT = 75;

function clampPanelPercent(percent) {
    return Math.min(MAX_PANEL_PERCENT, Math.max(MIN_PANEL_PERCENT, percent));
}

function applyPanelPercent(percent, persist) {
    const clamped = clampPanelPercent(percent);
    document.documentElement.style.setProperty('--panel-percent', clamped);

    const resizer = document.getElementById('splitResizer');
    if (resizer) {
        resizer.setAttribute('aria-valuenow', Math.round(clamped));
    }

    if (persist) {
        try {
            localStorage.setItem('panelWidth', String(clamped));
        } catch (e) {
            // localStorage unavailable - the split still works for this session
        }
    }

    return clamped;
}

function initSplitResizer() {
    const resizer = document.getElementById('splitResizer');
    const container = document.querySelector('.app-container');
    if (!resizer || !container) return;

    resizer.setAttribute('aria-valuemin', MIN_PANEL_PERCENT);
    resizer.setAttribute('aria-valuemax', MAX_PANEL_PERCENT);

    let stored = null;
    try {
        stored = localStorage.getItem('panelWidth');
    } catch (e) {
        // ignore - fall back to the default split
    }
    const initial = stored !== null && !isNaN(parseFloat(stored))
        ? parseFloat(stored)
        : DEFAULT_PANEL_PERCENT;
    applyPanelPercent(initial, false);

    let dragging = false;

    function percentFromEvent(event) {
        const rect = container.getBoundingClientRect();
        const rail = document.querySelector('.sidebar');
        const railWidth = rail ? rail.getBoundingClientRect().width : 0;
        const working = rect.width - railWidth;
        if (working <= 0) return DEFAULT_PANEL_PERCENT;
        // Panel occupies everything to the right of the pointer.
        return ((rect.right - event.clientX) / working) * 100;
    }

    function onPointerMove(event) {
        if (!dragging) return;
        event.preventDefault();
        applyPanelPercent(percentFromEvent(event), false);
    }

    function onPointerUp(event) {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        applyPanelPercent(percentFromEvent(event), true);
    }

    resizer.addEventListener('pointerdown', function (event) {
        // Primary button / touch only.
        if (event.button !== 0) return;
        event.preventDefault();
        dragging = true;
        resizer.classList.add('is-dragging');
        document.body.classList.add('is-resizing');
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    });

    // Double-click restores the default 60/40 split.
    resizer.addEventListener('dblclick', function () {
        applyPanelPercent(DEFAULT_PANEL_PERCENT, true);
    });

    // Keyboard support: arrows nudge, Home resets.
    resizer.addEventListener('keydown', function (event) {
        const current = parseFloat(
            getComputedStyle(document.documentElement)
                .getPropertyValue('--panel-percent')
        ) || DEFAULT_PANEL_PERCENT;

        let next = null;
        if (event.key === 'ArrowLeft') next = current + 2;
        else if (event.key === 'ArrowRight') next = current - 2;
        else if (event.key === 'Home') next = DEFAULT_PANEL_PERCENT;

        if (next !== null) {
            event.preventDefault();
            applyPanelPercent(next, true);
        }
    });
}

document.addEventListener('DOMContentLoaded', initSplitResizer);

// ---------------------------------------------------------------------------
// About dialog
// ---------------------------------------------------------------------------
function openAbout() {
    const overlay = document.getElementById('aboutOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeAbout() {
    const overlay = document.getElementById('aboutOverlay');
    if (overlay) overlay.style.display = 'none';
}

// Only dismiss when the backdrop itself is clicked, not the dialog.
function closeAboutBackdrop(event) {
    if (event.target === event.currentTarget) closeAbout();
}

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeAbout();

    const validation = document.getElementById('validationErrorsModal');
    if (validation) validation.remove();

    // Lets go of the JSON box being edited (a drag in progress is abandoned).
    clearBoxSelection();
});

// ---------------------------------------------------------------------------
// JSON editor text direction (LTR / RTL)
// RTL mode keeps the JSON structure (keys, braces, commas) reading left to
// right and flips only the quoted string VALUES, each of which becomes its own
// isolated RTL run. Isolation is what makes leading markers like "(*)" sit on
// the right: without it the Latin key to the left of the string pulls those
// neutral characters back to the LTR side. See the .cm-string rules in
// style.css - the work is done there; this only toggles the class.
// ---------------------------------------------------------------------------
function applyJsonDirection(dir, persist) {
    const rtl = dir === 'rtl';
    const btn = document.getElementById('jsonDirBtn');

    if (jsonEditor) jsonEditor.classList.toggle('rtl', rtl);
    // CodeMirror caches character metrics; force a re-measure after the flip.
    if (jsonCM) jsonCM.refresh();

    if (btn) {
        btn.classList.toggle('is-rtl', rtl);
        btn.setAttribute('aria-pressed', String(rtl));
        btn.title = rtl
            ? 'Switch to left-to-right view'
            : 'Switch to right-to-left view';
    }

    if (persist) {
        try {
            localStorage.setItem('jsonDirection', rtl ? 'rtl' : 'ltr');
        } catch (e) {
            // localStorage unavailable - the setting still applies this session
        }
    }
}

function toggleJsonDirection() {
    const isRtl = jsonEditor && jsonEditor.classList.contains('rtl');
    applyJsonDirection(isRtl ? 'ltr' : 'rtl', true);
}

document.addEventListener('DOMContentLoaded', function () {
    let stored = null;
    try {
        stored = localStorage.getItem('jsonDirection');
    } catch (e) {
        // ignore - fall back to LTR
    }
    applyJsonDirection(stored === 'rtl' ? 'rtl' : 'ltr', false);
});

// ---------------------------------------------------------------------------
// Status footer
// Reads current state directly rather than hooking every mutation site, and is
// refreshed on the events that can change it.
// ---------------------------------------------------------------------------
function updateFooter() {
    const annEl = document.getElementById('footerAnnotations');
    const imgEl = document.getElementById('footerImage');
    const jsonEl = document.getElementById('footerJsonStatus');

    if (annEl) {
        const n = typeof rectangles !== 'undefined' ? rectangles.length : 0;
        let label = n === 0 ? 'No annotations'
                  : n === 1 ? '<strong>1</strong> annotation'
                            : '<strong>' + n + '</strong> annotations';
        if (n > 0 && typeof selectedAnnotation !== 'undefined' && selectedAnnotation !== null) {
            label += ' · #' + (selectedAnnotation + 1) + ' selected';
        }
        annEl.innerHTML = label;
    }

    if (imgEl) {
        if (typeof image !== 'undefined' && image) {
            imgEl.innerHTML = '<strong>' + image.width + '</strong> × <strong>'
                + image.height + '</strong> px';
        } else {
            imgEl.textContent = 'No image';
        }
    }

    if (jsonEl) {
        const raw = jsonEditor ? jsonEditor.value.trim() : '';
        // Saving state wins; then unsaved edits; then the parse status alone.
        const dirtySuffix = typeof isSaving !== 'undefined' && isSaving
            ? ' · <span class="footer-unsaved">Saving…</span>'
            : (typeof isJsonDirty === 'function' && isJsonDirty()
                ? ' · <span class="footer-unsaved">Unsaved changes</span>'
                : '');
        if (!raw) {
            jsonEl.innerHTML = 'JSON empty' + dirtySuffix;
            jsonEl.style.color = '';
        } else {
            try {
                const parsed = JSON.parse(raw);
                const count = Array.isArray(parsed) ? parsed.length : null;
                jsonEl.innerHTML = (count === null
                    ? 'JSON valid'
                    : 'JSON valid · <strong>' + count + '</strong> entries') + dirtySuffix;
                jsonEl.style.color = '';
            } catch (e) {
                jsonEl.innerHTML = '<span style="color: var(--danger)">JSON invalid</span>' + dirtySuffix;
                jsonEl.style.color = '';
            }
        }
    }
}

// Refresh the footer after every function that mutates the state it shows.
['displayImage', 'updateAnnotationsList', 'updateCoordinatesDisplay', 'updateJSON']
    .forEach(function (name) {
        const original = window[name];
        if (typeof original !== 'function') return;
        window[name] = function () {
            const result = original.apply(this, arguments);
            updateFooter();
            return result;
        };
    });

document.addEventListener('DOMContentLoaded', function () {
    updateFooter();
    if (jsonEditor) {
        // Refreshes the unsaved-dot on the save button and the footer status.
        jsonEditor.addEventListener('input', updateSaveIndicators);
        // Keep the overlay in step with hand edits to the JSON.
        jsonEditor.addEventListener('input', refreshBoundingBoxes);
    }
    // The cursor in an entry selects its box (needs CodeMirror's events).
    if (jsonCM) jsonCM.on('cursorActivity', onEditorCursorActivity);
});

// ---------------------------------------------------------------------------
// Mount Folders
// Pairs an image directory with an annotation directory by basename, then
// pages through them. This sits alongside the single-file upload buttons,
// which continue to work unchanged.
// ---------------------------------------------------------------------------
let mountedImages = null;    // Map<basename, FileSystemFileHandle>
let mountedJson = null;      // Map<basename, FileSystemFileHandle>
let mounted = null;          // { pages: [...] } once both folders are present
let imageIndex = 0;
let jsonIndex = 0;
// Where each mounted folder lives ('local' | 'server' | null), so the toolbar
// can light up the button that actually did the mounting.
let mountedImagesSource = null;
let mountedJsonSource = null;

function isMountSupported() {
    return typeof window.showDirectoryPicker === 'function';
}

function warnMountUnsupported() {
    alert(
        'Mounting folders needs the File System Access API.\n\n' +
        'Use Chrome or Edge, and open the app at http://localhost:8000 ' +
        '(a LAN address such as http://192.168.x.x is not a secure context).'
    );
}

// Collects the files in a directory handle, keyed by basename.
async function readDirectory(dirHandle, extensions) {
    const found = new Map();
    for await (const entry of dirHandle.values()) {
        if (entry.kind !== 'file') continue;
        const dot = entry.name.lastIndexOf('.');
        if (dot < 0) continue;
        const ext = entry.name.slice(dot + 1).toLowerCase();
        if (!extensions.includes(ext)) continue;
        found.set(entry.name.slice(0, dot), entry);
    }
    return found;
}

// Sorts so page_2 comes before page_10 rather than lexicographically.
function compareNatural(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function mountImageFolder() {
    if (!isMountSupported()) { warnMountUnsupported(); return; }
    let dir;
    try {
        dir = await window.showDirectoryPicker({ id: 'bornochinho-images' });
    } catch (e) {
        return; // dismissed
    }
    try {
        mountedImages = await readDirectory(dir, ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']);
        if (mountedImages.size === 0) {
            mountedImages = null;
            showToast('warning', 'That folder contains no images.');
            return;
        }
        mountedImagesSource = 'local';
        await pairMountedFolders('image');
    } catch (e) {
        showToast('error', 'Could not read the image folder: ' + (e.message || e));
    }
}

async function mountJsonFolder() {
    if (!isMountSupported()) { warnMountUnsupported(); return; }
    let dir;
    try {
        dir = await window.showDirectoryPicker({ id: 'bornochinho-annotations' });
    } catch (e) {
        return; // dismissed
    }
    try {
        mountedJson = await readDirectory(dir, ['json']);
        if (mountedJson.size === 0) {
            mountedJson = null;
            showToast('warning', 'That folder contains no .json files.');
            return;
        }
        mountedJsonSource = 'local';
        await pairMountedFolders('json');
    } catch (e) {
        showToast('error', 'Could not read the annotation folder: ' + (e.message || e));
    }
}

// Pairs whatever is currently mounted. Either folder can be mounted first, or
// re-mounted later; `origin` is the side that just changed, so a single mounted
// folder can still be browsed on its own.
async function pairMountedFolders(origin) {
    updateMountStatus();

    // Only one side mounted so far: browse it alone.
    if (!mountedImages || !mountedJson) {
        const single = mountedImages || mountedJson;
        const isImages = !!mountedImages;
        mounted = {
            pages: Array.from(single.keys()).sort(compareNatural).map(function (base) {
                return {
                    base: base,
                    image: isImages ? single.get(base) : null,
                    annotation: isImages ? null : single.get(base)
                };
            })
        };
        imageIndex = 0;
        jsonIndex = 0;
        showPagers();
        if (isImages) await showImageAt(0); else await showJsonAt(0);
        return;
    }

    // Both mounted: pair by basename.
    const pages = [];
    const unmatched = [];
    Array.from(mountedImages.keys()).sort(compareNatural).forEach(function (base) {
        if (mountedJson.has(base)) {
            pages.push({ base: base, image: mountedImages.get(base), annotation: mountedJson.get(base) });
        } else {
            unmatched.push(base);
        }
    });

    if (pages.length === 0) {
        alert(
            'No matching pairs found.\n\n' +
            'Image and annotation files must share the same name, e.g. ' +
            'page_0003.png and page_0003.json.'
        );
        return;
    }

    mounted = { pages: pages };
    imageIndex = 0;
    jsonIndex = 0;
    showPagers();
    await showImageAt(0);
    await showJsonAt(0);

    if (unmatched.length) {
        console.warn('Images without a matching .json:', unmatched);
    }
}

function showPagers() {
    document.getElementById('imagePager').style.display = 'flex';
    document.getElementById('jsonPager').style.display = 'flex';
}

// Reflects which folders are mounted on the four buttons; the one that did
// the mounting lights up, its counterpart offers to switch source.
function updateMountStatus() {
    const buttons = [
        { id: 'mountImagesBtn', map: mountedImages, source: mountedImagesSource, mine: 'local',
          idle: 'Mount a folder of images', what: 'Images' },
        { id: 'serverImagesBtn', map: mountedImages, source: mountedImagesSource, mine: 'server',
          idle: 'Mount an image folder from the server dataset', what: 'Images' },
        { id: 'mountJsonBtn', map: mountedJson, source: mountedJsonSource, mine: 'local',
          idle: 'Mount a folder of annotations', what: 'Annotations' },
        { id: 'serverJsonBtn', map: mountedJson, source: mountedJsonSource, mine: 'server',
          idle: 'Mount an annotation folder from the server dataset', what: 'Annotations' }
    ];
    buttons.forEach(function (spec) {
        const btn = document.getElementById(spec.id);
        if (!btn) return;
        const active = !!spec.map && spec.source === spec.mine;
        btn.classList.toggle('is-mounted', active);
        btn.title = active
            ? spec.what + ' mounted (' + spec.map.size + ' files) - click to change folder'
            : spec.idle;
    });
}

// Guards against out-of-order completion when pages are stepped quickly.
let imageLoadToken = 0;

async function showImageAt(index) {
    if (!mounted) return;
    imageIndex = Math.min(Math.max(index, 0), mounted.pages.length - 1);
    const page = mounted.pages[imageIndex];

    // Reflect the new position immediately; the pixels follow asynchronously.
    updatePagers();

    // No image folder mounted yet - nothing to display on this side.
    if (!page.image) return;

    const token = ++imageLoadToken;
    let file, dataUrl;
    try {
        file = await page.image.getFile();
        dataUrl = await new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(reader.error); };
            reader.readAsDataURL(file);
        });
    } catch (e) {
        if (token === imageLoadToken) {
            showToast('error', 'Could not load the image for ' + page.base + ': ' + (e.message || e));
        }
        return;
    }

    // A newer step superseded this one while the file was being read.
    if (token !== imageLoadToken) return;

    currentImageFile = file.name;
    loadImage(dataUrl);
}

let jsonLoadToken = 0;

async function showJsonAt(index) {
    if (!mounted) return;
    const next = Math.min(Math.max(index, 0), mounted.pages.length - 1);
    const page = mounted.pages[next];

    // Loading a page replaces the editor, so unsaved edits would be lost
    // silently. The index only moves once the user agrees to discard them.
    if (page.annotation && isJsonDirty()) {
        const name = currentJsonFile || 'the current file';
        if (!confirm('Unsaved changes in ' + name + ' will be LOST.\n\nDiscard the changes and leave this page?')) {
            return;
        }
    }

    jsonIndex = next;
    updatePagers();

    // No annotation folder mounted yet - nothing to display on this side.
    if (!page.annotation) return;

    const token = ++jsonLoadToken;
    let text;
    try {
        const file = await page.annotation.getFile();
        if (token !== jsonLoadToken) return;
        text = await file.text();
        if (token !== jsonLoadToken) return;
        currentJsonFile = file.name;
    } catch (e) {
        if (token === jsonLoadToken) {
            showToast('error', 'Could not load ' + page.base + '.json: ' + (e.message || e));
        }
        return;
    }
    // The pager now owns the editor; any singly-loaded file is no longer shown.
    loadedJsonHandle = null;
    // A selection points into the old file's entries.
    clearBoxSelection();

    try {
        jsonEditor.value = JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
        // Show malformed files as-is so they can be inspected and fixed.
        jsonEditor.value = text;
    }

    // A different document is on screen now: it starts clean, and any save
    // feedback from the previous page no longer applies.
    noteJsonDocumentLoaded();

    updatePagers();
    if (typeof updateFooter === 'function') updateFooter();
    // New page, new boxes.
    refreshBoundingBoxes();
}

function stepImage(delta) {
    if (!mounted) return;
    showImageAt(imageIndex + delta);
}

function stepJson(delta) {
    if (!mounted) return;
    showJsonAt(jsonIndex + delta);
}

// Brings the JSON pane back in line with the image pane.
function syncPages() {
    if (!mounted) return;
    showJsonAt(imageIndex);
}

function updatePagers() {
    if (!mounted) return;
    const total = mounted.pages.length;

    const imgLabel = document.getElementById('imagePagerLabel');
    const jsonLabel = document.getElementById('jsonPagerLabel');
    if (imgLabel) {
        imgLabel.innerHTML = mounted.pages[imageIndex].base
            + ' <span class="pager-count">' + (imageIndex + 1) + ' / ' + total + '</span>';
    }
    if (jsonLabel) {
        jsonLabel.innerHTML = mounted.pages[jsonIndex].base
            + ' <span class="pager-count">' + (jsonIndex + 1) + ' / ' + total + '</span>';
    }

    const hasImages = !!mountedImages;
    const hasJson = !!mountedJson;
    document.getElementById('imagePrevBtn').disabled = !hasImages || imageIndex === 0;
    document.getElementById('imageNextBtn').disabled = !hasImages || imageIndex === total - 1;
    document.getElementById('jsonPrevBtn').disabled = !hasJson || jsonIndex === 0;
    document.getElementById('jsonNextBtn').disabled = !hasJson || jsonIndex === total - 1;

    // The sync affordance only appears when both folders are mounted and the
    // two panes have drifted apart.
    const desynced = !!mountedImages && !!mountedJson && imageIndex !== jsonIndex;
    const syncBtn = document.getElementById('syncPagesBtn');
    if (syncBtn) syncBtn.style.display = desynced ? 'inline-flex' : 'none';
    document.getElementById('imagePager').classList.toggle('is-desynced', desynced);
    document.getElementById('jsonPager').classList.toggle('is-desynced', desynced);
}

// ---------------------------------------------------------------------------
// Server folders
// The same mount-and-page workflow, but over the dataset directory that lives
// on the server, so nobody has to copy gigabytes of pages to their own machine
// first. Server files are wrapped in objects that mimic the two methods the
// mount code actually uses - getFile() and createWritable() - so pairing,
// paging and in-place saving all reuse the local-mount code unchanged. Unlike
// local mounts this needs no File System Access API, so it also works from
// browsers and non-secure LAN/VPN addresses where local mounting cannot.
// ---------------------------------------------------------------------------

// The dataset keeps images/<book> and annotations/<book> mirrored, so after
// one side is mounted the matching other side can be offered automatically.
const SERVER_SIBLING_ROOTS = {
    'images': 'annotations',
    'images_v2': 'annotations_v2',
    'annotations': 'images',
    'annotations_v2': 'images_v2'
};

function serverFileHandle(relPath, name) {
    return {
        name: name,

        async getFile() {
            const response = await fetch('/server/file?path=' + encodeURIComponent(relPath));
            if (!response.ok) {
                throw new Error('Could not read ' + name + ' from the server.');
            }
            const blob = await response.blob();
            return new File([blob], name, { type: blob.type });
        },

        // Collects the written data, then ships it on close() - mirroring how
        // a FileSystemWritableFileStream only commits when closed.
        async createWritable() {
            let buffer = '';
            return {
                async write(data) { buffer = data; },
                async close() {
                    const response = await fetch('/server/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: relPath, text: buffer })
                    });
                    if (!response.ok) {
                        let detail = 'Server save failed';
                        try {
                            const err = await response.json();
                            if (err.detail) detail = err.detail;
                        } catch (e) { /* keep the generic message */ }
                        throw new Error(detail);
                    }
                },
                async abort() { /* nothing was sent yet */ }
            };
        }
    };
}

async function fetchServerJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        let detail = 'Server request failed';
        try {
            const err = await response.json();
            if (err.detail) detail = err.detail;
        } catch (e) { /* keep the generic message */ }
        throw new Error(detail);
    }
    return response.json();
}

// Builds the basename->handle map for one server folder and mounts it on the
// requested side, exactly as the local mount functions do.
async function mountServerDirectory(kind, path) {
    const data = await fetchServerJson(
        '/server/files?path=' + encodeURIComponent(path) + '&kind=' + kind
    );

    const found = new Map();
    data.files.forEach(function (name) {
        const dot = name.lastIndexOf('.');
        const base = dot < 0 ? name : name.slice(0, dot);
        const rel = path ? path + '/' + name : name;
        found.set(base, serverFileHandle(rel, name));
    });

    if (found.size === 0) {
        showToast('warning', 'That server folder contains no ' + (kind === 'images' ? 'images.' : '.json files.'));
        return false;
    }

    if (kind === 'images') {
        mountedImages = found;
        mountedImagesSource = 'server';
    } else {
        mountedJson = found;
        mountedJsonSource = 'server';
    }
    await pairMountedFolders(kind === 'images' ? 'image' : 'json');
    return true;
}

// The mirrored counterpart of a dataset path, e.g. images_v2/foo ->
// annotations_v2/foo, or null when the path is not under a mirrored root.
function serverSiblingPath(path) {
    const parts = path.split('/');
    const mapped = SERVER_SIBLING_ROOTS[parts[0]];
    if (!mapped) return null;
    return [mapped].concat(parts.slice(1)).join('/');
}

// After mounting one side, offers the matching folder from the mirrored tree
// so a book can be opened with a single trip through the picker.
async function offerServerSibling(kind, path) {
    const otherKind = kind === 'images' ? 'json' : 'images';
    const alreadyMounted = otherKind === 'images' ? mountedImages : mountedJson;
    if (alreadyMounted) return;

    const sibling = serverSiblingPath(path);
    if (!sibling) return;

    try {
        const data = await fetchServerJson(
            '/server/files?path=' + encodeURIComponent(sibling) + '&kind=' + otherKind
        );
        if (data.files.length === 0) return;

        const label = otherKind === 'json' ? 'annotation' : 'image';
        if (confirm('Found the matching ' + label + ' folder on the server:\n\n'
                    + sibling + '\n\nMount it too?')) {
            await mountServerDirectory(otherKind, sibling);
        }
    } catch (e) {
        // The suggestion is a convenience; a missing sibling is not an error.
    }
}

// ---------------------------------------------------------------------------
// Server folder picker
// A minimal directory browser over /server/browse, built on the same modal
// chrome as the About and validation dialogs.
// ---------------------------------------------------------------------------
let serverBrowse = null; // { kind, path } while the picker is open

function mountServerFolder(kind) {
    openServerBrowser(kind);
}

function closeServerBrowser() {
    const overlay = document.getElementById('serverBrowserModal');
    if (overlay) overlay.remove();
    serverBrowse = null;
}

function openServerBrowser(kind) {
    closeServerBrowser();
    serverBrowse = { kind: kind, path: '' };

    const overlay = document.createElement('div');
    overlay.id = 'serverBrowserModal';
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', function (event) {
        if (event.target === overlay) closeServerBrowser();
    });

    const box = document.createElement('div');
    box.className = 'modal server-browser';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = kind === 'images'
        ? 'Choose an image folder on the server'
        : 'Choose an annotation folder on the server';
    header.appendChild(title);
    box.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';

    const crumb = document.createElement('p');
    crumb.id = 'serverBrowserPath';
    crumb.className = 'server-browser-path';
    body.appendChild(crumb);

    const list = document.createElement('ul');
    list.id = 'serverBrowserList';
    list.className = 'server-browser-list';
    body.appendChild(list);

    const counts = document.createElement('p');
    counts.id = 'serverBrowserCounts';
    counts.className = 'server-browser-counts';
    body.appendChild(counts);

    box.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'small-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeServerBrowser;
    footer.appendChild(cancelBtn);

    const mountBtn = document.createElement('button');
    mountBtn.id = 'serverBrowserMountBtn';
    mountBtn.className = 'small-btn primary';
    mountBtn.textContent = 'Mount this folder';
    mountBtn.disabled = true;
    mountBtn.onclick = mountFromServerBrowser;
    footer.appendChild(mountBtn);

    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    loadServerDirectory('');
}

async function loadServerDirectory(path) {
    if (!serverBrowse) return;
    serverBrowse.path = path;

    const list = document.getElementById('serverBrowserList');
    const crumb = document.getElementById('serverBrowserPath');
    const counts = document.getElementById('serverBrowserCounts');
    const mountBtn = document.getElementById('serverBrowserMountBtn');
    if (!list || !crumb || !counts || !mountBtn) return;

    crumb.textContent = '/' + (path || '');
    list.innerHTML = '';
    counts.textContent = 'Loading…';
    mountBtn.disabled = true;

    let data;
    try {
        data = await fetchServerJson('/server/browse?path=' + encodeURIComponent(path));
    } catch (e) {
        counts.textContent = e.message || 'Could not read that folder.';
        return;
    }
    // A slow response for a folder the user has already navigated away from.
    if (!serverBrowse || serverBrowse.path !== path) return;

    function addEntry(label, targetPath, isParent) {
        const item = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'server-browser-entry' + (isParent ? ' is-parent' : '');
        btn.textContent = label;
        btn.onclick = function () { loadServerDirectory(targetPath); };
        item.appendChild(btn);
        list.appendChild(item);
    }

    if (path) {
        const parent = path.split('/').slice(0, -1).join('/');
        addEntry('.. (up one level)', parent, true);
    }
    data.dirs.forEach(function (name) {
        addEntry(name, path ? path + '/' + name : name, false);
    });
    if (!path && data.dirs.length === 0
            && data.image_count === 0 && data.json_count === 0) {
        counts.textContent = 'The server data directory is empty.';
        return;
    }

    const relevant = serverBrowse.kind === 'images' ? data.image_count : data.json_count;
    counts.textContent = data.image_count + ' image files, '
        + data.json_count + ' annotation files in this folder';
    mountBtn.disabled = relevant === 0;
}

async function mountFromServerBrowser() {
    if (!serverBrowse) return;
    const kind = serverBrowse.kind;
    const path = serverBrowse.path;

    try {
        const ok = await mountServerDirectory(kind, path);
        closeServerBrowser();
        if (ok) await offerServerSibling(kind, path);
    } catch (e) {
        showToast('error', 'Could not mount the server folder: ' + (e.message || e));
    }
}

document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeServerBrowser();
});

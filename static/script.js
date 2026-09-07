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
            jsonCM.setValue(v == null ? '' : String(v));
            jsonCM.setCursor(cursor);
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
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
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
            alert('Failed to upload image');
        }
    } catch (error) {
        alert('Error uploading image: ' + error);
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
        alert('Failed to upload JSON');
        return false;
    }

    const data = await response.json();
    currentJsonFile = data.name || file.name;
    jsonEditor.value = JSON.stringify(data.content, null, 2);
    refreshBoundingBoxes();
    return true;
}

// The Load button. Uses the file picker where available so the chosen file can
// be overwritten in place on save; otherwise falls back to the hidden input,
// where saving can only download.
async function openJsonFile() {
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
        alert('Error opening JSON: ' + (error.message || error));
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
        alert('Error uploading JSON: ' + error);
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

    // Read-only layer from the loaded JSON, drawn on top of the hand-drawn
    // rectangles. No-op while the toggle is off.
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
    
    if (isSelected) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
    }
    
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.shadowBlur = 0;
}

// ---------------------------------------------------------------------------
// Bounding box overlay
// A read-only layer drawn from whatever is currently in the JSON editor, so it
// follows both the single-file Load and the mounted-folder pager, and picks up
// manual edits to the text. Entries without a usable bbox are skipped, which
// makes a partially-annotated file draw only the boxes it actually has.
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

// Every drawable box in the editor's current contents. Returns [] for empty,
// malformed, or bbox-free JSON, so the caller never has to special-case them.
function getJsonBoundingBoxes() {
    const raw = jsonEditor ? jsonEditor.value.trim() : '';
    if (!raw) return [];

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return []; // Mid-edit or malformed - nothing to draw.
    }

    // Top level is normally the array of entries; also accept a wrapper object
    // holding that array under a common key.
    let entries = parsed;
    if (!Array.isArray(entries) && parsed && typeof parsed === 'object') {
        entries = parsed.entries || parsed.annotations || parsed.elements
            || parsed.rectangles || parsed.data;
    }
    if (!Array.isArray(entries)) entries = [parsed];

    const boxes = [];
    entries.forEach(function (entry) {
        const box = parseBBox(entry);
        if (box) boxes.push(box);
    });
    return boxes;
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

    boxes.forEach(function (box, index) {
        const key = typeof box.category === 'string' ? box.category.toLowerCase() : '';
        const color = bboxColors[key] || bboxFallbackColor;

        const x = box.x1 * zoomLevel;
        const y = box.y1 * zoomLevel;
        const w = (box.x2 - box.x1) * zoomLevel;
        const h = (box.y2 - box.y1) * zoomLevel;

        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);

        drawBBoxLabel(x, y, color, box.category || 'Box', index + 1);
    });

    ctx.restore();
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
        el.innerHTML = '<strong>' + n + '</strong> ' + (n === 1 ? 'box' : 'boxes') + ' shown';
        el.style.color = '';
    }
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

function triggerSaveDialog() {
    try {
        const jsonData = JSON.parse(jsonEditor.value);
        const filename = currentJsonFile || 'annotations.json';

        const dataStr = JSON.stringify(jsonData, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);

        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', filename);
        linkElement.click();
    } catch (error) {
        alert('Error saving JSON: ' + error.message);
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

// Overwrites the mounted file in place. Returns 'written' on success,
// 'no-handle' when there is nothing to write through (the caller then falls
// back to a download), or 'denied' when write access was refused.
async function writeToMountedFile() {
    const handle = currentJsonHandle();
    if (!handle) return 'no-handle';

    if (!await ensureWritePermission(handle)) {
        alert('Permission to write to the annotation folder was declined, so the file was not saved.');
        return 'denied';
    }

    const dataStr = JSON.stringify(JSON.parse(jsonEditor.value), null, 2);
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
    let jsonData;
    try {
        jsonData = JSON.parse(jsonEditor.value);
    } catch (error) {
        alert('Invalid JSON format: ' + (error.message || error));
        return;
    }

    try {
        // Ensure payload is an array when submitting to validate_json
        const payload = Array.isArray(jsonData) ? jsonData : [jsonData];

        const response = await fetch('/validate_json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            alert('Validation request failed');
            return;
        }

        const result = await response.json();
        if (result.error_count === 0) {
            // Overwrite the mounted file in place; fall back to a download when
            // the JSON came from the single-file upload button.
            const outcome = await writeToMountedFile();
            if (outcome === 'no-handle') {
                triggerSaveDialog();
            } else if (outcome === 'denied') {
                return; // Already explained; no "Saved!" for a file that was not saved.
            }
            // show quick saved feedback
            const saveBtn = document.getElementById('saveJsonBtn');
            if (saveBtn) {
                const originalHTML = saveBtn.innerHTML;
                saveBtn.innerHTML = '<i data-lucide="check"></i> Saved!';
                saveBtn.style.background = 'var(--success-solid)';
                saveBtn.style.color = '#ffffff';
                if (typeof lucide !== 'undefined') lucide.createIcons();
                setTimeout(() => {
                    saveBtn.innerHTML = originalHTML;
                    saveBtn.style.background = '';
                    saveBtn.style.color = '';
                    if (typeof lucide !== 'undefined') lucide.createIcons();
                }, 1400);
            }
        } else {
            // Show errors in a popup/modal
            const details = Array.isArray(result.error_detail) ? result.error_detail : [String(result.error_detail)];
            showValidationErrors(details);
        }
    } catch (error) {
        alert('Error saving JSON: ' + (error.message || error));
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
    // Delete selected annotation with Delete or Backspace key
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotation !== null) {
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
        if (!raw) {
            jsonEl.textContent = 'JSON empty';
            jsonEl.style.color = '';
        } else {
            try {
                const parsed = JSON.parse(raw);
                const count = Array.isArray(parsed) ? parsed.length : null;
                jsonEl.innerHTML = count === null
                    ? 'JSON valid'
                    : 'JSON valid · <strong>' + count + '</strong> entries';
                jsonEl.style.color = '';
            } catch (e) {
                jsonEl.textContent = 'JSON invalid';
                jsonEl.style.color = 'var(--danger)';
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
        jsonEditor.addEventListener('input', updateFooter);
        // Keep the overlay in step with hand edits to the JSON.
        jsonEditor.addEventListener('input', refreshBoundingBoxes);
    }
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
            alert('That folder contains no images.');
            return;
        }
        await pairMountedFolders('image');
    } catch (e) {
        alert('Could not read the image folder: ' + e.message);
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
            alert('That folder contains no .json files.');
            return;
        }
        await pairMountedFolders('json');
    } catch (e) {
        alert('Could not read the annotation folder: ' + e.message);
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

// Reflects which folders are mounted on the two buttons.
function updateMountStatus() {
    const imgBtn = document.getElementById('mountImagesBtn');
    const jsonBtn = document.getElementById('mountJsonBtn');
    if (imgBtn) {
        imgBtn.classList.toggle('is-mounted', !!mountedImages);
        imgBtn.title = mountedImages
            ? 'Images mounted (' + mountedImages.size + ') - click to change folder'
            : 'Mount a folder of images';
    }
    if (jsonBtn) {
        jsonBtn.classList.toggle('is-mounted', !!mountedJson);
        jsonBtn.title = mountedJson
            ? 'Annotation folder mounted (' + mountedJson.size + ' files) - click to change'
            : 'Mount a folder of annotations';
    }
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
    const file = await page.image.getFile();
    const dataUrl = await new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsDataURL(file);
    });

    // A newer step superseded this one while the file was being read.
    if (token !== imageLoadToken) return;

    currentImageFile = file.name;
    loadImage(dataUrl);
}

let jsonLoadToken = 0;

async function showJsonAt(index) {
    if (!mounted) return;
    jsonIndex = Math.min(Math.max(index, 0), mounted.pages.length - 1);
    const page = mounted.pages[jsonIndex];

    updatePagers();

    // No annotation folder mounted yet - nothing to display on this side.
    if (!page.annotation) return;

    const token = ++jsonLoadToken;
    const file = await page.annotation.getFile();
    if (token !== jsonLoadToken) return;
    const text = await file.text();
    if (token !== jsonLoadToken) return;
    currentJsonFile = file.name;
    // The pager now owns the editor; any singly-loaded file is no longer shown.
    loadedJsonHandle = null;

    try {
        jsonEditor.value = JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
        // Show malformed files as-is so they can be inspected and fixed.
        jsonEditor.value = text;
    }

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

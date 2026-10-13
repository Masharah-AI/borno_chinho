# RTL / Arabic editing — manual QA checklist

Ten click-steps against the JSON editor. Run them on the live app after every
deploy that touches `static/script.js`, `static/style.css` or the CodeMirror
bundle. Use a page whose annotations contain Arabic, or paste this value into
any `"text"` field: `"قرأت 3 كتب في عام ١٤٤٥ عن tajweed"`.

Console helper: open DevTools and run `__rtlDebug()`. It reports the mode,
the text direction CodeMirror itself is using (not CSS), the number of
isolated runs in the viewport, and the active text font. `textDirection`
must match the mode after step 1 — if it says `LTR` while the editor is
right-to-left, direction is CSS-only and the caret will lie.

1. **Toggle RTL.** Click the direction button in the editor header. The whole
   editor flips right-to-left, the scrollbar moves to the LEFT edge, and
   `__rtlDebug().textDirection` says `RTL`. Toggle back; it says `LTR` and the
   Arabic values still read right-to-left (isolated), punctuation attached to
   the Arabic, not drifting toward the Latin key.

2. **Click into the middle of an Arabic value** (both modes). The caret must
   appear exactly where you clicked — between the two glyphs you aimed at,
   not at the string's far end. Click between an Arabic word and the closing
   quote too: the caret lands inside the string, not on the key before it.

3. **Walk the caret with ← / →.** Inside Arabic text, each press moves the
   caret one visual step in the arrow's direction, including across the
   Arabic↔Latin boundary inside `... عن tajweed`. Home/End go to the visual
   start/end of the line. No key may jump the caret to another line.

4. **Select across a bidi boundary.** Click just before `tajweed` and
   shift-click (or drag) into the middle of the Arabic before it. The
   highlight is contiguous on screen, and Copy copies exactly the highlighted
   characters (paste into the search box to verify).

5. **Type Arabic after a digit.** Put the caret right after `١٤٤٥` (and after
   the Latin `3`) and type an Arabic word. The new letters join the Arabic
   flow; the digits do not reorder and the quotes/commas around the value do
   not jump. Delete what you typed with Backspace — one glyph at a time, from
   the caret, never from the other end of the string.

6. **Empty string, first keystroke.** Make a value `""`, place the caret
   between the quotes and type an Arabic letter. From the FIRST letter the
   string lays out as an RTL run (in LTR view, the quotes hug the letter and
   nothing shifts elsewhere on the line). `__rtlDebug().visibleIsolates`
   goes up by one.

7. **Paste multiline Arabic.** Copy two lines of Arabic text and paste them
   inside a value. The editor must not mis-render or throw (check the
   console) even though the JSON is momentarily invalid; the validation
   panel flags it. Fix it to one line (or undo) and confirm the value reads
   correctly again.

8. **Undo / redo.** Ctrl+Z (Cmd+Z) after steps 5–7, several times, then redo.
   Every step restores the exact previous text AND a sensible caret; the
   Arabic never comes back visually scrambled or with quotes detached.

9. **Font check.** In the font menu pick *Noto Naskh Arabic*: the `"text"`
   values re-render in Naskh with no clipped diacritics (type a word with
   shadda+damma, e.g. `قُوَّة`). After the font finishes downloading, click
   into the middle of a long Arabic value again — the caret must still land
   where you click (metrics were re-measured). Pick *Noto Nastaliq Urdu*:
   line spacing opens up, nothing overlaps. Back to *Monospace*: Arabic
   still renders in an Arabic-capable fallback, never tofu boxes.

10. **Save round-trip.** With Arabic edits from the steps above still in the
    editor, Save, reload the page (and page back to the same file). The file
    on disk and the reloaded editor show byte-identical text — isolation is
    display-only, so no directional marks or reordered characters may ever
    be written into the JSON.

Any failure: note the step number, the mode (LTR/RTL), the browser, and the
output of `__rtlDebug()` at the moment of failure.

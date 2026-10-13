// Everything static/script.js uses from CodeMirror 6, bundled into one browser
// script that exposes it as the global `CM`. The app has no build step of its
// own, so this is the only place CodeMirror's ES modules are resolved.
export {
    EditorState, EditorSelection, StateField, StateEffect, Compartment, RangeSetBuilder,
} from '@codemirror/state';
export {
    EditorView, Decoration, ViewPlugin, Direction, keymap, drawSelection,
    highlightSpecialChars, placeholder,
} from '@codemirror/view';
export { syntaxTree, syntaxHighlighting } from '@codemirror/language';
export {
    history, historyKeymap, defaultKeymap, insertTab, indentLess, isolateHistory,
} from '@codemirror/commands';
export { json } from '@codemirror/lang-json';
export { classHighlighter } from '@lezer/highlight';

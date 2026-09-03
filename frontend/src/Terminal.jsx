import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNetworkId } from "./network.js";

// ONE global operation console, docked to the bottom of every page (cloud-shell
// style): ops anywhere push lines into a shared store; the dock auto-opens when a
// command starts and collapses to a slim status bar. On-chain steps take 10–60s —
// the spinner + ticking elapsed counter make it clearly alive.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const stamp = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

// --- shared store (module-level; any code can push, every page shows the same log)
let state = { lines: [], busy: "", open: false };
const subs = new Set();
const emit = () => { state = { ...state }; subs.forEach((f) => f()); };

// push a line; a "cmd" line marks the start of an operation → pop the dock open
export const termPush = (text, kind = "info") => {
  state.lines = [...state.lines, { ts: stamp(), text, kind }];
  if (kind === "cmd") state.open = true;
  emit();
};
export const termClear = () => { state.lines = []; emit(); };
// modules that can't import this file (e.g. network.js — it's imported BY the
// dock) log via a window event instead
if (typeof window !== "undefined") {
  window.addEventListener("kosign-termlog", (e) => termPush(e.detail?.text ?? "", e.detail?.kind || "info"));
}
export const termBusy = (label) => { const b = label || ""; if (b && !state.busy) state.open = true; state.busy = b; emit(); };
const toggle = () => { state.open = !state.open; emit(); };
export const useTerm = () => useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => state, () => state);

const glyph = (k) => (k === "cmd" ? "$" : k === "ok" ? "✔" : k === "err" ? "✘" : k === "warn" ? "⌁" : "▸");

export default function TerminalDock() {
  const { lines, busy, open } = useTerm();
  const netId = useNetworkId();
  // reserve scroll room under the page while expanded, so the dock never hides
  // content — you can always scroll it into view (see body.term-open in css)
  useEffect(() => {
    document.body.classList.toggle("term-open", open);
    return () => document.body.classList.remove("term-open");
  }, [open]);
  const [tick, setTick] = useState(0);
  const startRef = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (!busy) { startRef.current = null; return; }
    if (startRef.current == null) startRef.current = Date.now();
    const id = setInterval(() => setTick((t) => t + 1), 90); // drive spinner + elapsed
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => { const el = bodyRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lines, tick, open, busy]);

  const elapsed = busy && startRef.current ? ((Date.now() - startRef.current) / 1000).toFixed(1) : null;
  const last = lines[lines.length - 1];

  return (
    <div className={`termdock${open ? " open" : ""}${busy ? " live" : ""}`}>
      <div className="term-bar" role="button" title={open ? "Collapse" : "Expand"} onClick={toggle}>
        <span className="term-dots"><i /><i /><i /></span>
        <span className="term-title">kosign@{netId}:~</span>
        {!open && last && <span className="term-preview">{glyph(last.kind)} {last.text}</span>}
        <span className="term-status">{busy ? `${SPIN[tick % SPIN.length]} ${busy} · ${elapsed}s` : lines.length ? "● done" : "idle"}</span>
        {lines.length > 0 && !busy && <button className="term-clearbtn" onClick={(e) => { e.stopPropagation(); termClear(); }}>clear</button>}
        <span className="term-chev">{open ? "▾" : "▴"}</span>
      </div>
      {open && (
        <div className="term-body" ref={bodyRef}>
          {lines.length === 0 && (
            <div className="term-line"><span className="term-ts" /><span className="term-glyph">▸</span><span className="term-txt" style={{ color: "var(--muted)" }}>no activity yet — every operation logs here</span></div>
          )}
          {lines.map((l, i) => (
            <div className={`term-line ${l.kind || ""}`} key={i}>
              <span className="term-ts">{l.ts}</span>
              <span className="term-glyph">{glyph(l.kind)}</span>
              <span className="term-txt">{l.text}</span>
            </div>
          ))}
          {busy && (
            <div className="term-line">
              <span className="term-ts" />
              <span className="term-glyph" />
              <span className="term-txt"><span className="term-cur" /></span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

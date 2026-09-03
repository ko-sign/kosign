import React from "react";
import { createRoot } from "react-dom/client";
// Fira Code (the app's mono font) is self-hosted via @fontsource and bundled —
// no Google Fonts dependency, so cache / ad-blockers / offline can't leave the
// terminal UI on a fallback font.
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/fira-code/700.css";
// Inter (the app's sans font) is self-hosted too — the same four weights Google
// Fonts used to serve. Loading it from fonts.googleapis.com sent every visitor's
// IP to Google and let a third party ship arbitrary CSS into a wallet UI; SRI
// can't pin that request either, since the response varies by User-Agent.
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "./styles.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);

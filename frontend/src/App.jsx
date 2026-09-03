import React, { useEffect, useState } from "react";
import Landing from "./Landing.jsx";
import CreateTreasury from "./CreateTreasury.jsx";
import TreasuryView from "./TreasuryView.jsx";
import KeyBar from "./KeyBar.jsx";
import TerminalDock from "./Terminal.jsx";

function useHashRoute() {
  const [route, setRoute] = useState(() => (location.hash || "#/").slice(1));
  useEffect(() => {
    const on = () => setRoute((location.hash || "#/").slice(1));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
export const go = (to) => { location.hash = to; };

export default function App() {
  const route = useHashRoute();
  // The treasury is addressed in the URL by its wallet (vault) address, e.g.
  // /treasury/kaspatest:pqj…  — a legacy 64-hex treasuryId is also accepted. An optional
  // trailing segment picks the page (/assets | /transactions | /settings) so a
  // copied URL opens on the same tab.
  const treasuryMatch = route.match(/^\/treasury\/([^/]+)(?:\/(assets|transactions|settings))?$/);

  // Per-treasury view = full-bleed app layout (own left sidebar + topbar); no centered
  // marketing shell. Landing / Home keep the centered shell + top nav.
  if (treasuryMatch) {
    return (
      <>
        <div className="bg-fx" />
        <TreasuryView param={decodeURIComponent(treasuryMatch[1])} page={treasuryMatch[2] || "assets"} />
        <TerminalDock />
      </>
    );
  }

  // "My Treasuries" list is temporarily removed — Launch App goes straight to Create.
  const inApp = route.startsWith("/create");
  const view = inApp ? <CreateTreasury /> : <Landing onLaunch={() => go("/create")} />;
  return (
    <>
      <div className="bg-fx" />
      <div className="shell">
        <nav className="nav">
          <div className="brand" onClick={() => go("/")}>
            <span className="dot" />
            <span>Ko-<span className="grad">sign</span></span>
          </div>
          <div className="nav-links">
            {inApp ? (
              // in-app: just the wallet + network controls — the brand and the
              // page's "← Home" already cover navigation, GitHub lives on the landing
              <KeyBar />
            ) : (
              <>
                <KeyBar gearOnly />
                <button className="btn btn-primary" onClick={() => go("/create")}>Launch App</button>
              </>
            )}
          </div>
        </nav>
        {view}
      </div>
      <TerminalDock />
    </>
  );
}

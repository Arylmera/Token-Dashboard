import React from "react";
import { theme } from "../themes/theme";

/* Per-theme ornament that the flat instrument finishes don't get: a banner strip
   under the topbar (in flow, between header and main) and — for cockpit — a fixed
   HUD readout bottom-right. Ported from the special-themes design handoff and
   adapted to Praetorium's vocabulary. Renders nothing for non-special themes. */

const BOOT_LOG = [
  "mounting vault /Terra",
  "watch daemon online",
  "claude bridge ready",
  "graph engine primed",
  "0 errors · 0 warnings",
];

export function SpecialChrome() {
  // NOTE: theme() is still a SolidJS signal (theme.ts not yet ported to JS).
  // After Phase 7, this will be replaced with useStore(themeStore).
  // Until then, theming won't be reactive but the structure is correct.
  const t = theme();

  if (t === "terminal") {
    return (
      <div className="a-banner-terminal" aria-hidden="true">
        {/* track items duplicated for a seamless -50% marquee loop */}
        <div className="track">
          {[...BOOT_LOG, ...BOOT_LOG].map((line, i) => (
            <span key={i}>
              <span className="ok">[ OK ]</span> {line}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (t === "cockpit") {
    return (
      <>
        <div className="a-banner-cockpit" aria-hidden="true">
          <span className="blip" />
          <span>
            link <b>stable</b>
          </span>
          <i className="sep" />
          <span>
            telemetry <b>nominal</b>
          </span>
          <i className="sep" />
          <span>
            bearing <b>274°</b>
          </span>
          <i className="sep" />
          <span>
            reserves <span className="amber">63%</span>
          </span>
          <i className="sep" />
          <span>
            eta <b>03:42 zulu</b>
          </span>
        </div>
        <div className="a-hud" aria-hidden="true">
          <span>
            BRG <span className="val">274°</span>
          </span>
          <span>
            ALT <span className="val">38 200</span>
          </span>
          <span>
            SPD <span className="val">0.82M</span>
          </span>
          <span>
            FUEL <span className="amb">63%</span>
          </span>
          <div className="a-hud-tape">
            LINK <b>STABLE</b>
          </div>
        </div>
      </>
    );
  }

  if (t === "grimdark") {
    return (
      <div className="a-banner-grimdark" aria-hidden="true">
        <span>by torch and oath</span>
        <i className="sep" />
        <span>
          <b>the watch holds</b>
        </span>
        <i className="sep" />
        <span>orbit 0331.M3</span>
        <i className="sep" />
        <span>sector ix</span>
      </div>
    );
  }

  return null;
}

import ReactDOM from "react-dom/client";
import App from "./App";
import { SelectOverlay } from "./components/SelectOverlay";
import "./styles/app.css";

/**
 * Every menu this app opens is its own, and the browser's default one (Back, Reload, Save as…)
 * must never appear on top of it.
 *
 * A menu is placed at the pointer and, when it would run past the bottom or right edge of the
 * window, it is flipped up or pulled back from that edge — which puts its rows, scrollbar
 * included, under the very cursor that opened it. The right-click that follows is then
 * delivered to the menu rather than to the tab behind it, so the strip's own handler never
 * sees it and the native menu slides out beside ours. Suppressing it here covers every menu
 * the app draws, and every menu added later, without each one having to remember.
 */
window.addEventListener("contextmenu", (event) => {
  const target = event.target as Element | null;
  if (target?.closest?.(".ctx-menu")) event.preventDefault();
});

// StrictMode is not used: Monaco and the window event listeners have imperative
// lifecycles, and the double mount would open files twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <>
    <App />
    {/* Draws the themed list a <select> expands into, in place of the OS widget. */}
    <SelectOverlay />
  </>
);

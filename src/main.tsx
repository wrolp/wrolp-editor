import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/app.css";

// StrictMode is not used: Monaco and the window event listeners have imperative
// lifecycles, and the double mount would open files twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

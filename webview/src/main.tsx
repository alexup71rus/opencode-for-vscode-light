import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@vscode/codicons/dist/codicon.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/controls.css";
import "./styles/sessions.css";
import "./styles/messages.css";
import "./styles/toolcalls.css";
import "./styles/composer.css";
import "./styles/inspect.css";
import "./styles/selectors.css";
import "./styles/modals.css";
import "./styles/overlays.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

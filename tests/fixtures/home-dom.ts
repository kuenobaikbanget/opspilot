import { Window } from "happy-dom";

// Initialize DOM globals before React DOM and Next components are imported.
// The launcher runs each scenario in its own process, never in the shared test runner.
const window = new Window({ url: "http://opspilot.test" });
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  localStorage: window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

export const closeDom = () => window.happyDOM.close();

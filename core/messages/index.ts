export * from './constants';
export * from './protocol';
export * from './create-bare-runtime-context';
// Webview-side console capture is a browser/web bundle concern (it POSTs the
// page console to the same-origin loopback `POST /logs` ingest). Surface it
// from the core entry so on-device web bundles can install it without reaching
// into the internal `core/logs` path. Never call it in mock mode: there is no
// loopback backend to ingest into.
export { installWebConsoleCapture } from '../logs';

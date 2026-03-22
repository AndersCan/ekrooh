export function getWebSocket() {
  const wsUri = 'ws://localhost:8080';
  const websocket = new WebSocket(wsUri);
  console.log('Connecting to WebSocket server...', wsUri);
  websocket.onopen = function () {
    console.log('WebSocket connection opened');
    websocket.send('Hello from the web client!');
  };
  websocket.onmessage = function (event) {
    console.log('Received message from server:', event.data);
  };
  websocket.onclose = function () {
    console.log('WebSocket connection closed');
  };
  websocket.onerror = function (error) {
    console.error('WebSocket error:', error);
  };
  return websocket;
}

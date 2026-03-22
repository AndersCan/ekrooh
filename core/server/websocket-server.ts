import ws from 'bare-ws';

export function startWebSocketServer() {
  console.log('Starting WebSocket server...');
  const server = new ws.Server({ port: 8080 });

  server.on('connection', (ws) => {
    console.log('WebSocket connection established');
    ws.emit('connected', { message: 'Welcome to the WebSocket server!' });
    ws.on('data', (data) => {
      console.log('Received message:', data.toString());
      // Echo the message back to the client
      ws.write(`Server-Echo: ${data.toString()}`);
      // ws.end("SORRY, THIS IS A TEST MESSAGE FROM THE SERVER");
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed');
    });
  });

  console.log('WebSocket server is running on ws://localhost:8080');
}

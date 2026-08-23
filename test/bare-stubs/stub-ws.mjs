// Node stand-in for the `bare-ws` builtin used by the vitest alias in
// vite.config.js. Unit tests drive the loopback server over mock sockets or
// the mocked bare-ws server, so a no-op handshake + inert Socket suffice.
export default {
  Server: {
    handshake() {},
  },
  Socket: class {
    on() {}
    once() {}
    destroy() {}
    write() {
      return true;
    }
  },
};

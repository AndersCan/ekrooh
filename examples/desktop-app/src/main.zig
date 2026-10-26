//! Ekrooh desktop host: a thin launcher.
//!
//! 1. spawn the sidecar `bare` running the packed backend (stdin kept open),
//! 2. wait for the backend's `handoff.json` (origin + one-time bootstrap nonce),
//! 3. open a native webview on the loopback origin, with the nonce injected as
//!    `window.__ekrooh = { bootstrap }` (ADR 0003, same as the mobile hosts),
//! 4. on window close, close the child's stdin; the backend exits on EOF.
//!
//! The WebSocket + nonce is the only contract: the page cannot tell this host
//! from the Android or iOS ones.

const std = @import("std");
const Io = std.Io;

// webview/webview C API (core/include/webview/api.h). Declared by hand: the
// surface we use is nine functions.
const Webview = ?*anyopaque;
extern fn webview_create(debug: c_int, window: ?*anyopaque) Webview;
extern fn webview_destroy(w: Webview) c_int;
extern fn webview_run(w: Webview) c_int;
extern fn webview_terminate(w: Webview) c_int;
extern fn webview_dispatch(w: Webview, f: *const fn (Webview, ?*anyopaque) callconv(.c) void, arg: ?*anyopaque) c_int;
extern fn webview_set_title(w: Webview, title: [*:0]const u8) c_int;
extern fn webview_set_size(w: Webview, width: c_int, height: c_int, hints: c_int) c_int;
extern fn webview_init(w: Webview, js: [*:0]const u8) c_int;
extern fn webview_navigate(w: Webview, url: [*:0]const u8) c_int;

const handoff_timeout_ms = 20_000;
const handoff_poll_ms = 50;
const shutdown_grace_ms = 5_000;

const Handoff = struct {
    origin: []const u8,
    bootstrap: []const u8,
};

const Options = struct {
    /// Directory holding `bare`, `desktop.bundle` and `WebAssets/`.
    resources: []const u8,
    /// Durable app data (handoff.json + the p2p corestore).
    storage: []const u8,
    debug: bool,
};

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();
    const io = init.io;

    const opts = try resolveOptions(init, arena);
    // handoff.json carries the session token, and unlike the mobile hosts
    // there is no app sandbox: keep the storage dir user-only, also when it
    // already existed.
    const storage_dir = try Io.Dir.cwd().createDirPathOpen(io, opts.storage, .{ .permissions = .fromMode(0o700) });
    try storage_dir.setPermissions(io, .fromMode(0o700));
    storage_dir.close(io);
    const cache = try std.fs.path.join(arena, &.{ opts.storage, "cache" });
    try Io.Dir.cwd().createDirPath(io, cache);

    // A stale handoff from a crashed run would point at a dead port.
    const handoff_path = try std.fs.path.join(arena, &.{ opts.storage, "handoff.json" });
    Io.Dir.cwd().deleteFile(io, handoff_path) catch {};

    // Destroyed last: the backend shutdown below joins the watcher thread,
    // the only other user of the handle, before this runs.
    var webview: Webview = null;
    defer if (webview) |w| {
        _ = webview_destroy(w);
    };

    const bare = try std.fs.path.join(arena, &.{ opts.resources, "bare" });
    const web_assets = try std.fs.path.join(arena, &.{ opts.resources, "WebAssets" });
    var backend: Backend = .{
        .child = try std.process.spawn(io, .{
            .argv = &.{
                bare,
                "desktop.bundle",
                try std.fmt.allocPrint(arena, "webassets={s}", .{web_assets}),
                try std.fmt.allocPrint(arena, "storage={s}", .{opts.storage}),
                try std.fmt.allocPrint(arena, "cache={s}", .{cache}),
                "auth=on",
                "port=0",
            },
            // The packed bundle resolves its offloaded addons relative to itself.
            .cwd = .{ .path = opts.resources },
            .stdin = .pipe,
        }),
    };
    const pid = backend.child.id.?;
    // Take ownership of the stdin pipe before the watcher thread starts:
    // `child.wait` closes whatever is still in `child.stdin` once the backend
    // exits, which would race (double-close) our own close.
    const stdin = backend.child.stdin.?;
    backend.child.stdin = null;

    // From here on only the watcher reaps the child. It also ends the event
    // loop if the backend dies under us, instead of leaving a dead window.
    const watcher = std.Thread.spawn(.{}, watchBackend, .{ io, &backend }) catch |err| {
        stdin.close(io);
        backend.child.kill(io);
        return err;
    };
    defer shutdownBackend(io, &backend, pid, stdin, watcher);

    const handoff = try waitForHandoff(io, arena, handoff_path, &backend.exited);

    const w = webview_create(@intFromBool(opts.debug), null) orelse return error.WebviewCreateFailed;
    webview = w;
    backend.webview.store(w, .seq_cst);
    // The watcher sets `exited` before reading `webview`; checking after the
    // store means one of us always sees the other.
    if (backend.exited.load(.seq_cst)) return error.BackendExited;
    _ = webview_set_title(w, "Ekrooh");
    _ = webview_set_size(w, 1024, 720, 0);
    _ = webview_init(w, try bootstrapScript(arena, handoff.bootstrap));
    _ = webview_navigate(w, try std.fmt.allocPrintSentinel(arena, "{s}", .{handoff.origin}, 0));

    std.log.info("opening {s}", .{handoff.origin});
    const rc = webview_run(w);
    std.log.info("webview_run returned {d}", .{rc});
}

const Backend = struct {
    child: std.process.Child,
    /// Set by the watcher once the child is reaped.
    exited: std.atomic.Value(bool) = .init(false),
    /// Published once the window exists, so the watcher can end its loop.
    webview: std.atomic.Value(?*anyopaque) = .init(null),
};

fn watchBackend(io: Io, backend: *Backend) void {
    if (backend.child.wait(io)) |term| {
        std.log.info("backend exited: {f}", .{term});
    } else |err| {
        std.log.warn("waiting on the backend failed: {t}", .{err});
    }
    backend.exited.store(true, .seq_cst);
    // `webview_terminate` is not thread-safe on Cocoa (it stops NSApp from
    // the calling thread), and a stop requested before `webview_run` starts
    // is lost. Dispatching runs it on the UI thread once the loop is up.
    if (backend.webview.load(.seq_cst)) |w| _ = webview_dispatch(w, terminateOnUi, null);
}

fn terminateOnUi(w: Webview, _: ?*anyopaque) callconv(.c) void {
    _ = webview_terminate(w);
}

/// Close the backend's stdin (it exits by itself on EOF), give it a bounded
/// grace period, then SIGKILL so a wedged backend cannot hang the host.
fn shutdownBackend(io: Io, backend: *Backend, pid: std.posix.pid_t, stdin: Io.File, watcher: std.Thread) void {
    stdin.close(io);
    var waited: u64 = 0;
    while (!backend.exited.load(.seq_cst) and waited < shutdown_grace_ms) : (waited += handoff_poll_ms) {
        io.sleep(.fromMilliseconds(handoff_poll_ms), .awake) catch break;
    }
    if (!backend.exited.load(.seq_cst)) {
        std.log.warn("backend did not exit on stdin EOF; killing it", .{});
        std.posix.kill(pid, .KILL) catch {};
    }
    watcher.join();
}

/// `--resources <dir>` / `--storage <dir>` / `--debug`. Defaults suit an
/// `.app` bundle: resources next to `Contents/MacOS`, storage in Application
/// Support.
fn resolveOptions(init: std.process.Init, arena: std.mem.Allocator) !Options {
    const args = try init.minimal.args.toSlice(arena);
    var resources: ?[]const u8 = null;
    var storage: ?[]const u8 = null;
    var debug = false;

    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg: []const u8 = args[i];
        if (std.mem.eql(u8, arg, "--debug")) {
            debug = true;
        } else if (std.mem.eql(u8, arg, "--resources") or std.mem.eql(u8, arg, "--storage")) {
            i += 1;
            if (i >= args.len) return error.MissingArgumentValue;
            if (std.mem.eql(u8, arg, "--resources")) resources = args[i] else storage = args[i];
        } else return error.UnknownArgument;
    }

    if (resources == null) {
        const exe_dir = try std.process.executableDirPathAlloc(init.io, arena);
        resources = try std.fs.path.resolve(arena, &.{ exe_dir, "..", "Resources" });
    }
    if (storage == null) {
        const home = init.environ_map.get("HOME") orelse return error.HomeNotSet;
        storage = try std.fs.path.join(arena, &.{ home, "Library", "Application Support", "Ekrooh" });
    }
    // The child runs with its own cwd, so everything handed to it is absolute.
    const cwd = try std.process.currentPathAlloc(init.io, arena);
    return .{
        .resources = try std.fs.path.resolve(arena, &.{ cwd, resources.? }),
        .storage = try std.fs.path.resolve(arena, &.{ cwd, storage.? }),
        .debug = debug,
    };
}

fn waitForHandoff(io: Io, arena: std.mem.Allocator, path: []const u8, exited: *const std.atomic.Value(bool)) !Handoff {
    var waited: u64 = 0;
    while (waited < handoff_timeout_ms) : (waited += handoff_poll_ms) {
        // A backend that crashed at startup will never write the file.
        if (exited.load(.seq_cst)) return error.BackendExited;
        // The backend writes the file in one call, but tolerate a torn read.
        if (Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(64 * 1024))) |bytes| {
            if (parseHandoff(arena, bytes)) |h| return h else |_| {}
        } else |_| {}
        try io.sleep(.fromMilliseconds(handoff_poll_ms), .awake);
    }
    return error.HandoffTimeout;
}

fn parseHandoff(arena: std.mem.Allocator, bytes: []const u8) !Handoff {
    const parsed = try std.json.parseFromSliceLeaky(Handoff, arena, bytes, .{ .ignore_unknown_fields = true });
    if (!std.mem.startsWith(u8, parsed.origin, "http://127.0.0.1:")) return error.UnexpectedOrigin;
    return parsed;
}

/// The nonce is base64url, so it is safe inside a JS string literal; refuse
/// anything else rather than escape it.
fn bootstrapScript(arena: std.mem.Allocator, bootstrap: []const u8) ![:0]const u8 {
    for (bootstrap) |c| {
        if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '_') return error.UnsafeBootstrap;
    }
    return std.fmt.allocPrintSentinel(arena, "window.__ekrooh = {{ bootstrap: \"{s}\" }};", .{bootstrap}, 0);
}

test "parseHandoff reads origin and bootstrap, ignores the rest" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const h = try parseHandoff(arena.allocator(),
        \\{"origin":"http://127.0.0.1:49233","port":49233,"token":"t","bootstrap":"abc-_9"}
    );
    try std.testing.expectEqualStrings("http://127.0.0.1:49233", h.origin);
    try std.testing.expectEqualStrings("abc-_9", h.bootstrap);
}

test "parseHandoff rejects a non-loopback origin" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(error.UnexpectedOrigin, parseHandoff(arena.allocator(),
        \\{"origin":"http://evil.example","bootstrap":"x"}
    ));
}

test "bootstrapScript refuses characters that need escaping" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(error.UnsafeBootstrap, bootstrapScript(arena.allocator(), "a\"b"));
    const js = try bootstrapScript(arena.allocator(), "ok-_1");
    try std.testing.expectEqualStrings("window.__ekrooh = { bootstrap: \"ok-_1\" };", js);
}

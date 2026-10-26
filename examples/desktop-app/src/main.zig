//! Ekrooh desktop host: a thin launcher.
//!
//! 1. take the single-instance lock in the storage dir (a second launch for
//!    the same storage is a no-op),
//! 2. open the window on a local "Starting" page,
//! 3. spawn the sidecar `bare` running the packed backend, with a stdin pipe
//!    and a private handoff pipe,
//! 4. read the handoff line (origin + one-time bootstrap nonce) and navigate to
//!    the loopback origin with `window.__ekrooh = { bootstrap }` injected
//!    (ADR 0003, same as the mobile hosts),
//! 5. on window close, close the backend's stdin; it exits on EOF.
//!
//! A backend that fails to start, or dies under the open window, turns the
//! page into an error page pointing at its log instead of a silent exit. The
//! WebSocket + nonce is the only contract: the page cannot tell this host from
//! the Android or iOS ones.

const std = @import("std");
const Io = std.Io;
const builtin = @import("builtin");
const posix = std.posix;

// webview/webview C API (core/include/webview/api.h). Declared by hand: the
// surface we use is ten functions.
const Webview = ?*anyopaque;
const DispatchFn = *const fn (Webview, ?*anyopaque) callconv(.c) void;
extern fn webview_create(debug: c_int, window: ?*anyopaque) Webview;
extern fn webview_destroy(w: Webview) c_int;
extern fn webview_run(w: Webview) c_int;
extern fn webview_terminate(w: Webview) c_int;
extern fn webview_dispatch(w: Webview, f: DispatchFn, arg: ?*anyopaque) c_int;
extern fn webview_set_title(w: Webview, title: [*:0]const u8) c_int;
extern fn webview_set_size(w: Webview, width: c_int, height: c_int, hints: c_int) c_int;
extern fn webview_set_html(w: Webview, html: [*:0]const u8) c_int;
extern fn webview_init(w: Webview, js: [*:0]const u8) c_int;
extern fn webview_navigate(w: Webview, url: [*:0]const u8) c_int;

const handoff_timeout_ms = 20_000;
const handoff_max_bytes = 4096;
const shutdown_grace_ms = 5_000;
const shutdown_poll_ms = 50;
const origin_prefix = "http://127.0.0.1:";

const Handoff = struct {
    origin: []const u8,
    bootstrap: []const u8,
};

const Options = struct {
    /// Directory holding `bare`, `desktop.bundle` and `WebAssets/`.
    resources: []const u8,
    /// Durable app data: the lock, `backend.log`, `cache/` and the backend's
    /// own state.
    storage: []const u8,
    debug: bool,
};

pub fn main(init: std.process.Init) u8 {
    return run(init) catch |err| {
        std.log.err("{t}", .{err});
        return 1;
    };
}

fn run(init: std.process.Init) !u8 {
    const arena = init.arena.allocator();
    const io = init.io;
    const opts = try resolveOptions(init, arena);

    // Unlike the mobile hosts there is no app sandbox: keep the app's data
    // user-only, also when the dir already existed.
    const storage_dir = try Io.Dir.cwd().createDirPathOpen(io, opts.storage, .{ .permissions = .fromMode(0o700) });
    defer storage_dir.close(io);
    try storage_dir.setPermissions(io, .fromMode(0o700));
    try storage_dir.createDirPath(io, "cache");

    // One instance per storage dir. The flock follows the open file into the
    // backend (inherited below), so it is held until both processes are gone
    // and a relaunch can never race a backend that is still shutting down.
    const lock = try storage_dir.createFile(io, "ekrooh.lock", .{ .truncate = false });
    defer lock.close(io);
    if (!try lock.tryLock(io, .exclusive)) {
        std.log.info("already running for {s}; nothing to do", .{opts.storage});
        return 0;
    }

    const w = webview_create(@intFromBool(opts.debug), null) orelse return error.WebviewCreateFailed;
    defer _ = webview_destroy(w);
    _ = webview_set_title(w, "Ekrooh");
    _ = webview_set_size(w, 1024, 720, 0);
    _ = webview_set_html(w, starting_html);

    var app: App = .{
        .webview = w,
        .log_path = try std.fs.path.join(arena, &.{ opts.storage, "backend.log" }),
        .handoff_copy = init.environ_map.get("EKROOH_TEST_HANDOFF_COPY"),
        .arena = .init(std.heap.page_allocator),
    };
    defer app.arena.deinit();

    const spawned = spawnBackend(io, arena, opts, storage_dir, lock) catch |err| {
        std.log.err("spawning the backend failed: {t}", .{err});
        _ = webview_set_html(w, try errorPage(arena, "could not be started", app.log_path));
        _ = webview_run(w);
        return 1;
    };
    var backend: Backend = .{ .child = spawned.child };
    const pid = backend.child.id.?;

    // From here on only the supervisor reaps the child.
    const supervisor = std.Thread.spawn(.{}, superviseBackend, .{ io, &app, &backend, spawned.handoff }) catch |err| {
        _ = std.c.close(spawned.handoff);
        spawned.stdin.close(io);
        backend.child.kill(io);
        return err;
    };

    const rc = webview_run(w);
    std.log.info("webview_run returned {d}", .{rc});

    // Window closed: a backend exit from now on is the one we asked for.
    app.closing.store(true, .seq_cst);
    shutdownBackend(io, &backend, pid, spawned.stdin, supervisor);
    return if (app.failed.load(.seq_cst)) 1 else 0;
}

/// State shared between the UI thread and the supervisor thread.
const App = struct {
    webview: Webview,
    log_path: []const u8,
    /// Test hook (smoke test only): also write the received handoff here, so
    /// a test can prove the page redeemed the nonce by replaying it.
    handoff_copy: ?[]const u8,
    /// Used only by the supervisor thread; freed after it is joined, so it
    /// outlives every callback the thread dispatches.
    arena: std.heap.ArenaAllocator,
    /// Set once the window has been closed.
    closing: std.atomic.Value(bool) = .init(false),
    /// Set when an error page was shown; the exit code reports it.
    failed: std.atomic.Value(bool) = .init(false),
};

const Backend = struct {
    child: std.process.Child,
    /// Set by the supervisor once the child is reaped.
    exited: std.atomic.Value(bool) = .init(false),
};

const Spawned = struct {
    child: std.process.Child,
    stdin: Io.File,
    /// Read end of the handoff pipe.
    handoff: posix.fd_t,
};

fn spawnBackend(io: Io, arena: std.mem.Allocator, opts: Options, storage_dir: Io.Dir, lock: Io.File) !Spawned {
    var fds: [2]posix.fd_t = undefined;
    if (std.c.pipe(&fds) != 0) return error.PipeFailed;
    // Only the write end crosses into the backend, through `inherit_files`;
    // keep both ends out of anything else this process might exec.
    for (fds) |fd| _ = std.c.fcntl(fd, posix.F.SETFD, @as(c_int, posix.FD_CLOEXEC));
    errdefer _ = std.c.close(fds[0]);
    // Ours closes right after the spawn so EOF on the read end means the
    // backend is gone.
    defer _ = std.c.close(fds[1]);
    const handoff_write: Io.File = .{ .handle = fds[1], .flags = .{ .nonblocking = false } };

    const log = try storage_dir.createFile(io, "backend.log", .{});
    defer log.close(io);
    const output: std.process.SpawnOptions.StdIo = if (opts.debug) .inherit else .{ .file = log };

    var child = try std.process.spawn(io, .{
        .argv = &.{
            try std.fs.path.join(arena, &.{ opts.resources, "bare" }),
            "desktop.bundle",
            try std.fmt.allocPrint(arena, "webassets={s}", .{try std.fs.path.join(arena, &.{ opts.resources, "WebAssets" })}),
            try std.fmt.allocPrint(arena, "storage={s}", .{opts.storage}),
            try std.fmt.allocPrint(arena, "cache={s}", .{try std.fs.path.join(arena, &.{ opts.storage, "cache" })}),
            "auth=on",
            "port=0",
            try std.fmt.allocPrint(arena, "handoff={d}", .{fds[1]}),
        },
        // The packed bundle resolves its offloaded addons relative to itself.
        .cwd = .{ .path = opts.resources },
        .stdin = .pipe,
        .stdout = output,
        .stderr = output,
        .inherit_files = &.{ handoff_write, lock },
    });
    // Take ownership of the stdin pipe: `child.wait` closes whatever is still
    // in `child.stdin` once the backend exits, which would race (double-close)
    // our own close in `shutdownBackend`.
    const stdin = child.stdin.?;
    child.stdin = null;
    return .{ .child = child, .stdin = stdin, .handoff = fds[0] };
}

/// Supervisor thread: read the handoff, point the window at the backend (or
/// at an error page), then reap the backend and report an unexpected exit.
fn superviseBackend(io: Io, app: *App, backend: *Backend, handoff_fd: posix.fd_t) void {
    const a = app.arena.allocator();
    var started = false;
    if (readHandoff(io, a, handoff_fd, handoff_timeout_ms)) |handoff| {
        if (navigation(a, handoff)) |nav| {
            std.log.info("opening {s}", .{handoff.origin});
            _ = webview_dispatch(app.webview, navigateOnUi, nav);
            started = true;
            if (app.handoff_copy) |path| writeHandoffCopy(io, a, path, handoff);
        } else |err| {
            std.log.err("unusable handoff: {t}", .{err});
            showError(app, "sent an unusable handoff");
        }
    } else |err| {
        std.log.err("waiting for the handoff failed: {t}", .{err});
        showError(app, switch (err) {
            error.HandoffTimeout => "did not start in time",
            error.BackendExited => "stopped while starting",
            else => "sent an unusable handoff",
        });
    }
    _ = std.c.close(handoff_fd);
    // A backend that could not hand off is of no use; do not wait on it.
    if (!started) posix.kill(backend.child.id.?, .KILL) catch {};

    if (backend.child.wait(io)) |term| {
        std.log.info("backend exited: {f}", .{term});
    } else |err| {
        std.log.warn("waiting on the backend failed: {t}", .{err});
    }
    backend.exited.store(true, .seq_cst);
    if (started) showError(app, "stopped unexpectedly");
}

fn writeHandoffCopy(io: Io, a: std.mem.Allocator, path: []const u8, handoff: Handoff) void {
    const json = std.fmt.allocPrint(a, "{{\"origin\":\"{s}\",\"bootstrap\":\"{s}\"}}", .{ handoff.origin, handoff.bootstrap }) catch return;
    Io.Dir.cwd().writeFile(io, .{
        .sub_path = path,
        .data = json,
        .flags = .{ .permissions = .fromMode(0o600) },
    }) catch |err| std.log.warn("writing the handoff copy failed: {t}", .{err});
}

/// Replace the page with an error page, from any thread. A no-op once the
/// window has closed (the dispatched callback then never runs).
fn showError(app: *App, what: []const u8) void {
    if (app.closing.load(.seq_cst)) return;
    app.failed.store(true, .seq_cst);
    const html = errorPage(app.arena.allocator(), what, app.log_path) catch return;
    _ = webview_dispatch(app.webview, setHtmlOnUi, @constCast(html.ptr));
}

fn setHtmlOnUi(w: Webview, arg: ?*anyopaque) callconv(.c) void {
    _ = webview_set_html(w, @ptrCast(arg.?));
}

const Navigation = struct {
    script: [:0]const u8,
    url: [:0]const u8,
};

fn navigateOnUi(w: Webview, arg: ?*anyopaque) callconv(.c) void {
    const nav: *const Navigation = @ptrCast(@alignCast(arg.?));
    _ = webview_init(w, nav.script);
    _ = webview_navigate(w, nav.url);
}

fn navigation(a: std.mem.Allocator, handoff: Handoff) !*Navigation {
    const nav = try a.create(Navigation);
    nav.* = .{
        .script = try bootstrapScript(a, handoff),
        .url = try a.dupeSentinel(u8, handoff.origin, 0),
    };
    return nav;
}

/// Close the backend's stdin (it exits by itself on EOF), give it a bounded
/// grace period, then SIGKILL so a wedged backend cannot hang the host.
fn shutdownBackend(io: Io, backend: *Backend, pid: posix.pid_t, stdin: Io.File, supervisor: std.Thread) void {
    stdin.close(io);
    var waited: u64 = 0;
    while (!backend.exited.load(.seq_cst) and waited < shutdown_grace_ms) : (waited += shutdown_poll_ms) {
        io.sleep(.fromMilliseconds(shutdown_poll_ms), .awake) catch break;
    }
    if (!backend.exited.load(.seq_cst)) {
        std.log.warn("backend did not exit on stdin EOF; killing it", .{});
        posix.kill(pid, .KILL) catch {};
    }
    supervisor.join();
}

/// macOS: `~/Library/Application Support/Ekrooh`. Linux: `$XDG_DATA_HOME/ekrooh`
/// (absolute values only, per the XDG spec), else `~/.local/share/ekrooh`.
fn defaultStorage(init: std.process.Init, arena: std.mem.Allocator) ![]const u8 {
    if (builtin.os.tag != .macos) {
        if (init.environ_map.get("XDG_DATA_HOME")) |xdg| {
            if (std.fs.path.isAbsolute(xdg)) return std.fs.path.join(arena, &.{ xdg, "ekrooh" });
        }
    }
    const home = init.environ_map.get("HOME") orelse return error.HomeNotSet;
    return switch (builtin.os.tag) {
        .macos => std.fs.path.join(arena, &.{ home, "Library", "Application Support", "Ekrooh" }),
        else => std.fs.path.join(arena, &.{ home, ".local", "share", "ekrooh" }),
    };
}

/// `--resources <dir>` / `--storage <dir>` (or `--flag=value`) / `--debug`.
/// Defaults suit an `.app` bundle: resources next to `Contents/MacOS`, storage
/// in Application Support. Arguments macOS itself may pass (`-psn_*`,
/// `-NS<Key> <value>`, `-Apple<Key> <value>`) are skipped.
fn resolveOptions(init: std.process.Init, arena: std.mem.Allocator) !Options {
    const args = try init.minimal.args.toSlice(arena);
    var resources: ?[]const u8 = null;
    var storage: ?[]const u8 = null;
    var debug = false;

    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg: []const u8 = args[i];
        if (std.mem.startsWith(u8, arg, "-psn_")) continue;
        if (std.mem.startsWith(u8, arg, "-NS") or std.mem.startsWith(u8, arg, "-Apple")) {
            i += 1;
            continue;
        }
        if (std.mem.eql(u8, arg, "--debug")) {
            debug = true;
            continue;
        }
        const eq = std.mem.indexOfScalar(u8, arg, '=');
        const name = arg[0 .. eq orelse arg.len];
        const slot: *?[]const u8 = if (std.mem.eql(u8, name, "--resources"))
            &resources
        else if (std.mem.eql(u8, name, "--storage"))
            &storage
        else {
            std.log.err("unknown argument {s}; usage: ekrooh [--storage <dir>] [--resources <dir>] [--debug]", .{arg});
            return error.UnknownArgument;
        };
        if (eq) |at| {
            slot.* = arg[at + 1 ..];
        } else {
            i += 1;
            if (i >= args.len) return error.MissingArgumentValue;
            slot.* = args[i];
        }
    }

    if (resources == null) {
        const exe_dir = try std.process.executableDirPathAlloc(init.io, arena);
        // `.app`: Contents/MacOS/ekrooh next to Contents/Resources.
        // Linux tarball: bin/ekrooh next to resources/.
        const res_dir = if (builtin.os.tag == .macos) "Resources" else "resources";
        resources = try std.fs.path.resolve(arena, &.{ exe_dir, "..", res_dir });
    }
    if (storage == null) {
        storage = try defaultStorage(init, arena);
    }
    // The child runs with its own cwd, so everything handed to it is absolute.
    const cwd = try std.process.currentPathAlloc(init.io, arena);
    return .{
        .resources = try std.fs.path.resolve(arena, &.{ cwd, resources.? }),
        .storage = try std.fs.path.resolve(arena, &.{ cwd, storage.? }),
        .debug = debug,
    };
}

/// Reads the backend's one-line JSON handoff from the pipe. EOF before a full
/// line means the backend exited (or closed the pipe) without handing off.
fn readHandoff(io: Io, a: std.mem.Allocator, fd: posix.fd_t, timeout_ms: i64) !Handoff {
    var buf: [handoff_max_bytes]u8 = undefined;
    var len: usize = 0;
    const start = Io.Clock.awake.now(io);
    while (true) {
        if (std.mem.indexOfScalar(u8, buf[0..len], '\n')) |end| {
            return parseHandoff(a, buf[0..end]);
        }
        if (len == buf.len) return error.HandoffTooLong;
        const remaining = timeout_ms - start.untilNow(io, .awake).toMilliseconds();
        if (remaining <= 0) return error.HandoffTimeout;
        var pfd = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
        if (try posix.poll(&pfd, @intCast(remaining)) == 0) return error.HandoffTimeout;
        const n = try posix.read(fd, buf[len..]);
        if (n == 0) return error.BackendExited;
        len += n;
    }
}

fn parseHandoff(a: std.mem.Allocator, bytes: []const u8) !Handoff {
    // `alloc_always`: callers pass a transient read buffer, and the strings
    // must not point into it.
    const parsed = try std.json.parseFromSliceLeaky(Handoff, a, bytes, .{
        .ignore_unknown_fields = true,
        .allocate = .alloc_always,
    });
    // Loopback only, and digits only after the prefix, so it is also safe to
    // embed in the bootstrap script.
    if (!std.mem.startsWith(u8, parsed.origin, origin_prefix)) return error.UnexpectedOrigin;
    const port = parsed.origin[origin_prefix.len..];
    if (port.len == 0) return error.UnexpectedOrigin;
    for (port) |c| if (!std.ascii.isDigit(c)) return error.UnexpectedOrigin;
    return parsed;
}

/// Injects the nonce on the backend's origin only, never into a page the
/// webview might be navigated to later. The nonce is base64url and the origin
/// is checked by `parseHandoff`, so both are safe inside JS string literals;
/// anything else is refused rather than escaped.
fn bootstrapScript(a: std.mem.Allocator, handoff: Handoff) ![:0]const u8 {
    for (handoff.bootstrap) |c| {
        if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '_') return error.UnsafeBootstrap;
    }
    return std.fmt.allocPrintSentinel(a, "if (location.origin === \"{s}\") window.__ekrooh = {{ bootstrap: \"{s}\" }};", .{ handoff.origin, handoff.bootstrap }, 0);
}

const page_style =
    \\<style>
    \\:root { color-scheme: light dark; }
    \\body { font: 15px -apple-system, system-ui, sans-serif; margin: 0; height: 100vh;
    \\  display: flex; flex-direction: column; align-items: center; justify-content: center; }
    \\p { max-width: 36em; text-align: center; opacity: .75; }
    \\code { word-break: break-all; }
    \\</style>
;

const starting_html = "<!doctype html>" ++ page_style ++ "<p>Starting Ekrooh&hellip;</p>";

fn errorPage(a: std.mem.Allocator, what: []const u8, log_path: []const u8) ![:0]const u8 {
    var log_html: std.ArrayList(u8) = .empty;
    for (log_path) |c| switch (c) {
        '&' => try log_html.appendSlice(a, "&amp;"),
        '<' => try log_html.appendSlice(a, "&lt;"),
        '>' => try log_html.appendSlice(a, "&gt;"),
        '"' => try log_html.appendSlice(a, "&quot;"),
        else => try log_html.append(a, c),
    };
    return std.fmt.allocPrintSentinel(a, "<!doctype html>{s}<h2>Ekrooh {s}</h2>" ++
        "<p>Close this window and open Ekrooh again. If it keeps happening, " ++
        "the backend log is at <code>{s}</code>.</p>", .{ page_style, what, log_html.items }, 0);
}

test "parseHandoff reads origin and bootstrap, ignores the rest" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const h = try parseHandoff(arena.allocator(),
        \\{"origin":"http://127.0.0.1:49233","port":49233,"bootstrap":"abc-_9"}
    );
    try std.testing.expectEqualStrings("http://127.0.0.1:49233", h.origin);
    try std.testing.expectEqualStrings("abc-_9", h.bootstrap);
}

test "parseHandoff rejects a non-loopback or odd origin" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    for ([_][]const u8{
        \\{"origin":"http://evil.example","bootstrap":"x"}
        ,
        \\{"origin":"http://127.0.0.1:80\"x","bootstrap":"x"}
        ,
        \\{"origin":"http://127.0.0.1:","bootstrap":"x"}
    }) |json| try std.testing.expectError(error.UnexpectedOrigin, parseHandoff(arena.allocator(), json));
}

test "bootstrapScript scopes the nonce to the origin and refuses escapes" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const origin = "http://127.0.0.1:1";
    try std.testing.expectError(error.UnsafeBootstrap, bootstrapScript(arena.allocator(), .{ .origin = origin, .bootstrap = "a\"b" }));
    const js = try bootstrapScript(arena.allocator(), .{ .origin = origin, .bootstrap = "ok-_1" });
    try std.testing.expectEqualStrings("if (location.origin === \"http://127.0.0.1:1\") window.__ekrooh = { bootstrap: \"ok-_1\" };", js);
}

test "readHandoff reads one line, and reports EOF as the backend exiting" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const io = std.testing.io;

    var fds: [2]posix.fd_t = undefined;
    try std.testing.expectEqual(0, std.c.pipe(&fds));
    defer _ = std.c.close(fds[0]);
    const line = "{\"origin\":\"http://127.0.0.1:5\",\"bootstrap\":\"n\"}\n";
    try std.testing.expectEqual(@as(isize, line.len), std.c.write(fds[1], line.ptr, line.len));
    _ = std.c.close(fds[1]);
    const h = try readHandoff(io, arena.allocator(), fds[0], 1_000);
    // Clobber the stack the read buffer lived on; the result must not alias it.
    var clobber: [handoff_max_bytes]u8 = undefined;
    @memset(&clobber, 'x');
    std.mem.doNotOptimizeAway(&clobber);
    try std.testing.expectEqualStrings("http://127.0.0.1:5", h.origin);
    try std.testing.expectEqualStrings("n", h.bootstrap);

    var eof: [2]posix.fd_t = undefined;
    try std.testing.expectEqual(0, std.c.pipe(&eof));
    defer _ = std.c.close(eof[0]);
    _ = std.c.close(eof[1]);
    try std.testing.expectError(error.BackendExited, readHandoff(io, arena.allocator(), eof[0], 1_000));
}

test "readHandoff times out on a silent backend" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var fds: [2]posix.fd_t = undefined;
    try std.testing.expectEqual(0, std.c.pipe(&fds));
    defer _ = std.c.close(fds[0]);
    defer _ = std.c.close(fds[1]);
    try std.testing.expectError(error.HandoffTimeout, readHandoff(std.testing.io, arena.allocator(), fds[0], 50));
}

test "errorPage escapes the log path" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const html = try errorPage(arena.allocator(), "stopped", "/tmp/<a>&\"");
    try std.testing.expect(std.mem.indexOf(u8, html, "/tmp/&lt;a&gt;&amp;&quot;") != null);
}

test {
    // Compile the host's run path too, not only the helpers tested above.
    _ = &run;
}

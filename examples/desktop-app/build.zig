const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const webview = b.dependency("webview", .{});

    const exe = b.addExecutable(.{
        .name = "ekrooh",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .link_libcpp = true,
        }),
    });

    // webview/webview is C++ behind a C API; compile its single translation
    // unit straight into the host so the result is one static executable.
    exe.root_module.addIncludePath(webview.path("core/include"));
    exe.root_module.addCSourceFile(.{
        .file = webview.path("core/src/webview.cc"),
        .flags = &.{ "-std=c++14", "-DWEBVIEW_STATIC" },
        .language = .cpp,
    });

    switch (target.result.os.tag) {
        .macos => {
            exe.root_module.linkFramework("WebKit", .{});
            exe.root_module.linkFramework("AppKit", .{});
        },
        else => @panic("desktop host: only macOS is wired up so far"),
    }

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    run_cmd.addPassthruArgs();
    b.step("run", "Run the host").dependOn(&run_cmd.step);

    const tests = b.addTest(.{ .root_module = exe.root_module });
    b.step("test", "Run host unit tests").dependOn(&b.addRunArtifact(tests).step);
}

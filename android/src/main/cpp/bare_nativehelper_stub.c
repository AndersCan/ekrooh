// Minimal functional re-export of the Android platform library
// `libnativehelper.so` for the AAR.
//
// `libbare-kit.so` (the Bare Kit worklet, fetched from
// holepunchto/bare-kit prebuilds and bundled into this AAR) declares
// `libnativehelper.so` in its DT_NEEDED and imports exactly one symbol
// from it:
//
//     JNI_GetCreatedJavaVMs@LIBNATIVEHELPER_S
//
// `libnativehelper.so` is a private platform library: it is not in
// `public.libraries.txt`, so an app process cannot resolve it from the
// classloader namespace and `System.loadLibrary("bare-kit")` fails with
// `UnsatisfiedLinkError: library "libnativehelper.so" not found` (see
// ekrooh#45). The worklet also calls `JNI_GetCreatedJavaVMs` directly on
// thread enter, so a missing/broken provider null-derefs there on
// 32-bit-only runtimes (see ekrooh#46).
//
// This stub provides that one symbol as a real, working implementation: it
// captures the process's single JavaVM during `JNI_OnLoad` and returns it
// from `JNI_GetCreatedJavaVMs`. It must be compiled per-ABI so it loads in
// the classloader namespace next to `libbare-kit.so`; see
// `CMakeLists.txt` and `android/build.gradle`.

#include <jni.h>

static JavaVM* g_vm = NULL;

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* reserved) {
  (void) reserved;
  g_vm = vm;
  return JNI_VERSION_1_6;
}

JNIEXPORT jint JNICALL JNI_GetCreatedJavaVMs(JavaVM** vmBuf, jsize bufLen, jsize* nVMs) {
  if (nVMs != NULL) *nVMs = 0;
  if (g_vm == NULL || vmBuf == NULL || bufLen < 1) return JNI_OK;
  vmBuf[0] = g_vm;
  if (nVMs != NULL) *nVMs = 1;
  return JNI_OK;
}

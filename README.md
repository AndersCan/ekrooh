# Less Bare Android

A clean, organized project structure for developing Bare-based Android applications with a Web UI and shared Core logic.

## 📂 File Structure

*   **`core/`**: Contains shared business logic written in TypeScript.
*   **`web/`**: Contains the web-based user interface (HTML/JS/Vite).
*   **`android/`**: A self-contained Android project.
    *   **`app/`**: The main Android module (Kotlin).
    *   **`gradle/`**: Android-specific build configuration and wrapper.
*   **`prebuilds/`**: Contains the Bare Kit prebuilds for different platforms.

## 🛠 Build Process

The project uses a multi-step build process to integrate JS/TS into the Android app:

1.  **Transpile Core**: `core/` TypeScript files are bundled into `.gen.js` files using `bun`.
2.  **Pack JS**: `bare-pack` bundles the transpiled Core logic into `app.bundle` and `push.bundle.mjs` for Android assets.
3.  **Link Addons**: `bare-link` sets up native dependencies in `app/src/main/addons`.
4.  **Build Web**: `vite build` bundles the `web/` UI into Android's `assets/` folder.
5.  **Compile Android**: The standard Gradle process builds the APK/AAB.

### 📦 Prebuilds

To keep the build process fast and efficient, the project relies on a Bare Kit prebuild being available in the `prebuilds/android/bare-kit` directory. Prior to building the project, you must therefore either clone and compile Bare Kit from source, or download the latest prebuild from GitHub. The latter is easily accomplished using the [GitHub CLI](https://cli.github.com):

```bash
gh release download --repo holepunchto/bare-kit <version>
```

Unpack the resulting `prebuilds.zip` archive and ensure the `android/bare-kit` folder is moved into the root `prebuilds/` directory of this project.

### 🔌 Addons

Native addons will be linked into `android/app/src/main/addons/` as part of the build process and will be automatically included in the final APK bundle by Gradle.

### How to Run

To build the project from the root:
```bash
# Build the JS/TS and Web components
npm run build

# Build the Android APK
cd android && ./gradlew assembleDebug
```

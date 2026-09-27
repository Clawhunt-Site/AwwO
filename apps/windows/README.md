# AwwO for Windows

This lightweight Windows 10/11 client opens the configured HTTPS AwwO service in WebView2. It shares that service's login, workspaces, engine selection and personal API keys. It does not install a second database or execute local commands. No provider or Cloudflare credentials are bundled.

The separate app identity and **AwwO Cloud** installation/shortcut name preserve existing native local installations and their data. The window title remains AwwO. The earlier local execution client remains in `apps/desktop`.

Build with Node.js 24, Rust stable, Visual Studio C++ build tools and the Tauri CLI installed by `npm ci --prefix apps/desktop`:

```powershell
$env:APP_ENV = 'production'
$env:VITE_APP_ENV = 'production'
$env:AWWO_WINDOWS_CLOUD_URL = 'https://your-awwo.example.com'
$env:AWWO_WINDOWS_ACCESS_ORIGIN = 'https://your-team.cloudflareaccess.example.com'
$env:AWWO_WINDOWS_IDP_ORIGINS = 'https://accounts.your-idp.example.com'
npm run build:windows
```

All origins must be public HTTPS origins with no path, port, query, or credentials. Set the Access origin to the exact Cloudflare Access authentication host and list each verified third-party identity provider origin, separated by commas. Use the explicit value `none` only if the Access flow has no third-party identity provider. The client keeps only these exact origins inside WebView2 so sign-in can return through the same cookie jar; other HTTPS links open in the default browser. Sign-in flows that use `window.open()` receive a separate WebView2 window with the opener relationship and the same cookie environment; this also keeps the main canvas in place. The **AwwO** window menu provides **Reconnect to AwwO** and **Open AwwO in browser** even if the embedded page cannot load. Confirm a fresh-profile login against the chosen service before publishing an installer; some identity providers may reject embedded browser sign-in even when their origin is allowed.

The NSIS installer is under `apps/windows/target/release/bundle/nsis` (or `CARGO_TARGET_DIR`). Installers are unsigned unless the release operator configures signing. Windows may display a publisher warning. WebView2 is installed if needed. Internet access and any access-gate authorization required by the chosen service are still required.

For a manually published hosted-client release, temporarily pause the legacy `desktop-windows` workflow before publishing a `v*` tag and restore its prior state afterward. That workflow builds the older local client and must not attach it to this client's release.

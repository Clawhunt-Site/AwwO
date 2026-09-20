# AwwO for Windows

This lightweight Windows 10/11 client opens the configured HTTPS AwwO service in WebView2. It shares that service's login, workspaces, engine selection and personal API keys. It does not install a second database or execute local commands. No provider or Cloudflare credentials are bundled.

The separate app identity and **AwwO Cloud** installation/shortcut name preserve existing native local installations and their data. The window title remains AwwO. The earlier local execution client remains in `apps/desktop`.

Build with Node.js 24, Rust stable, Visual Studio C++ build tools and the Tauri CLI installed by `npm ci --prefix apps/desktop`:

```powershell
$env:APP_ENV = 'production'
$env:VITE_APP_ENV = 'production'
$env:AWWO_WINDOWS_CLOUD_URL = 'https://your-awwo.example.com'
npm run build:windows
```

The NSIS installer is under `apps/windows/target/release/bundle/nsis` (or `CARGO_TARGET_DIR`). Installers are unsigned unless the release operator configures signing. Windows may display a publisher warning. WebView2 is installed if needed. Internet access and any access-gate authorization required by the chosen service are still required.

Normal `v*` releases publish this client. The older native desktop workflow uses only `desktop-v*` tags or manual dispatch, so it cannot attach the legacy local installer to a hosted-client release.

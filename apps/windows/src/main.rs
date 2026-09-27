#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{
    menu::{MenuBuilder, SubmenuBuilder},
    Manager,
};

const RECONNECT_ITEM: &str = "reconnect";
const OPEN_BROWSER_ITEM: &str = "open_browser";
static NEXT_POPUP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, PartialEq, Eq)]
enum NavigationAction {
    Stay,
    OpenExternal,
    Deny,
}

fn navigation_action(
    target: &tauri::Url,
    app: &tauri::Url,
    access: &tauri::Url,
    identity_providers: &[tauri::Url],
) -> NavigationAction {
    if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some() {
        return NavigationAction::Deny;
    }
    if target.origin() == app.origin()
        || target.origin() == access.origin()
        || identity_providers
            .iter()
            .any(|idp| target.origin() == idp.origin())
    {
        NavigationAction::Stay
    } else {
        NavigationAction::OpenExternal
    }
}

fn popup_navigation_action(
    target: &tauri::Url,
    app: &tauri::Url,
    access: &tauri::Url,
    identity_providers: &[tauri::Url],
) -> NavigationAction {
    // window.open() may create a blank child before the caller assigns its
    // authentication URL. The child retains its opener, but subsequent
    // navigation is still subject to the exact-origin policy.
    if target.as_str() == "about:blank" {
        NavigationAction::Stay
    } else {
        navigation_action(target, app, access, identity_providers)
    }
}

#[cfg(target_os = "windows")]
fn open_external(url: &tauri::Url) {
    // Argument passing bypasses the shell; the navigation policy has already
    // rejected non-HTTPS URLs and credential-bearing authorities.
    let _ = std::process::Command::new("explorer.exe")
        .arg(url.as_str())
        .spawn();
}

fn create_popup(
    handle: tauri::AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
    app: tauri::Url,
    access: tauri::Url,
    identity_providers: Vec<tauri::Url>,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    use tauri::webview::NewWindowResponse;

    match popup_navigation_action(&url, &app, &access, &identity_providers) {
        NavigationAction::Stay => {
            let nav_app = app.clone();
            let nav_access = access.clone();
            let nav_idps = identity_providers.clone();
            let nested_handle = handle.clone();
            let label = format!("popup-{}", NEXT_POPUP_ID.fetch_add(1, Ordering::Relaxed));
            // Tauri's window_features uses the opener's WebView2 environment.
            // NewWindowResponse::Create then preserves window.opener so popup
            // based identity providers can return via postMessage or location.
            let builder = tauri::WebviewWindowBuilder::new(
                &handle,
                label,
                tauri::WebviewUrl::External(tauri::Url::parse("about:blank").expect("static URL")),
            )
            .window_features(features)
            .title("AwwO")
            .on_navigation(move |target| {
                match popup_navigation_action(target, &nav_app, &nav_access, &nav_idps) {
                    NavigationAction::Stay => true,
                    NavigationAction::OpenExternal => {
                        #[cfg(target_os = "windows")]
                        open_external(target);
                        false
                    }
                    NavigationAction::Deny => false,
                }
            })
            .on_new_window(move |nested_url, nested_features| {
                create_popup(
                    nested_handle.clone(),
                    nested_url,
                    nested_features,
                    app.clone(),
                    access.clone(),
                    identity_providers.clone(),
                )
            });
            match builder.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(error) => {
                    eprintln!("Could not open AwwO authentication popup: {error}");
                    NewWindowResponse::Deny
                }
            }
        }
        NavigationAction::OpenExternal => {
            #[cfg(target_os = "windows")]
            open_external(&url);
            NewWindowResponse::Deny
        }
        NavigationAction::Deny => NewWindowResponse::Deny,
    }
}

fn main() {
    // Public build configuration only. Remote pages receive no native commands,
    // filesystem access, local execution bridge or operator credentials.
    let origin = tauri::Url::parse(env!("AWWO_WINDOWS_CLOUD_URL"))
        .expect("the release builder validates the cloud origin");
    let access_origin = tauri::Url::parse(env!("AWWO_WINDOWS_ACCESS_ORIGIN"))
        .expect("the release builder validates the Access origin");
    let identity_providers: Vec<tauri::Url> = env!("AWWO_WINDOWS_IDP_ORIGINS")
        .split(',')
        .filter(|value| *value != "none")
        .map(|value| {
            tauri::Url::parse(value)
                .expect("the release builder validates identity provider origins")
        })
        .collect();
    let menu_origin = origin.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .on_menu_event(move |app, event| {
            if event.id() == RECONNECT_ITEM {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.navigate(menu_origin.clone());
                }
            } else if event.id() == OPEN_BROWSER_ITEM {
                #[cfg(target_os = "windows")]
                open_external(&menu_origin);
            }
        })
        .setup(move |app| {
            let menu = MenuBuilder::new(app)
                .item(
                    &SubmenuBuilder::new(app, "AwwO")
                        .text(RECONNECT_ITEM, "Reconnect to AwwO")
                        .text(OPEN_BROWSER_ITEM, "Open AwwO in browser")
                        .build()?,
                )
                .build()?;
            app.set_menu(menu)?;

            let nav_app = origin.clone();
            let nav_access = access_origin.clone();
            let nav_identity_providers = identity_providers.clone();
            let popup_app = origin.clone();
            let popup_access = access_origin.clone();
            let popup_identity_providers = identity_providers.clone();
            let popup_handle = app.handle().clone();
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(origin))
                .title("AwwO")
                .inner_size(1480.0, 960.0)
                .min_inner_size(1000.0, 680.0)
                .on_navigation(move |url| {
                    match navigation_action(url, &nav_app, &nav_access, &nav_identity_providers) {
                        NavigationAction::Stay => true,
                        NavigationAction::OpenExternal => {
                            #[cfg(target_os = "windows")]
                            open_external(url);
                            false
                        }
                        NavigationAction::Deny => false,
                    }
                })
                .on_new_window(move |url, features| {
                    create_popup(
                        popup_handle.clone(),
                        url,
                        features,
                        popup_app.clone(),
                        popup_access.clone(),
                        popup_identity_providers.clone(),
                    )
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("AwwO could not start");
}

#[cfg(test)]
mod tests {
    use super::{navigation_action, popup_navigation_action, NavigationAction};
    use tauri::Url;

    #[test]
    fn only_the_exact_app_and_access_origins_stay_in_the_webview() {
        let app = Url::parse("https://app.example.test").unwrap();
        let access = Url::parse("https://team.cloudflareaccess.example.test").unwrap();
        for allowed in [
            "https://app.example.test/login",
            "https://team.cloudflareaccess.example.test/cdn-cgi/access/login?state=1",
        ] {
            assert_eq!(
                navigation_action(&Url::parse(allowed).unwrap(), &app, &access, &[]),
                NavigationAction::Stay
            );
        }
        for external in [
            "https://billing.example.test",
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://app.example.test.evil.example",
            "https://fake.cloudflareaccess.example.test",
            "https://app.example.test:8443",
        ] {
            assert_eq!(
                navigation_action(&Url::parse(external).unwrap(), &app, &access, &[]),
                NavigationAction::OpenExternal
            );
        }
    }

    #[test]
    fn unsafe_navigation_is_denied_even_for_allowed_hosts() {
        let app = Url::parse("https://app.example.test").unwrap();
        let access = Url::parse("https://team.cloudflareaccess.example.test").unwrap();
        for blocked in [
            "http://app.example.test",
            "file:///C:/Users/test/private.txt",
            "javascript:alert(1)",
            "https://user:password@app.example.test/login",
        ] {
            assert_eq!(
                navigation_action(&Url::parse(blocked).unwrap(), &app, &access, &[]),
                NavigationAction::Deny
            );
        }
    }

    #[test]
    fn configured_identity_provider_stays_in_the_same_cookie_jar() {
        let app = Url::parse("https://app.example.test").unwrap();
        let access = Url::parse("https://team.cloudflareaccess.example.test").unwrap();
        let idp = Url::parse("https://accounts.example.test").unwrap();
        assert_eq!(
            navigation_action(
                &Url::parse("https://accounts.example.test/authorize?state=1").unwrap(),
                &app,
                &access,
                &[idp.clone()]
            ),
            NavigationAction::Stay
        );
        assert_eq!(
            navigation_action(
                &Url::parse("https://accounts.example.test.evil.example/authorize").unwrap(),
                &app,
                &access,
                &[idp]
            ),
            NavigationAction::OpenExternal
        );
    }

    #[test]
    fn popups_can_start_blank_but_unconfigured_origins_stay_external() {
        let app = Url::parse("https://app.example.test").unwrap();
        let access = Url::parse("https://team.cloudflareaccess.example.test").unwrap();
        assert_eq!(
            popup_navigation_action(&Url::parse("about:blank").unwrap(), &app, &access, &[]),
            NavigationAction::Stay
        );
        assert_eq!(
            popup_navigation_action(
                &Url::parse("https://other.example.test").unwrap(),
                &app,
                &access,
                &[],
            ),
            NavigationAction::OpenExternal
        );
        assert_eq!(
            popup_navigation_action(
                &Url::parse("file:///C:/private.txt").unwrap(),
                &app,
                &access,
                &[],
            ),
            NavigationAction::Deny
        );
    }
}

// Build the release binary as a Windows GUI-subsystem app so launching it never opens a
// stray console/terminal window (the empty `…\superclaw_desktop.exe` window). Debug builds
// keep the console for dev logging. DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    superclaw_desktop_lib::run()
}

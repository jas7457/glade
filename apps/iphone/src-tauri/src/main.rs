// Desktop entry (only for `cargo check`/tests on the Mac); the iOS app starts in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    glade_iphone_lib::run()
}

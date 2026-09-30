// Commands are implemented in Swift (ios/Sources/VoicePlugin.swift); JS calls them as
// `plugin:voice|<command>` and Tauri routes them to the Swift method named in lowerCamelCase.
const COMMANDS: &[&str] = &[
    "is_available",
    "get_permissions",
    "request_permissions",
    "request_personal_voice",
    "list_voices",
    "start_session",
    "end_session",
    "start_listening",
    "stop_listening",
    "speak",
    "stop_speaking",
    "play_cue",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}

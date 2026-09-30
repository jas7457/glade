//! Conversation mode's native voice engine (PLAN.md I-180) as a Tauri mobile plugin. All the work
//! is in Swift (`ios/Sources/`): Apple on-device speech recognition, AVSpeechSynthesizer voices
//! played through a voice-processing AVAudioEngine (echo cancellation for barge-in), the audio
//! session, keep-awake and cues. The TS side is `apps/iphone/src/voice/native-engine.ts`.
//! On other platforms the plugin registers nothing (commands then fail with "not found").

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_voice);

/// Registers the plugin (name `voice`).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("voice")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_voice)?;
            Ok(())
        })
        .build()
}

//! Keeping the Mac awake (I-147): an IOKit `PreventUserIdleSystemSleep` assertion while the
//! server says there's a reason (chats working, sharing with a device connected; `shell_state.rs`
//! reads them from `GET /api/desktop/state`). The display may still sleep; no admin rights and no
//! `pmset` changes. `pmset -g assertions` lists it as "Glade: …". Released as soon as no reason is
//! left and on quit (the system also drops it when the process exits).
//!
//! A closed laptop lid still sleeps unless the Mac is on power with an external display: nothing
//! an app can change.

use std::sync::Mutex;

/// The held assertion: its id and the name it was created with.
static HELD: Mutex<Option<(u32, String)>> = Mutex::new(None);

/// What to do for a wanted state (pure, for tests): `None` = nothing to change.
#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    Create(String),
    /// Release the old one and create one with a new name (the reason changed).
    Rename(String),
    Release,
}

pub fn plan(held: Option<&str>, wanted: Option<&str>) -> Option<Change> {
    match (held, wanted) {
        (None, None) => None,
        (None, Some(name)) => Some(Change::Create(name.to_string())),
        (Some(_), None) => Some(Change::Release),
        (Some(old), Some(new)) if old == new => None,
        (Some(_), Some(new)) => Some(Change::Rename(new.to_string())),
    }
}

/// Hold an assertion named `reason` (e.g. "Glade: 2 chats are working"), or release it (`None`).
pub fn set(reason: Option<&str>) {
    let mut held = HELD.lock().unwrap();
    let Some(change) = plan(held.as_ref().map(|(_, n)| n.as_str()), reason) else { return };
    match change {
        Change::Release => {
            if let Some((id, _)) = held.take() {
                sys::release(id);
            }
        }
        Change::Create(name) | Change::Rename(name) => {
            if let Some((id, _)) = held.take() {
                sys::release(id);
            }
            match sys::create(&name) {
                Some(id) => *held = Some((id, name)),
                None => eprintln!("[glade] couldn't create the power assertion"),
            }
        }
    }
}

/// Release on quit.
pub fn release() {
    set(None);
}

#[cfg(target_os = "macos")]
mod sys {
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(kind: *const c_void, level: u32, name: *const c_void, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    const LEVEL_ON: u32 = 255;

    pub fn create(name: &str) -> Option<u32> {
        // NSString is toll-free bridged with CFString.
        let kind = NSString::from_str("PreventUserIdleSystemSleep");
        let name = NSString::from_str(name);
        let mut id: u32 = 0;
        let rc = unsafe {
            IOPMAssertionCreateWithName(&*kind as *const NSString as *const c_void, LEVEL_ON, &*name as *const NSString as *const c_void, &mut id)
        };
        (rc == 0).then_some(id)
    }

    pub fn release(id: u32) {
        unsafe {
            IOPMAssertionRelease(id);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub fn create(_name: &str) -> Option<u32> {
        None
    }
    pub fn release(_id: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_assertion_changes() {
        assert_eq!(plan(None, None), None);
        assert_eq!(plan(None, Some("Glade: a")), Some(Change::Create("Glade: a".into())));
        assert_eq!(plan(Some("Glade: a"), Some("Glade: a")), None);
        assert_eq!(plan(Some("Glade: a"), Some("Glade: b")), Some(Change::Rename("Glade: b".into())));
        assert_eq!(plan(Some("Glade: a"), None), Some(Change::Release));
    }
}

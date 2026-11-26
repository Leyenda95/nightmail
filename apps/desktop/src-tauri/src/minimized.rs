//! Windows: keeps the webview from learning where a minimized window is parked.
//!
//! Windows parks a minimized window off screen, at (-32000, -32000), and the monitor nearest to that point is the
//! primary one. wry passes every `WM_MOVE` of the window on to WebView2 (`NotifyParentWindowPositionChanged`), so the
//! page then takes the primary monitor for its screen: `window.screen` reports that monitor, in the scale of the
//! monitor the window was on. With "Automático" as the interface size (`autoSize` in `src/prefs.ts`), a window restored
//! onto a smaller second monitor could pick the size meant for the large one and keep it until it was moved by hand:
//! on restore the page looks at the screen again before WebView2 has caught up, and nothing asks it afterwards.
//! Nothing needs the webview to follow the window to that parking position, so that one move stops here. The page
//! keeps the screen it had and nothing changes when the window comes back. Every other move goes through as before.

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, WM_MOVE, WM_NCDESTROY};

/// Identifies this filter among the window's subclasses (a value of our own; wry's are `WM_USER + 0x64` and up).
const SUBCLASS_ID: usize = 0x4E4D_0001;

/// Puts the filter on the window. On the thread that owns the window (the main one) and once its webview exists: the
/// subclass installed last sees each message first, so this one runs before wry's.
pub fn install(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    // SAFETY: `hwnd` is this window's live handle and this is its own thread; `filter` uses no reference data.
    if unsafe { SetWindowSubclass(hwnd.0, Some(filter), SUBCLASS_ID, 0) } == 0 {
        log::warn!("[window] could not install the filter for the minimized window's move");
    }
}

unsafe extern "system" fn filter(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    // SAFETY: Windows calls this with the live handle of the window it was installed on, on that window's thread.
    unsafe {
        match msg {
            // The move that parks the window: by now the window already counts as minimized. tao does not use
            // `WM_MOVE` (it reports moves from `WM_WINDOWPOSCHANGED`), so only wry's notice to the webview is skipped.
            WM_MOVE if IsIconic(hwnd) != 0 => {
                log::info!("[window] minimized: the move to the parking position is kept from the webview");
                0
            }
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(filter), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }
}

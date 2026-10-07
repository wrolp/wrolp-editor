//! Window geometry persistence: where the user left the window, and whether it was maximized.
//! Kept out of settings.json on purpose — settings are edited deliberately, this changes on
//! every drag.

use serde::{Deserialize, Serialize};

/// Physical pixels, matching what `outerPosition()` / `outerSize()` report.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowState {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
  pub maximized: bool,
}

/// One monitor's bounds, handed over by the frontend from `availableMonitors()`.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorRect {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

/// What to actually apply to the window. `adjusted` says the saved rectangle could not be
/// used as it was, which is worth telling the user: a silently teleported window looks like a bug.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
  pub maximized: bool,
  pub adjusted: bool,
}

/// Mirrors `minWidth` / `minHeight` in tauri.conf.json. Clamping below these is pointless: the
/// window manager would raise it back, so the stored size would never match the visible one.
const MIN_WIDTH: u32 = 720;
const MIN_HEIGHT: u32 = 420;
/// Used when the saved size is unusable (zero, junk) rather than merely off-screen.
/// Mirrors the `width` / `height` of the main window in tauri.conf.json: a saved file with a junk
/// size should reopen at the same place a first run starts, and those two are set apart by accident.
const FALLBACK_WIDTH: u32 = 1180;
const FALLBACK_HEIGHT: u32 = 740;
/// How much of the top-left of a frameless window must still be on a screen for it to be
/// reachable: enough to grab the drag handle and read the title.
const GRAB_WIDTH: i32 = 100;
const GRAB_HEIGHT: i32 = 32;
const MIN_VISIBLE: i32 = 40;
const EDGE_MARGIN: u32 = 24;

fn size_is_usable(width: u32, height: u32) -> bool {
  width >= MIN_WIDTH && height >= MIN_HEIGHT
}

/// A frameless window can only be moved by its top strip, so that is what has to be visible.
fn reachable(state: &WindowState, monitors: &[MonitorRect]) -> bool {
  let strip_x = state.x as i64;
  let strip_y = state.y as i64;
  monitors.iter().any(|m| {
    let left = strip_x.max(m.x as i64);
    let right = (strip_x + GRAB_WIDTH as i64).min((m.x + m.width as i32) as i64);
    let top = strip_y.max(m.y as i64);
    let bottom = (strip_y + GRAB_HEIGHT as i64).min((m.y + m.height as i32) as i64);
    right - left >= MIN_VISIBLE as i64 && bottom - top >= MIN_VISIBLE as i64 / 2
  })
}

fn clamp_size(width: u32, height: u32, monitor: Option<&MonitorRect>) -> (u32, u32) {
  let room = monitor.map(|m| {
    (
      m.width.saturating_sub(EDGE_MARGIN),
      m.height.saturating_sub(EDGE_MARGIN),
    )
  });
  // Never let the work-area fit push us under the minimum: a tiny monitor keeps the minimum.
  let width = match room {
    Some((room_w, _)) => width.min(room_w.max(MIN_WIDTH)),
    None => width,
  };
  let height = match room {
    Some((_, room_h)) => height.min(room_h.max(MIN_HEIGHT)),
    None => height,
  };
  (width.max(MIN_WIDTH), height.max(MIN_HEIGHT))
}

impl WindowState {
  /// Turn a stored rectangle into one that can be applied today. Nothing here moves a window
  /// that is still reachable, so plugging a second monitor back in restores the old place.
  pub fn plan(&self, monitors: &[MonitorRect]) -> Placement {
    let primary = monitors.first();
    let junk_size = !size_is_usable(self.width, self.height);
    let on_screen = !monitors.is_empty() && reachable(self, monitors);

    if monitors.is_empty() {
      // No monitor information to judge by: keep the position, only fix an impossible size.
      let (width, height) = clamp_size(
        if junk_size {
          FALLBACK_WIDTH
        } else {
          self.width
        },
        if junk_size {
          FALLBACK_HEIGHT
        } else {
          self.height
        },
        None,
      );
      return Placement {
        x: self.x,
        y: self.y,
        width,
        height,
        maximized: self.maximized,
        adjusted: junk_size,
      };
    }

    if !junk_size && on_screen {
      let containing = monitors.iter().find(|m| {
        (m.x..m.x + m.width as i32).contains(&self.x)
          && (m.y..m.y + m.height as i32).contains(&self.y)
      });
      let (width, height) = clamp_size(self.width, self.height, containing.or(primary));
      let adjusted = width != self.width || height != self.height;
      return Placement {
        x: self.x,
        y: self.y,
        width,
        height,
        maximized: self.maximized,
        adjusted,
      };
    }

    // Pulled back onto the first monitor, near its top-left so it cannot hide under a taskbar.
    let home = primary.expect("checked non-empty");
    let (width, height) = clamp_size(
      if junk_size {
        FALLBACK_WIDTH
      } else {
        self.width
      },
      if junk_size {
        FALLBACK_HEIGHT
      } else {
        self.height
      },
      Some(home),
    );
    let x = home.x + ((home.width.saturating_sub(width) / 2) as i32).max(0);
    let y = home.y + ((home.height as f64 * 0.08) as i32).max(0);
    Placement {
      x,
      y,
      width,
      height,
      maximized: self.maximized,
      adjusted: true,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn state(x: i32, y: i32, width: u32, height: u32) -> WindowState {
    WindowState {
      x,
      y,
      width,
      height,
      maximized: false,
    }
  }

  fn monitor(x: i32, y: i32, width: u32, height: u32) -> MonitorRect {
    MonitorRect {
      x,
      y,
      width,
      height,
    }
  }

  fn built_in() -> MonitorRect {
    monitor(0, 0, 1920, 1080)
  }

  fn external() -> MonitorRect {
    monitor(1920, 0, 2560, 1440)
  }

  #[test]
  fn a_reachable_rectangle_is_left_alone() {
    let plan = state(120, 80, 1180, 740).plan(&[built_in(), external()]);
    assert_eq!(
      (plan.x, plan.y, plan.width, plan.height),
      (120, 80, 1180, 740)
    );
    assert!(!plan.adjusted);
  }

  #[test]
  fn a_window_left_on_a_disconnected_monitor_comes_back() {
    // Saved on the external screen, which is now unplugged.
    let saved = state(2200, 120, 1400, 900);
    let plan = saved.plan(&[built_in()]);
    assert!(plan.adjusted);
    assert!(plan.x >= 0 && plan.x + plan.width as i32 <= 1920);
    assert!(plan.y >= 0 && plan.y < 1080 / 2);
    // Size survives: the user's window size is not the thing that went stale.
    assert_eq!((plan.width, plan.height), (1400, 900));
  }

  #[test]
  fn a_sliver_of_grab_area_is_enough_to_leave_it_put() {
    // 40 px of the top strip still sit on the built-in screen: the user can grab it, so
    // moving it would be the surprise. One pixel less and it comes back.
    assert!(!state(-60, 100, 1180, 740).plan(&[built_in()]).adjusted);
    assert!(state(-200, 100, 1180, 740).plan(&[built_in()]).adjusted);
  }

  #[test]
  fn negative_positions_off_every_screen_are_pulled_back() {
    let plan = state(-4000, -2000, 1180, 740).plan(&[built_in()]);
    assert!(plan.adjusted);
    assert!(plan.x >= 0 && plan.y >= 0);
  }

  #[test]
  fn a_junk_size_falls_back_to_the_configured_default() {
    for junk in [state(100, 100, 0, 0), state(100, 100, 40, 40)] {
      let plan = junk.plan(&[built_in()]);
      assert!(plan.adjusted);
      assert_eq!((plan.width, plan.height), (1180, 740));
    }
  }

  #[test]
  fn a_window_bigger_than_its_monitor_is_shrunk_not_moved() {
    let plan = state(0, 0, 5000, 4000).plan(&[built_in()]);
    assert!(plan.adjusted);
    assert!(plan.width <= 1920 && plan.height <= 1080);
    assert_eq!((plan.x, plan.y), (0, 0));
  }

  #[test]
  fn maximization_survives_the_trip_untouched() {
    let mut saved = state(120, 80, 1180, 740);
    saved.maximized = true;
    let plan = saved.plan(&[built_in()]);
    assert!(plan.maximized);
    // The saved normal geometry is still what to restore into.
    assert_eq!((plan.width, plan.height), (1180, 740));
  }

  #[test]
  fn without_monitor_information_only_the_size_is_trusted() {
    let plan = state(1500, 900, 1180, 740).plan(&[]);
    assert!(!plan.adjusted);
    assert_eq!((plan.x, plan.y), (1500, 900));

    let junk = state(1500, 900, 10, 10).plan(&[]);
    assert!(junk.adjusted);
    assert_eq!((junk.width, junk.height), (FALLBACK_WIDTH, FALLBACK_HEIGHT));
  }

  #[test]
  fn a_small_monitor_shrinks_the_window_but_not_past_the_minimum() {
    let plan = state(0, 0, 1180, 740).plan(&[monitor(0, 0, 900, 600)]);
    assert!(plan.adjusted);
    assert!(plan.width <= 900 - EDGE_MARGIN && plan.height <= 600 - EDGE_MARGIN);
    assert!(plan.width >= MIN_WIDTH && plan.height >= MIN_HEIGHT);
  }

  #[test]
  fn a_monitor_too_small_for_the_minimum_keeps_the_window_at_the_minimum() {
    // 700x500 leaves 676x476 of room. Width cannot go under the 720 minimum (the window manager
    // would raise it back), so the minimum wins there and the window sticks out a little. Height
    // has room left above its own minimum, so it takes the room.
    let plan = state(0, 0, 1180, 740).plan(&[monitor(0, 0, 700, 500)]);
    assert!(plan.adjusted);
    assert_eq!((plan.width, plan.height), (MIN_WIDTH, 500 - EDGE_MARGIN));
  }
}

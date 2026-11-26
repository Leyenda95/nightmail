//! Badge on NightMail's Windows taskbar button: the Inbox unread count ("99+" from 100) or, while NightMail is
//! locked, a padlock.
//!
//! Windows has no counter for taskbar buttons (`set_badge_count` does not support it), so an image is laid over the
//! icon (`Window::set_overlay_icon`). The image is drawn here without dependencies: a Lumbre circle with a Noche rim
//! (visible on light and dark taskbars) and Noche digits or padlock drawn from our own strokes. Each pixel is sampled
//! `SS × SS` times for antialiasing. At 16 px (100 % scaling) numbers and "99+" are drawn pixel by pixel
//! ([`pixel_mark`]) because antialiased strokes smeared. The pure part ([`decide`], [`render`], [`size_for_scale`])
//! does not touch the window and is tested on its own.
//!
//! No effect on Linux and macOS (on Linux `set_badge_count` only works under Unity).

/// What the badge shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Badge {
    /// 1 to 99 unread.
    Count(u8),
    /// 100 or more: "99+".
    Overflow,
    /// Locked: the padlock, regardless of the unread count.
    Locked,
}

/// The core session state when the request arrives; it overrides whatever the UI says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionNow {
    /// Not unlocked since the app started: there is no number to hide.
    NeverOpened,
    /// Locked after having been open.
    Closed,
    Open,
}

/// What to show. Without an open session the core wins over the UI: an Inbox read finishing after a lock asks for
/// `locked: false` with a number, and the padlock must stay (privacy). Never unlocked: nothing (no badge at startup).
/// With an open session: the padlock if the UI asks for it, otherwise the number (if enabled), or nothing for 0.
pub fn decide(unread: u32, locked: bool, show_count: bool, session: SessionNow) -> Option<Badge> {
    match session {
        SessionNow::NeverOpened => return None,
        SessionNow::Closed => return Some(Badge::Locked),
        SessionNow::Open if locked => return Some(Badge::Locked),
        SessionNow::Open => {}
    }
    match unread {
        _ if !show_count => None,
        0 => None,
        1..=99 => Some(Badge::Count(unread as u8)),
        _ => Some(Badge::Overflow),
    }
}

/// Image side in pixels for the display scale; Windows draws the badge at 16 logical px.
pub fn size_for_scale(scale: f64) -> u32 {
    let px = (16.0 * scale).round();
    if px.is_finite() { (px as u32).clamp(16, 32) } else { 16 }
}

/// Samples per pixel side (64 per pixel).
const SS: u32 = 8;
/// Brand colours: Noche (rim, digits, padlock) and Lumbre (background).
const NOCHE: [f32; 3] = [10.0, 24.0, 40.0];
const LUMBRE: [f32; 3] = [255.0, 207.0, 92.0];

type P = (f32, f32);

/// A stroke: round-capped segments, in units of the 16-unit grid.
struct Stroke {
    segs: Vec<(P, P)>,
    half: f32,
}

impl Stroke {
    fn new(half: f32) -> Self {
        Stroke { segs: Vec::new(), half }
    }

    fn line(&mut self, a: P, b: P) {
        self.segs.push((a, b));
    }

    fn polyline(&mut self, pts: &[P]) {
        for w in pts.windows(2) {
            self.line(w[0], w[1]);
        }
    }

    /// Elliptical arc from `a0` to `a1` degrees (0 to the right, 90 up), in short segments.
    fn arc(&mut self, c: P, rx: f32, ry: f32, a0: f32, a1: f32) {
        let steps = (((a1 - a0).abs() / 10.0).ceil() as usize).max(2);
        let pts: Vec<P> = (0..=steps)
            .map(|i| {
                let a = (a0 + (a1 - a0) * i as f32 / steps as f32).to_radians();
                (c.0 + rx * a.cos(), c.1 - ry * a.sin())
            })
            .collect();
        self.polyline(&pts);
    }

    fn hits(&self, p: P) -> bool {
        self.segs.iter().any(|&(a, b)| seg_dist2(p, a, b) <= self.half * self.half)
    }
}

fn seg_dist2(p: P, a: P, b: P) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 { 0.0 } else { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0) };
    let (qx, qy) = (a.0 + t * dx - p.0, a.1 + t * dy - p.1);
    qx * qx + qy * qy
}

/// Inside the circle centred at `(8, 8)` with radius `r`.
fn in_circle(p: P, r: f32) -> bool {
    let (dx, dy) = (p.0 - 8.0, p.1 - 8.0);
    dx * dx + dy * dy <= r * r
}

/// Inside the rounded rectangle `(x0, y0)-(x1, y1)` with corner radius `r`.
fn in_round_rect(p: P, x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> bool {
    if p.0 < x0 || p.0 > x1 || p.1 < y0 || p.1 > y1 {
        return false;
    }
    let cx = p.0.clamp(x0 + r, x1 - r);
    let cy = p.1.clamp(y0 + r, y1 - r);
    let (dx, dy) = (p.0 - cx, p.1 - cy);
    dx * dx + dy * dy <= r * r
}

/// Adds the stroke of a digit (or "+") to `s`, inside the `w × h` box at `(x, y)` (stroke centre line).
fn glyph(s: &mut Stroke, ch: char, x: f32, y: f32, w: f32, h: f32) {
    // Normalised box coordinates (0..1) to the grid.
    let m = |u: f32, v: f32| (x + u * w, y + v * h);
    // Elliptical arc with centre and radii in normalised coordinates.
    let arc = |s: &mut Stroke, cu: f32, cv: f32, ru: f32, rv: f32, a0: f32, a1: f32| {
        s.arc(m(cu, cv), ru * w, rv * h, a0, a1);
    };
    match ch {
        '0' => {
            arc(s, 0.5, 0.3, 0.5, 0.3, 0.0, 180.0);
            arc(s, 0.5, 0.7, 0.5, 0.3, 180.0, 360.0);
            s.line(m(0.0, 0.3), m(0.0, 0.7));
            s.line(m(1.0, 0.3), m(1.0, 0.7));
        }
        '1' => {
            s.polyline(&[m(0.15, 0.22), m(0.6, 0.0), m(0.6, 1.0)]);
        }
        '2' => {
            arc(s, 0.5, 0.28, 0.5, 0.28, 160.0, -30.0);
            s.polyline(&[m(0.93, 0.42), m(0.0, 1.0), m(1.0, 1.0)]);
        }
        '3' => {
            arc(s, 0.47, 0.25, 0.47, 0.25, 155.0, -90.0);
            arc(s, 0.5, 0.73, 0.5, 0.27, 90.0, -155.0);
        }
        '4' => {
            s.polyline(&[m(0.78, 1.0), m(0.78, 0.0), m(0.0, 0.7), m(1.0, 0.7)]);
        }
        '5' => {
            s.polyline(&[m(0.95, 0.0), m(0.1, 0.0), m(0.03, 0.45)]);
            arc(s, 0.5, 0.69, 0.5, 0.31, 130.0, -150.0);
        }
        '6' => {
            arc(s, 0.5, 0.7, 0.5, 0.3, 0.0, 360.0);
            arc(s, 1.0, 0.7, 1.0, 0.7, 180.0, 100.0);
        }
        '7' => {
            s.polyline(&[m(0.0, 0.0), m(1.0, 0.0), m(0.35, 1.0)]);
        }
        '8' => {
            arc(s, 0.5, 0.24, 0.42, 0.24, 0.0, 360.0);
            arc(s, 0.5, 0.73, 0.5, 0.27, 0.0, 360.0);
        }
        '9' => {
            arc(s, 0.5, 0.3, 0.5, 0.3, 0.0, 360.0);
            arc(s, 0.0, 0.3, 1.0, 0.7, 0.0, -80.0);
        }
        '+' => {
            s.line(m(0.5, 0.0), m(0.5, 1.0));
            s.line(m(0.0, 0.5), m(1.0, 0.5));
        }
        _ => {}
    }
}

/// Digits centred in the 16-unit circle; box, spacing and stroke width depend on how many there are.
fn text_stroke(text: &str) -> Stroke {
    let chars: Vec<char> = text.chars().collect();
    // (digit width, "+" width, height, gap, stroke width)
    let (cw, pw, h, gap, width) = match chars.len() {
        1 => (4.2, 0.0, 8.0, 0.0, 1.8),
        2 => (3.1, 0.0, 7.0, 1.4, 1.4),
        _ => (2.5, 2.6, 6.3, 0.7, 1.0),
    };
    let widths: Vec<f32> = chars.iter().map(|&c| if c == '+' { pw } else { cw }).collect();
    let total = widths.iter().sum::<f32>() + gap * (chars.len() as f32 - 1.0);
    let mut s = Stroke::new(width / 2.0);
    let mut x = (16.0 - total) / 2.0;
    let y = (16.0 - h) / 2.0;
    for (&c, &w) in chars.iter().zip(&widths) {
        // "+" is shorter than the digits, vertically centred.
        let (gy, gh) = if c == '+' { (y + (h - pw) / 2.0, pw) } else { (y, h) };
        glyph(&mut s, c, x, gy, w, gh);
        x += w + gap;
    }
    s
}

/// 4 × 7 digits for 16 px, pixel by pixel: antialiased strokes smear at that size ("38" looked like "3B"). 1 px
/// strokes so they fit inside the circle. The 3 is open on the left and the 8 closed so they cannot be confused.
/// `#` is Noche.
const PIX_4X7: [[&str; 7]; 10] = [
    [".##.", "#..#", "#..#", "#..#", "#..#", "#..#", ".##."],
    [".#..", "##..", ".#..", ".#..", ".#..", ".#..", "###."],
    [".##.", "#..#", "...#", "..#.", ".#..", "#...", "####"],
    ["###.", "...#", "...#", ".##.", "...#", "...#", "###."],
    ["#..#", "#..#", "#..#", "####", "...#", "...#", "...#"],
    ["####", "#...", "###.", "...#", "...#", "#..#", ".##."],
    [".##.", "#...", "#...", "###.", "#..#", "#..#", ".##."],
    ["####", "...#", "...#", "..#.", "..#.", ".#..", ".#.."],
    [".##.", "#..#", "#..#", ".##.", "#..#", "#..#", ".##."],
    [".##.", "#..#", "#..#", ".###", "...#", "...#", ".##."],
];
/// "99+" at 16 px: 3 × 5 nines and a 3 × 3 cross for "+", with spacing between all three.
const PIX_NINE_3X5: [&str; 5] = ["###", "#.#", "###", "..#", "###"];
const PIX_PLUS: [&str; 3] = [".#.", "###", ".#."];

/// 16 × 16 pixel mark for one- and two-digit numbers and "99+"; `None` for the padlock, which looks fine
/// antialiased.
fn pixel_mark(badge: Badge) -> Option<[[bool; 16]; 16]> {
    let mut grid = [[false; 16]; 16];
    let mut put = |rows: &[&str], x0: usize, y0: usize| {
        for (dy, row) in rows.iter().enumerate() {
            for (dx, c) in row.bytes().enumerate() {
                if c == b'#' {
                    grid[y0 + dy][x0 + dx] = true;
                }
            }
        }
    };
    match badge {
        Badge::Count(n) if n >= 10 => {
            // 4 + 2 + 4 = 10 px, columns 3 to 12; rows 4 to 10.
            put(&PIX_4X7[usize::from(n / 10)], 3, 4);
            put(&PIX_4X7[usize::from(n % 10)], 9, 4);
        }
        Badge::Count(n) => {
            // Same table for one digit: columns 6 to 9 (the stem of the 1, column 7, is centred); rows 4 to 10.
            put(&PIX_4X7[usize::from(n)], 6, 4);
        }
        Badge::Overflow => {
            // 3 + 1 + 3 + 1 + 3 = 11 px, columns 2 to 12; nines on rows 5 to 9, cross centred on row 7.
            put(&PIX_NINE_3X5, 2, 5);
            put(&PIX_NINE_3X5, 6, 5);
            put(&PIX_PLUS, 10, 6);
        }
        Badge::Locked => return None,
    }
    Some(grid)
}

/// The padlock: a stroked shackle and a solid body with a hollow keyhole.
struct Lock {
    shackle: Stroke,
}

impl Lock {
    fn new() -> Self {
        let mut shackle = Stroke::new(0.85);
        shackle.arc((8.0, 6.3), 2.55, 2.7, 0.0, 180.0);
        shackle.line((5.45, 6.3), (5.45, 7.6));
        shackle.line((10.55, 6.3), (10.55, 7.6));
        Lock { shackle }
    }

    fn body(p: P) -> bool {
        let keyhole = {
            let (dx, dy) = (p.0 - 8.0, p.1 - 9.9);
            dx * dx + dy * dy <= 1.0 || (p.0 - 8.0).abs() <= 0.45 && (9.9..=11.7).contains(&p.1)
        };
        in_round_rect(p, 3.6, 7.4, 12.4, 13.2, 1.3) && !keyhole
    }

    fn hits(&self, p: P) -> bool {
        Lock::body(p) || self.shackle.hits(p)
    }
}

/// `size × size` RGBA image (not premultiplied), rows from the top.
pub fn render(badge: Badge, size: u32) -> Vec<u8> {
    let pixels = if size == 16 { pixel_mark(badge) } else { None };
    let mark: Box<dyn Fn(P) -> bool> = match (pixels, badge) {
        // At 16 px the grid is the image: each sample falls on its own pixel.
        (Some(grid), _) => Box::new(move |p: P| grid[(p.1 as usize).min(15)][(p.0 as usize).min(15)]),
        (None, Badge::Count(n)) => {
            let s = text_stroke(&n.to_string());
            Box::new(move |p| s.hits(p))
        }
        (None, Badge::Overflow) => {
            let s = text_stroke("99+");
            Box::new(move |p| s.hits(p))
        }
        (None, Badge::Locked) => {
            let l = Lock::new();
            Box::new(move |p| l.hits(p))
        }
    };
    let unit = 16.0 / size as f32;
    // 1 px rim in image pixels (not grid units), equally thin at 16 and 32.
    let rim = unit;
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for py in 0..size {
        for px in 0..size {
            let mut acc = [0.0f32; 3];
            let mut alpha = 0.0f32;
            for sy in 0..SS {
                for sx in 0..SS {
                    let p = (
                        (px as f32 + (sx as f32 + 0.5) / SS as f32) * unit,
                        (py as f32 + (sy as f32 + 0.5) / SS as f32) * unit,
                    );
                    if !in_circle(p, 8.0) {
                        continue;
                    }
                    let inner = in_circle(p, 8.0 - rim);
                    let color = if !inner || mark(p) { NOCHE } else { LUMBRE };
                    for (a, c) in acc.iter_mut().zip(color) {
                        *a += c;
                    }
                    alpha += 1.0;
                }
            }
            let n = (SS * SS) as f32;
            if alpha == 0.0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                out.extend(acc.iter().map(|c| (c / alpha).round() as u8));
                out.push((alpha / n * 255.0).round() as u8);
            }
        }
    }
    out
}

/// Sets the badge (or clears it with `None`) on the window's button, sized for the display `scale`. Windows only.
/// Off the main thread it does not block: the image is queued on the window in order, so it is safe to call while
/// holding the session lock. The scale must be read beforehand and outside that lock (`Window::scale_factor` blocks
/// on the main thread, which waits for the session on shutdown).
#[cfg(windows)]
pub fn apply(window: &tauri::Window, badge: Option<Badge>, scale: f64) -> tauri::Result<()> {
    let icon = badge.map(|b| {
        let size = size_for_scale(scale);
        tauri::image::Image::new_owned(render(b, size), size, size)
    });
    window.set_overlay_icon(icon)
}

/// Linux and macOS: no badge (see the module docs).
#[cfg(not(windows))]
pub fn apply(_window: &tauri::Window, _badge: Option<Badge>, _scale: f64) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_follows_the_badge_rules() {
        use SessionNow::Open;
        assert_eq!(decide(0, false, true, Open), None);
        assert_eq!(decide(1, false, true, Open), Some(Badge::Count(1)));
        assert_eq!(decide(99, false, true, Open), Some(Badge::Count(99)));
        assert_eq!(decide(100, false, true, Open), Some(Badge::Overflow));
        assert_eq!(decide(u32::MAX, false, true, Open), Some(Badge::Overflow));
        // Locked: the padlock, whatever the count and whether or not the number is enabled.
        for unread in [0, 7, 150] {
            assert_eq!(decide(unread, true, true, Open), Some(Badge::Locked));
            assert_eq!(decide(unread, true, false, Open), Some(Badge::Locked));
        }
        // Number disabled (future setting): nothing while unlocked.
        assert_eq!(decide(5, false, false, Open), None);
        assert_eq!(decide(500, false, false, Open), None);
    }

    /// Without a core session the number is never drawn, whatever the UI says (an Inbox read finishing after a lock):
    /// locked after being open shows the padlock, never unlocked since startup shows nothing.
    #[test]
    fn without_a_session_the_core_wins() {
        for (unread, locked, show) in [(0, false, true), (7, false, true), (150, false, true), (7, true, true), (7, false, false)] {
            assert_eq!(decide(unread, locked, show, SessionNow::Closed), Some(Badge::Locked), "{unread} {locked} {show}");
            assert_eq!(decide(unread, locked, show, SessionNow::NeverOpened), None, "{unread} {locked} {show}");
        }
    }

    #[test]
    fn size_follows_the_screen_scale() {
        assert_eq!(size_for_scale(1.0), 16);
        assert_eq!(size_for_scale(1.25), 20);
        assert_eq!(size_for_scale(1.5), 24);
        assert_eq!(size_for_scale(2.0), 32);
        assert_eq!(size_for_scale(3.0), 32);
        assert_eq!(size_for_scale(0.5), 16);
        assert_eq!(size_for_scale(f64::NAN), 16);
    }

    fn px(img: &[u8], size: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * size + x) * 4) as usize;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    const NOCHE_PX: [u8; 4] = [10, 24, 40, 255];
    const LUMBRE_PX: [u8; 4] = [255, 207, 92, 255];

    #[test]
    fn every_badge_has_the_right_size_frame_and_corners() {
        let all = [Badge::Count(1), Badge::Count(8), Badge::Count(42), Badge::Count(99), Badge::Overflow, Badge::Locked];
        for size in [16, 20, 24, 32] {
            for badge in all {
                let img = render(badge, size);
                assert_eq!(img.len(), (size * size * 4) as usize, "{badge:?} {size}");
                // Corners outside the circle are transparent.
                assert_eq!(px(&img, size, 0, 0)[3], 0);
                assert_eq!(px(&img, size, size - 1, size - 1)[3], 0);
                // Noche rim at the middle of each side.
                assert_eq!(px(&img, size, size / 2, 0), NOCHE_PX);
                assert_eq!(px(&img, size, 0, size / 2), NOCHE_PX);
                // Lumbre background next to the left rim (the mark starts further in).
                assert_eq!(px(&img, size, size / 8, size / 2), LUMBRE_PX, "{badge:?} {size}");
            }
        }
    }

    /// Noche pixels inside the rim (the mark): how many and where, excluding the rim ring.
    fn mark_pixels(img: &[u8], size: u32) -> Vec<(u32, u32)> {
        let mut v = Vec::new();
        let half = size as f32 / 2.0;
        let limit = half - 1.5 * size as f32 / 16.0;
        for y in 0..size {
            for x in 0..size {
                let (dx, dy) = (x as f32 + 0.5 - half, y as f32 + 0.5 - half);
                if (dx * dx + dy * dy).sqrt() > limit {
                    continue;
                }
                let [r, g, b, _] = px(img, size, x, y);
                // Closer to Noche than to Lumbre.
                if (r as u32 + g as u32 + b as u32) < (255 + 207 + 92 + 10 + 24 + 40) / 2 {
                    v.push((x, y));
                }
            }
        }
        v
    }

    #[test]
    fn each_digit_draws_a_different_mark() {
        let mut seen: Vec<Vec<(u32, u32)>> = Vec::new();
        for n in 1..=9u8 {
            let mark = mark_pixels(&render(Badge::Count(n), 16), 16);
            assert!(mark.len() >= 8, "digit {n} is barely visible: {}", mark.len());
            assert!(!seen.contains(&mark), "digit {n} is drawn the same as another");
            seen.push(mark);
        }
        // "10" has a 0 that differs from all of the above.
        let ten = mark_pixels(&render(Badge::Count(10), 16), 16);
        assert!(!seen.contains(&ten));
    }

    #[test]
    fn overflow_and_lock_differ_from_numbers() {
        let overflow = render(Badge::Overflow, 16);
        let lock = render(Badge::Locked, 16);
        assert_ne!(overflow, render(Badge::Count(99), 16));
        assert_ne!(lock, overflow);
        for n in 1..=99u8 {
            assert_ne!(lock, render(Badge::Count(n), 16));
        }
    }

    #[test]
    fn marks_stay_inside_the_frame_and_centred() {
        for badge in [Badge::Count(7), Badge::Count(88), Badge::Overflow, Badge::Locked] {
            let mark = mark_pixels(&render(badge, 32), 32);
            let (xs, ys): (Vec<u32>, Vec<u32>) = mark.iter().copied().unzip();
            let (x0, x1) = (*xs.iter().min().unwrap(), *xs.iter().max().unwrap());
            let (y0, y1) = (*ys.iter().min().unwrap(), *ys.iter().max().unwrap());
            // Neither touches the rim nor drifts off centre.
            assert!(x0 >= 4 && y0 >= 4 && x1 <= 27 && y1 <= 27, "{badge:?}: {x0}..{x1} × {y0}..{y1}");
            assert!((x0 + x1).abs_diff(31) <= 3, "{badge:?} off-center in x: {x0}..{x1}");
            assert!((y0 + y1).abs_diff(31) <= 3, "{badge:?} off-center in y: {y0}..{y1}");
        }
    }

    /// Padlock: the keyhole is hollow (Lumbre) and the body below it is Noche.
    #[test]
    fn lock_has_a_keyhole() {
        let img = render(Badge::Locked, 32);
        assert_eq!(px(&img, 32, 15, 19), LUMBRE_PX);
        assert_eq!(px(&img, 32, 9, 24), NOCHE_PX);
        // Inside the shackle, between its legs: Lumbre.
        assert_eq!(px(&img, 32, 15, 12), LUMBRE_PX);
    }

    /// Same input, same image (no state, no randomness).
    #[test]
    fn rendering_is_deterministic() {
        assert_eq!(render(Badge::Count(42), 24), render(Badge::Count(42), 24));
    }

    /// At 16 px two digits are drawn pixel by pixel: 2 clear columns between them, the 3 open on the left and the 8
    /// closed (it must not read as "3B").
    #[test]
    fn two_digits_at_16px_are_crisp_and_apart() {
        let img = render(Badge::Count(38), 16);
        for y in 4..11 {
            assert_eq!(px(&img, 16, 7, y), LUMBRE_PX, "gap between digits, row {y}");
            assert_eq!(px(&img, 16, 8, y), LUMBRE_PX, "gap between digits, row {y}");
        }
        // Left side of the 3 (column 3) on rows 5-6 is open; of the 8 (column 9), closed.
        for y in 5..7 {
            assert_eq!(px(&img, 16, 3, y), LUMBRE_PX, "3, row {y}");
            assert_eq!(px(&img, 16, 9, y), NOCHE_PX, "8, row {y}");
        }
        // No greys: every mark pixel is Noche or Lumbre.
        for (x, y) in mark_pixels(&img, 16) {
            assert_eq!(px(&img, 16, x, y), NOCHE_PX, "({x}, {y})");
        }
    }

    /// The "+" of "99+" at 16 px is a cross: Noche arms and Lumbre corners.
    #[test]
    fn overflow_plus_at_16px_is_a_cross() {
        let img = render(Badge::Overflow, 16);
        for (x, y) in [(11, 6), (10, 7), (11, 7), (12, 7), (11, 8)] {
            assert_eq!(px(&img, 16, x, y), NOCHE_PX, "({x}, {y})");
        }
        for (x, y) in [(10, 6), (12, 6), (10, 8), (12, 8), (9, 7)] {
            assert_eq!(px(&img, 16, x, y), LUMBRE_PX, "({x}, {y})");
        }
        // Both nines have their right stem (columns 4 and 8); a blank column between them (5) and before the
        // cross (9).
        for y in 5..10 {
            for x in [4, 8] {
                assert_eq!(px(&img, 16, x, y), NOCHE_PX, "stem of the 9 ({x}, {y})");
            }
            for x in [5, 9] {
                assert_eq!(px(&img, 16, x, y), LUMBRE_PX, "gap ({x}, {y})");
            }
        }
    }

    /// At 16 px single digits are pixel drawn too (same style as two digits): no greys and centred.
    #[test]
    fn single_digits_at_16px_are_crisp_and_centred() {
        for n in 1..=9u8 {
            let img = render(Badge::Count(n), 16);
            let mark = mark_pixels(&img, 16);
            for &(x, y) in &mark {
                assert_eq!(px(&img, 16, x, y), NOCHE_PX, "{n}: ({x}, {y})");
            }
            let (xs, ys): (Vec<u32>, Vec<u32>) = mark.iter().copied().unzip();
            assert!(*xs.iter().min().unwrap() >= 6 && *xs.iter().max().unwrap() <= 9, "{n}: {xs:?}");
            assert!(*ys.iter().min().unwrap() == 4 && *ys.iter().max().unwrap() == 10, "{n}: {ys:?}");
        }
        // The stem of the 1 is centred (column 7), top to bottom.
        let one = render(Badge::Count(1), 16);
        for y in 4..11 {
            assert_eq!(px(&one, 16, 7, y), NOCHE_PX, "1, row {y}");
        }
    }

    /// 64-bit FNV-1a: a short image fingerprint.
    fn fnv1a(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
    }

    /// 20, 24 and 32 px images must not change by accident (16 px tweaks do not touch them): pinned fingerprints.
    #[test]
    fn images_above_16px_are_pinned() {
        use Badge::{Count, Locked, Overflow};
        let want = [
            (20, Count(7), 0x9503_9719_e907_cf7f),
            (20, Count(42), 0x8ce9_7641_4608_8fe8),
            (20, Overflow, 0x0614_5a14_362c_ac0a),
            (20, Locked, 0x3337_8518_a860_82d5),
            (24, Count(7), 0x0b47_d2a6_b6c0_1912),
            (24, Count(42), 0x5d34_019c_9a91_9d96),
            (24, Overflow, 0x94d8_6131_30c4_d5a0),
            (24, Locked, 0x3849_e2ef_eedf_4bed),
            (32, Count(7), 0xea27_0f72_3d75_c1bb),
            (32, Count(42), 0x7179_e6c6_6dd9_60f8),
            (32, Overflow, 0x3d8c_a622_3df9_6154),
            (32, Locked, 0x1f6b_364d_b13f_b2c1),
        ];
        for (size, badge, hash) in want {
            assert_eq!(fnv1a(&render(badge, size)), hash, "{badge:?} at {size} px: the image has changed");
        }
    }

    /// Pixel glyphs are 16 px only: 20-32 px still use antialiased strokes (grey edges).
    #[test]
    fn pixel_glyphs_only_at_16px() {
        for size in [20, 24, 32] {
            let img = render(Badge::Count(38), size);
            let soft = mark_pixels(&img, size).iter().any(|&(x, y)| px(&img, size, x, y) != NOCHE_PX);
            assert!(soft, "{size} px");
        }
        assert!(pixel_mark(Badge::Count(7)).is_some());
        assert!(pixel_mark(Badge::Locked).is_none());
    }
}

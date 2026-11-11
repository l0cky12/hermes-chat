//! Annotations (ADR 0094): what the app may say about a point on a page in the Preview. The page answers one fixed
//! query (`annotate_query.js`) with raw parts, and everything the owner reviews and sends is built and capped here,
//! from the answer's shape alone. A form field's value has no place in these types, and a raw answer that carries any
//! key the query doesn't send is refused whole.

use crate::screenshot::{CaptureError, Captures};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The body of the function the page runs, with `x`, `y` and `up` as its arguments.
pub const QUERY: &str = include_str!("annotate_query.js");
/// The isolated script world the query runs in, apart from the page's own scripts.
pub const WORLD: &str = "hermes-chat-annotate";
/// The most parents the query climbs from the element under the point.
pub const MAX_UP: u32 = 16;
const MAX_ANSWER: usize = 16 * 1024;
const MAX_STEPS: usize = 5;
const MAX_CLASSES: usize = 2;
const MAX_NAME: usize = 40;
const SECRET_WORDS: [&str; 7] = ["key", "token", "secret", "password", "auth", "session", "credential"];

/// Why an annotation command has no result. Sent to the webview as `{ kind, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AnnotateError {
    #[error("{0}")]
    Unsupported(String),
    /// The page isn't open, or this still isn't its latest.
    #[error("The page isn't shown any more.")]
    NoPage,
    /// The page moved to another address, or loaded again, after the still.
    #[error("The page has changed since the still.")]
    Stale,
    /// The page didn't answer within its time, or its answer was refused.
    #[error("The page didn't answer.")]
    NoAnswer,
    #[error("{0}")]
    Failed(String),
}

/// A still of the page, kept in the captures folder until it is staged or cancelled.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Still {
    pub id: u64,
    pub generation: u64,
    pub path: String,
    pub url: String,
    pub taken_at_ms: u64,
    /// The view's size in CSS pixels; the image is this times `scale`.
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// Text from the page: whitespace collapsed, control and direction-changing characters removed, at most `N`
/// characters, never empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Text<const N: usize>(String);

impl<const N: usize> Text<N> {
    pub fn new(raw: &str) -> Option<Self> {
        let mut clean = String::new();
        let mut space = false;
        for c in raw.chars() {
            if c.is_whitespace() {
                space = !clean.is_empty();
            } else if !c.is_control() && !hidden_format(c) {
                if space {
                    clean.push(' ');
                    space = false;
                }
                clean.push(c);
            }
        }
        if clean.is_empty() {
            return None;
        }
        if clean.chars().count() > N {
            clean = clean.chars().take(N - 1).collect();
            clean.push('…');
        }
        Some(Self(clean))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Characters that change the direction of text around them, or show nothing.
fn hidden_format(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
}

pub fn looks_secret(s: &str) -> bool {
    let s = s.to_lowercase();
    SECRET_WORDS.iter().any(|w| s.contains(w))
}

/// A tag or an input type: a lowercase word of letters, digits and hyphens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Word(String);

impl Word {
    pub fn parse(s: &str) -> Option<Self> {
        let mut chars = s.chars();
        let ok =
            s.len() <= 32 && chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        ok.then(|| Self(s.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The host and port of another site's frame, and nothing else of its address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Host(String);

impl Host {
    pub fn parse(s: &str) -> Option<Self> {
        let plain = !s.is_empty() && s.len() <= 260 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'));
        let url = plain.then(|| url::Url::parse(&format!("http://{s}/")).ok()).flatten()?;
        url.host_str().is_some().then(|| Self(s.to_ascii_lowercase()))
    }
}

/// A box in the page's CSS pixels, from the view's top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// Finite, with no negative size.
    pub fn sound(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite()) && self.width >= 0.0 && self.height >= 0.0
    }

    /// This box cut to `width` × `height` from the origin, unless it lies outside. A box with no size (a body whose
    /// children are all positioned) stays one.
    pub fn clip(&self, width: f64, height: f64) -> Option<Rect> {
        let (x0, y0) = (self.x.max(0.0), self.y.max(0.0));
        let (x1, y1) = ((self.x + self.width).min(width), (self.y + self.height).min(height));
        (x1 >= x0 && y1 >= y0).then_some(Rect { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
    }
}

/// The page's view when it answered: its size in CSS pixels, its scroll position and its device scale.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct View {
    pub width: f64,
    pub height: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
    pub scale: f64,
}

impl View {
    fn sound(&self) -> bool {
        let finite = [self.width, self.height, self.scroll_x, self.scroll_y, self.scale].iter().all(|v| v.is_finite());
        finite && self.width > 0.0 && self.height > 0.0 && self.scale > 0.0 && self.scale <= 16.0
    }
}

/// The computed styles an annotation may carry (ADR 0094). No image property is on the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StyleProp {
    Display,
    Position,
    Width,
    Height,
    Margin,
    Padding,
    Gap,
    Color,
    BackgroundColor,
    Border,
    BorderRadius,
    FontFamily,
    FontSize,
    FontWeight,
    LineHeight,
    TextAlign,
    Opacity,
}

impl StyleProp {
    pub const ALL: [StyleProp; 17] = [
        Self::Display,
        Self::Position,
        Self::Width,
        Self::Height,
        Self::Margin,
        Self::Padding,
        Self::Gap,
        Self::Color,
        Self::BackgroundColor,
        Self::Border,
        Self::BorderRadius,
        Self::FontFamily,
        Self::FontSize,
        Self::FontWeight,
        Self::LineHeight,
        Self::TextAlign,
        Self::Opacity,
    ];
}

/// What kind of form field. Never what it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "type", rename_all = "camelCase")]
pub enum Field {
    Password,
    Hidden,
    Other(Word),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Element {
        tag: Word,
        role: Option<Text<40>>,
        label: Option<Text<80>>,
        selector: Text<180>,
        styles: BTreeMap<StyleProp, Text<80>>,
    },
    Field {
        tag: Word,
        field: Field,
        label: Option<Text<80>>,
    },
    /// A frame from another site, which the query can't enter.
    OtherSite {
        host: Host,
    },
}

/// What is under a point of the still, as the page answered.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Answer {
    pub target: Target,
    pub rect: Rect,
    pub view: View,
}

/// A picked element, or a box without element details and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Pick {
    Element(Answer),
    Region { rect: Rect, why: RegionWhy },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RegionWhy {
    OtherSite {
        host: Host,
    },
    /// The page's pixels in the box differ from the still's.
    Changed,
    /// The page answered, but its pixels couldn't be checked against the still.
    NoAnswer,
}

/// What the query sends, before anything in it is trusted.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Raw {
    tag: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    contains_field: bool,
    #[serde(default)]
    path: Vec<RawStep>,
    rect: Rect,
    #[serde(default)]
    styles: BTreeMap<StyleProp, String>,
    #[serde(default)]
    host: Option<String>,
    view: View,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStep {
    tag: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    classes: Vec<String>,
    #[serde(default)]
    nth: u32,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AnswerError {
    #[error("the answer is over {MAX_ANSWER} bytes")]
    TooLong,
    #[error("the answer isn't the query's shape: {0}")]
    Shape(String),
    #[error("the answer has {0}")]
    Refused(&'static str),
}

/// The page's answer, or `None` when nothing is under the point.
pub fn parse_answer(json: &str) -> Result<Option<Answer>, AnswerError> {
    if json.len() > MAX_ANSWER {
        return Err(AnswerError::TooLong);
    }
    let raw: Option<Raw> = serde_json::from_str(json).map_err(|e| AnswerError::Shape(e.to_string()))?;
    raw.map(build).transpose()
}

fn build(raw: Raw) -> Result<Answer, AnswerError> {
    let tag = Word::parse(&raw.tag).ok_or(AnswerError::Refused("a bad tag"))?;
    let view = Some(raw.view).filter(View::sound).ok_or(AnswerError::Refused("a bad view"))?;
    let rect = Some(raw.rect).filter(Rect::sound).ok_or(AnswerError::Refused("a bad box"))?;
    let rect = rect.clip(view.width, view.height).ok_or(AnswerError::Refused("a box outside the view"))?;
    let target = if let Some(host) = raw.host {
        Target::OtherSite { host: Host::parse(&host).ok_or(AnswerError::Refused("a bad host"))? }
    } else if let Some(field) = raw.field {
        let field = match Word::parse(&field).ok_or(AnswerError::Refused("a bad field type"))? {
            w if w.as_str() == "password" => Field::Password,
            w if w.as_str() == "hidden" => Field::Hidden,
            w => Field::Other(w),
        };
        let label = match field {
            Field::Other(_) => raw.label.as_deref().and_then(page_text),
            Field::Password | Field::Hidden => None,
        };
        Target::Field { tag, field, label }
    } else {
        let styles = raw.styles.iter().filter(|(_, v)| !carries_address(v)).filter_map(|(p, v)| Some((*p, Text::new(v)?))).collect();
        Target::Element {
            selector: selector(&tag, &raw.path)?,
            tag,
            role: raw.role.as_deref().and_then(page_text),
            label: raw.label.as_deref().filter(|_| !raw.contains_field).and_then(page_text),
            styles,
        }
    };
    Ok(Answer { target, rect, view })
}

/// Text the page wrote, unless it looks like a secret.
fn page_text<const N: usize>(raw: &str) -> Option<Text<N>> {
    Text::new(raw).filter(|t| !looks_secret(t.as_str()))
}

/// A style value that can name an address, which may be a signed one.
fn carries_address(value: &str) -> bool {
    let v = value.to_lowercase();
    v.contains("url(") || v.contains("image-set(")
}

/// An id or class fit for a selector: short, plain, and not secret-looking.
fn name(s: &str) -> Option<&str> {
    let plain = s.len() <= MAX_NAME
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    (plain && !looks_secret(s)).then_some(s)
}

fn selector(tag: &Word, path: &[RawStep]) -> Result<Text<180>, AnswerError> {
    let mut steps = Vec::new();
    for step in &path[path.len().saturating_sub(MAX_STEPS)..] {
        let mut s = Word::parse(&step.tag).ok_or(AnswerError::Refused("a bad tag in its path"))?.0;
        let id = step.id.as_deref().and_then(name);
        if let Some(id) = id {
            s.push('#');
            s.push_str(id);
        }
        for class in step.classes.iter().filter_map(|c| name(c)).take(MAX_CLASSES) {
            s.push('.');
            s.push_str(class);
        }
        if id.is_none() && step.nth > 0 {
            s.push_str(&format!(":nth-of-type({})", step.nth));
        }
        steps.push(s);
    }
    if steps.is_empty() {
        steps.push(tag.0.clone());
    }
    let mut joined = steps.join(" > ");
    while joined.len() > 180 && steps.len() > 1 {
        steps.remove(0);
        joined = steps.join(" > ");
    }
    Text::new(&joined).ok_or(AnswerError::Refused("an empty selector"))
}

/// A point to ask about, in CSS pixels inside a still `width` × `height`, and how many parents to climb.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QueryArgs {
    pub x: f64,
    pub y: f64,
    pub up: u32,
}

impl QueryArgs {
    pub fn new(x: f64, y: f64, up: u32, width: f64, height: f64) -> Result<Self, AnnotateError> {
        let inside = x.is_finite() && y.is_finite() && (0.0..width).contains(&x) && (0.0..height).contains(&y);
        if !inside || up > MAX_UP {
            return Err(AnnotateError::Failed("That point isn't on the still.".into()));
        }
        Ok(Self { x, y, up })
    }
}

/// An image in cairo's ARGB32 layout: four bytes a pixel, rows `stride` bytes apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pixels {
    width: usize,
    height: usize,
    stride: usize,
    data: Vec<u8>,
}

impl Pixels {
    pub fn new(width: usize, height: usize, stride: usize, data: Vec<u8>) -> Option<Self> {
        (stride >= width * 4 && data.len() >= stride * height).then_some(Self { width, height, stride, data })
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }
}

/// Whether any pixel inside `rect` (CSS pixels, scaled by `scale` into device pixels) differs between the still and
/// a snapshot taken now. Images of different sizes always differ.
pub fn box_changed(still: &Pixels, now: &Pixels, rect: Rect, scale: f64) -> bool {
    if (still.width, still.height) != (now.width, now.height) {
        return true;
    }
    let at = |v: f64, most: usize| (v * scale).clamp(0.0, most as f64);
    let (x0, x1) = (at(rect.x, still.width).floor() as usize, at(rect.x + rect.width, still.width).ceil() as usize);
    let (y0, y1) = (at(rect.y, still.height).floor() as usize, at(rect.y + rect.height, still.height).ceil() as usize);
    (y0..y1).any(|row| {
        let (a, b) = (row * still.stride, row * now.stride);
        still.data[a + x0 * 4..a + x1 * 4] != now.data[b + x0 * 4..b + x1 * 4]
    })
}

/// The PNG of a still.
#[cfg(target_os = "linux")]
pub fn png(pixels: &Pixels) -> Result<Vec<u8>, AnnotateError> {
    let failed = |e: &dyn std::fmt::Display| AnnotateError::Failed(format!("Couldn't keep the still: {e}"));
    let (width, height, stride) = (pixels.width as i32, pixels.height as i32, pixels.stride as i32);
    let image = cairo::ImageSurface::create_for_data(pixels.data.clone(), cairo::Format::ARgb32, width, height, stride).map_err(|e| failed(&e))?;
    let mut png = Vec::new();
    image.write_to_png(&mut png).map_err(|e| failed(&e))?;
    Ok(png)
}

/// The longest side a staged annotation's image may have.
const MAX_SIDE: f64 = 2560.0;

/// Stages the still at `still` as annotation `n`: outlined at `rect` (CSS pixels) times `scale`, scaled down to at most
/// 2560 pixels on its longest side, and written as `annotation-<n>.png`. The still is deleted once the annotation is
/// written.
#[cfg(target_os = "linux")]
pub fn stage(captures: &Captures, still: &Path, n: u32, rect: Rect, scale: f64) -> Result<PathBuf, CaptureError> {
    let failed = |e: &dyn std::fmt::Display| CaptureError::Failed(format!("Couldn't mark the still: {e}"));
    if !captures.owns(still) {
        return Err(CaptureError::Failed("That still isn't one the app took.".into()));
    }
    if !(1..=999).contains(&n) || !rect.sound() || !(scale > 0.0 && scale <= 16.0) {
        return Err(CaptureError::Failed("That mark isn't on the still.".into()));
    }
    let mut file = std::fs::File::open(still).map_err(|e| failed(&e))?;
    let image = cairo::ImageSurface::create_from_png(&mut file).map_err(|e| failed(&e))?;
    let line = 2.0 * scale;
    let cx = cairo::Context::new(&image).map_err(|e| failed(&e))?;
    cx.set_source_rgb(37.0 / 255.0, 99.0 / 255.0, 235.0 / 255.0);
    cx.set_line_width(line);
    cx.rectangle(rect.x * scale + line / 2.0, rect.y * scale + line / 2.0, (rect.width * scale - line).max(0.0), (rect.height * scale - line).max(0.0));
    cx.stroke().map_err(|e| failed(&e))?;
    drop(cx);
    let fit = (MAX_SIDE / f64::from(image.width().max(image.height()))).min(1.0);
    let out = if fit < 1.0 {
        let (width, height) = ((f64::from(image.width()) * fit).round() as i32, (f64::from(image.height()) * fit).round() as i32);
        let smaller = cairo::ImageSurface::create(cairo::Format::ARgb32, width.max(1), height.max(1)).map_err(|e| failed(&e))?;
        let cx = cairo::Context::new(&smaller).map_err(|e| failed(&e))?;
        cx.scale(fit, fit);
        cx.set_source_surface(&image, 0.0, 0.0).map_err(|e| failed(&e))?;
        cx.paint().map_err(|e| failed(&e))?;
        drop(cx);
        smaller
    } else {
        image
    };
    let mut png = Vec::new();
    out.write_to_png(&mut png).map_err(|e| failed(&e))?;
    let path = captures.write(&format!("annotation-{n}"), &png)?;
    captures.discard(still);
    Ok(path)
}

#[cfg(not(target_os = "linux"))]
pub fn stage(_: &Captures, _: &Path, _: u32, _: Rect, _: f64) -> Result<PathBuf, CaptureError> {
    Err(CaptureError::Unsupported("Annotations are made on Linux only for now.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// A plain button's raw answer, with `changes` laid over it.
    fn raw(changes: Value) -> String {
        let mut answer = json!({
            "tag": "button",
            "role": null,
            "label": "Save changes",
            "containsField": false,
            "path": [
                { "tag": "body", "id": null, "classes": [], "nth": 0 },
                { "tag": "main", "id": null, "classes": [], "nth": 0 },
                { "tag": "form", "id": "profile", "classes": [], "nth": 0 },
                { "tag": "button", "id": null, "classes": ["primary"], "nth": 2 },
            ],
            "rect": { "x": 412, "y": 380, "width": 120, "height": 36 },
            "styles": { "color": "rgb(255, 255, 255)", "background-color": "rgb(37, 99, 235)" },
            "view": { "width": 1280, "height": 800, "scrollX": 0, "scrollY": 0, "scale": 2 },
        });
        for (k, v) in changes.as_object().unwrap() {
            answer[k] = v.clone();
        }
        answer.to_string()
    }

    fn parse(changes: Value) -> Result<Option<Answer>, AnswerError> {
        parse_answer(&raw(changes))
    }

    fn target(changes: Value) -> Target {
        parse(changes).unwrap().unwrap().target
    }

    fn element(changes: Value) -> (Option<String>, Option<String>, String, BTreeMap<StyleProp, Text<80>>) {
        match target(changes) {
            Target::Element { role, label, selector, styles, .. } => (role.map(|t| t.0), label.map(|t| t.0), selector.0, styles),
            other => panic!("not an element: {other:?}"),
        }
    }

    #[test]
    fn a_plain_button_is_an_element_with_its_selector() {
        let answer = parse(json!({})).unwrap().unwrap();
        assert_eq!(answer.rect, Rect { x: 412.0, y: 380.0, width: 120.0, height: 36.0 });
        assert_eq!(answer.view, View { width: 1280.0, height: 800.0, scroll_x: 0.0, scroll_y: 0.0, scale: 2.0 });
        let Target::Element { tag, role, label, selector, styles } = answer.target else { panic!("not an element") };
        assert_eq!(tag.as_str(), "button");
        assert_eq!(role, None);
        assert_eq!(label.unwrap().as_str(), "Save changes");
        assert_eq!(selector.as_str(), "body > main > form#profile > button.primary:nth-of-type(2)");
        assert_eq!(serde_json::to_value(&styles).unwrap(), json!({ "color": "rgb(255, 255, 255)", "background-color": "rgb(37, 99, 235)" }));
        assert_eq!(parse_answer("null"), Ok(None), "nothing under the point");
    }

    #[test]
    fn page_text_is_capped() {
        let (_, label, _, _) = element(json!({ "label": "x".repeat(10_000) }));
        let label = label.unwrap();
        assert_eq!(label.chars().count(), 80);
        assert!(label.ends_with('…'));
        let (role, ..) = element(json!({ "role": "r".repeat(200) }));
        assert_eq!(role.unwrap().chars().count(), 40);
    }

    #[test]
    fn an_answer_over_16_kib_is_refused() {
        let long = raw(json!({ "label": "x".repeat(17 * 1024) }));
        assert_eq!(parse_answer(&long).unwrap_err(), AnswerError::TooLong);
    }

    #[test]
    fn any_key_the_query_doesnt_send_is_refused() {
        for key in ["value", "html", "outerHTML", "checked", "cookie", "dataset"] {
            assert!(matches!(parse(json!({ key: "hunter2" })), Err(AnswerError::Shape(_))), "{key}");
        }
        let step = json!([{ "tag": "input", "id": null, "classes": [], "nth": 0, "value": "hunter2" }]);
        assert!(matches!(parse(json!({ "path": step })), Err(AnswerError::Shape(_))), "a value in a path step");
        let rect = json!({ "x": 0, "y": 0, "width": 1, "height": 1, "value": "hunter2" });
        assert!(matches!(parse(json!({ "rect": rect })), Err(AnswerError::Shape(_))), "a value in the box");
    }

    #[test]
    fn a_password_or_hidden_field_is_named_and_nothing_more() {
        for (kind, want) in [("password", Field::Password), ("hidden", Field::Hidden)] {
            let got = target(json!({ "tag": "input", "field": kind, "label": "hunter2" }));
            assert_eq!(got, Target::Field { tag: Word::parse("input").unwrap(), field: want, label: None }, "{kind}");
            assert!(!serde_json::to_string(&got).unwrap().contains("hunter2"));
        }
        let email = target(json!({ "tag": "input", "field": "email", "label": "Email address" }));
        assert_eq!(
            email,
            Target::Field { tag: Word::parse("input").unwrap(), field: Field::Other(Word::parse("email").unwrap()), label: Text::new("Email address") }
        );
        assert_eq!(
            serde_json::to_value(&email).unwrap(),
            json!({ "kind": "field", "tag": "input", "field": { "kind": "other", "type": "email" }, "label": "Email address" })
        );
    }

    #[test]
    fn an_element_holding_a_field_has_no_label() {
        let (_, label, _, _) = element(json!({ "tag": "form", "containsField": true, "label": "Name hunter2" }));
        assert_eq!(label, None);
    }

    #[test]
    fn secret_looking_ids_classes_and_labels_are_left_out() {
        let path = json!([
            { "tag": "div", "id": "apiKey", "classes": ["session-8f3a9b2c", "AUTH_x", "card", "wide", "tall"], "nth": 3 },
            { "tag": "span", "id": "x".repeat(41), "classes": [], "nth": 0 },
        ]);
        let (_, label, selector, _) = element(json!({ "path": path, "label": "Your API token is abc" }));
        assert_eq!(selector, "div.card.wide:nth-of-type(3) > span");
        assert_eq!(label, None);
        for secret in ["session-8f3a9b2c", "apiKey", "AUTH_x", "MySecret", "credentials", "Password1"] {
            assert!(looks_secret(secret), "{secret}");
        }
        assert!(!looks_secret("primary"));
    }

    #[test]
    fn an_id_over_40_characters_or_not_plain_is_left_out() {
        let path = json!([{ "tag": "div", "id": "a".repeat(41), "classes": ["b".repeat(41), "x y", "x\"]", "9lives", "ok"], "nth": 0 }]);
        assert_eq!(element(json!({ "path": path })).2, "div.ok");
        let path = json!([{ "tag": "div", "id": "a".repeat(40), "classes": [], "nth": 2 }]);
        assert_eq!(element(json!({ "path": path })).2, format!("div#{}", "a".repeat(40)), "an id takes nth-of-type's place");
    }

    #[test]
    fn the_selector_keeps_the_last_five_steps_within_180_characters() {
        let steps: Vec<Value> = (1..=8).map(|i| json!({ "tag": "div", "id": null, "classes": [format!("level{i}")], "nth": 0 })).collect();
        assert_eq!(element(json!({ "path": steps })).2, "div.level4 > div.level5 > div.level6 > div.level7 > div.level8");
        let wide: Vec<Value> = (0..8)
            .map(|i| json!({ "tag": "custom-element-name", "id": format!("{}{i}", "i".repeat(39)), "classes": ["c".repeat(40), "d".repeat(40)], "nth": 0 }))
            .collect();
        let selector = element(json!({ "path": wide })).2;
        assert!(selector.len() <= 180, "{}", selector.len());
        assert!(selector.ends_with("i7.cccccccccccccccccccccccccccccccccccccccc.dddddddddddddddddddddddddddddddddddddddd"), "{selector}");
    }

    #[test]
    fn style_values_that_name_an_address_are_left_out() {
        let styles = json!({
            "color": "url(https://x/a.png?sig=SECRETSIG)",
            "background-color": "URL(x)",
            "border": "image-set(\"a.png\" 1x)",
            "border-radius": "-webkit-image-set(a 1x)",
            "font-family": "f".repeat(300),
            "display": "block",
        });
        let (.., got) = element(json!({ "styles": styles }));
        assert_eq!(got.keys().copied().collect::<Vec<_>>(), [StyleProp::Display, StyleProp::FontFamily]);
        assert_eq!(got[&StyleProp::FontFamily].as_str().chars().count(), 80);
    }

    #[test]
    fn a_style_not_on_the_list_is_refused() {
        for prop in ["background-image", "content", "mask-image", "list-style"] {
            assert!(matches!(parse(json!({ "styles": { prop: "none" } })), Err(AnswerError::Shape(_))), "{prop}");
        }
    }

    #[test]
    fn the_query_asks_for_exactly_the_listed_styles() {
        let listed = QUERY.split_once("const STYLES = [").unwrap().1.split_once(']').unwrap().0;
        let names: Vec<String> = listed.split(',').map(|s| s.trim().trim_matches('\'').to_owned()).collect();
        let ours: Vec<String> = StyleProp::ALL.iter().map(|p| serde_json::to_value(p).unwrap().as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ours);
    }

    #[test]
    fn a_bad_tag_is_refused() {
        for tag in ["", "BUTTON", "x y", "a<b", "1div", "svg:rect", &"a".repeat(33)] {
            assert_eq!(parse(json!({ "tag": tag })).unwrap_err(), AnswerError::Refused("a bad tag"), "{tag:?}");
        }
        let path = json!([{ "tag": "div>script", "id": null, "classes": [], "nth": 0 }]);
        assert_eq!(parse(json!({ "path": path })).unwrap_err(), AnswerError::Refused("a bad tag in its path"));
        assert!(parse(json!({ "tag": "my-widget2" })).is_ok());
    }

    #[test]
    fn page_text_comes_out_clean() {
        let (_, label, ..) = element(json!({ "label": "  Save\u{202E}evil\u{202C}\n\t changes\u{0007}\u{200B} \u{2066}now\u{2069}  " }));
        assert_eq!(label.as_deref(), Some("Saveevil changes now"));
        assert_eq!(Text::<80>::new("\u{202E}\u{0000} \n"), None, "nothing left is no text");
    }

    #[test]
    fn a_bad_box_is_refused_and_one_off_the_view_is_clipped() {
        for rect in [json!({ "x": 0, "y": 0, "width": -5, "height": 10 }), json!({ "x": null, "y": 0, "width": 5, "height": 10 })] {
            assert!(parse(json!({ "rect": rect })).is_err(), "{rect}");
        }
        assert!(!Rect { x: f64::NAN, y: 0.0, width: 1.0, height: 1.0 }.sound());
        let answer = parse(json!({ "rect": { "x": -10, "y": 790, "width": 50, "height": 40 } })).unwrap().unwrap();
        assert_eq!(answer.rect, Rect { x: 0.0, y: 790.0, width: 40.0, height: 10.0 });
        assert_eq!(parse(json!({ "rect": { "x": 2000, "y": 0, "width": 5, "height": 5 } })).unwrap_err(), AnswerError::Refused("a box outside the view"));
        assert_eq!(
            parse(json!({ "view": { "width": 0, "height": 800, "scrollX": 0, "scrollY": 0, "scale": 2 } })).unwrap_err(),
            AnswerError::Refused("a bad view")
        );
    }

    #[test]
    fn another_sites_frame_gives_only_its_host() {
        let got = target(json!({ "tag": "iframe", "host": "Localhost:8443" }));
        assert_eq!(got, Target::OtherSite { host: Host("localhost:8443".into()) });
        assert_eq!(serde_json::to_value(&got).unwrap(), json!({ "kind": "otherSite", "host": "localhost:8443" }));
        assert!(Host::parse("[::1]:80").is_some());
        for bad in ["user:pw@example.com", "example.com/path?sig=1", "example.com#x", "", "exa mple.com", "a\\b"] {
            assert_eq!(parse(json!({ "host": bad })).unwrap_err(), AnswerError::Refused("a bad host"), "{bad:?}");
        }
    }

    #[test]
    fn query_args_stay_on_the_still() {
        assert!(QueryArgs::new(0.0, 0.0, 0, 640.0, 480.0).is_ok());
        assert!(QueryArgs::new(639.5, 479.5, MAX_UP, 640.0, 480.0).is_ok());
        for (x, y, up) in [(-1.0, 0.0, 0), (640.0, 0.0, 0), (0.0, 480.0, 0), (f64::NAN, 0.0, 0), (0.0, f64::INFINITY, 0), (1.0, 1.0, MAX_UP + 1)] {
            assert!(QueryArgs::new(x, y, up, 640.0, 480.0).is_err(), "{x} {y} {up}");
        }
    }

    fn image(width: usize, height: usize) -> Pixels {
        Pixels::new(width, height, width * 4 + 8, vec![0x80; (width * 4 + 8) * height]).unwrap()
    }

    fn set(p: &mut Pixels, x: usize, y: usize) {
        let i = y * p.stride + x * 4;
        p.data[i] ^= 0xff;
    }

    #[test]
    fn a_box_changed_only_when_a_pixel_inside_it_did() {
        let still = image(200, 100);
        let rect = Rect { x: 10.0, y: 10.0, width: 20.0, height: 10.0 };
        assert!(!box_changed(&still, &still.clone(), rect, 2.0), "identical");
        let mut inside = still.clone();
        set(&mut inside, 59, 39);
        assert!(box_changed(&still, &inside, rect, 2.0), "the last device pixel inside the box at scale 2");
        let mut outside = still.clone();
        set(&mut outside, 60, 25);
        set(&mut outside, 25, 19);
        assert!(!box_changed(&still, &outside, rect, 2.0), "just outside the box");
        assert!(box_changed(&still, &image(100, 100), rect, 2.0), "another size");
        assert!(Pixels::new(10, 10, 39, vec![0; 400]).is_none(), "a stride too short for the width");
        assert!(Pixels::new(10, 10, 40, vec![0; 399]).is_none(), "too little data");
    }

    #[test]
    fn the_query_reads_nothing_it_mustnt() {
        for word in ["cookie", "Storage", "indexedDB", ".value", "HTML", "textContent", "dataset", "attributes", "fetch", "XMLHttpRequest", "postMessage"] {
            assert!(!QUERY.contains(word), "annotate_query.js mentions {word}");
        }
    }

    #[test]
    fn errors_reach_the_webview_as_kind_and_message() {
        assert_eq!(serde_json::to_value(AnnotateError::Stale).unwrap(), json!({ "kind": "stale" }));
        assert_eq!(serde_json::to_value(AnnotateError::Unsupported("no".into())).unwrap(), json!({ "kind": "unsupported", "message": "no" }));
        let region = Pick::Region { rect: Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 }, why: RegionWhy::Changed };
        assert_eq!(
            serde_json::to_value(region).unwrap(),
            json!({ "kind": "region", "rect": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 }, "why": { "kind": "changed" } })
        );
    }

    #[cfg(target_os = "linux")]
    mod staging {
        use super::*;

        struct Folder(PathBuf);
        impl Drop for Folder {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn captures(tag: &str) -> (Folder, Captures) {
            let base = std::env::temp_dir().join(format!("hermes-chat-annotate-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let captures = Captures::open(base.join("captures")).unwrap();
            (Folder(base), captures)
        }

        /// A grey still `width` × `height` device pixels, kept as a capture.
        fn still(captures: &Captures, width: usize, height: usize) -> PathBuf {
            let pixels = Pixels::new(width, height, width * 4, [0x80, 0x80, 0x80, 0xff].repeat(width * height)).unwrap();
            captures.write("still", &png(&pixels).unwrap()).unwrap()
        }

        /// The colour at `(x, y)` of a PNG, as `[r, g, b]`.
        fn rgb(image: &mut cairo::ImageSurface, x: usize, y: usize) -> [u8; 3] {
            let stride = image.stride() as usize;
            let data = image.data().unwrap();
            let i = y * stride + x * 4;
            [data[i + 2], data[i + 1], data[i]]
        }

        fn open(path: &Path) -> cairo::ImageSurface {
            cairo::ImageSurface::create_from_png(&mut std::fs::File::open(path).unwrap()).unwrap()
        }

        #[test]
        fn staging_outlines_the_mark_and_deletes_the_still() {
            let (_folder, captures) = captures("outline");
            let at = still(&captures, 400, 200);
            let rect = Rect { x: 10.0, y: 10.0, width: 50.0, height: 20.0 };
            let staged = stage(&captures, &at, 1, rect, 2.0).unwrap();
            assert_eq!(staged.file_name().unwrap(), "annotation-1.png");
            assert!(captures.owns(&staged));
            assert!(!at.exists() && !at.parent().unwrap().exists(), "the still is deleted");
            let mut image = open(&staged);
            assert_eq!((image.width(), image.height()), (400, 200), "a small still keeps its size");
            let blue = [37, 99, 235];
            assert_eq!(rgb(&mut image, 21, 40), blue, "the box's left edge, 2 CSS px wide at scale 2");
            assert_eq!(rgb(&mut image, 70, 21), blue, "its top edge");
            assert_eq!(rgb(&mut image, 118, 58), blue, "its bottom-right corner");
            assert_eq!(rgb(&mut image, 40, 40), [0x80; 3], "inside the outline");
            assert_eq!(rgb(&mut image, 18, 40), [0x80; 3], "outside the box");
            assert_eq!(rgb(&mut image, 121, 40), [0x80; 3], "outside the box");
        }

        #[test]
        fn a_large_still_is_staged_at_2560_pixels_at_most() {
            let (_folder, captures) = captures("large");
            let at = still(&captures, 3000, 1000);
            let staged = stage(&captures, &at, 2, Rect { x: 0.0, y: 0.0, width: 10.0, height: 10.0 }, 2.0).unwrap();
            assert_eq!(staged.file_name().unwrap(), "annotation-2.png");
            let image = open(&staged);
            assert_eq!((image.width(), image.height()), (2560, 853));
        }

        #[test]
        fn only_a_still_the_app_took_is_staged() {
            let (folder, captures) = captures("refuse");
            let elsewhere = folder.0.join("still.png");
            std::fs::write(&elsewhere, b"\x89PNG\r\n\x1a\n").unwrap();
            let rect = Rect { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };
            assert!(stage(&captures, &elsewhere, 1, rect, 1.0).is_err());
            assert!(elsewhere.exists());
            let at = still(&captures, 10, 10);
            assert!(stage(&captures, &at, 0, rect, 1.0).is_err(), "annotations count from 1");
            assert!(stage(&captures, &at, 1, Rect { width: -1.0, ..rect }, 1.0).is_err());
            assert!(stage(&captures, &at, 1, rect, f64::NAN).is_err());
            assert!(at.exists(), "a refused stage keeps the still");
        }
    }
}

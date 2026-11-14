//! Spell checking in the app's own webview on Linux (#578). WebKitGTK checks no spelling until its context is turned
//! on and given languages, so it finds those from the system locale, with English when no dictionary matches. Which
//! fields are checked is the page's choice (`spellcheck`). WebView2 checks spelling by itself.

use webkit2gtk::WebContextExt;

/// English, used when no dictionary matches the system's languages.
const FALLBACK: &str = "en_US";

/// The dictionary tags Enchant knows for the locale names GLib gives (`en_US.UTF-8`, `en_US`, `en`, `C`), in order:
/// `en_US`, `en`. The codeset and modifier go, and `C` and `POSIX`, which name no language, are left out.
pub fn languages<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for name in names {
        let tag = name.split(['.', '@']).next().unwrap_or_default();
        if !tag.is_empty() && tag != "C" && tag != "POSIX" && !found.iter().any(|t| t == tag) {
            found.push(tag.to_owned());
        }
    }
    found
}

/// Turns spell checking on in `context` in the system's languages. WebKit skips a language with no dictionary
/// installed and lists only the ones it loaded, so with none of them it takes English. With no dictionary at all,
/// nothing is underlined.
pub fn start(context: &webkit2gtk::WebContext) {
    context.set_spell_checking_enabled(true);
    let names = gtk::glib::language_names();
    let wanted = languages(names.iter().map(|n| n.as_str()));
    context.set_spell_checking_languages(&wanted.iter().map(String::as_str).collect::<Vec<_>>());
    if context.spell_checking_languages().is_empty() {
        context.set_spell_checking_languages(&[FALLBACK]);
    }
}

#[cfg(test)]
mod tests {
    use super::languages;

    #[test]
    fn takes_the_locales_languages_without_codeset_or_modifier() {
        assert_eq!(languages(["en_US.UTF-8", "en_US", "en.UTF-8", "en", "C"]), ["en_US", "en"]);
        assert_eq!(languages(["de_DE.UTF-8@euro", "de_DE@euro", "de_DE", "de", "C"]), ["de_DE", "de"]);
        assert_eq!(languages(["sr_RS@latin", "sr@latin", "sr_RS", "sr", "C"]), ["sr_RS", "sr"]);
    }

    #[test]
    fn names_no_language_for_c_or_posix() {
        assert!(languages(["C.UTF-8", "C", "POSIX"]).is_empty());
        assert!(languages([""]).is_empty());
    }
}

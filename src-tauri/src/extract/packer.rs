//! Desempaquetador de scripts `eval(function(p,a,c,k,e,d){...}('...',a,c,'...'.split('|')))`
//! (Dean Edwards' packer), usado por mixdrop, lulu, uqload, streamwish y similares.

use std::sync::LazyLock;

use regex::Regex;

static PACKED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split\(\s*'\|'\s*\)")
        .unwrap()
});

const ALPHABET: &[u8; 62] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// Devuelve el código desempaquetado de cada bloque empaquetado de `html`.
pub fn unpack_all(html: &str) -> Vec<String> {
    if !html.contains("p,a,c,k,e,") {
        return Vec::new();
    }
    PACKED
        .captures_iter(html)
        .filter_map(|c| {
            let radix: usize = c[2].parse().ok()?;
            let count: usize = c[3].parse().ok()?;
            unpack(&unescape(&c[1]), radix, count, &unescape(&c[4]))
        })
        .collect()
}

fn unpack(payload: &str, radix: usize, count: usize, symtab: &str) -> Option<String> {
    if !(2..=62).contains(&radix) {
        return None;
    }
    let symbols: Vec<&str> = symtab.split('|').collect();
    let mut out = String::with_capacity(payload.len() * 2);
    let mut word = String::new();
    // Igual que `\b\w+\b` en JavaScript: \w es [A-Za-z0-9_] en ASCII.
    for ch in payload.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            word.push(ch);
        } else {
            flush(&mut out, &mut word, radix, count, &symbols);
            out.push(ch);
        }
    }
    flush(&mut out, &mut word, radix, count, &symbols);
    Some(out)
}

fn flush(out: &mut String, word: &mut String, radix: usize, count: usize, symbols: &[&str]) {
    if word.is_empty() {
        return;
    }
    match decode_index(word, radix).filter(|i| *i < count) {
        Some(i) if symbols.get(i).is_some_and(|s| !s.is_empty()) => out.push_str(symbols[i]),
        _ => out.push_str(word),
    }
    word.clear();
}

/// Inverso de la función `e(c)` del packer (base `radix` con dígitos 0-9a-zA-Z).
fn decode_index(word: &str, radix: usize) -> Option<usize> {
    if word.len() > 1 && word.starts_with('0') {
        return None;
    }
    word.bytes().try_fold(0usize, |acc, b| {
        let digit = ALPHABET.iter().position(|&a| a == b).filter(|d| *d < radix)?;
        acc.checked_mul(radix)?.checked_add(digit)
    })
}

/// Deshace los escapes de una cadena JavaScript entre comillas simples.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_mixdrop_style_script() {
        // Fragmento real (acortado) de una página de mixdrop.
        let html = r#"<script>eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}('0.a="//b.c.d/e/f.g?s=h&i=j";0.k=\'l\';',22,22,'MDCore||||||||||wurl|30xplewoo|mxcontent|net|v2|r66p0xj6ug0n4r|mp4|wVtGGocYy38gkjSmCTkaZg|e|1794090948|vfile|x'.split('|'),0,{}))</script>"#;
        let unpacked = unpack_all(html);
        assert_eq!(unpacked.len(), 1);
        assert_eq!(
            unpacked[0],
            r#"MDCore.wurl="//30xplewoo.mxcontent.net/v2/r66p0xj6ug0n4r.mp4?s=wVtGGocYy38gkjSmCTkaZg&e=1794090948";MDCore.vfile='x';"#
        );
    }

    #[test]
    fn keeps_words_without_symbol_and_high_radix_digits() {
        // "A" vale 36 en base 62; "zz" no es un índice válido (fuera de `count`); "07" no es canónico.
        let out = unpack("A zz 07 1", 62, 40, &format!("{}|uno", vec!["x"; 36].join("|"))).unwrap();
        assert_eq!(out, "uno zz 07 x");
    }

    #[test]
    fn ignores_pages_without_packer() {
        assert!(unpack_all("<script>var a = 1;</script>").is_empty());
    }
}

//! Node `path` semantics on plain strings. The JS scripts lean on
//! `path.resolve` / `path.relative` normalization everywhere their output is
//! built, so every path that reaches stdout goes through these instead of
//! `std::path`.
//!
//! Host paths use POSIX semantics.
//!
//! `resolve` and `relative` take an explicit `cwd`.

/// `path.sep`: `/`.
pub const SEP: &str = "/";

/// `path.sep` as a char.
pub const SEP_CHAR: char = '/';

/// JS: `p.split(path.sep).join('/')`. The scripts do this wherever a path is
/// displayed, matched against a glob, or written into a manifest another
/// platform may read. Identity on posix.
pub fn to_posix(p: &str) -> String {
    p.to_string()
}

/// `path.isAbsolute`
pub fn is_absolute(p: &str) -> bool {
    posix::is_absolute(p)
}

/// `path.normalize`
pub fn normalize(p: &str) -> String {
    posix::normalize(p)
}

/// `path.join`
pub fn join(parts: &[&str]) -> String {
    posix::join(parts)
}

/// `path.resolve(...segments)` with `cwd` standing in for `process.cwd()`.
pub fn resolve(cwd: &str, parts: &[&str]) -> String {
    posix::resolve(cwd, parts)
}

/// `path.relative(from, to)` with `cwd` standing in for `process.cwd()`.
pub fn relative(cwd: &str, from: &str, to: &str) -> String {
    posix::relative(cwd, from, to)
}

/// `path.dirname`
pub fn dirname(p: &str) -> String {
    posix::dirname(p)
}

/// `path.basename(p)`
pub fn basename(p: &str) -> String {
    posix::basename(p)
}

/// `path.basename(p, ext)`
pub fn basename_ext(p: &str, ext: &str) -> String {
    posix::basename_ext(p, ext)
}

/// `path.extname`
pub fn extname(p: &str) -> String {
    posix::extname(p)
}

/// Node's `normalizeString`: split on separators, drop empty and `.`
/// segments, fold `..` (kept only when `allow_above_root`).
fn normalize_segments(p: &str, allow_above_root: bool, is_sep: fn(u8) -> bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for seg in p.split(|c: char| c.is_ascii() && is_sep(c as u8)) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if let Some(last) = out.last() {
                if last != ".." {
                    out.pop();
                    continue;
                }
            }
            if allow_above_root {
                out.push("..".to_string());
            }
            continue;
        }
        out.push(seg.to_string());
    }
    out
}

/// `path.posix`. Separators are `/`.
pub mod posix {
    fn is_sep(c: u8) -> bool {
        c == b'/'
    }

    /// JS: path.posix.isAbsolute
    pub fn is_absolute(p: &str) -> bool {
        p.starts_with('/')
    }

    /// JS: path.posix.normalize
    pub fn normalize(p: &str) -> String {
        if p.is_empty() {
            return ".".to_string();
        }
        let absolute = is_absolute(p);
        let trailing = p.ends_with('/');
        let segs = super::normalize_segments(p, !absolute, is_sep);
        let mut s = segs.join("/");
        if s.is_empty() && !absolute {
            s = ".".to_string();
        }
        if trailing && !s.is_empty() && s != "." {
            s.push('/');
        } else if trailing && s == "." {
            s = "./".to_string();
        }
        if absolute {
            format!("/{}", s.trim_start_matches('/'))
        } else {
            s
        }
    }

    /// JS: path.posix.join
    pub fn join(parts: &[&str]) -> String {
        let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
        if joined.is_empty() {
            return ".".to_string();
        }
        normalize(&joined.join("/"))
    }

    /// JS: path.posix.resolve(cwd, ...segments) with an explicit cwd.
    pub fn resolve(cwd: &str, parts: &[&str]) -> String {
        let mut resolved = String::new();
        let mut abs = false;
        for p in parts.iter().rev() {
            if p.is_empty() {
                continue;
            }
            resolved = format!("{}/{}", p, resolved);
            if is_absolute(p) {
                abs = true;
                break;
            }
        }
        if !abs {
            resolved = format!("{}/{}", cwd, resolved);
        }
        let segs = super::normalize_segments(&resolved, false, is_sep);
        format!("/{}", segs.join("/"))
    }

    /// JS: path.posix.relative(from, to)
    pub fn relative(cwd: &str, from: &str, to: &str) -> String {
        let from = resolve(cwd, &[from]);
        let to = resolve(cwd, &[to]);
        if from == to {
            return String::new();
        }
        let f: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
        let t: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
        let mut i = 0;
        while i < f.len() && i < t.len() && f[i] == t[i] {
            i += 1;
        }
        let mut out: Vec<&str> = Vec::new();
        for _ in i..f.len() {
            out.push("..");
        }
        for seg in &t[i..] {
            out.push(seg);
        }
        out.join("/")
    }

    /// JS: path.posix.dirname
    pub fn dirname(p: &str) -> String {
        if p.is_empty() {
            return ".".to_string();
        }
        let has_root = p.starts_with('/');
        let bytes = p.as_bytes();
        let mut end: isize = -1;
        let mut matched_slash = true;
        let mut i = bytes.len() as isize - 1;
        while i >= 1 {
            if bytes[i as usize] == b'/' {
                if !matched_slash {
                    end = i;
                    break;
                }
            } else {
                matched_slash = false;
            }
            i -= 1;
        }
        if end == -1 {
            return if has_root {
                "/".to_string()
            } else {
                ".".to_string()
            };
        }
        if has_root && end == 1 {
            return "//".to_string();
        }
        p[..end as usize].to_string()
    }

    /// JS: path.posix.basename (no ext)
    pub fn basename(p: &str) -> String {
        let trimmed = p.trim_end_matches('/');
        if trimmed.is_empty() {
            return String::new();
        }
        match trimmed.rfind('/') {
            Some(i) => trimmed[i + 1..].to_string(),
            None => trimmed.to_string(),
        }
    }

    /// JS: path.posix.basename(p, ext)
    pub fn basename_ext(p: &str, ext: &str) -> String {
        let b = basename(p);
        if !ext.is_empty() && b.len() > ext.len() && b.ends_with(ext) {
            b[..b.len() - ext.len()].to_string()
        } else {
            b
        }
    }

    /// JS: path.posix.extname
    pub fn extname(p: &str) -> String {
        let b = basename(p);
        // JS: leading dot without another dot => ''
        match b.rfind('.') {
            Some(0) | None => String::new(),
            Some(i) => {
                if i == b.len() - 1 {
                    ".".to_string()
                } else {
                    b[i..].to_string()
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_basics() {
        use super::posix::*;
        assert_eq!(resolve("/a/b", &["c"]), "/a/b/c");
        assert_eq!(resolve("/a/b", &["../c"]), "/a/c");
        assert_eq!(resolve("/a/b", &["/x/y/", "z"]), "/x/y/z");
        assert_eq!(relative("/", "/a/b", "/a/c/d"), "../c/d");
        assert_eq!(relative("/", "/a/b", "/a/b"), "");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(basename("/a/b.md"), "b.md");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename_ext("/a/b.md", ".md"), "b");
        assert_eq!(extname("x.tar.gz"), ".gz");
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("a."), ".");
        assert_eq!(join(&["/a", "b", "../c"]), "/a/c");
        assert_eq!(join(&["a", ""]), "a");
        assert_eq!(normalize("./"), "./");
        assert_eq!(normalize("../a/./b/.."), "../a");
        assert_eq!(normalize("/a//b/../c/"), "/a/c/");
    }

    #[test]
    fn dispatch_matches_platform() {
        assert_eq!(SEP, "/");
        assert_eq!(join(&["a", "b"]), "a/b");
        assert_eq!(to_posix("a\\b"), "a\\b");
    }
}

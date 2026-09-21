//! JS: generate-image.mjs -> `impeccable generate-image`
//!
//! `--plate <region-id>` is fork-original (not part of the old generate-image.mjs
//! CLI contract): it produces a shipping raster for one raster region of a
//! measured comp spec end to end -- crop as reference, the spec's plate
//! prompt, output size from the region's aspect, embed, and a score against
//! the crop via [`impeccable_comp_verbs::build_phase::gate_one_plate`], the
//! same gate `impeccable build-phase advance` runs, so a subagent's reported
//! score and the parent's gate can never disagree. `--score-only` runs just
//! that gate against a plate a harness-native image tool already produced,
//! with no API key.

use crate::jsp;
use crate::util::{iso_now, json_pretty, node_read_error, utf16_len, Env};
use impeccable_comp::png_io;
use impeccable_comp::raster::Image;
use impeccable_comp_verbs::{build_phase, comp_spec};
use impeccable_common::Io;
use serde_json::{Map, Value};
use std::io::Write;

pub const DEFAULT_MODEL: &str = "gpt-image-2.5-flare";

fn arg(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == &format!("--{}", name))?;
    let v = args.get(i + 1)?;
    if !v.is_empty() && !v.starts_with("--") {
        Some(v.clone())
    } else {
        None
    }
}

fn hash32(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for cu in s.encode_utf16() {
        h ^= cu as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

fn hsl_to_rgb(h_deg: f64, s: f64, l: f64) -> [u8; 3] {
    let h = ((h_deg % 360.0) + 360.0) % 360.0 / 360.0;
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hue = |t: f64| -> f64 {
        let mut tt = t;
        if tt < 0.0 {
            tt += 1.0;
        }
        if tt > 1.0 {
            tt -= 1.0;
        }
        if tt < 1.0 / 6.0 {
            return p + (q - p) * 6.0 * tt;
        }
        if tt < 1.0 / 2.0 {
            return q;
        }
        if tt < 2.0 / 3.0 {
            return p + (q - p) * (2.0 / 3.0 - tt) * 6.0;
        }
        p
    };
    let round = |c: f64| -> u8 { js_round(c * 255.0) as u8 };
    [round(hue(h + 1.0 / 3.0)), round(hue(h)), round(hue(h - 1.0 / 3.0))]
}

/// Math.round: half up toward +inf
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn to_hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn palette(prompt: &str) -> Vec<[u8; 3]> {
    let h = hash32(prompt);
    let base = (h % 360) as f64;
    let bands = 2 + ((h >> 9) % 2) as usize;
    let spread = (40 + (h >> 3) % 120) as f64;
    let mut out = Vec::new();
    for i in 0..bands {
        let hue = base + i as f64 * spread;
        let light = 0.32 + ((h >> (i * 5)) % 40) as f64 / 100.0;
        out.push(hsl_to_rgb(hue, 0.55, light));
    }
    out
}

fn collapse_ws(s: &str) -> String {
    // .replace(/\s+/g, ' ').trim()
    let mut out = String::new();
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() || c == '\u{FEFF}' {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            in_ws = false;
            out.push(c);
        }
    }
    crate::util::js_trim(&out).to_string()
}

fn num(v: f64) -> String {
    crate::util::js_number_to_string(v)
}

fn svg_fake(prompt: &str, w: f64, h: f64) -> String {
    let colors: Vec<String> = palette(prompt).into_iter().map(to_hex).collect();
    let n = colors.len();
    let stops: String = colors
        .iter()
        .enumerate()
        .map(|(i, c)| format!("<stop offset=\"{}%\" stop-color=\"{}\"/>", num(js_round(i as f64 / (n as f64 - 1.0) * 100.0)), c))
        .collect();
    let per_line = (12.0f64).max((w / 26.0).floor()) as usize;
    let words: Vec<&str> = {
        let collapsed = collapse_ws(prompt);
        // split(' ') on the collapsed string; leak for lifetime simplicity
        Box::leak(collapsed.into_boxed_str()).split(' ').collect()
    };
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in words {
        let candidate = crate::util::js_trim(&format!("{} {}", cur, word)).to_string();
        if utf16_len(&candidate) > per_line {
            if !cur.is_empty() {
                lines.push(cur.clone());
            }
            cur = word.to_string();
        } else {
            cur = candidate;
        }
        if lines.len() >= 10 {
            break;
        }
    }
    if !cur.is_empty() && lines.len() < 11 {
        lines.push(cur);
    }
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let font_size = js_round(w / 24.0);
    let start_y = h / 2.0 - ((lines.len() as f64 - 1.0) * font_size * 1.3) / 2.0;
    let text: String = lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            format!(
                "<text x=\"{}\" y=\"{}\" font-family=\"Helvetica, Arial, sans-serif\" font-size=\"{}\" fill=\"#ffffff\" text-anchor=\"middle\" dominant-baseline=\"middle\">{}</text>",
                num(w / 2.0),
                num(js_round(start_y + i as f64 * font_size * 1.3)),
                num(font_size),
                escape(line)
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\">\n  <defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">{stops}</linearGradient></defs>\n  <rect width=\"{w}\" height=\"{h}\" fill=\"url(#g)\"/>\n  <rect x=\"0\" y=\"0\" width=\"{w}\" height=\"{h}\" fill=\"#000000\" fill-opacity=\"0.22\"/>\n  {text}\n  <rect x=\"{x1}\" y=\"{y1}\" width=\"{bw}\" height=\"{bh}\" fill=\"#000000\" fill-opacity=\"0.55\"/>\n  <text x=\"{tx}\" y=\"{ty}\" font-family=\"Helvetica, Arial, sans-serif\" font-size=\"{fs}\" letter-spacing=\"2\" fill=\"#ffffff\" text-anchor=\"middle\" dominant-baseline=\"middle\">SYNTHETIC COMP</text>\n</svg>\n",
        w = num(w),
        h = num(h),
        stops = stops,
        text = text,
        x1 = num(w - js_round(w / 4.2)),
        y1 = num(h - js_round(h / 16.0)),
        bw = num(js_round(w / 4.2)),
        bh = num(js_round(h / 16.0)),
        tx = num(w - js_round(w / 8.4)),
        ty = num(h - js_round(h / 32.0)),
        fs = num(js_round(w / 60.0)),
    )
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffffffffu32;
    for b in data {
        c ^= *b as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    c ^ 0xffffffff
}

fn png_chunk(ty: &[u8], data: &[u8]) -> Vec<u8> {
    let mut body = ty.to_vec();
    body.extend_from_slice(data);
    let mut out = Vec::new();
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

fn png_fake(prompt: &str, w: usize, h: usize) -> Vec<u8> {
    png_fake_background(prompt, w, h, false)
}

fn png_fake_background(prompt: &str, w: usize, h: usize, transparent: bool) -> Vec<u8> {
    let colors = palette(prompt);
    let band_h = (h as f64 / colors.len() as f64).ceil() as usize;
    let channels = if transparent { 4 } else { 3 };
    let stride = w * channels;
    let mut raw = vec![0u8; h * (stride + 1)];
    for y in 0..h {
        let row = y * (stride + 1);
        raw[row] = 0;
        let idx = (colors.len() - 1).min(if band_h == 0 { 0 } else { y / band_h });
        let [r, g, b] = colors[idx];
        for x in 0..w {
            let p = row + 1 + x * channels;
            raw[p] = r;
            raw[p + 1] = g;
            raw[p + 2] = b;
            if transparent {
                raw[p + 3] = if x < w / 8 || x >= w - w / 8 || y < h / 8 || y >= h - h / 8 {
                    0
                } else {
                    255
                };
            }
        }
    }
    let mut ihdr = vec![0u8; 13];
    ihdr[..4].copy_from_slice(&(w as u32).to_be_bytes());
    ihdr[4..8].copy_from_slice(&(h as u32).to_be_bytes());
    ihdr[8] = 8;
    ihdr[9] = if transparent { 6 } else { 2 };
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(9));
    let _ = enc.write_all(&raw);
    let idat = enc.finish().unwrap_or_default();
    let mut text = b"Comment".to_vec();
    text.push(0);
    // latin1: chars > 0xff become their low byte in Node's 'latin1' encoding
    for c in format!("SYNTHETIC COMP: {}", collapse_ws(prompt)).encode_utf16() {
        text.push((c & 0xff) as u8);
    }
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    out.extend(png_chunk(b"IHDR", &ihdr));
    out.extend(png_chunk(b"tEXt", &text));
    out.extend(png_chunk(b"IDAT", &idat));
    out.extend(png_chunk(b"IEND", &[]));
    out
}

fn parse_size(s: &str) -> (usize, usize) {
    if let Some((a, b)) = s.split_once('x') {
        if !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit()) {
            return (a.parse().unwrap_or(1536), b.parse().unwrap_or(1024));
        }
    }
    (1536, 1024)
}

/// JS: inkOnGround(region). A region whose crop is dominated by one ground
/// color with a dark second: ink on ground.
fn ink_on_ground(region: &Value) -> bool {
    let pal = region.get("palette").and_then(Value::as_array).cloned().unwrap_or_default();
    if pal.len() < 2 {
        return false;
    }
    pal[0].get("coverage").and_then(Value::as_f64).map(|c| c >= 0.55).unwrap_or(false)
}

fn hex_rgb(hex: &str) -> [u8; 3] {
    let re = regex_hex();
    match re.captures(hex) {
        Some(caps) => [
            u8::from_str_radix(&caps[1], 16).unwrap_or(0),
            u8::from_str_radix(&caps[2], 16).unwrap_or(255),
            u8::from_str_radix(&caps[3], 16).unwrap_or(0),
        ],
        None => [0, 255, 0],
    }
}

fn regex_hex() -> &'static regex::Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"(?i)^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$").unwrap());
    &RE
}

/// JS: keyChroma(file, keyHex). Keys a flat color to alpha with a soft edge:
/// pixels within `hard` of the key go fully transparent, within `soft` fade,
/// and green spill on edge pixels is pulled toward the ink color. Writes back
/// in place; keeps existing tEXt chunks (the prompt embedded before keying).
/// Returns the keyed fraction.
fn key_chroma(path: &std::path::Path, key_hex: &str) -> Result<f64, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut decoded = png_io::decode_png(&bytes)?;
    let [kr, kg, kb] = hex_rgb(key_hex);
    let w = decoded.image.width;
    let h = decoded.image.height;
    // sample the actual key from the corners: generators shift the green
    let corners = [(2usize, 2usize), (w.saturating_sub(3), 2), (2, h.saturating_sub(3)), (w.saturating_sub(3), h.saturating_sub(3))];
    let mut sr = 0f64;
    let mut sg = 0f64;
    let mut sb = 0f64;
    for (x, y) in corners {
        let p = (y * w + x) * 4;
        sr += decoded.image.data[p] as f64;
        sg += decoded.image.data[p + 1] as f64;
        sb += decoded.image.data[p + 2] as f64;
    }
    let key = [sr / 4.0, sg / 4.0, sb / 4.0];
    let is_greenish = key[1] > 120.0 && key[1] > key[0] * 1.4 && key[1] > key[2] * 1.4;
    let k = if is_greenish { key } else { [kr as f64, kg as f64, kb as f64] };
    let (hard, soft) = (60f64, 120f64);
    let mut keyed = 0usize;
    let total_px = decoded.image.data.len() / 4;
    let mut i = 0;
    while i < decoded.image.data.len() {
        let (r, g, b) = (decoded.image.data[i] as f64, decoded.image.data[i + 1] as f64, decoded.image.data[i + 2] as f64);
        let d = ((r - k[0]).powi(2) + (g - k[1]).powi(2) + (b - k[2]).powi(2)).sqrt();
        let green_dom = g > 150.0 && g - r.max(b) > 60.0;
        if d < hard || green_dom {
            decoded.image.data[i + 3] = 0;
            keyed += 1;
        } else if d < soft {
            let a = (d - hard) / (soft - hard);
            decoded.image.data[i + 3] = js_round(decoded.image.data[i + 3] as f64 * a) as u8;
            let m = (r + b) / 2.0;
            decoded.image.data[i + 1] = js_round(g * a + m * (1.0 - a)) as u8;
        }
        i += 4;
    }
    let text: Vec<(String, String)> = decoded.text.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let bytes = png_io::encode_png(&decoded.image, &text)?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(keyed as f64 / total_px as f64)
}

/// The OpenAI images call shared by the plain prompt/out path and `--plate`:
/// generations with no refs, edits (multipart) with one or more. Returns the
/// decoded image bytes, or an (exit code, already-newline-terminated stderr
/// message) pair.
#[allow(clippy::too_many_arguments)]
fn call_openai_image(key: &str, prompt: &str, size: &str, quality: &str, refs: &[String], abs: &dyn Fn(&str) -> String, model: &str, background: Option<&str>, api_base: &str) -> Result<Vec<u8>, (i32, String)> {
    let agent = crate::http::agent_builder().build();
    let response = if !refs.is_empty() {
        let boundary = format!("----impeccable{:x}", crate::util::now_ms() as u64);
        let mut body: Vec<u8> = Vec::new();
        let mut field = |name: &str, value: &str| {
            body.extend_from_slice(format!("--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n", boundary, name, value).as_bytes());
        };
        field("model", model);
        field("prompt", prompt);
        field("size", size);
        field("quality", quality);
        field("n", "1");
        if let Some(background) = background {
            field("background", background);
            field("output_format", "png");
        }
        for r in refs {
            let bytes = std::fs::read(abs(r)).map_err(|e| (1, format!("Error: {}\n", node_read_error(r, &e))))?;
            let ty = if r.ends_with(".png") {
                "image/png"
            } else if r.ends_with(".webp") {
                "image/webp"
            } else {
                "image/jpeg"
            };
            let filename = r.rsplit('/').next().unwrap_or(r);
            body.extend_from_slice(
                format!("--{}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n", boundary, filename, ty).as_bytes(),
            );
            body.extend_from_slice(&bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());
        agent
            .post(&format!("{api_base}/images/edits"))
            .set("Authorization", &format!("Bearer {}", key))
            .set("Content-Type", &format!("multipart/form-data; boundary={}", boundary))
            .send_bytes(&body)
    } else {
        let mut m = Map::new();
        m.insert("model".into(), Value::String(model.to_string()));
        m.insert("prompt".into(), Value::String(prompt.to_string()));
        m.insert("size".into(), Value::String(size.to_string()));
        m.insert("quality".into(), Value::String(quality.to_string()));
        m.insert("n".into(), Value::from(1));
        if let Some(background) = background {
            m.insert("background".into(), Value::String(background.to_string()));
            m.insert("output_format".into(), Value::String("png".into()));
        }
        agent
            .post(&format!("{api_base}/images/generations"))
            .set("Authorization", &format!("Bearer {}", key))
            .set("content-type", "application/json")
            .send_string(&serde_json::to_string(&Value::Object(m)).unwrap())
    };
    let (status, text) = match response {
        Ok(r) => {
            let st = r.status();
            (st, r.into_string().unwrap_or_default())
        }
        Err(ureq::Error::Status(code, r)) => (code, r.into_string().unwrap_or_default()),
        Err(e) => return Err((1, format!("TypeError: fetch failed: {}\n", e))),
    };
    if !(200..300).contains(&status) {
        let snippet: String = text.chars().take(300).collect();
        return Err((1, format!("generate-image: API error {}: {}\n", status, snippet)));
    }
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let b64 = json.get("data").and_then(|d| d.get(0)).and_then(|d| d.get("b64_json")).and_then(|b| b.as_str()).filter(|s| !s.is_empty());
    let Some(b64) = b64 else {
        return Err((1, "generate-image: no image in response\n".to_string()));
    };
    Ok(base64_decode(b64))
}

pub fn run(args: &[String], io: &mut Io) -> i32 {
    run_with_api_base(args, io, "https://api.openai.com/v1")
}

fn run_with_api_base(args: &[String], io: &mut Io, api_base: &str) -> i32 {
    let background = arg(args, "background");
    if args.iter().any(|a| a == "--background") && !matches!(background.as_deref(), Some("transparent" | "opaque" | "auto")) {
        io.err("generate-image: --background must be transparent, opaque, or auto.\n");
        return 1;
    }
    let transparent = background.as_deref() == Some("transparent");
    if background.is_some() && arg(args, "out").is_some_and(|out| !out.to_ascii_lowercase().ends_with(".png")) {
        io.err("generate-image: --background requires a .png --out path.\n");
        return 1;
    }
    let cwd = io.cwd.to_string_lossy().into_owned();
    let env: Env = io.env.clone();
    let abs = |p: &str| jsp::resolve(&cwd, &[p]);
    let read_prompt_file = |io: &mut Io, pf: &str| -> Result<String, i32> {
        match std::fs::read(abs(pf)) {
            Ok(b) => Ok(String::from_utf8_lossy(&b).into_owned()),
            Err(e) => {
                io.err(&format!("Error: {}\n", node_read_error(pf, &e)));
                Err(1)
            }
        }
    };
    if let Some(plate_id) = arg(args, "plate") {
        return run_plate(args, io, &cwd, &env, &plate_id, api_base);
    }
    if env.get("IMPECCABLE_IMAGE_GEN_FAKE").map(|v| !v.is_empty()).unwrap_or(false) {
        let prompt = match arg(args, "prompt-file") {
            Some(pf) => match read_prompt_file(io, &pf) {
                Ok(p) => Some(p),
                Err(c) => return c,
            },
            None => arg(args, "prompt"),
        };
        let out = arg(args, "out");
        let (Some(prompt), Some(out)) = (prompt.filter(|p| !p.is_empty()), out) else {
            io.err("generate-image: --prompt (or --prompt-file) and --out are required.\n");
            return 1;
        };
        let (w, h) = parse_size(&arg(args, "size").unwrap_or_else(|| "1536x1024".into()));
        let bytes = if out.ends_with(".svg") {
            svg_fake(&prompt, w as f64, h as f64).into_bytes()
        } else if transparent {
            png_fake_background(&prompt, w, h, true)
        } else {
            png_fake(&prompt, w, h)
        };
        if let Err(e) = std::fs::write(abs(&out), bytes) {
            io.err(&format!("Error: {}\n", node_read_error(&out, &e)));
            return 1;
        }
        io.out(&format!("IMAGE: {} ({}x{}, fake synthetic comp, $0.00, no API call)\n", out, w, h));
        return 0;
    }
    let Some(key) = env.get("OPENAI_API_KEY").filter(|k| !k.is_empty()).cloned() else {
        io.err("generate-image: OPENAI_API_KEY is not set; use the harness-native image tool instead.\n");
        return 1;
    };
    let prompt = match arg(args, "prompt-file") {
        Some(pf) => match read_prompt_file(io, &pf) {
            Ok(p) => Some(p),
            Err(c) => return c,
        },
        None => arg(args, "prompt"),
    };
    let out = arg(args, "out");
    let (Some(prompt), Some(out)) = (prompt.filter(|p| !p.is_empty()), out) else {
        io.err("generate-image: --prompt (or --prompt-file) and --out are required.\n");
        return 1;
    };
    let size = arg(args, "size").unwrap_or_else(|| "1536x1024".into());
    let quality = arg(args, "quality").unwrap_or_else(|| "medium".into());
    let model = arg(args, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
    let mut refs: Vec<String> = Vec::new();
    for i in 0..args.len() {
        if args[i] == "--ref" {
            if let Some(n) = args.get(i + 1) {
                if !n.is_empty() && !n.starts_with("--") {
                    refs.push(n.clone());
                }
            }
        }
    }
    let bytes = match call_openai_image(&key, &prompt, &size, &quality, &refs, &abs, &model, background.as_deref(), api_base) {
        Ok(b) => b,
        Err((code, msg)) => {
            io.err(&msg);
            return code;
        }
    };
    let _ = std::fs::write(abs(&out), bytes);
    // best-effort embed + sidecar
    // JS-PARITY: generate-image.mjs#676 reports whether the embed actually
    // succeeded. The install-path-with-spaces half of #676 is a JS-only
    // subprocess concern (fileURLToPath vs URL.pathname); the engine embeds
    // in-process, so only the success tracking and message carry over here.
    let embedded;
    {
        let mut sub_io = Io::captured("", io.cwd.clone(), io.env.clone()).0;
        let ret = crate::embed_prompt::run(&[out.clone(), "--prompt".to_string(), prompt.clone()], &mut sub_io);
        embedded = ret == 0;
        if !embedded {
            io.err("generate-image: failed to embed prompt in the image\n");
        }
        let mut m = Map::new();
        m.insert("prompt".into(), Value::String(prompt.clone()));
        m.insert("createdAt".into(), Value::String(iso_now()));
        m.insert("tool".into(), Value::String("impeccable generate-image".into()));
        m.insert("model".into(), Value::String(model.clone()));
        if let Some(background) = &background {
            m.insert("background".into(), Value::String(background.clone()));
            m.insert("outputFormat".into(), Value::String("png".into()));
        }
        if !refs.is_empty() {
            m.insert("refs".into(), Value::Array(refs.iter().cloned().map(Value::String).collect()));
        }
        let _ = std::fs::write(abs(&format!("{}.json", out)), json_pretty(&Value::Object(m)));
    }
    io.out(&format!(
        "IMAGE: {} ({}, {}, {}, billed to your OpenAI key); {} at {}.json\n",
        out,
        size,
        quality,
        model,
        if embedded { "prompt embedded + sidecar" } else { "sidecar" },
        out
    ));
    0
}

/// `impeccable generate-image --plate <region-id>`: one raster region of a
/// measured comp spec, end to end.
fn run_plate(args: &[String], io: &mut Io, cwd: &str, env: &Env, plate_id: &str, api_base: &str) -> i32 {
    let abs = |p: &str| jsp::resolve(cwd, &[p]);
    let model = arg(args, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
    let background = arg(args, "background");
    let spec_path = arg(args, "spec").unwrap_or_else(|| comp_spec::SPEC_PATH.to_string());
    let Some(spec) = comp_spec::load_spec(std::path::Path::new(&abs(&spec_path))) else {
        io.err(&format!("generate-image: no spec at {spec_path}; run impeccable comp-spec first\n"));
        return 1;
    };
    let regions = build_phase::spec_regions(&spec);
    let Some(region) = regions.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(plate_id)).cloned() else {
        let ids = regions.iter().filter_map(|r| r.get("id").and_then(Value::as_str)).collect::<Vec<_>>().join(", ");
        io.err(&format!("generate-image: no region {plate_id} in {spec_path}; ids: {ids}\n"));
        return 1;
    };
    // Parse --min before anything with a side effect. `parse().ok()` silently
    // dropped a typo, so `--min 0.8x` ran with no threshold at all and exited
    // 0; "NaN" and "inf" parse fine in Rust, and `score < NaN` is false, so
    // those passed the gate too. A threshold the user asked for and did not
    // get is the one failure this option must never have.
    // Read --min's value directly rather than through `arg`, which reports an
    // empty or flag-shaped value as absent. That is the right default for the
    // other options here (no --out falls back to the spec's plate path, which
    // the user sees), but --min's only job is a threshold, and the one failure
    // it must never have is being asked for and silently not applied. So a
    // present --min with no usable value is an error, not a default.
    let min = match args.iter().position(|a| a == "--min") {
        Some(i) => {
            let raw = args.get(i + 1).map(String::as_str).unwrap_or("");
            // `parse().ok()` dropped a typo, so `--min 0.8x` ran with no
            // threshold and exited 0; "NaN" and "inf" parse fine in Rust, and
            // `score < NaN` is false, so those cleared the gate as well.
            match raw.parse::<f64>() {
                Ok(v) if v.is_finite() => Some(v),
                _ => {
                    io.err(&format!("generate-image: --min {raw} is not a finite number\n"));
                    return 1;
                }
            }
        }
        None => None,
    };
    let medium = region.get("medium").and_then(Value::as_str).unwrap_or("");
    if medium != "raster" {
        io.err(&format!("generate-image: region {plate_id} is {medium}, not a plate; set its kind to plate|image|texture in the regions file\n"));
        return 1;
    }
    let comp_path = spec.get("comp").and_then(Value::as_str).unwrap_or("").to_string();
    let comp = match build_phase::load_raster(io, &comp_path) {
        Ok(c) => c,
        Err(e) => {
            io.err(&format!("generate-image: cannot read comp {comp_path}: {e}\n"));
            return 1;
        }
    };
    let refimg = comp_spec::plate_reference(&comp, &spec, &region);
    let spec_dir = std::path::Path::new(&spec_path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let ref_path = jsp::join(&[&spec_dir, "crops", &format!("{plate_id}.png")]);
    if let Some(parent) = std::path::Path::new(&abs(&ref_path)).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let crop_text = vec![("impeccable:crop-of".to_string(), format!("{comp_path}#{plate_id}"))];
    match png_io::encode_png(&refimg, &crop_text) {
        Ok(bytes) => {
            let _ = std::fs::write(abs(&ref_path), bytes);
        }
        Err(e) => {
            io.err(&format!("generate-image: {e}\n"));
            return 1;
        }
    }
    let out = match arg(args, "out")
        .or_else(|| region.get("plate").and_then(Value::as_str).map(String::from))
        .filter(|p| !p.is_empty())
    {
        Some(p) => p,
        None => {
            io.err(&format!(
                "generate-image: region {plate_id} has no \"plate\" path in {spec_path}; re-run comp-spec --regions or pass --out <path>\n"
            ));
            return 1;
        }
    };
    if let Some(parent) = std::path::Path::new(&abs(&out)).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Closest supported size to the region's aspect; the page crops the rest
    // with object-fit. The plates gate demands >= 1.5x the region's width
    // (capped at 1536), so a square region wider than 682px cannot ship from
    // 1024x1024: take the 1536-wide landscape frame instead and let cover crop.
    let px_w = region.pointer("/px/w").and_then(Value::as_f64).unwrap_or(0.0);
    let px_h = region.pointer("/px/h").and_then(Value::as_f64).unwrap_or(1.0);
    let aspect = px_w / px_h;
    let need_w = 1536f64.min((px_w * 1.5).ceil());
    let size = arg(args, "size").unwrap_or_else(|| {
        if aspect > 1.2 {
            "1536x1024".to_string()
        } else if aspect < 0.83 {
            if need_w > 1024.0 { "1536x1024".to_string() } else { "1024x1536".to_string() }
        } else if need_w > 1024.0 {
            "1536x1024".to_string()
        } else {
            "1024x1024".to_string()
        }
    });

    let extra = match arg(args, "prompt") {
        Some(p) => p,
        None => match arg(args, "prompt-file") {
            Some(pf) => match std::fs::read(abs(&pf)) {
                Ok(b) => String::from_utf8_lossy(&b).into_owned(),
                Err(e) => {
                    io.err(&format!("Error: {}\n", node_read_error(&pf, &e)));
                    return 1;
                }
            },
            None => String::new(),
        },
    };
    // Chroma: an ink-on-ground plate (a line drawing, a figure on flat
    // ground) is generated on a flat key color and keyed to alpha, so the
    // page's own ground shows through instead of a second, mismatched paper.
    // Default on for kind plate when the comp region reads as ink over one
    // flat ground; --chroma / --no-chroma force it.
    let wants_chroma = if background.is_some() {
        false
    } else if args.iter().any(|a| a == "--chroma") {
        true
    } else if args.iter().any(|a| a == "--no-chroma") {
        false
    } else {
        region.get("kind").and_then(Value::as_str) == Some("plate") && ink_on_ground(&region)
    };
    let chroma_color = "#00ff00";
    let chroma_line = if wants_chroma {
        format!(
            " Render the artwork on a perfectly flat, uniform bright green background ({chroma_color}) that fills every pixel not covered by the artwork; no paper texture, no vignette, no shadow on the green; the green will be removed and the artwork composited onto the page's own surface."
        )
    } else {
        String::new()
    };
    let prompt = [comp_spec::plate_prompt_background(&spec, &region, background.as_deref() == Some("transparent")), extra, chroma_line]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    // Score a plate that already exists, without generating one. The
    // harness's own image tool produces the plate on the native branch, and
    // this needs the same verdict `impeccable build-phase advance` will
    // reach. Placed above the API-key check on purpose: the native branch is
    // exactly the case with no key.
    if args.iter().any(|a| a == "--score-only") {
        if !std::path::Path::new(&abs(&out)).exists() {
            io.err(&format!("generate-image: no plate at {out} to score; produce it first, then run --score-only\n"));
            return 1;
        }
        return report_plate_score(io, &spec, &comp, &region, &out, &ref_path, min);
    }

    if env.get("IMPECCABLE_IMAGE_GEN_FAKE").map(|v| !v.is_empty()).unwrap_or(false) {
        let up = impeccable_comp::raster::resize(&refimg, refimg.width as f64 * 2.0, refimg.height as f64 * 2.0);
        let text = vec![("impeccable:prompt".to_string(), prompt.clone()), ("impeccable:fake".to_string(), "1".to_string())];
        match png_io::encode_png(&up, &text) {
            Ok(bytes) => {
                // Same handling as the real path's write below: a discarded
                // error here let fake mode print PLATE: and exit 0 with no
                // plate on disk (--out naming a directory, an unwritable
                // path), so fake-mode validation reported a false success.
                if let Err(e) = std::fs::write(abs(&out), bytes) {
                    io.err(&format!("Error: {}\n", node_read_error(&out, &e)));
                    return 1;
                }
            }
            Err(e) => {
                io.err(&format!("generate-image: {e}\n"));
                return 1;
            }
        }
        let mut m = Map::new();
        m.insert("prompt".into(), Value::String(prompt.clone()));
        m.insert("createdAt".into(), Value::String(iso_now()));
        m.insert("tool".into(), Value::String("impeccable generate-image".into()));
        m.insert("model".into(), Value::String("fake".into()));
        m.insert("plate".into(), Value::String(plate_id.to_string()));
        m.insert("refs".into(), Value::Array(vec![Value::String(ref_path.clone())]));
        let _ = std::fs::write(abs(&format!("{out}.json")), json_pretty(&Value::Object(m)));
        io.out(&format!("PLATE: {out} ({}x{}, fake 2x crop of region {plate_id}, $0.00, no API call)\n", up.width, up.height));
        // Fall through to the shared gate, as the real path does and as the
        // CLI contract already specified. Returning here emitted no
        // PLATE-SCORE and ignored --min, so fake mode could not stand in for
        // a real one in validation.
        return report_plate_score(io, &spec, &comp, &region, &out, &ref_path, min);
    }

    let Some(key) = env.get("OPENAI_API_KEY").filter(|k| !k.is_empty()).cloned() else {
        io.err("generate-image: OPENAI_API_KEY is not set; use the harness-native image tool instead.\n");
        return 1;
    };
    let quality = arg(args, "quality").unwrap_or_else(|| "high".to_string());
    let mut refs: Vec<String> = vec![ref_path.clone()];
    for i in 0..args.len() {
        if args[i] == "--ref" {
            if let Some(n) = args.get(i + 1) {
                if !n.is_empty() && !n.starts_with("--") {
                    refs.push(n.clone());
                }
            }
        }
    }
    let bytes = match call_openai_image(&key, &prompt, &size, &quality, &refs, &abs, &model, background.as_deref(), api_base) {
        Ok(b) => b,
        Err((code, msg)) => {
            io.err(&msg);
            return code;
        }
    };
    if let Err(e) = std::fs::write(abs(&out), &bytes) {
        io.err(&format!("Error: {}\n", node_read_error(&out, &e)));
        return 1;
    }
    let embedded;
    {
        let mut sub_io = Io::captured("", io.cwd.clone(), io.env.clone()).0;
        let ret = crate::embed_prompt::run(&[out.clone(), "--prompt".to_string(), prompt.clone()], &mut sub_io);
        embedded = ret == 0;
        if !embedded {
            io.err("generate-image: failed to embed prompt in the image\n");
        }
        let mut m = Map::new();
        m.insert("prompt".into(), Value::String(prompt.clone()));
        m.insert("createdAt".into(), Value::String(iso_now()));
        m.insert("tool".into(), Value::String("impeccable generate-image".into()));
        m.insert("model".into(), Value::String(model.to_string()));
        if let Some(background) = &background {
            m.insert("background".into(), Value::String(background.clone()));
            m.insert("outputFormat".into(), Value::String("png".into()));
        }
        m.insert("refs".into(), Value::Array(refs.iter().cloned().map(Value::String).collect()));
        let _ = std::fs::write(abs(&format!("{out}.json")), json_pretty(&Value::Object(m)));
    }
    io.out(&format!(
        "IMAGE: {out} ({size}, {quality}, {model}, billed to your OpenAI key); {} at {out}.json\n",
        if embedded { "prompt embedded + sidecar" } else { "sidecar" }
    ));

    if wants_chroma {
        match key_chroma(std::path::Path::new(&abs(&out)), chroma_color) {
            Ok(frac) => io.out(&format!(
                "PLATE-CHROMA keyed {:.0}% of pixels to alpha ({chroma_color}); place with a plain <img> over the page's own ground, no background on the plate. If the keyed fraction is under 20% the generator ignored the key: regenerate with --no-chroma and use mix-blend-mode: multiply instead.\n",
                frac * 100.0
            )),
            Err(e) => io.err(&format!("generate-image: chroma key failed: {e}\n")),
        }
    }

    report_plate_score(io, &spec, &comp, &region, &out, &ref_path, min)
}

/// Prints the same `PLATE-SCORE` / `PLATE-WARN` / `PLATE-REJECTED` lines for
/// a plate scored via [`build_phase::gate_one_plate`], whether the plate was
/// just generated here or already sat on disk from `--score-only`. Exit
/// codes: 0 clean, 1 no usable score, 2 fails the plates gate, 3 below
/// `--min`.
fn report_plate_score(io: &mut Io, spec: &Value, comp: &Image, region: &Value, out: &str, ref_path: &str, min: Option<f64>) -> i32 {
    let region_id = region.get("id").and_then(Value::as_str).unwrap_or("");
    let gate = build_phase::gate_one_plate(io, spec, Some(comp), region, Some(out));
    if let Some(score) = &gate.score {
        io.out(&format!(
            "PLATE-SCORE {region_id} {:.0}% against the comp region (structure {:.0}%, color {:.0}%, detail {:.0}%)\n",
            score.overall * 100.0,
            score.structure * 100.0,
            score.color * 100.0,
            score.detail * 100.0
        ));
    }
    for reason in &gate.reasons {
        io.out(&format!("PLATE-WARN {reason}\n"));
    }
    let Some(score) = &gate.score else {
        io.err(&format!("generate-image: no score for {out}; the plates gate refuses it as it stands.\n"));
        return 1;
    };
    if let Some(min_val) = min {
        if score.overall < min_val {
            io.out(&format!("PLATE-REJECTED below --min {:.0}%\n", min_val * 100.0));
            return 3;
        }
    }
    if !gate.reasons.is_empty() {
        io.err(&format!("generate-image: {out} does not pass the plates gate; open it beside {ref_path} and regenerate before building on it.\n"));
        return 2;
    }
    0
}

fn base64_decode(s: &str) -> Vec<u8> {
    let table = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in s.bytes() {
        let Some(v) = table(b) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn round_trip(edit: bool, override_model: Option<&str>, background: Option<&str>) {
        round_trip_impl(edit, override_model, background, false);
    }

    #[test]
    fn plate_edit_preserves_model_native_alpha_and_provenance() {
        round_trip_impl(true, Some("gpt-image-2.5-sunburst"), Some("transparent"), true);
    }

    fn round_trip_impl(edit: bool, override_model: Option<&str>, background: Option<&str>, plate: bool) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let api_base = format!("http://{}", server.server_addr());
        let temp = std::env::temp_dir().join(format!("impeccable-image-{}-{}", std::process::id(), server.server_addr().to_ip().unwrap().port()));
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("ref.png"), png_fake("reference", 16, 16)).unwrap();
        let handle = std::thread::spawn(move || {
            let mut request = server.recv_timeout(Duration::from_secs(10)).unwrap().expect("image request");
            let path = request.url().to_string();
            let content_type = request.headers().iter().find(|h| h.field.equiv("Content-Type")).unwrap().value.to_string();
            let mut body = String::new();
            // Multipart carries binary PNG bytes; preserve ASCII fields for inspection.
            let mut bytes = Vec::new();
            request.as_reader().read_to_end(&mut bytes).unwrap();
            body.push_str(&String::from_utf8_lossy(&bytes));
            request.respond(tiny_http::Response::from_string(r#"{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGklEQVR4nGP4////f7mAigYGBgaG/////wMAUdQJXhk2RAEAAAAASUVORK5CYII="}]}"#)).unwrap();
            (path, content_type, body)
        });
        let env = Env::from([("OPENAI_API_KEY".into(), "test-key".into())]);
        let (mut io, captured) = Io::captured("", temp.clone(), env);
        let mut args: Vec<String> = ["--prompt", "Comp regression", "--out", "comp.png", "--quality", "high"].iter().map(|s| s.to_string()).collect();
        if edit {
            args.extend(["--ref".into(), "ref.png".into()]);
        }
        if let Some(model) = override_model {
            args.extend(["--model".into(), model.into()]);
        }
        if let Some(background) = background {
            args.extend(["--background".into(), background.into()]);
        }
        if plate {
            let spec = serde_json::json!({"comp": "ref.png", "regions": [{
                "id": "art", "kind": "plate", "medium": "raster", "plate": "comp.png",
                "px": {"x": 0, "y": 0, "w": 16, "h": 16},
                "palette": [{"hex": "#ffffff", "coverage": 0.8}, {"hex": "#000000", "coverage": 0.2}]
            }]});
            std::fs::write(temp.join("spec.json"), serde_json::to_vec(&spec).unwrap()).unwrap();
            args.extend(["--plate".into(), "art".into(), "--spec".into(), "spec.json".into()]);
        }
        let exit = run_with_api_base(&args, &mut io, &api_base);
        let (path, content_type, body) = handle.join().unwrap();
        let sidecar: Value = serde_json::from_slice(&std::fs::read(temp.join("comp.png.json")).unwrap()).unwrap();
        let image = std::fs::read(temp.join("comp.png")).unwrap();
        std::fs::remove_dir_all(&temp).unwrap();
        assert_eq!(exit, if plate { 2 } else { 0 }); // The mock plate is below the size floor.
        let model = override_model.unwrap_or("gpt-image-2.5-flare");
        if edit {
            assert_eq!(path, "/images/edits");
            assert!(content_type.starts_with("multipart/form-data; boundary="));
            assert!(body.contains(&format!("name=\"model\"\r\n\r\n{model}\r\n")));
            assert!(body.contains("name=\"image[]\"; filename=\"ref.png\""));
            if plate {
                assert_eq!(sidecar["refs"], serde_json::json!(["crops/art.png", "ref.png"]));
            } else {
                assert_eq!(sidecar["refs"], serde_json::json!(["ref.png"]));
            }
            if let Some(background) = background {
                assert!(body.contains(&format!("name=\"background\"\r\n\r\n{background}\r\n")));
                assert!(body.contains("name=\"output_format\"\r\n\r\npng\r\n"));
            } else {
                assert!(!body.contains("name=\"background\""));
            }
        } else {
            assert_eq!(path, "/images/generations");
            assert_eq!(content_type, "application/json");
            let body: Value = serde_json::from_str(&body).unwrap();
            let mut expected = serde_json::json!({"model": model, "prompt": "Comp regression", "size": "1536x1024", "quality": "high", "n": 1});
            if let Some(background) = background {
                expected["background"] = background.into();
                expected["output_format"] = "png".into();
            }
            assert_eq!(body, expected);
        }
        if let Some(background) = background {
            assert_eq!(sidecar["background"], background);
            assert_eq!(sidecar["outputFormat"], "png");
        } else {
            assert!(sidecar.get("background").is_none());
        }
        // The server's PNG contains clear, partial, near-opaque and opaque pixels.
        // Embedding may add metadata before IEND, but must preserve all image chunks.
        let original = base64_decode("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGklEQVR4nGP4////f7mAigYGBgaG/////wMAUdQJXhk2RAEAAAAASUVORK5CYII=");
        assert!(image.starts_with(&original[..original.len() - 12]));
        assert_eq!(sidecar["model"], model);
        if plate {
            assert!(sidecar["prompt"].as_str().unwrap().contains("transparent PNG cutout"));
        } else {
            assert_eq!(sidecar["prompt"], "Comp regression");
        }
        assert!(image.starts_with(b"\x89PNG\r\n\x1a\n"));
        let stdout = String::from_utf8(captured.stdout.borrow().clone()).unwrap();
        assert!(stdout.contains(&format!("{model}, billed to your OpenAI key")));
        assert!(stdout.contains("prompt embedded + sidecar"));
    }

    #[test]
    fn generation_uses_image_25_and_records_model() {
        round_trip(false, None, None);
    }

    #[test]
    fn reference_edit_uses_image_25_and_records_model() {
        round_trip(true, None, None);
    }

    #[test]
    fn generation_accepts_model_override() {
        round_trip(false, Some("gpt-image-2"), None);
    }

    #[test]
    fn reference_edit_accepts_sunburst_override() {
        round_trip(true, Some("gpt-image-2.5-sunburst"), None);
    }

    #[test]
    fn transparent_generation_preserves_alpha_and_provenance() {
        round_trip(false, None, Some("transparent"));
    }

    #[test]
    fn transparent_edit_preserves_alpha_and_provenance() {
        round_trip(true, Some("gpt-image-2.5-sunburst"), Some("transparent"));
    }

    #[test]
    fn opaque_background_is_explicit() {
        round_trip(false, None, Some("opaque"));
    }

    #[test]
    fn fake_cutout_has_real_alpha_and_default_fake_stays_rgb() {
        use std::io::Read;
        let png = png_fake_background("cutout", 16, 16, true);
        assert_eq!(png[25], 6); // RGBA
        assert_eq!(png_fake("comp", 16, 16)[25], 2); // RGB, legacy fake output
        let mut offset = 8;
        let mut raw = Vec::new();
        while offset + 12 <= png.len() {
            let size = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
            if &png[offset + 4..offset + 8] == b"IDAT" {
                flate2::read::ZlibDecoder::new(&png[offset + 8..offset + 8 + size])
                    .read_to_end(&mut raw)
                    .unwrap();
            }
            offset += size + 12;
        }
        assert_eq!(raw[4], 0); // transparent corner
        assert_eq!(raw[8 * (16 * 4 + 1) + 1 + 8 * 4 + 3], 255); // opaque subject
    }

    #[test]
    fn invalid_background_requests_fail_before_network_or_output() {
        for flags in [
            vec!["--background"],
            vec!["--background", "white"],
            vec!["--background", "transparent", "--out", "cutout.jpg"],
            vec!["--background", "opaque", "--out", "hero.webp"],
            vec!["--background", "auto", "--out", "hero.svg"],
        ] {
            let (mut io, captured) = Io::captured("", std::env::temp_dir(), Env::new());
            let args = flags.iter().map(|s| s.to_string()).collect::<Vec<_>>();
            assert_eq!(run(&args, &mut io), 1);
            let stderr = String::from_utf8(captured.stderr.borrow().clone()).unwrap();
            assert!(stderr.contains("--background"), "{stderr}");
            assert!(!stderr.contains("OPENAI_API_KEY"));
        }
    }
}

#[cfg(test)]
mod plate_tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    static TMP_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn tmp() -> String {
        let base = std::env::temp_dir().join(format!(
            "impeccable-generate-image-plate-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let real = std::fs::canonicalize(&base).unwrap().to_string_lossy().into_owned();
        real.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(real)
    }

    fn fake_env() -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("IMPECCABLE_IMAGE_GEN_FAKE".to_string(), "1".to_string());
        env
    }

    fn run_capture(cwd: &str, env: HashMap<String, String>, args: &[&str]) -> (i32, String, String) {
        let (mut io, cap) = Io::captured("", PathBuf::from(cwd), env);
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let code = run(&owned, &mut io);
        let out = String::from_utf8_lossy(&cap.stdout.borrow()).into_owned();
        let err = String::from_utf8_lossy(&cap.stderr.borrow()).into_owned();
        (code, out, err)
    }

    /// Sets up a comp + measured spec with one raster ("plate") region and
    /// one text region, in fake mode (no network, no key). Returns the cwd.
    fn setup_spec_with_regions() -> String {
        let cwd = tmp();
        let (code, _, err) = run_capture(&cwd, fake_env(), &["--prompt", "a test comp", "--out", "comp.png", "--size", "600x400"]);
        assert_eq!(code, 0, "comp generation failed: {err}");
        let regions = r#"{ "regions": [
            { "id": "hero-art", "kind": "plate", "grid": "A0:E4", "note": "a decorative illustration" },
            { "id": "headline", "kind": "text", "grid": "F0:J1", "note": "the page headline" }
        ] }"#;
        std::fs::write(std::path::Path::new(&cwd).join("regions.json"), regions).unwrap();
        let (mut io, _) = Io::captured("", PathBuf::from(&cwd), HashMap::new());
        let code = comp_spec::run(
            &["--comp", "comp.png", "--regions", "regions.json", "--spec", comp_spec::SPEC_PATH]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>(),
            &mut io,
        );
        assert_eq!(code, 0, "comp-spec measure failed");
        cwd
    }

    #[test]
    fn plate_mode_produces_a_scored_plate_in_fake_mode() {
        let cwd = setup_spec_with_regions();
        let (code, out, err) = run_capture(&cwd, fake_env(), &["--plate", "hero-art"]);
        assert_eq!(code, 0, "stderr: {err}");
        assert!(out.starts_with("PLATE: "), "unexpected stdout: {out}");
        // The name of this test is the contract: fake mode runs the same
        // plate gate the real path does, so it scores and honors --min
        // rather than reporting a bare PLATE: and exiting.
        assert!(out.contains("PLATE-SCORE hero-art"), "unexpected stdout: {out}");
        assert!(std::path::Path::new(&cwd).join("assets/plates/hero-art.png").exists());
        assert!(std::path::Path::new(&cwd).join(".impeccable/build/crops/hero-art.png").exists());
    }

    #[test]
    fn score_only_reports_a_score_with_no_api_key() {
        let cwd = setup_spec_with_regions();
        let (code, _, err) = run_capture(&cwd, fake_env(), &["--plate", "hero-art"]);
        assert_eq!(code, 0, "stderr: {err}");
        // No OPENAI_API_KEY and no IMPECCABLE_IMAGE_GEN_FAKE in the env below:
        // --score-only must not need either.
        let (code, out, _) = run_capture(&cwd, HashMap::new(), &["--plate", "hero-art", "--score-only"]);
        assert_eq!(code, 0);
        assert!(out.contains("PLATE-SCORE hero-art"), "stdout: {out}");
    }

    #[test]
    fn invalid_min_is_refused_rather_than_ignored() {
        let cwd = setup_spec_with_regions();
        for bad in ["0.8x", "NaN", "inf", ""] {
            let (code, out, err) =
                run_capture(&cwd, fake_env(), &["--plate", "hero-art", "--min", bad]);
            assert_eq!(code, 1, "--min {bad} should be refused; stdout: {out}");
            assert!(err.contains("is not a finite number"), "--min {bad} stderr: {err}");
        }
        // A threshold above 1 is a legitimate comparison, not a percentage
        // bound, and stays accepted.
        let (code, out, _) =
            run_capture(&cwd, fake_env(), &["--plate", "hero-art", "--min", "1.1"]);
        assert_eq!(code, 3, "stdout: {out}");
    }

    #[test]
    fn score_only_rejects_below_min() {
        let cwd = setup_spec_with_regions();
        let (code, _, err) = run_capture(&cwd, fake_env(), &["--plate", "hero-art"]);
        assert_eq!(code, 0, "stderr: {err}");
        let (code, out, _) = run_capture(&cwd, HashMap::new(), &["--plate", "hero-art", "--score-only", "--min", "1.1"]);
        assert_eq!(code, 3);
        assert!(out.contains("PLATE-REJECTED"), "stdout: {out}");
    }

    #[test]
    fn score_only_without_a_plate_on_disk_fails_loudly() {
        let cwd = setup_spec_with_regions();
        let (code, _, err) = run_capture(&cwd, HashMap::new(), &["--plate", "hero-art", "--score-only"]);
        assert_eq!(code, 1);
        assert!(err.contains("no plate at"), "stderr: {err}");
    }

    #[test]
    fn unknown_region_is_refused() {
        let cwd = setup_spec_with_regions();
        let (code, _, err) = run_capture(&cwd, HashMap::new(), &["--plate", "nope"]);
        assert_eq!(code, 1);
        assert!(err.contains("no region nope"), "stderr: {err}");
    }

    #[test]
    fn non_raster_region_is_refused() {
        let cwd = setup_spec_with_regions();
        let (code, _, err) = run_capture(&cwd, HashMap::new(), &["--plate", "headline"]);
        assert_eq!(code, 1);
        assert!(err.contains("not a plate"), "stderr: {err}");
    }

    #[test]
    fn empty_explicit_plate_path_is_refused_before_generation() {
        // comp-spec defaults an *omitted* plate field, but passes an
        // *explicit* empty string through unchanged. Generation must not
        // then resolve `out` to the project directory and attempt to write
        // a directory as the plate file.
        let cwd = tmp();
        let (code, _, err) = run_capture(&cwd, fake_env(), &["--prompt", "a test comp", "--out", "comp.png", "--size", "600x400"]);
        assert_eq!(code, 0, "comp generation failed: {err}");
        let regions = r#"{ "regions": [
            { "id": "hero-art", "kind": "plate", "grid": "A0:E4", "note": "a decorative illustration", "plate": "" }
        ] }"#;
        std::fs::write(std::path::Path::new(&cwd).join("regions.json"), regions).unwrap();
        let (mut io, _) = Io::captured("", PathBuf::from(&cwd), HashMap::new());
        let code = comp_spec::run(
            &["--comp", "comp.png", "--regions", "regions.json", "--spec", comp_spec::SPEC_PATH]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>(),
            &mut io,
        );
        assert_eq!(code, 0, "comp-spec measure failed");

        let (code, _, err) = run_capture(&cwd, fake_env(), &["--plate", "hero-art"]);
        assert_eq!(code, 1);
        assert!(err.contains("no \"plate\" path"), "stderr: {err}");
    }

    #[test]
    fn ink_on_ground_reads_dominant_coverage() {
        let region = serde_json::json!({ "palette": [{ "hex": "#fff", "coverage": 0.6 }, { "hex": "#000", "coverage": 0.4 }] });
        assert!(ink_on_ground(&region));
        let region = serde_json::json!({ "palette": [{ "hex": "#fff", "coverage": 0.5 }, { "hex": "#000", "coverage": 0.5 }] });
        assert!(!ink_on_ground(&region));
        assert!(!ink_on_ground(&serde_json::json!({})));
    }
}

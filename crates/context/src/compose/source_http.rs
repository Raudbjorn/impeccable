//! Public-web source capture. DNS validation is part of the transport, not a preflight.
use super::state::{Result, MAX_BYTES};
use std::{
    io::Read,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    time::{Duration, Instant},
};
use url::{Host, Url};

fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public(IpAddr::V4(v4));
            }
            let s = ip.segments();
            // Only global unicast; exclude special-purpose, documentation and 6to4 ranges.
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
pub fn validate_url(text: &str) -> Result<Url> {
    let url = Url::parse(text).map_err(|_| "Invalid source URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Source URL must use HTTP(S) without credentials".into());
    }
    match url.host().ok_or("Source URL needs a host")? {
        Host::Ipv4(ip) if !public(ip.into()) => {
            return Err("Source URL address is not public".into())
        }
        Host::Ipv6(ip) if !public(ip.into()) => {
            return Err("Source URL address is not public".into())
        }
        Host::Domain(name) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if !name.contains('.')
                || name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
            {
                return Err("Source URL host is not public".into());
            }
        }
        _ => {}
    }
    Ok(url)
}
fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .ok_or("Source request timed out".into())
}
fn resolve(url: &Url, deadline: Instant) -> Result<Vec<SocketAddr>> {
    let host = url
        .host_str()
        .ok_or("Missing host")?
        .trim_matches(['[', ']'])
        .to_string();
    let port = url.port_or_known_default().ok_or("Missing port")?;
    let (tx, rx) = std::sync::mpsc::channel();
    // System DNS cannot be cancelled; never let it hold up the caller beyond the request deadline.
    std::thread::spawn(move || {
        let _ = tx.send((host.as_str(), port).to_socket_addrs().map(|a| a.collect()));
    });
    rx.recv_timeout(remaining(deadline)?)
        .map_err(|_| "DNS resolution timed out")?
        .map_err(|e| format!("Source DNS failed: {e}"))
}
struct Response {
    status: u16,
    location: Option<String>,
    bytes: Vec<u8>,
}
fn request(url: &Url, addresses: &[SocketAddr], deadline: Instant) -> Result<Response> {
    let addresses = addresses.to_vec();
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout(remaining(deadline)?)
        .resolver(move |_: &str| Ok(addresses.clone()))
        .build();
    let response = match agent
        .get(url.as_str())
        .set("Accept-Encoding", "identity")
        .call()
    {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("Source request failed: {e}")),
    };
    let status = response.status();
    let location = response.header("Location").map(str::to_owned);
    if (300..400).contains(&status) {
        return Ok(Response {
            status,
            location,
            bytes: vec![],
        });
    }
    if !(200..300).contains(&status) {
        return Err(format!("Source HTTP status {status}"));
    }
    let encoding = response
        .header("Content-Encoding")
        .unwrap_or("identity")
        .to_ascii_lowercase();
    let bytes = read_body(response.into_reader(), &encoding)?;
    remaining(deadline)?;
    Ok(Response {
        status,
        location,
        bytes,
    })
}
fn read_body(body: impl Read + 'static, encoding: &str) -> Result<Vec<u8>> {
    let wire = body.take(MAX_BYTES + 1);
    let reader: Box<dyn Read> = match encoding {
        "identity" => Box::new(wire),
        "gzip" => Box::new(flate2::read::MultiGzDecoder::new(wire)),
        "deflate" => Box::new(flate2::read::ZlibDecoder::new(wire)),
        _ => return Err("Unsupported source content encoding".into()),
    };
    let mut bytes = vec![];
    reader
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Source response exceeds 16 MiB".into());
    }
    Ok(bytes)
}
fn walk(
    text: &str,
    resolve: impl Fn(&Url, Instant) -> Result<Vec<SocketAddr>>,
    request: impl Fn(&Url, &[SocketAddr], Instant) -> Result<Response>,
) -> Result<Vec<u8>> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut url = validate_url(text)?;
    for hop in 0..=5 {
        let addresses = resolve(&url, deadline)?;
        if addresses.is_empty() || addresses.iter().any(|a| !public(a.ip())) {
            return Err("Source DNS contains a non-public address".into());
        }
        let response = request(&url, &addresses, deadline)?;
        match response.status {
            301 | 302 | 303 | 307 | 308 if hop < 5 => {
                let next = url
                    .join(
                        response
                            .location
                            .as_deref()
                            .ok_or("Redirect missing Location")?,
                    )
                    .map_err(|e| e.to_string())?;
                url = validate_url(next.as_str())?;
            }
            200..=299 => return Ok(response.bytes),
            _ => return Err("Source redirect refused or exceeded five hops".into()),
        }
    }
    unreachable!()
}
pub fn fetch(text: &str) -> Result<Vec<u8>> {
    walk(text, resolve, request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compressed_bodies_are_bounded_after_decoding() {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(b"hello").unwrap();
        assert_eq!(
            read_body(std::io::Cursor::new(encoder.finish().unwrap()), "gzip").unwrap(),
            b"hello"
        );
        assert!(read_body(std::io::repeat(0).take(MAX_BYTES + 1), "identity").is_err());
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::copy(&mut std::io::repeat(0).take(MAX_BYTES + 1), &mut encoder).unwrap();
        assert!(read_body(std::io::Cursor::new(encoder.finish().unwrap()), "gzip").is_err());
    }
    #[test]
    fn redirect_limit_and_address_classes_are_enforced() {
        for ip in [
            "0.0.0.0",
            "100.64.0.1",
            "224.0.0.1",
            "198.18.0.1",
            "::",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "2002:7f00:1::1",
        ] {
            assert!(!public(ip.parse().unwrap()), "{ip}");
        }
        assert!(public("2606:4700:4700::1111".parse().unwrap()));
        let calls = std::cell::Cell::new(0);
        assert!(walk(
            "https://example.com",
            |_, _| Ok(vec!["93.184.216.34:443".parse().unwrap()]),
            |_, _, _| {
                calls.set(calls.get() + 1);
                Ok(Response {
                    status: 302,
                    location: Some("/again".into()),
                    bytes: vec![],
                })
            }
        )
        .is_err());
        assert_eq!(calls.get(), 6);
    }
    #[test]
    fn redirects_and_dns_are_checked_before_any_connection() {
        let public = "93.184.216.34:443".parse().unwrap();
        let private = "127.0.0.1:443".parse().unwrap();
        assert!(walk(
            "https://example.com",
            |_, _| Ok(vec![public, private]),
            |_, _, _| panic!("must not connect")
        )
        .is_err());
        let calls = std::cell::Cell::new(0);
        assert!(walk(
            "https://example.com",
            |_, _| Ok(vec![public]),
            |_, addresses, _| {
                assert_eq!(addresses, &[public]);
                calls.set(calls.get() + 1);
                Ok(Response {
                    status: 302,
                    location: Some("http://169.254.169.254/".into()),
                    bytes: vec![],
                })
            }
        )
        .is_err());
        assert_eq!(calls.get(), 1);
        let dns = std::cell::Cell::new(0);
        assert!(walk(
            "https://example.com",
            |_, _| {
                dns.set(dns.get() + 1);
                Ok(vec![if dns.get() == 1 { public } else { private }])
            },
            |_, _, _| Ok(Response {
                status: 302,
                location: Some("/next".into()),
                bytes: vec![]
            })
        )
        .is_err());
        assert_eq!(
            walk(
                "https://example.com",
                |_, _| Ok(vec![public]),
                |_, _, _| Ok(Response {
                    status: 200,
                    location: None,
                    bytes: b"ok".to_vec()
                })
            )
            .unwrap(),
            b"ok"
        );
    }
}
